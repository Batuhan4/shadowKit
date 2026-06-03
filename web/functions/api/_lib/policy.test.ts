import { describe, it, expect } from "vitest";
import type { ActionSpec } from "@shadowkit/shared";
import { gatePlan, type AgentPlan, type PolicyContext } from "./policy";

// A clean, approved swap context. amountIn 8000 <= cap 10000; minOut 7000 >= floor 7000.
const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC",
  assetOut: "CWXLM",
  amount: "10000",
  minOut: "7000",
};
const ctx: PolicyContext = {
  approved: true,
  executed: false,
  cap: "10000",
  spec,
};
const goodPlan: AgentPlan = {
  action: "swap",
  venue: "CAMM",
  amountIn: "8000",
  minOut: "7500",
  reason: "buy signal, partial fill below cap",
};

describe("gatePlan — the AgentPolicy mirror (client-side safeguard)", () => {
  it("ALLOWS a well-formed, in-cap, approved plan", () => {
    const v = gatePlan(goodPlan, ctx);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBeNull();
  });

  it("BLOCKS when the proposal is NOT approved (NotApproved gate)", () => {
    const v = gatePlan(goodPlan, { ...ctx, approved: false });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("NOT_APPROVED");
  });

  it("BLOCKS when the proposal was already executed (AlreadyExecuted gate)", () => {
    const v = gatePlan(goodPlan, { ...ctx, executed: true });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("ALREADY_EXECUTED");
  });

  it("BLOCKS an over-cap amountIn (OverCap gate) — the hallucination case", () => {
    const v = gatePlan({ ...goodPlan, amountIn: "10001" }, ctx);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("OVER_CAP");
  });

  it("BLOCKS a non-positive amountIn", () => {
    const v = gatePlan({ ...goodPlan, amountIn: "0" }, ctx);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("NON_POSITIVE");
  });

  it("BLOCKS a malformed (non-integer) amountIn", () => {
    const v = gatePlan({ ...goodPlan, amountIn: "8000.5" }, ctx);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("MALFORMED");
  });

  it("BLOCKS a minOut below the proposal slippage floor (weaker protection)", () => {
    const v = gatePlan({ ...goodPlan, minOut: "6999" }, ctx);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("MIN_OUT_TOO_LOW");
  });

  it("BLOCKS a non-swap action (hallucinated action kind)", () => {
    const v = gatePlan({ ...goodPlan, action: "transfer" as unknown as "swap" }, ctx);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("WRONG_ACTION");
  });

  it("BLOCKS when the plan venue is not the approved AMM (WrongTarget)", () => {
    const v = gatePlan({ ...goodPlan, venue: "CEVIL" }, { ...ctx, approvedVenue: "CAMM" });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("WRONG_VENUE");
  });

  it("ALLOWS when the plan venue matches the approved AMM", () => {
    const v = gatePlan({ ...goodPlan, venue: "CAMM" }, { ...ctx, approvedVenue: "CAMM" });
    expect(v.allowed).toBe(true);
  });

  it("allows amountIn exactly equal to cap (inclusive boundary)", () => {
    const v = gatePlan({ ...goodPlan, amountIn: "10000" }, ctx);
    expect(v.allowed).toBe(true);
  });
});
