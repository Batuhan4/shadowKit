// packages/tally-reveal/src/drand.ts
// Foundation §3.4 places roundForDeadline here; the single implementation lives in
// @shadowkit/zk-prover seal.ts (avoids a circular dep). Re-export to expose the §3.4 name.
export { roundForDeadline } from "@shadowkit/zk-prover";
