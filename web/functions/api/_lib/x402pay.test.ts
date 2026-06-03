import { describe, it, expect, vi } from "vitest";
import { makePayAndQuote } from "./x402pay";

const okQuote = { pair: "USDC-XLM", price: "0.1123", signal: "buy" as const };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("makePayAndQuote — the x402 INBOUND pay path", () => {
  it("returns paid + the quote when the (paid) fetch yields 200", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(okQuote, 200, { "x-payment-response": "settle-ref-1" }),
    ) as unknown as typeof fetch;
    const pay = makePayAndQuote({
      premiumDataUrl: "https://x/api/premium-data",
      clientSecret: "SDEMO",
      network: "stellar:testnet",
      fetchImpl,
    });
    const r = await pay("USDC-XLM");
    expect(r.paid).toBe(true);
    expect(r.quote).toEqual(okQuote);
    expect(r.txRef).toBe("settle-ref-1");
  });

  it("reports unpaid (no settlement) when the response is still 402", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "payment required" }, 402),
    ) as unknown as typeof fetch;
    const pay = makePayAndQuote({
      premiumDataUrl: "https://x/api/premium-data",
      clientSecret: "SDEMO",
      network: "stellar:testnet",
      fetchImpl,
    });
    const r = await pay("USDC-XLM");
    expect(r.paid).toBe(false);
    expect(r.quote).toBeNull();
  });

  it("reports unpaid when no CLIENT_SECRET is configured (no fallback)", async () => {
    const pay = makePayAndQuote({
      premiumDataUrl: "https://x/api/premium-data",
      network: "stellar:testnet",
    });
    const r = await pay("USDC-XLM");
    expect(r.paid).toBe(false);
    expect(r.error).toMatch(/CLIENT_SECRET/);
  });
});
