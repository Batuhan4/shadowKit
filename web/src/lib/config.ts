// Public, browser-safe ShadowKit testnet config. contracts.json is generated from .env.demo.testnet
// by scripts/gen-web-config.mjs (re-run after every deploy). NO secrets here — the agent/executor
// signing keys live ONLY as Cloudflare Pages Function secrets.
import contracts from "./contracts.json";

export interface ShadowKitConfig {
  network: string;
  rpcUrl: string;
  networkPassphrase: string;
  explorerBase: string;
  govVaultId: string;
  verifierId: string;
  usdcId: string;
  wxlmId: string;
  ammId: string;
  agentPolicyId: string;
  treasuryAddr: string;
  deployerAddr: string;
  merkleRoot: string;
}

export const CONFIG = contracts as ShadowKitConfig;

export const explorerTx = (hash: string): string => `${CONFIG.explorerBase}/tx/${hash}`;
export const explorerContract = (id: string): string => `${CONFIG.explorerBase}/contract/${id}`;
export const explorerAccount = (addr: string): string => `${CONFIG.explorerBase}/account/${addr}`;
/** Shorten a strkey / hash for display: CDYN…WTX5 */
export const short = (s: string, head = 4, tail = 4): string =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
