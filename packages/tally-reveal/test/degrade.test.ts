import { describe, it, expect } from "vitest";
import { aggregateUnlinked, aggregate1p1v } from "../src/degrade.js";

const decrypted = [
  { direction: 1 as const, weight: "100" },
  { direction: 1 as const, weight: "250" },
  { direction: 0 as const, weight: "300" },
];

describe("degradation fallbacks", () => {
  it("weight-unlinked: each vote counts as 1 regardless of weight", () => {
    const r = aggregateUnlinked(decrypted);
    expect(r.yesW).toBe("2"); // two yes votes
    expect(r.noW).toBe("1");  // one no vote
  });

  it("1p1v: identical head-count semantics", () => {
    const r = aggregate1p1v(decrypted);
    expect(r.yesW).toBe("2");
    expect(r.noW).toBe("1");
  });

  it("1p1v differs from weighted: whales do not dominate", () => {
    const whaleNo = [
      { direction: 1 as const, weight: "1" },
      { direction: 1 as const, weight: "1" },
      { direction: 0 as const, weight: "1000000" },
    ];
    const h = aggregate1p1v(whaleNo);
    expect(h.yesW).toBe("2"); // 2 heads yes > 1 head no -> yes wins per head
    expect(h.noW).toBe("1");
  });
});
