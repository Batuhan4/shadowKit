import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "./dataClient";

export interface ActionPlan {
  amountIn: string;
  minOut: string;
  reasoning: string;
}

export interface Planner {
  /** Decide amount/min_out (<= cap) given the approved ActionSpec + market data. */
  plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan>;
}

/** Deterministic fallback (M2 default): amountIn = min(spec.amount, cap); minOut from price - slippage.
 *  No LLM. The cap guard is a HARD min() — never plans amountIn above cap (foundation §3.5). */
export class DeterministicPlanner implements Planner {
  private slippageBps: number;
  constructor(cfg?: { slippageBps?: number }) {
    this.slippageBps = cfg?.slippageBps ?? 50;
  }
  async plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan> {
    const want = BigInt(spec.amount);
    const capN = BigInt(cap);
    const amountIn = want <= capN ? want : capN; // hard cap guard
    const price = BigInt(market.price);
    const gross = amountIn * price;
    const minOut = (gross * BigInt(10_000 - this.slippageBps)) / 10_000n;
    return {
      amountIn: amountIn.toString(),
      minOut: minOut.toString(),
      reasoning: `deterministic: amountIn=min(amount,cap)=${amountIn}, minOut=price-${this.slippageBps}bps`,
    };
  }
}

/** Claude-backed planner — implemented in M3. M2 placeholder throws so it is never silently used. */
export class ClaudePlanner implements Planner {
  constructor(_cfg: { apiKey: string; model: string }) {}
  async plan(): Promise<ActionPlan> {
    throw new Error("ClaudePlanner is implemented in M3; M2 uses DeterministicPlanner");
  }
}
