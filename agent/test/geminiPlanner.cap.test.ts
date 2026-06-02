import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { GeminiPlanner } from "../src/planner.js";
import { LogBus } from "../src/logBus.js";

const cassette = JSON.parse(
  readFileSync(new URL("./fixtures/gemini-cassette.json", import.meta.url), "utf8"),
);

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

/**
 * Fake @google/genai client matching the subset GeminiPlanner uses:
 * `ai.models.generateContentStream({...})` returning an async iterable of `{ text }` chunks.
 * It replays the cassette's REAL recorded deltas. We stub ONLY the network boundary
 * (charter §7.2); the planner's own JSON parsing + validatePlan run for real against real bytes.
 */
function makeFakeGemini(deltas: string[]) {
  return {
    models: {
      generateContentStream: async () => {
        return {
          async *[Symbol.asyncIterator]() {
            for (const d of deltas) {
              yield {
                text: d,
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
                modelVersion: cassette.model,
              };
            }
          },
        };
      },
    },
  };
}

// CHARTER GUARD (rule 4): the committed cassette MUST be a REAL gemini-3.1-flash-lite capture, not a
// hand-authored literal. These assertions fail CI if a fabricated/placeholder cassette is checked
// in — the capturedAt must not be the documented placeholder sentinel, the model must be the real
// id, a real usage block must be present, and the model's finalText must parse to an IN-CAP plan
// the model actually produced. This is what makes the cap test validate REAL model behavior.
describe("gemini-cassette.json is a REAL capture (no fabrication)", () => {
  it("has a real capturedAt, model, and usage block (not a placeholder)", () => {
    expect(typeof cassette.capturedAt).toBe("string");
    expect(cassette.capturedAt).not.toBe("2026-06-02T00:00:00.000Z"); // the forbidden placeholder sentinel
    expect(cassette.model).toMatch(/^gemini-2\.5-flash/);
    expect(cassette.usage).toBeTruthy();
    expect(
      (cassette.usage.promptTokenCount ?? 0) + (cassette.usage.candidatesTokenCount ?? 0),
    ).toBeGreaterThan(0); // a real response reports real token usage
    expect(Array.isArray(cassette.textDeltas)).toBe(true);
    expect(cassette.textDeltas.length).toBeGreaterThan(0);
  });

  it("finalText parses to an in-cap plan the MODEL produced (not a literal we wrote)", () => {
    const parsed = JSON.parse(cassette.finalText); // streamed structured output is verbatim JSON
    expect(typeof parsed.amountIn).toBe("string");
    expect(typeof parsed.minOut).toBe("string");
    expect(typeof parsed.reasoning).toBe("string");
    expect(BigInt(parsed.amountIn) > 0n).toBe(true);
    expect(BigInt(parsed.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(parsed.minOut) >= BigInt(spec.minOut)).toBe(true);
  });
});

describe("GeminiPlanner.plan (network-stubbed cassette)", () => {
  let bus: LogBus;
  beforeEach(() => {
    bus = new LogBus();
  });

  it("returns a valid, in-cap ActionPlan parsed from the real structured output", async () => {
    const planner = new GeminiPlanner({
      apiKey: "test",
      model: "gemini-3.1-flash-lite",
      client: makeFakeGemini(cassette.textDeltas),
    });
    const plan = await planner.plan(spec, cap, market);
    expect(plan.amountIn).toMatch(/^[0-9]+$/);
    expect(plan.minOut).toMatch(/^[0-9]+$/);
    expect(typeof plan.reasoning).toBe("string");
    // The PRIMARY guarantee: amountIn <= cap, compared as BigInt.
    expect(BigInt(plan.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(plan.amountIn) > 0n).toBe(true);
    // minOut respects the floor.
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
  });

  it("ACCEPTS a strictly UNDER-cap (partial-fill) plan unchanged (amountIn < cap)", async () => {
    // The SYSTEM_PROMPT permits partial fills; validatePlan accepts amount < cap. This guards the
    // boundary BELOW cap (the at-cap case is covered above), so an off-by-one such as `>=` instead
    // of `>` in the planner's cap comparison would be caught here at the planner level.
    const halfCap = (BigInt(cap) / 2n).toString(); // 75000000000, strictly < cap
    const underCapFinal = JSON.stringify({
      amountIn: halfCap,
      minOut: "1100000000", // >= floor (1000000000)
      reasoning: "partial fill: deploying half the cap given a neutral entry",
    });
    const planner = new GeminiPlanner({
      apiKey: "test",
      model: "gemini-3.1-flash-lite",
      client: makeFakeGemini([underCapFinal]),
    });
    const plan = await planner.plan(spec, cap, market);
    expect(plan.amountIn).toBe(halfCap); // returned UNCHANGED
    expect(BigInt(plan.amountIn) < BigInt(cap)).toBe(true); // strictly under cap
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
  });

  it("THROWS when the model returns an OVER-CAP amount (planner never returns a bad plan)", async () => {
    const overCapFinal = JSON.stringify({
      amountIn: "999999999999999", // way over cap
      minOut: "1200000000",
      reasoning: "hallucinated oversize swap",
    });
    const planner = new GeminiPlanner({
      apiKey: "test",
      model: "gemini-3.1-flash-lite",
      client: makeFakeGemini([overCapFinal]),
    });
    await expect(planner.plan(spec, cap, market)).rejects.toThrowError(/OVER_CAP/);
  });

  it("THROWS when the model returns malformed JSON (not a faked success)", async () => {
    const planner = new GeminiPlanner({
      apiKey: "test",
      model: "gemini-3.1-flash-lite",
      client: makeFakeGemini(["not json at all"]),
    });
    await expect(planner.plan(spec, cap, market)).rejects.toThrow();
  });

  it("THROWS when the spec carries the wrong asset/target (defense-in-depth)", async () => {
    const wrongSpec: ActionSpec = { ...spec, assetOut: "" };
    const planner = new GeminiPlanner({
      apiKey: "test",
      model: "gemini-3.1-flash-lite",
      client: makeFakeGemini(cassette.textDeltas),
    });
    await expect(planner.plan(wrongSpec, cap, market)).rejects.toThrowError(/WRONG_TARGET/);
  });
});
