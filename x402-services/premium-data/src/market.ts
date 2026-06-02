// The (deterministic) premium data being sold. Real systems would proxy a feed; for the demo this is
// a deterministic function so tests assert exact values. The x402 paywall (not the data) is the point.
export interface MarketData {
  pair: string;
  price: string;
  signal: "buy" | "sell" | "hold";
}

const TABLE: Record<string, MarketData> = {
  "USDC-XLM": { pair: "USDC-XLM", price: "0.1123", signal: "buy" },
  "XLM-USDC": { pair: "XLM-USDC", price: "8.9047", signal: "sell" },
};

export function marketDataFor(pair: string): MarketData {
  return TABLE[pair] ?? { pair, price: "1.0000", signal: "hold" };
}
