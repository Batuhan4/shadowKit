import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { startTestFacilitator } from "@shadowkit/x402-shared";
import { loadX402Accounts } from "@shadowkit/x402-shared/fixtures";
import { createPremiumDataServer } from "@shadowkit/x402-premium-data/server";
import { DataClient } from "../src/dataClient.js";

// REAL x402 over 3 distinct funded accounts (foundation §3.6a): the agent (CLIENT) pays the premium-data
// resource server (RESOURCE_SERVER payTo); the FACILITATOR settles. JUSTIFICATION (charter rule 4): a real
// USDC settlement needs the three funded accounts; skip (not fake) when absent.
//
// FLAG (trivial drift vs the M6 plan listing): the plan passed `priceUsdc: "0.001"`, but the SHIPPED
// premium-data server + real @x402 middleware require an x402 Money string (`"$0.001"`) — every other
// x402 suite (roundtrip.test.ts, server.test.ts) uses `"$0.001"`. We use the Money form so the REAL
// middleware actually paywalls; this is not a behavioral deviation, only the correct on-the-wire format.
const ACCT = loadX402Accounts();
const run = ACCT ? describe : describe.skip;

run("DataClient pays a REAL x402 premium-data call (3 accounts)", () => {
  const { clientSecret, facilitatorSecret, resourceServerAddress, network } =
    ACCT ?? ({} as NonNullable<typeof ACCT>);
  let fac: { url: string; stop: () => Promise<void> };
  let server: Server;
  let url: string;
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
    url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fac.stop();
  });

  it("fetchMarket auto-pays the 402 and returns parsed MarketData", async () => {
    const dc = new DataClient({ url, signerSecret: clientSecret, network });
    const data = await dc.fetchMarket("USDC-XLM");
    expect(data).toEqual({ pair: "USDC-XLM", price: "0.1123", signal: "buy" });
  });

  it("a plain (non-paying) fetch to the same endpoint is rejected with 402", async () => {
    const res = await fetch(`${url}/market/USDC-XLM`);
    expect(res.status).toBe(402);
  });
});

// NON-ENV-GATED proof that the DataClient is a REAL x402 client (charter rules 1 + 4), not the M2 stub.
// We stand up the SHIPPED premium-data paywall against a real local facilitator (no funded accounts
// needed for THIS leg) and point the DataClient at it with an UNFUNDED random payer. The current stub
// would silently return canned data ({price:"10",signal:"hold"}); the REAL DataClient instead drives the
// @x402/fetch client, which attempts an on-chain USDC payment and FAILS to build the payment payload
// (the payer holds no USDC -> contract error #13). The assertion is therefore "engages real x402 + never
// fabricates market data", which is exactly what distinguishes the real client from the stub. The
// SETTLED 200 path (a funded payer actually paying) is the env-gated suite above.
describe("DataClient engages REAL x402 client logic (no funded account required)", () => {
  const network = "stellar:testnet" as const;
  let fac: { url: string; stop: () => Promise<void> };
  let server: Server;
  let url: string;
  beforeAll(async () => {
    fac = await startTestFacilitator({ network, signerSecret: Keypair.random().secret() });
    const app = createPremiumDataServer({
      payTo: Keypair.random().publicKey(),
      network,
      priceUsdc: "$0.001",
      facilitatorUrl: fac.url,
    });
    server = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fac.stop();
  });

  it("attempts a real x402 payment (and never returns fabricated/stub data) for an unfunded payer", async () => {
    const dc = new DataClient({ url, signerSecret: Keypair.random().secret(), network });
    // The real x402 client must engage: an unfunded payer cannot build the payment payload, so this
    // rejects. The OLD stub resolved with canned data and would NOT throw -> genuine RED before GREEN.
    await expect(dc.fetchMarket("USDC-XLM")).rejects.toThrow();
    // And it must NEVER have resolved to the stub's canned shape.
    const result = await dc.fetchMarket("USDC-XLM").catch(() => "threw" as const);
    expect(result).toBe("threw");
  });
});
