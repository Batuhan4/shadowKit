// scripts/demo/compute-root.ts — print the demo snapshot's Merkle root as a 32-byte big-endian hex
// string (BytesN<32> form) for `gov-vault init --merkle_root`. Deterministic (fixed DEMO_HOLDERS).
import { buildSnapshot } from "@shadowkit/snapshot-tool";
import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";
import { DEMO_HOLDERS } from "./_holders.js";

async function main() {
  const leaves = [];
  for (const h of DEMO_HOLDERS) {
    leaves.push({ secretCommit: await poseidonHashBls([h.secret]), weight: h.weight });
  }
  const snap = await buildSnapshot(leaves);
  // gov-vault wants the BytesN<32> as bare hex (no 0x) for the CLI --merkle_root arg.
  process.stdout.write(snap.rootBe32Hex.replace(/^0x/, ""));
}

main()
  .then(() => new Promise<void>((r) => process.stdout.write("", () => r())))
  .then(() => process.exit(0))
  .catch((e) => { console.error("compute-root FAILED:", (e as Error)?.stack || e); process.exit(1); });
