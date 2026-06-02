import { describe, it, expect } from "vitest";
import { fieldToBe32Hex, toScSealedVote } from "./types.js";
import type { SealedVoteCiphertext } from "./types.js";

describe("fieldToBe32Hex", () => {
  it("pads small values to 32 bytes big-endian", () => {
    expect(fieldToBe32Hex("1")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
  });
  it("encodes 256 as big-endian 0x..0100", () => {
    expect(fieldToBe32Hex("256")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000100",
    );
  });
  it("handles a 32-byte value (no overflow)", () => {
    const max = (2n ** 256n - 1n).toString(); // exactly 64 hex chars
    expect(fieldToBe32Hex(max)).toBe("0x" + "f".repeat(64));
  });
  it("rejects non-decimal input", () => {
    expect(() => fieldToBe32Hex("0xdead")).toThrow(/decimal field string/);
  });
  it("rejects values exceeding 32 bytes", () => {
    const tooBig = (2n ** 256n).toString();
    expect(() => fieldToBe32Hex(tooBig)).toThrow(/exceeds 32 bytes/);
  });
});

describe("toScSealedVote (intentionally deferred to M5 — spec §9)", () => {
  // Charter rule 1: every public fn in this REAL (tested) module has a test. toScSealedVote
  // needs the generated GovVault bindings (M5), so M0 asserts it currently throws the
  // documented M5 error — a tested, intentionally-deferred surface, not an untested public fn.
  it("throws the documented M5-deferral error", () => {
    const sample: SealedVoteCiphertext = {
      round: 1,
      ciphertext: "deadbeef",
      sealedCommitmentHash:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
    };
    expect(() => toScSealedVote(sample)).toThrow(/implemented in M5/);
  });
});
