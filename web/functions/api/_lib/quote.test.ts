import { describe, it, expect } from "vitest";
import { quoteFor } from "./quote";

describe("quoteFor — the premium market data sold over x402", () => {
  it("returns a deterministic quote for a known pair", () => {
    const a = quoteFor("USDC-XLM");
    const b = quoteFor("USDC-XLM");
    expect(a).toEqual(b); // deterministic so tests + on-chain math stay reproducible
    expect(a.pair).toBe("USDC-XLM");
    expect(typeof a.price).toBe("string");
    expect(["buy", "sell", "hold"]).toContain(a.signal);
  });

  it("price is a positive decimal string (drives minOut math downstream)", () => {
    const q = quoteFor("USDC-XLM");
    expect(q.price).toMatch(/^[0-9]+(\.[0-9]+)?$/);
    expect(Number(q.price)).toBeGreaterThan(0);
  });

  it("falls back to a neutral hold quote for an unknown pair", () => {
    const q = quoteFor("FOO-BAR");
    expect(q.pair).toBe("FOO-BAR");
    expect(q.signal).toBe("hold");
  });
});
