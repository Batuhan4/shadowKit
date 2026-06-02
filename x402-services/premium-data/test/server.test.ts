import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { startTestFacilitator } from "@shadowkit/x402-shared";
import { makeX402Fetch } from "@shadowkit/x402-shared/payerFetch";
import { loadX402Accounts } from "@shadowkit/x402-shared/fixtures";
import { createPremiumDataServer } from "../src/server.js";

// REAL x402 over 3 distinct funded accounts (foundation §3.6a): CLIENT pays, FACILITATOR settles,
// RESOURCE_SERVER is the payTo. JUSTIFICATION (charter rule 4): a real USDC settlement needs the
// three funded accounts; skip (not fake) when absent.
const ACCT = loadX402Accounts();
const run = ACCT ? describe : describe.skip;

run("premium-data x402 paywall (REAL, 3 accounts)", () => {
  const { clientSecret, facilitatorSecret, resourceServerAddress, network } =
    ACCT ?? ({} as NonNullable<typeof ACCT>);
  let fac: { url: string; stop: () => Promise<void> };
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    fac = await startTestFacilitator({ network, signerSecret: facilitatorSecret });
    const app = createPremiumDataServer({
      payTo: resourceServerAddress,
      network,
      priceUsdc: "$0.001",
      facilitatorUrl: fac.url,
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

  it("402 without payment", async () => {
    const res = await fetch(`${baseUrl}/market/USDC-XLM`);
    expect(res.status).toBe(402);
  });
  it("200 + market data WITH payment", async () => {
    const pf = makeX402Fetch(clientSecret, network);
    const res = await pf(`${baseUrl}/market/USDC-XLM`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pair: "USDC-XLM", price: "0.1123", signal: "buy" });
  });
});
