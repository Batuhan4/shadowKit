// Load the snarkjs verification key from the committed circuit fixtures WITHOUT a JSON import attribute.
// (Cross-package `import vkey from "...json" with { type: "json" }` is not reliably supported under
// `node --experimental-strip-types`; readFileSync + JSON.parse is portable.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// src/ -> package root -> x402-services -> repo root -> circuits/vote/fixtures
const VKEY_PATH =
  process.env.VKEY_PATH ?? resolve(here, "../../../circuits/vote/fixtures/verification_key.json");

export function loadVkey(): object {
  return JSON.parse(readFileSync(VKEY_PATH, "utf8")) as object;
}
