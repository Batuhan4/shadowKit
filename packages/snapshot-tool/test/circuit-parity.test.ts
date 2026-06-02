import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { buildSnapshot } from "../src/index.js";
import { generateVoteProof, verifyVoteProof } from "@shadowkit/zk-prover";
import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";

const ART = resolve(__dirname, "../../zk-prover/artifacts");
const vkey = JSON.parse(readFileSync(resolve(ART, "verification_key.json"), "utf8"));

describe("snapshot <-> prover <-> verifier parity", () => {
  it("a proof against a snapshot-tool root verifies", async () => {
    const secret = "555", weight = "777";
    const sc = await poseidonHashBls([secret]);
    const snap = await buildSnapshot([{ secretCommit: sc, weight }]);
    const { merklePath, pathIndices } = snap.getPath(0);
    const r = await generateVoteProof(
      { secret, merklePath, pathIndices, weight, proposalId: "0", direction: 1, merkleRoot: snap.root },
      { wasmPath: resolve(ART, "vote.wasm"), zkeyPath: resolve(ART, "vote_final.zkey") }, 1_999_999_999);
    expect(r.publicSignals.merkleRoot).toBe(snap.root);
    expect(await verifyVoteProof(vkey, r.publicSignals, r.proof)).toBe(true);
  });
});
