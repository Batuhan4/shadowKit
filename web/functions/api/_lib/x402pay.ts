// The x402 INBOUND pay path: the agent PAYS this site's own /api/premium-data endpoint to fetch the
// market quote before planning. Uses @shadowkit/x402-shared/payerFetch (the REAL x402 payer) wrapping
// fetch over a Stellar Ed25519 signer (CLIENT_SECRET), so a 402 challenge is transparently settled in
// USDC and the 200 body is the quote. If no CLIENT_SECRET is configured the loop reports unpaid (402)
// and stops BEFORE planning/submitting — no fallback (charter: fully live, no replay).
import { makeX402Fetch } from "@shadowkit/x402-shared/payerFetch";
import type { StellarNetwork } from "@shadowkit/x402-shared";
import type { MarketQuote } from "./quote";

export interface PayResult {
  paid: boolean;
  txRef?: string;
  quote: MarketQuote | null;
  error?: string;
}

export interface PayAndQuote {
  (pair: string): Promise<PayResult>;
}

export interface X402PayCfg {
  premiumDataUrl: string; // e.g. https://shadowkit.pages.dev/api/premium-data
  clientSecret?: string;
  network: string; // "stellar:testnet"
  /** Injected in tests; defaults to the real x402 payer fetch. */
  fetchImpl?: typeof fetch;
}

/** Build the payAndQuote function the loop calls. Network boundary = fetchImpl (faked in tests). */
export function makePayAndQuote(cfg: X402PayCfg): PayAndQuote {
  return async (pair: string): Promise<PayResult> => {
    if (!cfg.clientSecret) {
      return { paid: false, quote: null, error: "no x402 CLIENT_SECRET configured" };
    }
    const doFetch =
      cfg.fetchImpl ?? makeX402Fetch(cfg.clientSecret, cfg.network as StellarNetwork);
    const url = `${cfg.premiumDataUrl}?pair=${encodeURIComponent(pair)}`;
    let res: Response;
    try {
      res = await doFetch(url);
    } catch (e) {
      return { paid: false, quote: null, error: `x402 fetch failed: ${(e as Error).message}` };
    }
    if (res.status === 402) {
      return { paid: false, quote: null, error: "payment required (402) — settlement did not complete" };
    }
    if (!res.ok) {
      return { paid: false, quote: null, error: `premium-data ${res.status}` };
    }
    const quote = (await res.json()) as MarketQuote;
    // The x402 payer attaches the settlement reference on the response header (x-payment-response).
    const txRef = res.headers.get("x-payment-response") ?? res.headers.get("x-payment") ?? undefined;
    return { paid: true, txRef, quote };
  };
}
