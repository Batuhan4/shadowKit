#!/usr/bin/env bash
# scripts/demo/_bundle.sh — bundle a demo TS helper into a runnable ESM file at the repo root.
#
# WHY a bundle (not `node --experimental-strip-types`): the @shadowkit/* workspace packages import
# their internal modules with `.js` specifiers that resolve to `.ts` files; node 26's type-stripping
# loader does NOT rewrite `.js`->`.ts`, so it cannot import these packages directly. esbuild resolves
# the workspace TS (and the .js->.ts specifiers) into one ESM file; the heavy crypto deps stay external
# and resolve from ./node_modules (so the bundle MUST live at the repo root). Same pattern as
# scripts/e2e-hero.sh's run-e2e bundle.
#
# Usage: scripts/demo/_bundle.sh <src.ts> <out.mjs>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$1"
OUT="$2"

# poseidon.ts resolves its wasm via `resolve(dirname(import.meta.url), "../artifacts")`. The bundle is
# expected to live ONE directory below the repo root (the demo writes to <root>/.demo-bundle/), so the
# bundle's "../artifacts" resolves to <root>/artifacts. Provide a repo-local symlink there so the
# bundle finds the committed zk-prover wasm. node still walks up to <root>/node_modules for the
# external crypto deps. (Idempotent; the symlink is gitignored.)
ln -sfn packages/zk-prover/artifacts "${ROOT}/artifacts"
mkdir -p "$(dirname "${OUT}")"

"${ROOT}/node_modules/.bin/esbuild" "${SRC}" \
  --bundle --platform=node --format=esm \
  --external:snarkjs --external:ffjavascript --external:tlock-js \
  --external:drand-client --external:fastfile \
  --outfile="${OUT}" >/dev/null 2>&1
