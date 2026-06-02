import { describe, it, expect } from "vitest";
import { buildSnapshot } from "../src/index.js";
import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";

describe("buildSnapshot", () => {
  it("root is deterministic for the same holders", async () => {
    const holders = [
      { secretCommit: await poseidonHashBls(["12345"]), weight: "1000" },
      { secretCommit: await poseidonHashBls(["67890"]), weight: "500" },
    ];
    const s1 = await buildSnapshot(holders);
    const s2 = await buildSnapshot(holders);
    expect(s1.root).toBe(s2.root);
    expect(s1.depth).toBe(20);
  });

  it("getPath yields a path the circuit accepts (root matches)", async () => {
    const secret = "12345", weight = "1000";
    const holders = [{ secretCommit: await poseidonHashBls([secret]), weight }];
    const s = await buildSnapshot(holders);
    const { merklePath, pathIndices } = s.getPath(0);
    // recompute root from leaf + path; must equal s.root.
    const leaf = await poseidonHashBls([holders[0]!.secretCommit, weight]);
    let cur = leaf;
    for (let i = 0; i < merklePath.length; i++) {
      cur = pathIndices[i] === 0 ? await poseidonHashBls([cur, merklePath[i]!]) : await poseidonHashBls([merklePath[i]!, cur]);
    }
    expect(cur).toBe(s.root);
  });

  it("tampering the path breaks the root", async () => {
    const holders = [{ secretCommit: await poseidonHashBls(["12345"]), weight: "1000" }];
    const s = await buildSnapshot(holders);
    const { merklePath, pathIndices } = s.getPath(0);
    const leaf = await poseidonHashBls([holders[0]!.secretCommit, "1000"]);
    let cur = leaf;
    const tampered = [...merklePath]; tampered[0] = "1";
    for (let i = 0; i < tampered.length; i++) {
      cur = pathIndices[i] === 0 ? await poseidonHashBls([cur, tampered[i]!]) : await poseidonHashBls([tampered[i]!, cur]);
    }
    expect(cur).not.toBe(s.root);
  });
});
