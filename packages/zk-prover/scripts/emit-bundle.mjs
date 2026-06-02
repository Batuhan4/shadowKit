// Emit a fresh proof bundle for a given secret/weight/proposalId to a target dir, using the FULL
// @shadowkit/zk-prover generateVoteProof path (snapshot-tool root + prover re-map) — so the on-chain
// round-trip (Task 4.35) exercises the SAME re-map the browser uses. Emits the proof + the snarkjs
// NATIVE-order public.json (for the Rust loader that mirrors committed_proof) + the binding-order
// signals + root in meta.json for the contract test.
// RUN WITH: `npx tsx packages/zk-prover/scripts/emit-bundle.mjs <secret> <weight> <proposalId> <outDir>`
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "../../snapshot-tool/src/index.js";
import { generateVoteProof, verifyVoteProof } from "../src/index.js";
import { poseidonHashBls } from "../src/poseidon.js";

const [secret = "555", weight = "777", proposalId = "0", outDir = "circuits/vote/fixtures-fresh"] =
  process.argv.slice(2);
const ART = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts");
const vkey = JSON.parse(readFileSync(resolve(ART, "verification_key.json"), "utf8"));
const sc = await poseidonHashBls([secret]);
const snap = await buildSnapshot([{ secretCommit: sc, weight }]);
const { merklePath, pathIndices } = snap.getPath(0);
const r = await generateVoteProof(
  { secret, merklePath, pathIndices, weight, proposalId, direction: 1, merkleRoot: snap.root },
  { wasmPath: resolve(ART, "vote.wasm"), zkeyPath: resolve(ART, "vote_final.zkey") },
  1_999_999_999,
);
// Self-check off-chain before committing the bundle (REAL snarkjs verify of the re-mapped signals).
if (!(await verifyVoteProof(vkey, r.publicSignals, r.proof)))
  throw new Error("emit-bundle: fresh proof failed off-chain verify");
const dir = resolve(process.cwd(), outDir);
mkdirSync(dir, { recursive: true });
// snarkjs NATIVE order for proof.json compatibility with the Rust loader (mirrors committed_proof):
const nativePublic = [
  r.publicSignals.nullifier,
  r.publicSignals.merkleRoot,
  r.publicSignals.proposalId,
  r.publicSignals.sealedCommitmentHash,
];
writeFileSync(resolve(dir, "proof.json"), JSON.stringify(r.proof, null, 2));
writeFileSync(resolve(dir, "public.json"), JSON.stringify(nativePublic, null, 2));
// meta.json records the BINDING-order signals + root so a reviewer can eyeball the re-map agreement.
writeFileSync(
  resolve(dir, "meta.json"),
  JSON.stringify({ secret, weight, proposalId, root: snap.root, publicSignals: r.publicSignals }, null, 2),
);
console.log("emitted FRESH bundle to", dir, "root=", snap.root);
