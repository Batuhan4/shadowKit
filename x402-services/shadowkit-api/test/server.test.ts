import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { startTestFacilitator } from "@shadowkit/x402-shared";
import { makeX402Fetch } from "@shadowkit/x402-shared/payerFetch";
import { loadX402Accounts } from "@shadowkit/x402-shared/fixtures";
import { createShadowKitApiServer } from "../src/server.js";

// REAL x402 over 3 distinct funded accounts (foundation §3.6a). JUSTIFICATION (charter rule 4): a real
// USDC settlement needs the three funded accounts; skip (not fake) when absent. The off-chain Groth16
// verify + provider gate are ALSO covered un-gated in unit.test.ts (those run in every CI without funds).
const ACCT = loadX402Accounts();
const run = ACCT ? describe : describe.skip;
const ROOT = new URL("../../../", import.meta.url).pathname; // repo root from x402-services/shadowkit-api/test/

run("shadowkit-api x402 paywall + provider gating + agent kick (REAL, 3 accounts)", () => {
  const { clientSecret, facilitatorSecret, resourceServerAddress, network } =
    ACCT ?? ({} as NonNullable<typeof ACCT>);
  let fac: { url: string; stop: () => Promise<void> };
  let server: Server;
  let baseUrl: string;
  // Injected agent kick: /execute must trigger the agent for an approved proposal (spec §6 step 6).
  const runAgent = vi.fn(async (_id: number) => ({ txHash: "deadbeef00txhash" }));

  beforeAll(async () => {
    fac = await startTestFacilitator({ network, signerSecret: facilitatorSecret });
    const app = createShadowKitApiServer({
      payTo: resourceServerAddress,
      network,
      priceUsdc: "$0.001",
      facilitatorUrl: fac.url,
      govVaultId: "CGOVVAULT000000000000000000000000000000000000000000000000",
      rpcUrl: "http://127.0.0.1:8000/rpc",
      direction: "both",
      // Inject the on-chain read so the test asserts the GATE without a live RPC: approved only for id 1.
      readApproved: async (id: number) => id === 1,
      // Inject the agent runner so the test asserts /execute actually kicks the agent.
      runAgent,
    });
    server = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });
    const a = server.address();
    baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fac.stop();
  });

  it("402 on /execute without payment", async () => {
    const res = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: 1 }),
    });
    expect(res.status).toBe(402);
  });

  it("200 on /execute with payment for an APPROVED proposal — kicks the agent and returns txHash", async () => {
    const pf = makeX402Fetch(clientSecret, network);
    const res = await pf(`${baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, proposalId: 1, txHash: "deadbeef00txhash" });
    expect(runAgent).toHaveBeenCalledWith(1); // the agent was actually triggered
  });

  it("403 (provider gate) on /execute with payment for a NON-APPROVED proposal — does NOT kick the agent", async () => {
    runAgent.mockClear();
    const pf = makeX402Fetch(clientSecret, network);
    const res = await pf(`${baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: 2 }),
    });
    expect(res.status).toBe(403);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("200 on /verify with payment for a VALID proof (off-chain Groth16 verify)", async () => {
    // REAL proof from committed circuit fixtures (charter rule 4: no stubbed crypto).
    const proof = JSON.parse(readFileSync(`${ROOT}circuits/vote/fixtures/proof.json`, "utf8"));
    const publicRaw = JSON.parse(readFileSync(`${ROOT}circuits/vote/fixtures/public.json`, "utf8"));
    // public.json native order is [nullifier, merkleRoot, proposalId, sealedCommitmentHash]
    // (zk-prover src/index.ts:48 — snarkjs native order; VERIFIED 2026-06-03, plan's stated
    // [merkleRoot, nullifier] order is wrong and would fail a valid proof).
    const publicSignals = {
      nullifier: publicRaw[0],
      merkleRoot: publicRaw[1],
      proposalId: publicRaw[2],
      sealedCommitmentHash: publicRaw[3],
    };
    const pf = makeX402Fetch(clientSecret, network);
    const res = await pf(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof, publicSignals }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });
});
