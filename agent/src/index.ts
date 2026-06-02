import type { AgentLog, ActionSpec } from "@shadowkit/shared";
import { LogBus } from "./logBus";
import { DeterministicPlanner, GeminiPlanner, type Planner, type ActionPlan } from "./planner";
import { DataClient, type MarketData } from "./dataClient";
import { Watcher } from "./watcher";
import { Executor } from "./executor";
import { contract } from "@stellar/stellar-sdk";

export interface AgentConfig {
  rpcUrl: string;
  networkPassphrase: string;
  govVaultId: string;
  agentPolicyId: string;
  swapVenueId: string;
  sessionSecretKey: string;
  premiumDataUrl: string;
  geminiApiKey: string;
  useDeterministicPlanner: boolean;
}

/** Resolve the planner model: env override wins, else gemini-2.5-flash (foundation §6, configurable). */
function resolveModel(): string {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

/** TS read-adapter over the GovVault binding (foundation §3.5 GovReader). Invents no contract method —
 *  wraps the existing on-chain cap_of/action_of entrypoints (§2.2). */
export interface GovReader {
  capOf(proposalId: number): Promise<string>;
  actionOf(proposalId: number): Promise<ActionSpec>;
}

/** Collaborator seam — MUST match §foundation §3.5 AgentDeps exactly. REAL by default; faked in tests. */
export interface AgentDeps {
  watcher: { waitForApproved(proposalId: number, pollMs?: number): Promise<void> };
  dataClient: { fetchMarket(pair: string): Promise<MarketData> };
  govReader: GovReader;
  executor: {
    executeSwap(plan: ActionPlan, spec: ActionSpec, cap: string, proposalId: number): Promise<{ txHash: string }>;
  };
  makeClaudePlanner(logBus: LogBus): Planner;
  makeDeterministicPlanner(): Planner;
}

export class AgentRunner {
  private bus = new LogBus();
  private deps: AgentDeps;
  constructor(private cfg: AgentConfig, deps?: AgentDeps) {
    this.deps = deps ?? this.realDeps();
  }

  /** Default deps wire the REAL modules (Watcher, Executor+StellarChainGateway, DataClient, GovReader). */
  private realDeps(): AgentDeps {
    const watcher = new Watcher({
      rpcUrl: this.cfg.rpcUrl,
      govVaultId: this.cfg.govVaultId,
      networkPassphrase: this.cfg.networkPassphrase,
    });
    const executor = new Executor({ ...this.cfg }); // default StellarChainGateway inside
    const dataClient = new DataClient({
      url: this.cfg.premiumDataUrl,
      signerSecret: this.cfg.sessionSecretKey,
      network: this.cfg.networkPassphrase,
    });
    const readProposal = async (id: number) => {
      const c = await contract.Client.from({
        contractId: this.cfg.govVaultId,
        networkPassphrase: this.cfg.networkPassphrase,
        rpcUrl: this.cfg.rpcUrl,
        allowHttp: this.cfg.rpcUrl.startsWith("http://"),
      });
      const tx = await (
        c as unknown as {
          proposal: (a: { id: number }) => Promise<{ result: unknown }>;
        }
      ).proposal({ id });
      // Live `proposal` returns Result<ProposalView> (Ok wrapper w/ .unwrap()); the transport tests
      // return the ProposalView directly. Tolerate both (matches watcher.normalizeStatus rationale).
      const r = tx.result as { unwrap?: () => unknown } | undefined;
      return (
        r && typeof r.unwrap === "function" ? r.unwrap() : r
      ) as { action_spec: unknown; cap: bigint };
    };
    const toTsSpec = (raw: unknown): ActionSpec => {
      const s = raw as { asset_in: string; asset_out: string; amount: bigint; min_out: bigint };
      return {
        kind: "swap",
        assetIn: s.asset_in,
        assetOut: s.asset_out,
        amount: s.amount.toString(),
        minOut: s.min_out.toString(),
      };
    };
    const govReader: GovReader = {
      capOf: async (id) => (await readProposal(id)).cap.toString(),
      actionOf: async (id) => toTsSpec((await readProposal(id)).action_spec),
    };
    return {
      watcher: { waitForApproved: (id, pollMs) => watcher.waitForApproved(id, pollMs) },
      dataClient: { fetchMarket: (pair) => dataClient.fetchMarket(pair) },
      govReader,
      executor: { executeSwap: (plan, spec, cap, id) => executor.executeSwap(plan, spec, cap, id) },
      makeClaudePlanner: (logBus) =>
        new GeminiPlanner({ apiKey: this.cfg.geminiApiKey, model: resolveModel(), logBus }),
      makeDeterministicPlanner: () => new DeterministicPlanner(),
    };
  }

  /** M2 loop: watch -> data -> plan -> sign -> submit -> done. (reveal is M5 — recorded divergence
   *  from §foundation §3.5; plaintext close in M1/M2 has no decrypt step, so no `reveal` phase.) */
  async run(proposalId: number, onLog: (l: AgentLog) => void): Promise<{ txHash: string }> {
    const off = this.bus.subscribe(onLog);
    const log = (phase: AgentLog["phase"], message: string, txHash?: string) =>
      this.bus.emit({ ts: Date.now(), phase, message, ...(txHash ? { txHash } : {}) });
    try {
      await this.deps.watcher.waitForApproved(proposalId);
      log("data", "fetching market data");
      const market = await this.deps.dataClient.fetchMarket("USDC/XLM");
      const actionSpec = await this.deps.govReader.actionOf(proposalId);
      const cap = await this.deps.govReader.capOf(proposalId);
      const plan = await this.selectAndPlan(actionSpec, cap, market, log);
      if (BigInt(plan.amountIn) > BigInt(cap)) throw new Error(`cap guard: ${plan.amountIn} > ${cap}`);
      log("sign", `signing swap amountIn=${plan.amountIn} minOut=${plan.minOut}`);
      // Executor handles idempotency (isExecuted short-circuit) + client cap guard + submit + mark.
      const sub = await this.deps.executor.executeSwap(plan, actionSpec, cap, proposalId);
      log("submit", "swap submitted", sub.txHash);
      log("done", "execution complete", sub.txHash);
      return { txHash: sub.txHash };
    } catch (err) {
      log("error", (err as Error).message);
      throw err;
    } finally {
      off();
    }
  }

  /** Planner selection + AUTO-FALLBACK. Config (`useDeterministicPlanner`) selects the planner; on
   *  any GeminiPlanner failure (LLM down / network error / invalid plan caught by validatePlan
   *  inside the planner), logs phase:"error" and falls back to the deterministic planner. The
   *  chosen planner's output is already in-cap (GeminiPlanner re-validates internally;
   *  DeterministicPlanner is in-cap by construction). Returns exactly one plan; the executor is
   *  still called exactly once by run(), preserving single-shot idempotency. */
  private async selectAndPlan(
    spec: ActionSpec,
    cap: string,
    market: MarketData,
    log: (phase: AgentLog["phase"], message: string, txHash?: string) => void,
  ): Promise<ActionPlan> {
    if (this.cfg.useDeterministicPlanner) {
      log("plan", "planning swap (deterministic, config)");
      return this.deps.makeDeterministicPlanner().plan(spec, cap, market);
    }
    try {
      log("plan", "planning swap (Gemini)");
      return await this.deps.makeClaudePlanner(this.bus).plan(spec, cap, market);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log("error", `Gemini planner failed (${reason}); fallback to deterministic planner.`);
      return this.deps.makeDeterministicPlanner().plan(spec, cap, market);
    }
  }
}

export type { ActionPlan, Planner, MarketData };
export { LogBus, DeterministicPlanner, GeminiPlanner, DataClient, Watcher, Executor };
