// Type declarations for snarkjs@0.7.6 (ships NO TypeScript types and there is no @types/snarkjs).
// snarkjs has an `exports` map but no `types`, so under moduleResolution:"bundler" an ambient
// `declare module "snarkjs"` is IGNORED. We instead expose THIS file as the "snarkjs" types via a
// `paths` mapping in tsconfig.json. It lives OUTSIDE the `include: ["src"]` glob on purpose: when a
// file is BOTH an include-root and a paths-target, tsc's resolution becomes order-dependent (a
// heisenbug — green alone, red inside the `npm run build` chain). Kept out of `src`, it is reached
// ONLY via the paths substitution → deterministic. The mapping is tsc-only (no vite-tsconfig-paths
// in this repo), so the runtime still resolves the real package.
// VERIFIED against snarkjs@0.7.6 build/main.cjs (2026-06-02):
//   groth16.fullProve(input, wasmFile, zkeyFile) -> Promise<{ proof, publicSignals }>
//   groth16.verify(vkey, publicSignals, proof) -> Promise<boolean>
//   wtns.calculate(input, wasmFile, wtnsFile, options?) -> Promise<void>  (3rd arg = output file path)
//   wtns.exportJson(wtnsFile) -> Promise<bigint[]>  (witness vector; index 1 = first output signal)
export const groth16: {
  fullProve(
    input: Record<string, unknown>,
    wasmFile: string,
    zkeyFile: string,
  ): Promise<{ proof: unknown; publicSignals: string[] }>;
  verify(vkey: object, publicSignals: string[], proof: unknown): Promise<boolean>;
};
export const wtns: {
  calculate(
    input: Record<string, unknown>,
    wasmFile: string,
    wtnsFile: string,
    options?: unknown,
  ): Promise<void>;
  exportJson(wtnsFile: string): Promise<bigint[]>;
};
export const zKey: {
  exportVerificationKey(zkeyFile: string): Promise<object>;
};
