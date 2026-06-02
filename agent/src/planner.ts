import { GoogleGenAI } from "@google/genai";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "./dataClient";
import { SYSTEM_PROMPT, ACTION_PLAN_SCHEMA, buildUserMessage } from "./prompt.js";
import { validatePlan } from "./planValidation.js";
import type { LogBus } from "./logBus.js";

// Re-export MarketData so the planner module is the single import surface for plan() types
// (prompt.ts, the planner tests, and AgentRunner all import MarketData from "./planner").
export type { MarketData };

export interface ActionPlan {
  amountIn: string;
  minOut: string;
  reasoning: string;
}

export interface Planner {
  /** Decide amount/min_out (<= cap) given the approved ActionSpec + market data. */
  plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan>;
}

/** Minimal structural shape of the @google/genai client the GeminiPlanner uses
 *  (verified: @google/genai, ctx7 /googleapis/js-genai — `ai.models.generateContentStream({...})`
 *  returns an async iterable of chunks exposing `.text`). Declared here so a fake client can be
 *  injected in tests (network-stubbed, charter §7.2). */
export interface GeminiChunk {
  text?: string;
  usageMetadata?: unknown;
  modelVersion?: string;
}
export interface GeminiLike {
  models: {
    generateContentStream(args: unknown): Promise<AsyncIterable<GeminiChunk>>;
  };
}

export interface GeminiPlannerConfig {
  apiKey: string;
  model: string;
  /** Optional injected client (tests replay a recorded cassette). Default: real GoogleGenAI. */
  client?: GeminiLike;
  /** Optional log sink. In Task 5, each streamed reasoning delta is emitted as
   *  AgentLog{phase:"plan"} through this bus (accepted but unused until Task 5). */
  logBus?: LogBus;
}

/**
 * PRIMARY planner (M3). Calls gemini-3.1-flash-lite via the @google/genai streaming API with:
 *  - a frozen system instruction (prompt.ts) carrying the full bounded-execution policy,
 *  - structured JSON output (config.responseMimeType + config.responseSchema) so the result is
 *    machine-checkable,
 *  - streaming (generateContentStream) so reasoning can be surfaced live (Task 5).
 * Gemini implicit caching is AUTOMATIC on gemini-3.1-flash-lite (no code needed; observed in the live
 * test as cachedContentTokenCount), so there is no Anthropic-style ≥4096-token frozen-prefix
 * engineering — the byte-stable system instruction simply maximises implicit cache hits.
 *
 * The returned plan is re-validated by validatePlan, so GeminiPlanner NEVER returns an
 * over-cap / wrong-target / wrong-asset plan (defense-in-depth; spec §7.2).
 *
 * NOTE (TDD seam): this Task-3 implementation parses + validates the structured output but does
 * NOT yet emit streamed reasoning deltas to the LogBus — that behavior is implemented in Task 5,
 * where its tests fail first (honest RED) before the streaming emission is added. `logBus` is
 * accepted and stored here but intentionally unused until Task 5.
 * SOURCE: @google/genai@2.7.0 (ctx7 /googleapis/js-genai).
 */
export class GeminiPlanner implements Planner {
  private readonly client: GeminiLike;
  private readonly model: string;
  protected readonly logBus?: LogBus; // protected: Task 5 uses it in plan()

  constructor(cfg: GeminiPlannerConfig) {
    this.client = cfg.client ?? (new GoogleGenAI({ apiKey: cfg.apiKey }) as unknown as GeminiLike);
    this.model = cfg.model;
    this.logBus = cfg.logBus;
  }

  async plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan> {
    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: buildUserMessage(spec, cap, market),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: ACTION_PLAN_SCHEMA,
      },
    });

    // Accumulate the structured JSON from the stream chunks. The streamed structured-output run
    // yields the schema JSON across chunk.text deltas; concatenating them reconstructs the verbatim
    // JSON object (verified against the live model in the recorder/live test). Each non-empty delta
    // is also streamed to the terminal as AgentLog{phase:"plan"} via the optional LogBus (empty
    // deltas are dropped so the terminal stays clean).
    let finalText = "";
    for await (const chunk of stream) {
      if (typeof chunk.text === "string") {
        finalText += chunk.text;
        if (this.logBus && chunk.text) {
          this.logBus.emit({ ts: Date.now(), phase: "plan", message: chunk.text });
        }
      }
    }

    let parsed: { amountIn?: unknown; minOut?: unknown; reasoning?: unknown };
    try {
      parsed = JSON.parse(finalText);
    } catch {
      throw new Error(`GeminiPlanner: model output is not valid JSON: ${finalText.slice(0, 80)}`);
    }
    if (
      typeof parsed.amountIn !== "string" ||
      typeof parsed.minOut !== "string" ||
      typeof parsed.reasoning !== "string"
    ) {
      throw new Error("GeminiPlanner: structured output missing required string fields");
    }

    const candidate: ActionPlan = {
      amountIn: parsed.amountIn,
      minOut: parsed.minOut,
      reasoning: parsed.reasoning,
    };
    // The planner re-validates its own output. Throws on any violation (never returns bad plan).
    return validatePlan(candidate, spec, cap);
  }
}

export interface DeterministicPlannerConfig {
  slippageBps?: number; // basis points of slippage tolerance
}

/** Deterministic fallback (M2/M3): amountIn = min(spec.amount, cap); minOut from price - slippage.
 *  No LLM, no network. The cap guard is a HARD min() — never plans amountIn above cap
 *  (foundation §3.5). Price may be an integer ("10") or decimal ("8.25") string; all arithmetic is
 *  BigInt (scaled) to preserve i128 precision (foundation §5) and minOut is clamped to the floor. */
export class DeterministicPlanner implements Planner {
  private slippageBps: number;
  constructor(cfg?: DeterministicPlannerConfig) {
    this.slippageBps = cfg?.slippageBps ?? 50;
  }
  async plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan> {
    const want = BigInt(spec.amount);
    const capN = BigInt(cap);
    const amountIn = want <= capN ? want : capN; // hard cap guard
    // price is a decimal string (e.g. "8.25" output units per input unit) or an integer ("10").
    // Convert with a fixed 6-dp scale to avoid floats, then divide out.
    const SCALE = 1_000_000n;
    const [whole, frac = ""] = market.price.split(".");
    const fracPadded = (frac + "000000").slice(0, 6);
    const priceScaled = BigInt(whole || "0") * SCALE + BigInt(fracPadded || "0"); // price * 1e6
    const gross = (amountIn * priceScaled) / SCALE; // input * price (price-implied output)
    const afterSlippage = (gross * BigInt(10_000 - this.slippageBps)) / 10_000n;
    const floor = BigInt(spec.minOut);
    const minOut = afterSlippage > floor ? afterSlippage : floor; // never below floor
    return {
      amountIn: amountIn.toString(),
      minOut: minOut.toString(),
      reasoning: `deterministic: amountIn=min(amount,cap)=${amountIn}, minOut=${minOut} at ${this.slippageBps}bps slippage from price ${market.price}`,
    };
  }
}
