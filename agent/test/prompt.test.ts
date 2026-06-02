import { describe, it, expect } from "vitest";
import { Type } from "@google/genai";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { SYSTEM_PROMPT, ACTION_PLAN_SCHEMA, buildUserMessage } from "../src/prompt.js";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

describe("prompt", () => {
  it("SYSTEM_PROMPT is a non-empty, frozen string (stable system instruction)", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
    // Frozen system instruction MUST NOT interpolate volatile data (no dates/ids).
    // Gemini uses implicit caching (automatic on gemini-2.5-flash); keeping the system
    // instruction byte-stable maximises implicit cache hits and keeps planning deterministic.
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no embedded date
    expect(SYSTEM_PROMPT).not.toMatch(/amountIn=\d|cap of \d|proposalId=\d/i); // no per-request VALUES baked in
  });

  it("SYSTEM_PROMPT states the hard cap rule (prompt-side defense-in-depth)", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("cap");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("must not exceed");
  });

  it("SYSTEM_PROMPT is a complete bounded-execution policy (constraints + worked examples)", () => {
    // A real, complete policy (not a one-liner): it carries the slippage-floor rule, the
    // partial-fill allowance, and worked examples for determinism/quality. We assert the
    // CONTENT is present, NOT any char/token threshold (Gemini implicit caching is automatic).
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("partial fill");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("slippage");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("worked example");
  });

  it("ACTION_PLAN_SCHEMA constrains output to {amountIn, minOut, reasoning} STRING fields (Gemini Type)", () => {
    expect(ACTION_PLAN_SCHEMA.type).toBe(Type.OBJECT);
    expect(ACTION_PLAN_SCHEMA.properties.amountIn.type).toBe(Type.STRING);
    expect(ACTION_PLAN_SCHEMA.properties.minOut.type).toBe(Type.STRING);
    expect(ACTION_PLAN_SCHEMA.properties.reasoning.type).toBe(Type.STRING);
    expect([...ACTION_PLAN_SCHEMA.required].sort()).toEqual(["amountIn", "minOut", "reasoning"]);
  });

  it("ACTION_PLAN_SCHEMA validates a real in-cap plan shape (schema is usable)", () => {
    // Prove the schema describes exactly the ActionPlan fields the planner returns: the three
    // required keys are present and string-typed, so a JSON object with these keys is acceptable.
    const sample = { amountIn: "150000000000", minOut: "1200000000", reasoning: "full cap on buy" };
    for (const k of ACTION_PLAN_SCHEMA.required) {
      expect(k in sample).toBe(true);
      expect(typeof (sample as Record<string, unknown>)[k]).toBe("string");
    }
  });

  it("buildUserMessage embeds the per-request cap, spec, and market (volatile, NOT in the frozen prompt)", () => {
    const msg = buildUserMessage(spec, "150000000000", market);
    expect(msg).toContain("150000000000"); // cap
    expect(msg).toContain(spec.assetIn); // asset in
    expect(msg).toContain(spec.assetOut); // asset out (target)
    expect(msg).toContain("USDC/XLM"); // market pair
    expect(msg).toContain("8.25"); // market price
    expect(msg).toContain("buy"); // signal
  });

  it("buildUserMessage is deterministic for identical inputs", () => {
    expect(buildUserMessage(spec, "150000000000", market)).toBe(
      buildUserMessage(spec, "150000000000", market),
    );
  });
});
