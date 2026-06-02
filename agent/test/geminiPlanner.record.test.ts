import { describe, it, expect } from "vitest";
import { GoogleGenAI } from "@google/genai";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { GeminiPlanner } from "../src/planner.js";
import { SYSTEM_PROMPT, ACTION_PLAN_SCHEMA, buildUserMessage } from "../src/prompt.js";

/**
 * Minimal, dependency-free .env loader. Reads the gitignored repo-root .env so the recorder can
 * pick up GEMINI_API_KEY without printing or committing it. Only sets keys not already in the env
 * (real env wins). The .env is never logged or written into the cassette.
 */
function loadDotEnv() {
  const envPath = new URL("../../.env", import.meta.url);
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const lineRaw of raw.split("\n")) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

/**
 * Cassette RECORDER (not a CI assertion). Makes a REAL, billable streaming call to the live
 * `gemini-3.1-flash-lite` model using the EXACT invocation the GeminiPlanner / live test use, and
 * records the GENUINE response into test/fixtures/gemini-cassette.json (real capturedAt, real model
 * id, real per-chunk textDeltas, verbatim finalText, real usageMetadata). This is what the
 * anti-fabrication guard in geminiPlanner.cap.test.ts verifies against — so the recorder MUST never
 * fabricate: it aborts (fails) unless the live model returns a parseable, in-cap plan.
 *
 * Gated behind RUN_RECORD_CASSETTE=1 (+ a real GEMINI_API_KEY) so the default `vitest run agent`
 * does NOT make a network call. Regenerate with:
 *   RUN_RECORD_CASSETTE=1 npx vitest run agent/test/geminiPlanner.record.test.ts
 * The API key is read from process.env.GEMINI_API_KEY; it is NEVER printed or written.
 */
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const RECORD = process.env.RUN_RECORD_CASSETTE === "1" && !!API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const record = RECORD ? describe : describe.skip;

// SAME inputs the cap test replays the cassette against (so the recorded plan validates in-cap).
const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

record("RECORD gemini-cassette.json (live gemini-3.1-flash-lite)", () => {
  it("records a REAL streamed structured-output capture and writes the cassette", async () => {
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

    const textDeltas: string[] = [];
    let finalText = "";
    let usage: unknown;
    let modelVersion: string | undefined;
    for await (const chunk of stream) {
      if (typeof chunk.text === "string" && chunk.text.length > 0) {
        textDeltas.push(chunk.text);
        finalText += chunk.text;
      }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      if (typeof chunk.modelVersion === "string" && chunk.modelVersion.length > 0) {
        modelVersion = chunk.modelVersion;
      }
    }

    // The recorded capture MUST be a genuine, parseable, in-cap plan — replay it through the real
    // planner (no fabrication: throws if the live model returned anything invalid/over-cap).
    const replayPlanner = new GeminiPlanner({
      apiKey: "unused",
      model: MODEL,
      client: {
        models: {
          generateContentStream: async () => ({
            async *[Symbol.asyncIterator]() {
              for (const d of textDeltas) yield { text: d };
            },
          }),
        },
      },
    });
    const validated = await replayPlanner.plan(spec, cap, market);
    expect(BigInt(validated.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(validated.minOut) >= BigInt(spec.minOut)).toBe(true);
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(usage).toBeTruthy();

    const cassette = {
      capturedAt: new Date().toISOString(),
      model: modelVersion ?? MODEL,
      textDeltas,
      finalText,
      usage,
    };

    const out = new URL("./fixtures/gemini-cassette.json", import.meta.url);
    writeFileSync(out, JSON.stringify(cassette, null, 2) + "\n", "utf8");

    // Key-redacted proof in the test log (never prints the API key or .env).
    // eslint-disable-next-line no-console
    console.log(
      `RECORDED cassette: model=${cassette.model} deltas=${textDeltas.length} ` +
        `finalTextLen=${finalText.length} plan(amountIn=${validated.amountIn},minOut=${validated.minOut}) ` +
        `usage=${JSON.stringify(usage)}`,
    );
  }, 90_000);
});
