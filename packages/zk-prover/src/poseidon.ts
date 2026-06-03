// Poseidon over the BLS12-381 scalar field, computed by running the circuit's OWN compiled
// witness calculator (§0.1). This GUARANTEES byte-parity with the in-circuit Poseidon — poseidon-lite
// and circomlibjs.buildPoseidon() are hardcoded to BN254 (verified 2026-06-02) and would silently
// produce wrong hashes for our BLS12-381 circuit (charter rule 4 forbids that).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// snarkjs has no types. VERIFIED API (snarkjs@0.7.6 source, build/main.cjs, 2026-06-02):
//   wtns.calculate(input, wasmFileName, wtnsFileName, options?) -> Promise<void>
//     — the 3rd arg is the OUTPUT FILE PATH; it does fastFile.createOverride(wtnsFileName) and
//       writes the witness there. It returns NOTHING. There is NO `{type:"mem"}` mem-mode that
//       returns a buffer (the earlier plan draft invented that and was broken).
//   wtns.exportJson(wtnsFileName) -> Promise<bigint[]>  (reads the .wtns file back; the returned
//       array `w` has w[0] === 1n (the constant) and w[1] === the FIRST output signal `out` of the
//       helper circuit; subsequent indices are the inputs). SOURCE: wtnsExportJson -> read() ->
//       readBigInt loop returning res[] of bigints (build/main.cjs lines 4107 + 890).
// @ts-ignore — untyped import; types come from vendor-types/snarkjs.d.ts via tsconfig `paths` (see the
// index.ts note); this guards against the bundler-resolution race in the `npm run build` chain.
import * as snarkjs from "snarkjs";

const ARTIFACTS = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts");

// Run wtns.calculate to a temp .wtns file, then exportJson it and read the output signal.
// The helper circuits (poseidon{1,2,3}.circom) declare exactly one output `out`, so in the
// snarkjs witness vector it is index 1 (index 0 is the implicit constant 1 signal).
async function helperOut(n: 1 | 2 | 3, inputs: string[]): Promise<string> {
  const wasmPath = resolve(ARTIFACTS, `poseidon${n}.wasm`);
  const dir = mkdtempSync(resolve(tmpdir(), "shadowkit-wtns-"));
  const wtnsPath = resolve(dir, "w.wtns");
  try {
    // 3rd arg is a REAL file path (verified). The witness is written to wtnsPath.
    await snarkjs.wtns.calculate({ in: inputs }, wasmPath, wtnsPath);
    // exportJson returns the witness as an array of bigints; w[1] is the `out` signal.
    const w: bigint[] = await snarkjs.wtns.exportJson(wtnsPath);
    return w[1]!.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function poseidonHashBls(inputs: string[]): Promise<string> {
  const n = inputs.length;
  if (n < 1 || n > 3) throw new Error(`poseidonHashBls: unsupported arity ${n} (1..3)`);
  return helperOut(n as 1 | 2 | 3, inputs);
}
