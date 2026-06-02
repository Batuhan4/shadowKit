import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// Demo-script test (the user's "demo script test" requirement). Runs the FULL SEALED-ZK loop end to
// end on the LOCAL network and asserts it is green (real sealed proofs + real tlock reveal + real
// on-chain balance movement + Executed).
//
// JUSTIFICATION (charter rule 4 — no bare skips): this drives REAL contracts on the live local
// quickstart container and generates REAL Groth16 proofs + REAL drand tlock decryptions, none of which
// is available in a pure unit-test runner. It is therefore gated on RUN_DEMO_TEST=1 (CI's e2e stage
// sets it after `just net-up`). The gate is documented, not a silent skip. The single test runs the
// loop TWICE to prove repeatability ("the demo never dies").
const run = process.env.RUN_DEMO_TEST === "1" ? describe : describe.skip;

run("demo.sh full sealed loop (local)", () => {
  it(
    "runs green and prints DEMO OK — twice (repeatable)",
    () => {
      const out1 = execFileSync("bash", ["scripts/demo.sh", "--network", "local"], {
        encoding: "utf8",
        timeout: 600_000,
      });
      expect(out1).toMatch(/DEMO OK \(local\)/);

      // Second run proves the demo is repeatable (fresh proposal id, fresh sealed votes, fresh swap).
      const out2 = execFileSync("bash", ["scripts/demo.sh", "--network", "local"], {
        encoding: "utf8",
        timeout: 600_000,
      });
      expect(out2).toMatch(/DEMO OK \(local\)/);
    },
    1_300_000,
  );
});
