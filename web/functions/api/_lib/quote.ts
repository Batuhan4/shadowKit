// The "premium market data" the agent PAYS for over x402 (proves x402 INBOUND on this site). This is
// the same deterministic shape as x402-services/premium-data/src/market.ts: a real system would proxy
// a live feed, but the demo keeps it deterministic so tests assert exact values and the on-chain
// minOut math stays reproducible. The PAYWALL (not the data) is the point being demonstrated.

export interface MarketQuote {
  pair: string;
  price: string; // output units per input unit, decimal string
  signal: "buy" | "sell" | "hold";
}

const TABLE: Record<string, MarketQuote> = {
  "USDC-XLM": { pair: "USDC-XLM", price: "0.1123", signal: "buy" },
  "XLM-USDC": { pair: "XLM-USDC", price: "8.9047", signal: "sell" },
};

/** Deterministic quote for a pair label, e.g. "USDC-XLM". Unknown pairs get a neutral hold quote. */
export function quoteFor(pair: string): MarketQuote {
  return TABLE[pair] ?? { pair, price: "1.0000", signal: "hold" };
}
