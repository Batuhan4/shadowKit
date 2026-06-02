import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { startTestFacilitator } from "@shadowkit/x402-shared";
import { createPremiumDataServer } from "../src/server.js";
import { marketDataFor } from "../src/market.js";

// GENUINE NEGATIVE / NON-ENV-GATED (charter rules 1 + 4): the UNPAID 402 leg needs NO funded account
// and NO USDC settlement — only a syntactically-valid facilitator signer to construct the REAL x402
// facilitator + REAL paymentMiddleware. We mint a random keypair for the facilitator signer so this
// runs in CI without the 3-account bootstrap. This proves the SHIPPED premium-data server NEVER serves
// the premium data without payment — and that no `X402_DIRECTION` ungate path leaks the agent-pays side.
const FAC_KP = Keypair.random();

describe("premium-data NEVER serves data unpaid, even when X402_DIRECTION=agent-pays-only", () => {
  let fac: { url: string; stop: () => Promise<void> };
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.X402_DIRECTION = "agent-pays-only"; // the env that would ungate the SELL side
    fac = await startTestFacilitator({ network: "stellar:testnet", signerSecret: FAC_KP.secret() });
    const app = createPremiumDataServer({
      payTo: Keypair.random().publicKey(),
      network: "stellar:testnet",
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
    delete process.env.X402_DIRECTION;
    await new Promise<void>((r) => server.close(() => r()));
    await fac.stop();
  });

  it("returns 402 without payment", async () => {
    const res = await fetch(`${baseUrl}/market/USDC-XLM`);
    expect(res.status).toBe(402);
  });
  it("the unpaid response body does NOT contain the premium market data", async () => {
    const res = await fetch(`${baseUrl}/market/USDC-XLM`);
    const text = await res.text();
    const secret = marketDataFor("USDC-XLM"); // { pair, price:"0.1123", signal:"buy" }
    expect(text).not.toContain(secret.price); // the price must NOT leak before payment
    expect(text).not.toContain(secret.signal);
  });
});
