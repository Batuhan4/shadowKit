// @shadowkit/agent — STUB (foundation §3.5). Real impl: M2 (deterministic) + M3 (Claude).
import type { AgentLog } from "@shadowkit/shared";

export interface AgentConfig {
  rpcUrl: string;
  networkPassphrase: string;
  govVaultId: string;
  agentPolicyId: string;
  swapVenueId: string;
  sessionSecretKey: string;
  premiumDataUrl: string;
  anthropicApiKey: string;
  useDeterministicPlanner: boolean;
}

export class AgentRunner {
  constructor(private cfg: AgentConfig) {}
  run(_proposalId: number, _onLog: (l: AgentLog) => void): Promise<{ txHash: string }> {
    throw new Error("AgentRunner.run: implemented in M2/M3");
  }
}
