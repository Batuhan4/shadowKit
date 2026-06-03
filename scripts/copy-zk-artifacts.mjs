#!/usr/bin/env node
// scripts/copy-zk-artifacts.mjs — copy the committed circuit proving artifacts into web/public/zk/
// so the browser can generate REAL Groth16 vote proofs client-side. Runs as web's `prebuild` (the
// artifacts are gitignored under web/public/zk to avoid duplicating 10MB in git — circuits/vote/
// fixtures/ is the single committed source).
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dst = resolve(ROOT, "web/public/zk");
mkdirSync(dst, { recursive: true });

// Each artifact lists its committed source dir. The Groth16 circuit (vote.*) +
// verification_key.json live in circuits/vote/fixtures; the in-circuit Poseidon3 witness
// calculator (BLS12-381, byte-parity with the circuit — circomlibjs/poseidon-lite are BN254 and
// WRONG) lives in packages/zk-prover/artifacts. ShadowFund's browser proof flow fetches all four
// from /zk/* at runtime, so all four MUST be copied for a clean-checkout build to work.
const files = [
  { name: "vote.wasm", from: resolve(ROOT, "circuits/vote/fixtures/vote.wasm") },
  { name: "vote_final.zkey", from: resolve(ROOT, "circuits/vote/fixtures/vote_final.zkey") },
  { name: "verification_key.json", from: resolve(ROOT, "circuits/vote/fixtures/verification_key.json") },
  { name: "poseidon3.wasm", from: resolve(ROOT, "packages/zk-prover/artifacts/poseidon3.wasm") },
];
for (const { name, from } of files) {
  if (!existsSync(from)) throw new Error(`copy-zk-artifacts: missing ${from} (run the circuit/zk-prover artifact build)`);
  copyFileSync(from, resolve(dst, name));
  console.log(`copy-zk-artifacts: ${name}`);
}
console.log(`copy-zk-artifacts: wrote ${files.length} files -> web/public/zk/`);
