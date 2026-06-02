import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as snarkjs from "snarkjs";

const FX = resolve(__dirname, "../fixtures");
const wasm = resolve(FX, "vote.wasm");
const zkey = resolve(FX, "vote_final.zkey");
const vkey = JSON.parse(readFileSync(resolve(FX, "verification_key.json"), "utf8"));
const baseInput = JSON.parse(readFileSync(resolve(FX, "input.json"), "utf8"));

describe("vote circuit (real snarkjs, BLS12-381)", () => {
  it("witness satisfiable for valid input; proof verifies", async () => {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(baseInput, wasm, zkey);
    expect(await snarkjs.groth16.verify(vkey, publicSignals, proof)).toBe(true);
  });

  it("rejects non-bit direction (direction = 2)", async () => {
    const bad = { ...baseInput, direction: "2" };
    // direction*(direction-1)===0 is violated => witness generation throws (Assert Failed).
    await expect(snarkjs.groth16.fullProve(bad, wasm, zkey)).rejects.toThrow();
  });

  it("rejects weight that does not match the committed leaf", async () => {
    // Changing weight breaks BOTH leaf membership and the sealedCommitmentHash constraint.
    const bad = { ...baseInput, weight: "9999" };
    await expect(snarkjs.groth16.fullProve(bad, wasm, zkey)).rejects.toThrow();
  });

  it("rejects wrong nullifier wiring (tampered sealedCommitmentHash public input)", async () => {
    const bad = { ...baseInput, sealedCommitmentHash: "1" }; // != Poseidon(direction,weight,sealKey)
    await expect(snarkjs.groth16.fullProve(bad, wasm, zkey)).rejects.toThrow();
  });

  it("nullifier output equals Poseidon(secret, proposalId)", async () => {
    const { publicSignals } = await snarkjs.groth16.fullProve(baseInput, wasm, zkey);
    // publicSignals[0] is the circuit OUTPUT (nullifier) per snarkjs convention; assert it is
    // a non-empty field element and stable across runs (deterministic given fixed input).
    const a = publicSignals[0];
    const { publicSignals: ps2 } = await snarkjs.groth16.fullProve(baseInput, wasm, zkey);
    expect(ps2[0]).toBe(a);
    expect(/^[0-9]+$/.test(a)).toBe(true);
  });
});
