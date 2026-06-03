// Typed access to the Pages Function environment + the demo constants. Secrets are injected by
// Cloudflare (`wrangler pages secret put`) and reach the handler via the request context `.env`.
//
// SECRETS (set with `wrangler pages secret put <NAME>`), never in the browser:
//   GEMINI_API_KEY   — the Gemini key for the bounded planner.
//   EXECUTOR_SECRET  — the agent's Stellar signing key (a SCOPED demo key set as GovVault executor /
//                      AgentPolicy session signer; NOT the main DEMO_WALLET seed).
//   CLIENT_SECRET    — (x402 payer) the USDC-funded account that pays the premium-data 402 inbound.
//   FACILITATOR_SECRET / RESOURCE_SERVER_ADDRESS — the x402 3-account settlement harness.
// Non-secret (overridable) vars: GEMINI_MODEL, X402_NETWORK, X402_PRICE_USDC, X402_FACILITATOR_URL,
//   PREMIUM_DATA_URL (defaults to this site's own /api/premium-data), DEMO_PROPOSAL_ID, USDC_PAIR.

export interface WorkerEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  EXECUTOR_SECRET?: string;
  CLIENT_SECRET?: string;
  FACILITATOR_SECRET?: string;
  RESOURCE_SERVER_ADDRESS?: string;
  X402_NETWORK?: string;
  X402_PRICE_USDC?: string;
  X402_FACILITATOR_URL?: string;
  X402_USDC_SAC?: string;
  /** OpenZeppelin Channels facilitator API key (Bearer auth on verify/settle/supported). */
  OZ_API_KEY?: string;
  /** Raw (stroop-scale) price charged in our self-issued USDC SAC, e.g. "10000". */
  X402_PRICE_RAW?: string;
  /** The admin/deployer S… secret used to admin-sign per-session GovVault proposals. */
  ADMIN_SECRET?: string;
  /** Per-session proposal TTL in seconds (added to the latest ledger close time). */
  SESSION_TTL_SECONDS?: string;
  PREMIUM_DATA_URL?: string;
  DEMO_PROPOSAL_ID?: string;
  USDC_PAIR?: string;
  /** "true" → an unsettled x402 payment hard-stops the agent loop (strict). Otherwise (default) the
   *  loop continues with a public market quote so the agentic core stays live. */
  X402_REQUIRED?: string;
  /** "true" → after a successful swap the loop calls GovVault.mark_executed, consuming the proposal
   *  (single-shot). Default (unset/"false") → the loop does NOT mark_executed so the dedicated
   *  APPROVED demo proposal stays re-runnable for repeated judge clicks (the swap still executes for
   *  real every run). See AGENT_MARK_EXECUTED in execute.ts for the rationale. */
  AGENT_MARK_EXECUTED?: string;
  /** "true" (default) → before the swap, the loop tops up the treasury's assetIn (USDC) to the plan
   *  amount by minting the shortfall via the USDC SAC admin (ADMIN_SECRET). Keeps the demo repeatable
   *  even though each swap drains the treasury's input asset. Set "false" to disable auto-funding. */
  AGENT_AUTOFUND?: string;
}

/** The proposal the AgentBoard demo executes (override with DEMO_PROPOSAL_ID). Must be APPROVED
 *  on-chain (GovVault) for the demo to run; if not, the loop returns 403 with a clear message.
 *  Proposal #0 is the dedicated long-lived APPROVED proposal provisioned for the repeatable demo
 *  (Approved, NOT executed) — the loop deliberately does NOT mark it Executed so a judge can re-run. */
export const DEFAULT_DEMO_PROPOSAL_ID = 0;

/** The trading pair the agent buys premium data for (override with USDC_PAIR). */
export const DEFAULT_PAIR = "USDC-XLM";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export function demoProposalId(env: WorkerEnv): number {
  const v = env.DEMO_PROPOSAL_ID;
  return v && /^[0-9]+$/.test(v) ? Number(v) : DEFAULT_DEMO_PROPOSAL_ID;
}

/** Whether to consume the proposal via GovVault.mark_executed after a successful swap. Default OFF so
 *  the dedicated APPROVED demo proposal stays re-runnable; opt in with AGENT_MARK_EXECUTED="true". */
export function markExecutedEnabled(env: WorkerEnv): boolean {
  return env.AGENT_MARK_EXECUTED === "true";
}

/** Whether to top up the treasury's input asset before the swap (mint shortfall via USDC SAC admin).
 *  Default ON so repeated runs never fail on a drained treasury; opt out with AGENT_AUTOFUND="false". */
export function autoFundEnabled(env: WorkerEnv): boolean {
  return env.AGENT_AUTOFUND !== "false";
}
