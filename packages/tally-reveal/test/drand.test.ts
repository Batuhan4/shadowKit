import { describe, it, expect } from "vitest";
import { roundForDeadline } from "../src/drand.js";

describe("tally-reveal roundForDeadline (re-export, REAL quicknet)", () => {
  it("matches roundAt/roundTime round-trip on real chain info", async () => {
    const genesis = 1692803367, period = 3;
    const deadline = genesis + 100 * period;
    const round = await roundForDeadline(deadline);
    expect(round).toBe(101);
  }, 30_000);
});
