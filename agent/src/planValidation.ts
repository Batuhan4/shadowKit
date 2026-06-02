import type { ActionSpec } from "@shadowkit/shared";
import type { ActionPlan } from "./planner.js";

/** Why a plan was rejected before submit. Mirrors the on-chain PolicyError gates
 *  (foundation §2.3: NotApproved/OverCap/WrongTarget/WrongAsset). Client-side
 *  defense-in-depth so a bad LLM plan never reaches the signer (spec §7.2). */
export type PlanRejectReason =
  | "MALFORMED" // amountIn not a positive integer string
  | "NON_POSITIVE" // amountIn <= 0
  | "OVER_CAP" // amountIn > cap
  | "MIN_OUT" // minOut not a positive integer string
  | "MIN_OUT_TOO_LOW" // minOut < spec.minOut floor (weaker slippage protection)
  | "MALFORMED_CAP" // cap not a positive integer string
  | "WRONG_KIND" // spec.kind != "swap"
  | "WRONG_ASSET" // spec.assetIn missing/empty
  | "WRONG_TARGET"; // spec.assetOut missing/empty

export class PlanValidationError extends Error {
  readonly reason: PlanRejectReason;
  constructor(reason: PlanRejectReason, message: string) {
    super(`${reason}: ${message}`);
    this.name = "PlanValidationError";
    this.reason = reason;
  }
}

/** Parse a decimal i128 string to a positive BigInt, or null if malformed/non-positive.
 *  Uses BigInt (never Number) to preserve i128 precision (foundation §5). */
function parsePositiveI128(s: string): bigint | null {
  if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null; // integer digits only
  let v: bigint;
  try {
    v = BigInt(s);
  } catch {
    return null;
  }
  return v > 0n ? v : null;
}

/**
 * Validate a planner's ActionPlan against the approved ActionSpec and on-chain cap
 * BEFORE the executor signs. Throws PlanValidationError on any violation; returns the
 * (unchanged) plan on success. This is the client-side mirror of AgentPolicy.enforce
 * (foundation §2.3) — both must pass; this one fails fast and cheaply. Provider-agnostic:
 * it guards BOTH the Gemini planner's output and the deterministic fallback's output.
 */
export function validatePlan(plan: ActionPlan, spec: ActionSpec, cap: string): ActionPlan {
  // 1) spec sanity (target/asset/kind) — a wrong spec means we never trust the plan.
  if (spec.kind !== "swap") {
    throw new PlanValidationError("WRONG_KIND", `expected kind "swap", got "${spec.kind}"`);
  }
  if (!spec.assetIn) {
    throw new PlanValidationError("WRONG_ASSET", "spec.assetIn is empty");
  }
  if (!spec.assetOut) {
    throw new PlanValidationError("WRONG_TARGET", "spec.assetOut is empty");
  }

  // 2) cap sanity.
  const capV = parsePositiveI128(cap);
  if (capV === null) {
    throw new PlanValidationError("MALFORMED_CAP", `cap "${cap}" is not a positive integer`);
  }

  // 3) amountIn: integer string, > 0, <= cap (BigInt comparison — no precision loss).
  if (typeof plan.amountIn !== "string" || !/^-?[0-9]+$/.test(plan.amountIn)) {
    throw new PlanValidationError("MALFORMED", `amountIn "${plan.amountIn}" is not an integer string`);
  }
  let amount: bigint;
  try {
    amount = BigInt(plan.amountIn);
  } catch {
    throw new PlanValidationError("MALFORMED", `amountIn "${plan.amountIn}" is not parseable`);
  }
  if (amount <= 0n) {
    throw new PlanValidationError("NON_POSITIVE", `amountIn "${plan.amountIn}" must be > 0`);
  }
  if (amount > capV) {
    throw new PlanValidationError("OVER_CAP", `amountIn ${amount} exceeds cap ${capV}`);
  }

  // 4) minOut: integer string, > 0, and >= the proposal's slippage floor.
  const minOutV = parsePositiveI128(plan.minOut);
  if (minOutV === null) {
    throw new PlanValidationError("MIN_OUT", `minOut "${plan.minOut}" is not a positive integer`);
  }
  const floor = parsePositiveI128(spec.minOut);
  if (floor !== null && minOutV < floor) {
    throw new PlanValidationError(
      "MIN_OUT_TOO_LOW",
      `minOut ${minOutV} is below the proposal floor ${floor}`,
    );
  }

  return plan;
}
