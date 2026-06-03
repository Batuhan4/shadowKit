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
  PREMIUM_DATA_URL?: string;
  DEMO_PROPOSAL_ID?: string;
  USDC_PAIR?: string;
}

/** The proposal the AgentBoard demo executes (override with DEMO_PROPOSAL_ID). Must be APPROVED
 *  on-chain (GovVault) for the demo to run; if not, the loop returns 403 with a clear message. */
export const DEFAULT_DEMO_PROPOSAL_ID = 0;

/** The trading pair the agent buys premium data for (override with USDC_PAIR). */
export const DEFAULT_PAIR = "USDC-XLM";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export function demoProposalId(env: WorkerEnv): number {
  const v = env.DEMO_PROPOSAL_ID;
  return v && /^[0-9]+$/.test(v) ? Number(v) : DEFAULT_DEMO_PROPOSAL_ID;
}
