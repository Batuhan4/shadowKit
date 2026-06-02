import { describe, it, expect } from "vitest";
import type { ActionSpec } from "@shadowkit/shared";
import type { ActionPlan } from "../src/planner.js";
import { validatePlan, PlanValidationError } from "../src/planValidation.js";

// USDC and XLM SAC addresses are opaque C-strkeys; fixed test constants.
const USDC = "CUSDC0000000000000000000000000000000000000000000000000000000";
const XLM = "CXLM00000000000000000000000000000000000000000000000000000000";

// cap = 15_000 USDC at 7 decimals = 150_000_000_000 stroops (foundation §5: i128 decimal string).
const CAP = "150000000000";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: USDC,
  assetOut: XLM,
  amount: CAP, // proposal amount equals cap
  minOut: "1000000000",
};

const okPlan: ActionPlan = {
  amountIn: "150000000000", // exactly cap
  minOut: "1200000000",
  reasoning: "Swap full cap; min_out floor from market.",
};

describe("validatePlan", () => {
  it("accepts an in-cap, correctly-targeted, correctly-assetted plan", () => {
    expect(() => validatePlan(okPlan, spec, CAP)).not.toThrow();
  });

  it("accepts a strictly UNDER-cap (partial-fill) plan and returns it unchanged", () => {
    // Partial fills are permitted (SYSTEM_PROMPT rule 5; validatePlan accepts amount < cap).
    // Guards the boundary BELOW cap so an off-by-one (`>=` instead of `>`) would be caught here.
    const halfCap = (BigInt(CAP) / 2n).toString(); // 75000000000, strictly < cap
    const under: ActionPlan = { ...okPlan, amountIn: halfCap };
    expect(() => validatePlan(under, spec, CAP)).not.toThrow();
    expect(validatePlan(under, spec, CAP)).toEqual(under);
    expect(BigInt(validatePlan(under, spec, CAP).amountIn) < BigInt(CAP)).toBe(true);
  });

  it("returns the validated plan unchanged on success", () => {
    expect(validatePlan(okPlan, spec, CAP)).toEqual(okPlan);
  });

  it("rejects an OVER-CAP amountIn (one stroop over)", () => {
    const over = { ...okPlan, amountIn: "150000000001" };
    expect(() => validatePlan(over, spec, CAP)).toThrowError(PlanValidationError);
    try {
      validatePlan(over, spec, CAP);
    } catch (e) {
      expect((e as PlanValidationError).reason).toBe("OVER_CAP");
    }
  });

  it("rejects a huge over-cap amount without precision loss (BigInt, not Number)", () => {
    // 90071992547409910 > Number.MAX_SAFE_INTEGER (9007199254740991);
    // a parseFloat-based guard would round and wrongly pass this.
    const huge = { ...okPlan, amountIn: "90071992547409910" };
    expect(() => validatePlan(huge, spec, CAP)).toThrowError(/OVER_CAP/);
  });

  it("rejects a non-positive amountIn", () => {
    expect(() => validatePlan({ ...okPlan, amountIn: "0" }, spec, CAP)).toThrowError(/NON_POSITIVE/);
    expect(() => validatePlan({ ...okPlan, amountIn: "-5" }, spec, CAP)).toThrowError(/NON_POSITIVE/);
  });

  it("rejects a non-integer / non-numeric amountIn (malformed)", () => {
    expect(() => validatePlan({ ...okPlan, amountIn: "1.5" }, spec, CAP)).toThrowError(/MALFORMED/);
    expect(() => validatePlan({ ...okPlan, amountIn: "abc" }, spec, CAP)).toThrowError(/MALFORMED/);
    expect(() => validatePlan({ ...okPlan, amountIn: "" }, spec, CAP)).toThrowError(/MALFORMED/);
  });

  it("rejects a non-positive or malformed minOut", () => {
    expect(() => validatePlan({ ...okPlan, minOut: "0" }, spec, CAP)).toThrowError(/MIN_OUT/);
    expect(() => validatePlan({ ...okPlan, minOut: "x" }, spec, CAP)).toThrowError(/MIN_OUT/);
  });

  it("rejects a plan whose minOut is BELOW the proposal's minOut floor (slippage too loose)", () => {
    // spec.minOut = 1_000_000_000; a plan offering less protection is invalid.
    const loose = { ...okPlan, minOut: "999999999" };
    expect(() => validatePlan(loose, spec, CAP)).toThrowError(/MIN_OUT_TOO_LOW/);
  });

  it("rejects a wrong-asset spec (assetIn != treasury asset would be caught upstream; here malformed spec asset)", () => {
    const wrongAssetSpec: ActionSpec = { ...spec, assetIn: "" };
    expect(() => validatePlan(okPlan, wrongAssetSpec, CAP)).toThrowError(/WRONG_ASSET/);
  });

  it("rejects a wrong-target spec (assetOut empty/malformed)", () => {
    const wrongTargetSpec: ActionSpec = { ...spec, assetOut: "" };
    expect(() => validatePlan(okPlan, wrongTargetSpec, CAP)).toThrowError(/WRONG_TARGET/);
  });

  it("rejects a non-swap kind", () => {
    // @ts-expect-error deliberately wrong kind to prove runtime guard
    const badKind: ActionSpec = { ...spec, kind: "transfer" };
    expect(() => validatePlan(okPlan, badKind, CAP)).toThrowError(/WRONG_KIND/);
  });

  it("rejects a malformed cap", () => {
    expect(() => validatePlan(okPlan, spec, "not-a-number")).toThrowError(/MALFORMED_CAP/);
    expect(() => validatePlan(okPlan, spec, "0")).toThrowError(/MALFORMED_CAP/);
  });
});
