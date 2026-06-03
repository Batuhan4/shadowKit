// Worker-side bounded Gemini planner. Ports agent/src/planner.ts to the Pages Function runtime:
// calls gemini-3.1-flash-lite via @google/genai streaming structured-output, returns the full
// machine-checkable plan { action, venue, amountIn, minOut, reason } that the policy gate then judges.
//
// The GEMINI_API_KEY lives ONLY as a Worker secret — it never reaches the browser. The model is
// BOUNDED: it only sizes/prices the single already-approved swap; the policy gate (policy.ts) and the
// on-chain AgentPolicy independently reject anything out of bounds, so a hallucinated plan is blocked,
// never signed. A `GeminiLike` seam lets execute.test.ts inject a recorded cassette (network-stubbed).
import { GoogleGenAI } from "@google/genai";
import type { ActionSpec } from "@shadowkit/shared";
import type { AgentPlan } from "./policy";
import type { MarketQuote } from "./quote";

export interface GeminiChunk {
  text?: string;
}
export interface GeminiLike {
  models: {
    generateContentStream(args: unknown): Promise<AsyncIterable<GeminiChunk>>;
  };
}

export interface PlannerInput {
  spec: ActionSpec;
  cap: string;
  venue: string;
  market: MarketQuote;
}

export interface Planner {
  /** Produce a bounded plan; each streamed reasoning delta is reported via onDelta (live terminal). */
  plan(input: PlannerInput, onDelta?: (text: string) => void): Promise<AgentPlan>;
}

// Frozen system instruction (byte-stable -> maximises Gemini implicit caching, automatic on
// gemini-3.1-flash-lite). All volatile data goes in the user message. Mirrors agent/src/prompt.ts's
// bounded-execution policy, condensed, and adds the `action`/`venue` fields the policy gate checks.
const SYSTEM_PROMPT = [
  "You are ShadowKit's autonomous treasury execution planner for a DAO on Stellar.",
  "The DAO has ALREADY approved exactly one asset swap via an on-chain zero-knowledge vote.",
  "Your only job is to decide HOW to execute that single, already-approved swap. You output:",
  '  - action: always the string "swap" (you may not invent any other action),',
  "  - venue: the exact approved venue id you are given (do not change it),",
  "  - amountIn: a positive integer string in the input asset's smallest unit, <= the cap,",
  "  - minOut: a positive integer string in the output asset's smallest unit, >= the proposal floor,",
  "  - reason: a short honest explanation, grounded in the market data.",
  "HARD CONSTRAINTS (independently enforced; violating them only wastes effort, no swap will happen):",
  "  1. amountIn MUST NOT exceed the cap. Treat the cap as an absolute ceiling.",
  "  2. amountIn MUST be a positive integer string (no decimals, no sci-notation, no separators).",
  "  3. minOut MUST be a positive integer string and at least the proposal's minOut floor.",
  "  4. Stay on the approved swap: do not change the assets, the action, or the venue.",
  "  5. Partial fills are allowed: a weak/hold signal or poor price justifies amountIn below the cap.",
  'Interpret signal: "buy" favors sizing toward (never above) the cap; "sell"/"hold" favor a smaller',
  "partial fill with a prudent minOut derived from the quoted price minus a small slippage margin.",
].join("\n");

const ACTION_PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    action: { type: "STRING" },
    venue: { type: "STRING" },
    amountIn: { type: "STRING" },
    minOut: { type: "STRING" },
    reason: { type: "STRING" },
  },
  required: ["action", "venue", "amountIn", "minOut", "reason"],
  propertyOrdering: ["action", "venue", "amountIn", "minOut", "reason"],
} as const;

function buildUserMessage(input: PlannerInput): string {
  const { spec, cap, venue, market } = input;
  return [
    "Approved swap to execute:",
    `- input asset (assetIn): ${spec.assetIn}`,
    `- output asset (assetOut, the swap target): ${spec.assetOut}`,
    `- approved venue id: ${venue}`,
    `- proposal cap (max amountIn, smallest unit): ${cap}`,
    `- proposal minOut floor (smallest unit): ${spec.minOut}`,
    "",
    "Current market data (paid for over x402):",
    `- pair: ${market.pair}`,
    `- price: ${market.price}`,
    `- signal: ${market.signal}`,
    "",
    'Produce the execution plan now: action="swap", venue=the approved venue id,',
    "amountIn (<= cap), minOut (>= floor), and a brief reason.",
  ].join("\n");
}

export interface GeminiPlannerCfg {
  apiKey: string;
  model: string;
  client?: GeminiLike; // injected in tests (recorded cassette)
}

export class GeminiPlanner implements Planner {
  private client: GeminiLike;
  private model: string;
  constructor(cfg: GeminiPlannerCfg) {
    this.client = cfg.client ?? (new GoogleGenAI({ apiKey: cfg.apiKey }) as unknown as GeminiLike);
    this.model = cfg.model;
  }

  async plan(input: PlannerInput, onDelta?: (text: string) => void): Promise<AgentPlan> {
    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: buildUserMessage(input),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: ACTION_PLAN_SCHEMA,
      },
    });

    let finalText = "";
    for await (const chunk of stream) {
      if (typeof chunk.text === "string" && chunk.text) {
        finalText += chunk.text;
        onDelta?.(chunk.text);
      }
    }

    let parsed: Partial<AgentPlan>;
    try {
      parsed = JSON.parse(finalText) as Partial<AgentPlan>;
    } catch {
      throw new Error(`GeminiPlanner: model output is not valid JSON: ${finalText.slice(0, 80)}`);
    }
    if (
      typeof parsed.action !== "string" ||
      typeof parsed.venue !== "string" ||
      typeof parsed.amountIn !== "string" ||
      typeof parsed.minOut !== "string" ||
      typeof parsed.reason !== "string"
    ) {
      throw new Error("GeminiPlanner: structured output missing required string fields");
    }
    // Return the RAW plan unchanged — the policy gate (not the planner) is the authority that
    // ALLOWS or BLOCKS it, so a hallucinated/over-cap plan is surfaced and then blocked (never silently
    // clamped here). This is what makes the BLOCKED-by-policy demo genuine.
    return {
      action: parsed.action as "swap",
      venue: parsed.venue,
      amountIn: parsed.amountIn,
      minOut: parsed.minOut,
      reason: parsed.reason,
    };
  }
}
