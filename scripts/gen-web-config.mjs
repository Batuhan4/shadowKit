#!/usr/bin/env node
// scripts/gen-web-config.mjs — generate web/src/lib/contracts.json (PUBLIC testnet config only) from
// .env.demo.testnet so the site + Pages Functions read live contract ids without committing secrets.
// Re-run after every deploy. SECRETS (DEPLOYER_SECRET, TREASURY_SECRET) are intentionally EXCLUDED —
// they are set as Cloudflare Pages Function secrets (wrangler pages secret put), never shipped to the
// browser bundle. Usage: node scripts/gen-web-config.mjs [path-to-env]  (default .env.demo.testnet)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(ROOT, process.argv[2] ?? ".env.demo.testnet");
const raw = readFileSync(envPath, "utf8");

const env = {};
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  env[m[1]] = v;
}

const need = (k) => {
  const v = env[k];
  if (!v) throw new Error(`gen-web-config: missing ${k} in ${envPath}`);
  return v;
};

// PUBLIC fields only (contract ids, addresses, network) — NO secret keys.
const config = {
  network: env.STELLAR_NETWORK ?? "testnet",
  rpcUrl: need("RPC_URL"),
  networkPassphrase: need("NETWORK_PASSPHRASE"),
  explorerBase: "https://stellar.expert/explorer/testnet",
  govVaultId: need("GOV_VAULT_ID"),
  verifierId: need("GROTH16_VERIFIER_ID"),
  usdcId: need("USDC_ID"),
  wxlmId: need("WXLM_ID"),
  ammId: need("FALLBACK_AMM_ID"),
  agentPolicyId: need("AGENT_POLICY_ID"),
  treasuryAddr: need("TREASURY_ADDR"),
  deployerAddr: need("DEPLOYER_ADDR"),
  merkleRoot: need("MERKLE_ROOT"),
};

const outPath = resolve(ROOT, "web/src/lib/contracts.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
console.log(`gen-web-config: wrote ${outPath}\n` + JSON.stringify(config, null, 2));
