import { describe, it, expect } from "vitest";
import { GoogleGenAI } from "@google/genai";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { GeminiPlanner } from "../src/planner.js";
import { LogBus } from "../src/logBus.js";
import { SYSTEM_PROMPT, ACTION_PLAN_SCHEMA, buildUserMessage } from "../src/prompt.js";

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const LIVE = process.env.RUN_LIVE_LLM === "1" && !!API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// JUSTIFIED SKIP (charter rule 4): this test makes a REAL, billable network call to the
// Gemini API and requires a live GEMINI_API_KEY. It is gated behind RUN_LIVE_LLM=1 so CI
// without secrets does not flake/fail. The cassette-backed cap test (geminiPlanner.cap.test.ts)
// runs by default and exercises the same parse+validate path against REAL recorded model bytes;
// this test additionally confirms the live model produces a valid, in-cap plan. Run it with:
// npm run test-llm-live -w @shadowkit/agent  (or: just test-llm-live).
const live = LIVE ? describe : describe.skip;

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

live("GeminiPlanner (LIVE Gemini, gemini-2.5-flash)", () => {
  it("produces a schema-conforming, in-cap ActionPlan from the real model (primary works alone)", async () => {
    // The LogBus is passed so streaming wiring (Task 5) is exercised end-to-end here too, but this
    // test does NOT assert on streamed deltas — that has its own suite (geminiPlanner.stream.test.ts).
    // This test's job is the charter rule 2 guarantee: the PRIMARY planner, calling the REAL model,
    // returns a valid in-cap plan with no fallback involved.
    const bus = new LogBus();
    const planner = new GeminiPlanner({ apiKey: API_KEY!, model: MODEL, logBus: bus });
    const plan = await planner.plan(spec, cap, market);

    expect(plan.amountIn).toMatch(/^[0-9]+$/);
    expect(plan.minOut).toMatch(/^[0-9]+$/);
    expect(typeof plan.reasoning).toBe("string");
    expect(plan.reasoning.length).toBeGreaterThan(0);
    // PRIMARY guarantee on real output: in-cap and respects the floor.
    expect(BigInt(plan.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(plan.amountIn) > 0n).toBe(true);
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
  }, 60_000);

  it("the streamed structured output accumulates to the schema JSON (verbatim, no fences/prose)", async () => {
    // Verifies the load-bearing assumption behind the planner's accumulate-then-JSON.parse path:
    // a streamed structured-output run on the real model yields ONLY the schema JSON across the
    // chunk.text deltas — no markdown fences, no surrounding prose.
    const ai = new GoogleGenAI({ apiKey: API_KEY! });
    const stream = await ai.models.generateContentStream({
      model: MODEL,
      contents: buildUserMessage(spec, cap, market),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: ACTION_PLAN_SCHEMA,
      },
    });
    let text = "";
    for await (const chunk of stream) {
      if (typeof chunk.text === "string") text += chunk.text;
    }
    expect(text.trim().startsWith("{")).toBe(true);
    expect(text.trim().endsWith("}")).toBe(true);
    expect(text).not.toMatch(/```/); // no markdown fences
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual(["amountIn", "minOut", "reasoning"]);
    expect(BigInt(parsed.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(parsed.minOut) >= BigInt(spec.minOut)).toBe(true);
  }, 60_000);

  it("reports usage metadata (token accounting; implicit caching is automatic on gemini-2.5-flash)", async () => {
    // Gemini implicit caching is AUTOMATIC on gemini-2.5-flash (no code/markers needed). We do NOT
    // assert a token threshold (unlike the Anthropic plan). We DO assert the real API reports usage
    // metadata with a non-trivial prompt token count, and that cachedContentTokenCount — when the
    // implicit cache engages — is a numeric field (>= 0). A second identical call MAY report a
    // cache hit, but Gemini implicit caching is best-effort, so we only assert the field exists and
    // is numeric, never that it is > 0.
    const ai = new GoogleGenAI({ apiKey: API_KEY! });
    const args = {
      model: MODEL,
      contents: buildUserMessage(spec, cap, market),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: ACTION_PLAN_SCHEMA,
      },
    };
    const first = await ai.models.generateContent(args);
    const second = await ai.models.generateContent(args);
    const u1 = first.usageMetadata!;
    const u2 = second.usageMetadata!;
    expect(typeof u1.promptTokenCount).toBe("number");
    expect(u1.promptTokenCount).toBeGreaterThan(0);
    // cachedContentTokenCount is optional; when present it must be a non-negative number.
    const cached = u2.cachedContentTokenCount ?? 0;
    expect(typeof cached).toBe("number");
    expect(cached).toBeGreaterThanOrEqual(0);
    // Both calls returned parseable in-cap structured output.
    const p = JSON.parse(second.text!);
    expect(BigInt(p.amountIn) <= BigInt(cap)).toBe(true);
  }, 90_000);
});
