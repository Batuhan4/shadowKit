// The 3-account x402 test harness (foundation §3.6a). REAL Stellar x402 settlement needs distinct
// funded accounts: a CLIENT/payer (USDC trustline + USDC balance), a FACILITATOR signer, and a
// RESOURCE_SERVER/payTo (USDC trustline). A single self-paying XLM account cannot settle USDC.
import type { StellarNetwork } from "./index.js";

export interface X402Accounts {
  clientSecret: string; // CLIENT_SECRET (S...) — payer; holds USDC
  facilitatorSecret: string; // FACILITATOR_SECRET (S...) — verifies/settles
  resourceServerAddress: string; // RESOURCE_SERVER_ADDRESS (G...) — payTo; receives USDC
  network: StellarNetwork;
  usdcSac: string; // X402_USDC_SAC (C...) — SEP-41 USDC contract id
}

/** Read the 3 funded x402 accounts from env. Returns null if any required key is missing
 *  (tests then SKIP with a written justification, charter rule 4 — cannot fake a real settlement). */
export function loadX402Accounts(): X402Accounts | null {
  const clientSecret = process.env.CLIENT_SECRET;
  const facilitatorSecret = process.env.FACILITATOR_SECRET;
  const resourceServerAddress = process.env.RESOURCE_SERVER_ADDRESS;
  if (!clientSecret || !facilitatorSecret || !resourceServerAddress) return null;
  return {
    clientSecret,
    facilitatorSecret,
    resourceServerAddress,
    network: (process.env.X402_NETWORK as StellarNetwork) ?? "stellar:testnet",
    // Default testnet USDC SAC (foundation §3.6a; coinbase/x402 stellar README, 7 decimals):
    usdcSac: process.env.X402_USDC_SAC ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  };
}
