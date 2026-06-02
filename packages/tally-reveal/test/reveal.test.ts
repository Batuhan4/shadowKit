import { describe, it, expect } from "vitest";
import { timelockSealVote } from "@shadowkit/zk-prover";
import { revealTally } from "../src/index.js";
import type { SealedVoteCiphertext } from "@shadowkit/shared";

const PAST_DEADLINE = 1692803367 + 5 * 3; // round ~6, released → decryptable now

async function seal(dir: 0 | 1, w: string): Promise<SealedVoteCiphertext> {
  return timelockSealVote(dir, w, PAST_DEADLINE);
}

describe("revealTally (REAL tlock decryption + weighted sum)", () => {
  it("sums weight by direction over decrypted votes", async () => {
    const votes = await Promise.all([
      seal(1, "100"), // yes 100
      seal(1, "250"), // yes 250
      seal(0, "300"), // no 300
    ]);
    const res = await revealTally(votes);
    expect(res.yesW).toBe("350");
    expect(res.noW).toBe("300");
    expect(res.decrypted).toHaveLength(3);
    expect(res.decrypted[0]).toEqual({ direction: 1, weight: "100" });
  }, 120_000);
});
