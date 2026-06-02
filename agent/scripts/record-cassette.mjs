// One-off cassette recorder. Captures a REAL gemini-2.5-flash streamed response so CI can
// replay it deterministically (charter rule 4: real model output, never a hand-faked 200).
// It ALSO verifies, against the live model, the two invariants the cassette/cap path relies on:
//   (1) the streamed structured-output run yields the schema JSON parseable from the accumulated
//       stream text (no markdown fences, no prose) — so the planner's JSON.parse path is sound; and
//   (2) the model's plan is genuinely IN-CAP (amountIn <= cap, > 0; minOut >= floor) — so the
//       committed cassette holds a real, model-produced, valid plan, not a literal we authored.
// If either invariant fails, the recorder EXITS NON-ZERO and writes NOTHING: there is no
// placeholder, and Task 3 stays blocked until a real, conforming capture exists.
// Run: GEMINI_API_KEY=... RUN_LIVE_LLM=1 node agent/scripts/record-cassette.mjs
import { writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPT, ACTION_PLAN_SCHEMA, buildUserMessage } from "../src/prompt.ts";

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is required: the cassette MUST be real model bytes (no placeholder).");
  process.exit(2);
}

const spec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market = { pair: "USDC/XLM", price: "8.25", signal: "buy" };
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const ai = new GoogleGenAI({ apiKey });
const textDeltas = [];
const stream = await ai.models.generateContentStream({
  model,
  contents: buildUserMessage(spec, cap, market),
  config: {
    systemInstruction: SYSTEM_PROMPT,
    responseMimeType: "application/json",
    responseSchema: ACTION_PLAN_SCHEMA,
  },
});
let finalText = "";
let usage;
let modelVersion = model;
for await (const chunk of stream) {
  if (typeof chunk.text === "string" && chunk.text.length > 0) {
    textDeltas.push(chunk.text);
    finalText += chunk.text;
  }
  if (chunk.usageMetadata) usage = chunk.usageMetadata;
  if (chunk.modelVersion) modelVersion = chunk.modelVersion;
}

// INVARIANT (1): the streamed structured output accumulates to verbatim, parseable JSON.
let parsed;
try {
  parsed = JSON.parse(finalText);
} catch {
  console.error("REJECTED: streamed structured output is not verbatim JSON:\n", finalText.slice(0, 200));
  process.exit(3);
}
if (
  typeof parsed.amountIn !== "string" ||
  typeof parsed.minOut !== "string" ||
  typeof parsed.reasoning !== "string"
) {
  console.error("REJECTED: parsed structured output is missing required string fields:", parsed);
  process.exit(4);
}

// INVARIANT (2): the model's plan is a REAL in-cap plan (not a literal we wrote).
const amount = BigInt(parsed.amountIn);
const minOut = BigInt(parsed.minOut);
if (!(amount > 0n && amount <= BigInt(cap) && minOut >= BigInt(spec.minOut))) {
  console.error("REJECTED: model plan is not in-cap/above-floor:", parsed, "cap:", cap, "floor:", spec.minOut);
  process.exit(5);
}

writeFileSync(
  new URL("../test/fixtures/gemini-cassette.json", import.meta.url),
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(), // REAL capture time (asserted non-placeholder in tests)
      model: modelVersion, // REAL model id from the response
      textDeltas, // the real streamed reasoning chunks
      finalText, // the structured JSON the model emitted, verbatim (accumulated)
      usage, // usageMetadata: promptTokenCount/candidatesTokenCount/(cachedContentTokenCount)
    },
    null,
    2,
  ),
);
console.log("wrote cassette with", textDeltas.length, "deltas; plan:", parsed.amountIn, "/", parsed.minOut);
