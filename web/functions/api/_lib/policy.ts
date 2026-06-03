// The client-side mirror of the on-chain AgentPolicy.enforce gate (contracts/agent-policy:
// NotApproved / AlreadyExecuted / WrongTarget / WrongAsset / OverCap). This is THE safeguard surfaced
// to the user: a hallucinated or over-cap plan is BLOCKED here and NO transaction is ever signed.
// The on-chain policy is still the ultimate authority (it runs inside the smart-account __check_auth);
// this fail-fast verdict mirrors it so the AgentBoard can show a green/red decision before submit.
//
// Ported from agent/src/planValidation.ts (BigInt math — never Number — to preserve i128 precision)
// and extended with the approval/executed/venue gates that the worker reads live from GovVault.
import type { ActionSpec } from "@shadowkit/shared";

/** The structured plan Gemini returns (matches the responseSchema in the planner). */
export interface AgentPlan {
  action: "swap";
  venue: string;
  amountIn: string;
  minOut: string;
  reason: string;
}

/** Live on-chain context the worker reads before gating (GovVault + config). */
export interface PolicyContext {
  approved: boolean;
  executed: boolean;
  cap: string;
  spec: ActionSpec;
  /** The single approved swap venue id (from config). When set, the plan venue must match it. */
  approvedVenue?: string;
}

export type PolicyCode =
  | "NOT_APPROVED"
  | "ALREADY_EXECUTED"
  | "WRONG_ACTION"
  | "WRONG_ASSET"
  | "WRONG_TARGET"
  | "WRONG_VENUE"
  | "MALFORMED_CAP"
  | "MALFORMED"
  | "NON_POSITIVE"
  | "OVER_CAP"
  | "MIN_OUT"
  | "MIN_OUT_TOO_LOW";

export interface PolicyVerdict {
  allowed: boolean;
  code: PolicyCode | null;
  reason: string | null;
}

const ALLOW: PolicyVerdict = { allowed: true, code: null, reason: null };
const block = (code: PolicyCode, reason: string): PolicyVerdict => ({ allowed: false, code, reason });

/** Parse a decimal i128 string to a positive BigInt, or null if malformed/non-positive. */
function parsePositiveI128(s: string): bigint | null {
  if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null;
  let v: bigint;
  try {
    v = BigInt(s);
  } catch {
    return null;
  }
  return v > 0n ? v : null;
}

/**
 * Gate a planner's AgentPlan against the live on-chain context. Returns a verdict (never throws).
 * Order mirrors the on-chain enforce gates so the surfaced reason matches what the chain would reject.
 */
export function gatePlan(plan: AgentPlan, ctx: PolicyContext): PolicyVerdict {
  // Gate 1 — NotApproved: the DAO must have approved this proposal on-chain.
  if (!ctx.approved) {
    return block("NOT_APPROVED", "proposal is not Approved on-chain");
  }
  // Gate 2 — AlreadyExecuted: single-shot replay guard.
  if (ctx.executed) {
    return block("ALREADY_EXECUTED", "proposal has already been executed");
  }
  // Gate 3 — the plan must be the approved action kind (no hallucinated action).
  if (plan.action !== "swap") {
    return block("WRONG_ACTION", `plan action "${plan.action}" is not the approved "swap"`);
  }
  // Gate 4 — assets: stay on the approved swap.
  if (!ctx.spec.assetIn) return block("WRONG_ASSET", "approved spec.assetIn is empty");
  if (!ctx.spec.assetOut) return block("WRONG_TARGET", "approved spec.assetOut is empty");
  // Gate 5 — venue: must be the single approved AMM (when the worker supplies it).
  if (ctx.approvedVenue && plan.venue !== ctx.approvedVenue) {
    return block(
      "WRONG_VENUE",
      `plan venue "${plan.venue}" is not the approved venue "${ctx.approvedVenue}"`,
    );
  }
  // Gate 6 — cap sanity.
  const capV = parsePositiveI128(ctx.cap);
  if (capV === null) return block("MALFORMED_CAP", `cap "${ctx.cap}" is not a positive integer`);

  // Gate 7 — amountIn: integer string, > 0, <= cap (BigInt — no precision loss).
  if (typeof plan.amountIn !== "string" || !/^-?[0-9]+$/.test(plan.amountIn)) {
    return block("MALFORMED", `amountIn "${plan.amountIn}" is not an integer string`);
  }
  let amount: bigint;
  try {
    amount = BigInt(plan.amountIn);
  } catch {
    return block("MALFORMED", `amountIn "${plan.amountIn}" is not parseable`);
  }
  if (amount <= 0n) return block("NON_POSITIVE", `amountIn "${plan.amountIn}" must be > 0`);
  if (amount > capV) return block("OVER_CAP", `amountIn ${amount} exceeds cap ${capV}`);

  // Gate 8 — minOut: integer string, > 0, and >= the proposal's slippage floor.
  const minOutV = parsePositiveI128(plan.minOut);
  if (minOutV === null) return block("MIN_OUT", `minOut "${plan.minOut}" is not a positive integer`);
  const floor = parsePositiveI128(ctx.spec.minOut);
  if (floor !== null && minOutV < floor) {
    return block("MIN_OUT_TOO_LOW", `minOut ${minOutV} is below the proposal floor ${floor}`);
  }

  return ALLOW;
}
