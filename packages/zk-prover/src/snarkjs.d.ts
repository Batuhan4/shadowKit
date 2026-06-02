// Ambient declarations for snarkjs@0.7.6 (ships NO TypeScript types and there is no @types/snarkjs).
// Only the surface ShadowKit uses is declared. VERIFIED against snarkjs@0.7.6 build/main.cjs (2026-06-02):
//   groth16.fullProve(input, wasmFile, zkeyFile) -> Promise<{ proof, publicSignals }>
//   groth16.verify(vkey, publicSignals, proof) -> Promise<boolean>
//   wtns.calculate(input, wasmFile, wtnsFile, options?) -> Promise<void>  (3rd arg = output file path)
//   wtns.exportJson(wtnsFile) -> Promise<bigint[]>  (witness vector; index 1 = first output signal)
declare module "snarkjs" {
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
}
