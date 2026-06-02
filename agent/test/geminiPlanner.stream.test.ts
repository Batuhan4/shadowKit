import { describe, it, expect } from "vitest";
import type { ActionSpec, AgentLog } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { GeminiPlanner } from "../src/planner.js";
import { LogBus } from "../src/logBus.js";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

const DELTAS = ["Considering ", "the buy signal ", "at price 8.25, ", "execute full cap."];
// The accumulated deltas must form the structured JSON the planner parses. We craft DELTAS so the
// reasoning field IS the streamed text, then append the closing structure; but for the stream test
// we only care that each chunk surfaces as a plan log, so we feed a single valid-JSON final chunk
// for parsing and assert the reasoning deltas are emitted.
const FINAL_JSON = JSON.stringify({ amountIn: "150000000000", minOut: "1200000000", reasoning: "ok" });

/**
 * Fake @google/genai client: generateContentStream yields each delta as a chunk. The deltas in
 * order must concatenate to parseable JSON for the planner's final parse; the LAST chunk carries
 * the verbatim JSON so the planner can parse it, while the preceding chunks are reasoning-only
 * deltas surfaced to the terminal. To keep parsing valid AND assert per-delta emission, we yield
 * the reasoning deltas first (which the terminal renders) then a final chunk holding the JSON.
 * We assert ONLY the plan-phase log messages, not the parse result here.
 */
function makeFakeGemini(deltas: string[]) {
  return {
    models: {
      generateContentStream: async () => ({
        async *[Symbol.asyncIterator]() {
          for (const d of deltas) yield { text: d };
        },
      }),
    },
  };
}

describe("GeminiPlanner streaming → AgentBoardTerminal", () => {
  it("emits each streamed delta as AgentLog{phase:'plan'} on the LogBus, in order", async () => {
    const bus = new LogBus();
    const logs: AgentLog[] = [];
    const unsub = bus.subscribe((l) => logs.push(l));

    // Feed the reasoning deltas, then a final chunk that completes a parseable JSON object so the
    // planner's accumulate+parse succeeds. The accumulated text must be valid JSON, so we make the
    // whole stream a single JSON object split across chunks where the chunks ARE the deltas.
    const jsonChunks = chunkJson(FINAL_JSON, DELTAS.length);
    const planner = new GeminiPlanner({
      apiKey: "test",
      model: "gemini-3.1-flash-lite",
      client: makeFakeGemini(jsonChunks),
      logBus: bus,
    });
    await planner.plan(spec, cap, market);
    unsub();

    const planLogs = logs.filter((l) => l.phase === "plan");
    expect(planLogs.length).toBe(jsonChunks.length);
    expect(planLogs.map((l) => l.message)).toEqual(jsonChunks);
    // Each log carries a timestamp (terminal renders chronological reasoning).
    for (const l of planLogs) expect(typeof l.ts).toBe("number");
  });

  it("does NOT throw when no LogBus is provided (streaming is optional)", async () => {
    const planner = new GeminiPlanner({
      apiKey: "test",
      model: "gemini-3.1-flash-lite",
      client: makeFakeGemini(chunkJson(FINAL_JSON, 3)),
      // no logBus
    });
    const plan = await planner.plan(spec, cap, market);
    expect(BigInt(plan.amountIn) <= BigInt(cap)).toBe(true);
  });

  it("does not emit empty deltas (terminal stays clean)", async () => {
    const bus = new LogBus();
    const logs: AgentLog[] = [];
    bus.subscribe((l) => logs.push(l));
    // Inject empty chunks between real JSON chunks; the empty ones must NOT surface as logs.
    const [a, b] = chunkJson(FINAL_JSON, 2);
    const planner = new GeminiPlanner({
      apiKey: "test",
      model: "gemini-3.1-flash-lite",
      client: makeFakeGemini([a!, "", b!, ""]),
      logBus: bus,
    });
    await planner.plan(spec, cap, market);
    expect(logs.filter((l) => l.phase === "plan").map((l) => l.message)).toEqual([a, b]);
  });
});

/** Split a string into n non-empty chunks (for building a streamed JSON object). */
function chunkJson(s: string, n: number): string[] {
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
