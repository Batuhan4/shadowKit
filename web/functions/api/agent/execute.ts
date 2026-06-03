// POST /api/agent/execute — the LIVE AI-AGENT loop, streamed as Server-Sent Events.
//
// This is the Hack-Agentic showcase. The agent loop runs SERVER-SIDE in this Cloudflare Pages Function
// (nodejs_compat) so the Gemini key and the executor signing key NEVER reach the browser. Steps, each
// emitted as an SSE log line:
//   1) read GovVault: is the demo proposal APPROVED?  (if not -> 403 + clear message, NO tx)
//   2) x402-pay the premium-data endpoint and fetch the market quote  (if unpaid -> 402, NO plan)
//   3) Gemini bounded PLAN -> structured { action, venue, amountIn, minOut, reason }
//   4) POLICY GATE the plan (reject hallucinated/over-cap -> "BLOCKED by policy", NO tx)
//   5) submit the swap on-chain signed by EXECUTOR_SECRET -> real tx hash + explorer link + balances
//   6) final { done: true } event.
//
// runAgentLoop() is the pure, injectable core (network boundary behind AgentLoopDeps) so it is
// unit-tested with HAPPY + the three NEGATIVES (not approved / over-cap plan / 402) WITHOUT mocking the
// policy or the loop. onRequestPost() wires the REAL deps and streams the events as SSE.
import type { ActionSpec } from "@shadowkit/shared";
import { gatePlan, type AgentPlan, type PolicyVerdict } from "../_lib/policy";
import { quoteFor, type MarketQuote } from "../_lib/quote";
import { makeSseStream, SSE_HEADERS } from "../_lib/sse";
import {
  StellarGovReader,
  StellarExecutor,
  type GovReader,
  type Executor,
  type ProposalRead,
  type TreasuryBalances,
} from "../_lib/stellar";
import { GeminiPlanner, type Planner } from "../_lib/gemini";
import { makePayAndQuote } from "../_lib/x402pay";
import { CONFIG, explorerTx } from "../../../src/lib/config";
import {
  type WorkerEnv,
  demoProposalId,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_PAIR,
} from "../_lib/env";

// ---- The injectable seams (network boundary only) ---------------------------------------------
export interface PayQuoteResult {
  paid: boolean;
  txRef?: string;
  quote: MarketQuote | null;
  error?: string;
}
export interface AgentLoopDeps {
  govReader: { readProposal(id: number): Promise<ProposalRead> };
  payAndQuote: (pair: string) => Promise<PayQuoteResult>;
  planner: {
    plan(
      input: { spec: ActionSpec; cap: string; venue: string; market: MarketQuote },
      onDelta?: (t: string) => void,
    ): Promise<AgentPlan>;
  };
  executor: {
    treasuryBalances(spec: ActionSpec): Promise<TreasuryBalances>;
    submitSwap(args: {
      assetIn: string;
      amountIn: string;
      minOut: string;
    }): Promise<{ txHash: string }>;
    markExecuted(id: number): Promise<{ txHash: string }>;
  };
  approvedVenue?: string;
  pair?: string;
  /** When true, an unsettled x402 payment HARD-STOPS the loop (402, no plan, no tx) — the strict
   *  "agent must pay for its data" policy. When false (demo default), the loop logs the honest reason
   *  and continues with a public market quote so the agentic CORE (plan → policy → on-chain swap)
   *  stays fully live even when the public facilitator can't settle the configured (test) asset. */
  x402Required?: boolean;
}

export type LoopPhase =
  | "watch"
  | "data"
  | "plan"
  | "policy"
  | "submit"
  | "balances"
  | "done"
  | "error";

export interface AgentEvent {
  phase: LoopPhase;
  message: string;
  txHash?: string;
  explorer?: string;
  allowed?: boolean; // on phase "policy"
  plan?: AgentPlan; // on phase "plan"
  quote?: MarketQuote; // on phase "data"
  balancesBefore?: TreasuryBalances;
  balancesAfter?: TreasuryBalances;
  done?: boolean; // on phase "done"
}

export type LoopStatus =
  | "ok"
  | "not_approved"
  | "payment_required"
  | "blocked"
  | "error";

export interface LoopResult {
  status: LoopStatus;
  httpStatus: number;
  txHash?: string;
  explorer?: string;
  verdict?: PolicyVerdict;
  plan?: AgentPlan;
  balancesBefore?: TreasuryBalances;
  balancesAfter?: TreasuryBalances;
}

/**
 * The agent loop core. Pure orchestration over the injected deps; emits an AgentEvent per step and
 * returns a typed LoopResult. The policy gate and control-flow are REAL (never mocked in tests).
 * Never throws — failures are surfaced as an "error" event + an error LoopResult.
 */
export async function runAgentLoop(
  deps: AgentLoopDeps,
  params: { proposalId: number },
  emit: (e: AgentEvent) => void,
): Promise<LoopResult> {
  const pair = deps.pair ?? DEFAULT_PAIR;
  try {
    // 1) GovVault: is the proposal APPROVED?
    emit({ phase: "watch", message: `reading GovVault for proposal #${params.proposalId}…` });
    const prop = await deps.govReader.readProposal(params.proposalId);
    if (!prop.approved) {
      emit({
        phase: "error",
        message: `proposal #${params.proposalId} is NOT approved on-chain — refusing to execute`,
      });
      return { status: "not_approved", httpStatus: 403 };
    }
    if (prop.executed) {
      emit({
        phase: "error",
        message: `proposal #${params.proposalId} has already been executed (single-shot) — refusing`,
      });
      return { status: "blocked", httpStatus: 409 };
    }
    emit({
      phase: "watch",
      message: `proposal #${params.proposalId} is APPROVED · cap=${prop.cap} · ${prop.spec.assetIn} → ${prop.spec.assetOut}`,
    });

    // Read the treasury balances BEFORE the swap (so we can show the delta).
    let balancesBefore: TreasuryBalances | undefined;
    try {
      balancesBefore = await deps.executor.treasuryBalances(prop.spec);
      emit({
        phase: "balances",
        message: `treasury before · in=${balancesBefore.assetIn} out=${balancesBefore.assetOut}`,
        balancesBefore,
      });
    } catch {
      /* balances are display-only; never block the loop on a read */
    }

    // 2) x402-pay the premium-data endpoint and fetch the quote.
    emit({ phase: "data", message: `paying premium-data over x402 for ${pair}…` });
    const pay = await deps.payAndQuote(pair);
    let quote: MarketQuote;
    if (pay.paid && pay.quote) {
      quote = pay.quote;
      emit({
        phase: "data",
        message: `x402 paid${pay.txRef ? ` (settle ${pay.txRef})` : ""} · quote ${quote.pair} price=${quote.price} signal=${quote.signal}`,
        quote,
      });
    } else if (deps.x402Required) {
      emit({
        phase: "error",
        message: `x402 payment required — ${pay.error ?? "settlement did not complete"}`,
      });
      return { status: "payment_required", httpStatus: 402 };
    } else {
      // The x402 round-trip ran for real (402 challenge → client payment → facilitator verify), but the
      // public facilitator (OZ Channels) could not settle the configured asset — e.g. our self-issued
      // test USDC returns "unsupported_asset" (OZ settles Circle USDC). Keep the agentic CORE live:
      // continue with a deterministic public market quote. Fund the x402 client with a
      // facilitator-supported asset (Circle testnet USDC) to settle x402 end-to-end.
      quote = quoteFor(pair);
      emit({
        phase: "data",
        message: `x402 not settled (${pay.error ?? "settlement unavailable"}) — continuing with public market quote · ${quote.pair} price=${quote.price} signal=${quote.signal}`,
        quote,
      });
    }

    // 3) Gemini bounded plan (structured output).
    emit({ phase: "plan", message: "Gemini planning the bounded swap…" });
    const venue = deps.approvedVenue ?? "";
    const plan = await deps.planner.plan(
      { spec: prop.spec, cap: prop.cap, venue, market: quote },
      (delta) => emit({ phase: "plan", message: delta }),
    );
    emit({
      phase: "plan",
      message: `PLAN · amountIn=${plan.amountIn} minOut=${plan.minOut} · ${plan.reason}`,
      plan,
    });

    // 4) POLICY GATE — the safeguard. A hallucinated/over-cap plan is BLOCKED; NO tx.
    const verdict = gatePlan(plan, {
      approved: prop.approved,
      executed: prop.executed,
      cap: prop.cap,
      spec: prop.spec,
      approvedVenue: deps.approvedVenue,
    });
    if (!verdict.allowed) {
      emit({
        phase: "policy",
        message: `BLOCKED by policy: ${verdict.code} — ${verdict.reason}`,
        allowed: false,
      });
      return { status: "blocked", httpStatus: 200, verdict, plan };
    }
    emit({ phase: "policy", message: "policy ALLOWED — plan is within bounds", allowed: true });

    // 5) Submit the swap on-chain (signed server-side by EXECUTOR_SECRET).
    emit({ phase: "submit", message: "submitting swap on-chain…" });
    const sub = await deps.executor.submitSwap({
      assetIn: prop.spec.assetIn,
      amountIn: plan.amountIn,
      minOut: plan.minOut,
    });
    const explorer = sub.txHash ? explorerTx(sub.txHash) : undefined;
    emit({
      phase: "submit",
      message: `swap submitted · tx ${sub.txHash}`,
      txHash: sub.txHash,
      explorer,
    });

    // Mark the proposal Executed on-chain (single-shot consume; satisfies the 409-already-executed
    // guard on re-runs). Non-fatal: the swap already moved funds, so a mark_executed hiccup must NOT
    // fail the run — surface it and continue to the balances/done summary.
    try {
      const marked = await deps.executor.markExecuted(params.proposalId);
      emit({
        phase: "submit",
        message: `proposal #${params.proposalId} marked Executed${marked.txHash ? ` · tx ${marked.txHash}` : ""}`,
        txHash: marked.txHash || undefined,
      });
    } catch (e) {
      emit({
        phase: "submit",
        message: `note: mark_executed did not complete (${(e as Error).message}) — swap already settled on-chain`,
      });
    }

    // Read balances AFTER for the before/after delta.
    let balancesAfter: TreasuryBalances | undefined;
    try {
      balancesAfter = await deps.executor.treasuryBalances(prop.spec);
      emit({
        phase: "balances",
        message: `treasury after · in=${balancesAfter.assetIn} out=${balancesAfter.assetOut}`,
        balancesAfter,
      });
    } catch {
      /* display-only */
    }

    emit({
      phase: "done",
      message: "execution complete",
      txHash: sub.txHash,
      explorer,
      balancesBefore,
      balancesAfter,
      done: true,
    });
    return {
      status: "ok",
      httpStatus: 200,
      txHash: sub.txHash,
      explorer,
      verdict,
      plan,
      balancesBefore,
      balancesAfter,
    };
  } catch (err) {
    emit({ phase: "error", message: (err as Error).message });
    return { status: "error", httpStatus: 500 };
  }
}

// ---- The real Pages Function: wire real deps + stream SSE --------------------------------------
interface PagesContext {
  request: Request;
  env: WorkerEnv;
  waitUntil?: (p: Promise<unknown>) => void;
}

/** Build the REAL deps from config + Worker secrets. */
function realDeps(env: WorkerEnv, origin: string): AgentLoopDeps {
  const chainCfg = {
    rpcUrl: CONFIG.rpcUrl,
    networkPassphrase: CONFIG.networkPassphrase,
    govVaultId: CONFIG.govVaultId,
    swapVenueId: CONFIG.ammId,
    treasuryAddr: CONFIG.treasuryAddr,
    usdcId: CONFIG.usdcId,
    wxlmId: CONFIG.wxlmId,
  };
  const govReader: GovReader = new StellarGovReader(chainCfg);
  const executor: Executor = new StellarExecutor(chainCfg, env.EXECUTOR_SECRET ?? "");
  const premiumDataUrl = env.PREMIUM_DATA_URL ?? `${origin}/api/premium-data`;
  const payAndQuote = makePayAndQuote({
    premiumDataUrl,
    clientSecret: env.CLIENT_SECRET,
    network: env.X402_NETWORK ?? "stellar:testnet",
  });
  const planner: Planner = new GeminiPlanner({
    apiKey: env.GEMINI_API_KEY ?? "",
    model: env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
  });
  return {
    govReader,
    payAndQuote,
    planner,
    executor,
    approvedVenue: CONFIG.ammId,
    pair: env.USDC_PAIR ?? DEFAULT_PAIR,
    x402Required: env.X402_REQUIRED === "true",
  };
}

export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  const env = context.env ?? {};
  // Missing the executor secret means we cannot run a genuinely-live swap — fail clearly (no fallback).
  if (!env.EXECUTOR_SECRET) {
    return new Response(
      JSON.stringify({ error: "server not configured: EXECUTOR_SECRET secret is missing" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  const origin = new URL(context.request.url).origin;
  const proposalId = demoProposalId(env);
  const deps = realDeps(env, origin);

  const { stream, emit, close } = makeSseStream();
  // Drive the loop in the background; stream events as they happen.
  const work = (async () => {
    try {
      await runAgentLoop(deps, { proposalId }, (e) => emit(e));
    } catch (e) {
      emit({ phase: "error", message: (e as Error).message });
    } finally {
      close();
    }
  })();
  context.waitUntil?.(work);

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
};

// Lightweight preflight for the browser island.
export const onRequestOptions = async (): Promise<Response> =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
