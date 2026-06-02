import { describe, it, expect } from "vitest";
import { marketDataFor } from "../src/market.js";

describe("marketDataFor", () => {
  it("returns the table entry for a known pair", () => {
    expect(marketDataFor("USDC-XLM")).toEqual({ pair: "USDC-XLM", price: "0.1123", signal: "buy" });
  });
  it("returns a hold default for an unknown pair", () => {
    expect(marketDataFor("FOO-BAR")).toEqual({ pair: "FOO-BAR", price: "1.0000", signal: "hold" });
  });
});
