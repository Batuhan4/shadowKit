// foundation §3.5 DataClient: GET the x402-protected premium-data endpoint, auto-pay the 402, parse.
// Uses the shared payer fetch (REAL x402, charter rule 4). M6 replaces the M2 stub with the real payer:
// fetchMarket drives @x402/fetch's wrapFetchWithPayment over a Stellar Ed25519 signer (CLIENT_SECRET),
// so a 402 challenge is transparently paid in USDC and the 200 body is parsed into MarketData.
import { makeX402Fetch } from "@shadowkit/x402-shared/payerFetch";
import type { StellarNetwork } from "@shadowkit/x402-shared";

export interface MarketData {
  pair: string;
  price: string;
  signal: "buy" | "sell" | "hold";
}

export class DataClient {
  private readonly pay: typeof fetch;
  constructor(private cfg: { url: string; signerSecret: string; network: string }) {
    this.pay = makeX402Fetch(cfg.signerSecret, cfg.network as StellarNetwork);
  }
  /** GET /market/:pair behind x402; auto-pays the 402; returns parsed MarketData. */
  async fetchMarket(pair: string): Promise<MarketData> {
    const res = await this.pay(`${this.cfg.url}/market/${encodeURIComponent(pair)}`);
    if (!res.ok) throw new Error(`premium-data fetch failed: ${res.status}`);
    return (await res.json()) as MarketData;
  }
}
