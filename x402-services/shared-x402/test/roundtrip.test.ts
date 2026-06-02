import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { buildStellarResourceServer, startTestFacilitator } from "../src/index.js";
import { makeX402Fetch } from "../src/payerFetch.js";
import { loadX402Accounts } from "../src/fixtures.js";

// REAL x402 round-trip over a LOCAL test facilitator (charter rule 4: not a faked 200).
// Settlement network = Stellar TESTNET; the THREE x402 roles are DISTINCT funded accounts
// (foundation §3.6a): the PAYER (client) holds USDC, the FACILITATOR signs settle txs, and the
// payTo is the RESOURCE_SERVER address. A single self-paying XLM account cannot settle USDC.
//
// JUSTIFICATION (charter rule 4): a real on-chain USDC x402 settlement requires three distinct
// funded testnet accounts + a USDC-funded payer; when CLIENT_SECRET/FACILITATOR_SECRET/
// RESOURCE_SERVER_ADDRESS are unset the suite cannot perform a REAL payment, so it is SKIPPED
// rather than faked. CI sets them via scripts/x402-bootstrap.ts (see Task 3.1b / deploy-testnet.sh).
const ACCT = loadX402Accounts();
const run = ACCT ? describe : describe.skip;

run("x402 shared round-trip (REAL facilitator + 3 distinct accounts)", () => {
  // `describe.skip` still runs this factory body synchronously, so read fields defensively
  // (ACCT is guaranteed non-null only when `run === describe`).
  const { clientSecret, facilitatorSecret, resourceServerAddress, network } =
    ACCT ?? ({} as NonNullable<typeof ACCT>);
  let facilitator: { url: string; stop: () => Promise<void> };
  let app: express.Express;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Facilitator runs under its OWN signer (FACILITATOR_SECRET), distinct from the payer/payTo.
    facilitator = await startTestFacilitator({ network, signerSecret: facilitatorSecret });
    app = express();
    app.use(
      buildStellarResourceServer({
        // payTo is the RESOURCE_SERVER address (NOT the payer) — it receives the USDC.
        routes: { "GET /thing": { payTo: resourceServerAddress, price: "$0.001", network } },
        network,
        facilitatorUrl: facilitator.url,
      }),
    );
    app.get("/thing", (_req, res) => {
      res.json({ ok: true });
    });
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await facilitator.stop();
  });

  it("returns 402 when called WITHOUT payment", async () => {
    const res = await fetch(`${baseUrl}/thing`);
    expect(res.status).toBe(402);
  });

  it("returns 200 + data when called WITH x402 payment (payer pays resource-server in USDC)", async () => {
    // The payer uses its OWN funded USDC account (CLIENT_SECRET), distinct from the payTo.
    const payingFetch = makeX402Fetch(clientSecret, network);
    const res = await payingFetch(`${baseUrl}/thing`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
