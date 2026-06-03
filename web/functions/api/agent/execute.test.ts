import { describe, it, expect, vi } from "vitest";
import type { ActionSpec } from "@shadowkit/shared";
import { runAgentLoop, type AgentLoopDeps, type AgentEvent } from "./execute";

// ---------------------------------------------------------------------------
// These tests exercise the REAL orchestration + REAL policy gate (the unit under
// test). Only the NETWORK BOUNDARY is faked via the injectable AgentLoopDeps seam:
//   - govReader  (the on-chain GovVault read)
//   - payAndQuote (the x402 paid premium-data fetch)
//   - planner    (the Gemini structured-output call)
//   - executor   (the on-chain swap submit + balances)
// The policy gate, the cap guard, and the loop control-flow are NEVER mocked.
// ---------------------------------------------------------------------------

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC",
  assetOut: "CWXLM",
  amount: "10000",
  minOut: "7000",
};

function baseDeps(over: Partial<AgentLoopDeps> = {}): AgentLoopDeps {
  return {
    govReader: {
      readProposal: vi.fn(async () => ({
        approved: true,
        executed: false,
        cap: "10000",
        spec,
      })),
    },
    payAndQuote: vi.fn(async () => ({
      paid: true,
      txRef: "x402-settle-abc",
      quote: { pair: "USDC-XLM", price: "0.1", signal: "buy" as const },
    })),
    planner: {
      plan: vi.fn(async () => ({
        action: "swap" as const,
        venue: "CAMM",
        amountIn: "8000",
        minOut: "7500",
        reason: "buy signal, partial fill under cap",
      })),
    },
    executor: {
      treasuryBalances: vi.fn(async () => ({ assetIn: "100000", assetOut: "0" })),
      submitSwap: vi.fn(async () => ({ txHash: "TXHASH123" })),
    },
    approvedVenue: "CAMM",
    ...over,
  };
}

async function collect(
  deps: AgentLoopDeps,
): Promise<{ events: AgentEvent[]; result: Awaited<ReturnType<typeof runAgentLoop>> }> {
  const events: AgentEvent[] = [];
  const result = await runAgentLoop(deps, { proposalId: 0 }, (e) => events.push(e));
  return { events, result };
}

describe("runAgentLoop — HAPPY path (fully live shape)", () => {
  it("reads proposal → pays x402 → plans → gates ALLOW → submits swap → done", async () => {
    const deps = baseDeps();
    const { events, result } = await collect(deps);

    const phases = events.map((e) => e.phase);
    expect(phases).toContain("watch");
    expect(phases).toContain("data");
    expect(phases).toContain("plan");
    expect(phases).toContain("policy");
    expect(phases).toContain("submit");
    expect(phases.at(-1)).toBe("done");

    // x402 was actually paid before the quote was used
    expect(deps.payAndQuote).toHaveBeenCalledOnce();
    // policy verdict allowed
    const verdict = events.find((e) => e.phase === "policy");
    expect(verdict?.allowed).toBe(true);
    // real tx hash + explorer link surfaced on the submit event that carries it
    const submit = events.find((e) => e.phase === "submit" && e.txHash);
    expect(submit?.txHash).toBe("TXHASH123");
    expect(submit?.explorer).toContain("TXHASH123");
    // final result carries the hash and before/after balances
    expect(result.status).toBe("ok");
    expect(result.txHash).toBe("TXHASH123");
    expect(result.balancesBefore).toBeDefined();
    expect(result.balancesAfter).toBeDefined();
    expect(deps.executor.submitSwap).toHaveBeenCalledOnce();
  });
});

describe("runAgentLoop — NEGATIVE: proposal NOT approved → 403, NO tx", () => {
  it("emits an error verdict, never calls planner/executor, status=not_approved (403)", async () => {
    const deps = baseDeps({
      govReader: {
        readProposal: vi.fn(async () => ({ approved: false, executed: false, cap: "10000", spec })),
      },
    });
    const { events, result } = await collect(deps);

    expect(result.status).toBe("not_approved");
    expect(result.httpStatus).toBe(403);
    expect(result.txHash).toBeUndefined();
    // hard stop BEFORE planning or paying — no Gemini call, no swap
    expect(deps.planner.plan).not.toHaveBeenCalled();
    expect(deps.executor.submitSwap).not.toHaveBeenCalled();
    // a clear blocked/error event is surfaced
    expect(events.some((e) => e.phase === "error")).toBe(true);
  });
});

describe("runAgentLoop — NEGATIVE: Gemini plan violates policy → BLOCKED, zero tx", () => {
  it("plan exceeds cap → policy verdict BLOCKED, executor never called", async () => {
    const deps = baseDeps({
      planner: {
        plan: vi.fn(async () => ({
          action: "swap" as const,
          venue: "CAMM",
          amountIn: "999999999", // hallucinated, way over the 10000 cap
          minOut: "7500",
          reason: "I will spend the whole treasury",
        })),
      },
    });
    const { events, result } = await collect(deps);

    const verdict = events.find((e) => e.phase === "policy");
    expect(verdict?.allowed).toBe(false);
    expect(verdict?.message).toMatch(/BLOCKED/i);
    expect(result.status).toBe("blocked");
    expect(result.txHash).toBeUndefined();
    // THE safeguard: a hallucinating agent produced a plan but NO swap was submitted
    expect(deps.executor.submitSwap).not.toHaveBeenCalled();
  });
});

describe("runAgentLoop — NEGATIVE: x402 payment missing → 402, NO plan, NO tx", () => {
  it("payAndQuote reports unpaid → status=payment_required (402), stops before planning", async () => {
    const deps = baseDeps({
      payAndQuote: vi.fn(async () => ({ paid: false, quote: null })),
    });
    const { events, result } = await collect(deps);

    expect(result.status).toBe("payment_required");
    expect(result.httpStatus).toBe(402);
    expect(deps.planner.plan).not.toHaveBeenCalled();
    expect(deps.executor.submitSwap).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === "error")).toBe(true);
  });
});

describe("runAgentLoop — robustness", () => {
  it("surfaces an executor failure as an error result without throwing", async () => {
    const deps = baseDeps({
      executor: {
        treasuryBalances: vi.fn(async () => ({ assetIn: "100000", assetOut: "0" })),
        submitSwap: vi.fn(async () => {
          throw new Error("rpc submit failed");
        }),
      },
    });
    const { result, events } = await collect(deps);
    expect(result.status).toBe("error");
    expect(events.some((e) => e.phase === "error")).toBe(true);
  });
});
