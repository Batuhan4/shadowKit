import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as snarkjs from "snarkjs";
const FX = resolve(__dirname, "../fixtures-min");
describe("degraded vote_min circuit (membership + nullifier only)", () => {
  it("3 public signals [nullifier, merkleRoot, proposalId] and verifies", async () => {
    const input = JSON.parse(readFileSync(resolve(FX, "input.json"), "utf8"));
    const vkey = JSON.parse(readFileSync(resolve(FX, "verification_key.json"), "utf8"));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, resolve(FX, "vote_min.wasm"), resolve(FX, "vote_min_final.zkey"));
    expect(publicSignals.length).toBe(3); // nullifier(out) + merkleRoot + proposalId
    expect(await snarkjs.groth16.verify(vkey, publicSignals, proof)).toBe(true);
  });
});
