import { describe, it, expect } from "vitest";
import { selectSwapVenueId } from "../src/executor.js";

// SWAP_VENUE config switch (foundation §2.4): never a code fork — a pure id selector.
describe("selectSwapVenueId", () => {
  it("returns the FallbackAMM id when SWAP_VENUE=fallback", () => {
    expect(selectSwapVenueId("fallback", { fallbackAmmId: "CFALLBACK", soroswapAdapterId: "CSORO" })).toBe(
      "CFALLBACK",
    );
  });
  it("returns the Soroswap adapter id when SWAP_VENUE=soroswap", () => {
    expect(selectSwapVenueId("soroswap", { fallbackAmmId: "CFALLBACK", soroswapAdapterId: "CSORO" })).toBe(
      "CSORO",
    );
  });
  it("defaults to FallbackAMM for an unknown value", () => {
    expect(selectSwapVenueId("nope", { fallbackAmmId: "CFALLBACK", soroswapAdapterId: "CSORO" })).toBe(
      "CFALLBACK",
    );
  });
});
