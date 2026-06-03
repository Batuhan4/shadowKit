#!/usr/bin/env node
// scripts/copy-zk-artifacts.mjs — copy the committed circuit proving artifacts into web/public/zk/
// so the browser can generate REAL Groth16 vote proofs client-side. Runs as web's `prebuild` (the
// artifacts are gitignored under web/public/zk to avoid duplicating 10MB in git — circuits/vote/
// fixtures/ is the single committed source).
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(ROOT, "circuits/vote/fixtures");
const dst = resolve(ROOT, "web/public/zk");
mkdirSync(dst, { recursive: true });

const files = ["vote.wasm", "vote_final.zkey", "verification_key.json"];
for (const f of files) {
  const from = resolve(src, f);
  if (!existsSync(from)) throw new Error(`copy-zk-artifacts: missing ${from} (run the circuit fixtures build)`);
  copyFileSync(from, resolve(dst, f));
  console.log(`copy-zk-artifacts: ${f}`);
}
console.log(`copy-zk-artifacts: wrote ${files.length} files -> web/public/zk/`);
