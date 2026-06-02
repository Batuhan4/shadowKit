// dataClient.ts (foundation §3.5). M2 stub: returns injected data.
// The REAL x402-paying client (over @x402/stellar createEd25519Signer) lands in M6.
export interface MarketData {
  pair: string;
  price: string;
  signal: "buy" | "sell" | "hold";
}

/** M2 stub DataClient. `setInjected` lets tests/demo feed market data without a live x402 endpoint. */
export class DataClient {
  constructor(private cfg: { url: string; signerSecret: string; network: string }) {}
  private injected?: MarketData;
  setInjected(d: MarketData): void {
    this.injected = d;
  }
  async fetchMarket(pair: string): Promise<MarketData> {
    if (this.injected) return this.injected;
    return { pair, price: "10", signal: "hold" };
  }
}
