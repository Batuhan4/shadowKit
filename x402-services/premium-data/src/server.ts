// Agent PAYS this endpoint (foundation §3.6). Paywall via @shadowkit/x402-shared (REAL x402).
// NOTE: premium-data is the AGENT-PAYS side; it is ALWAYS paywalled (in BOTH x402 directions), so there
// is intentionally NO `direction` switch here — there is nothing to ungate. The X402_DIRECTION fallback
// only affects the SELL side (shadowkit-api).
import express from "express";
import { buildStellarResourceServer, type StellarNetwork } from "@shadowkit/x402-shared";
import { marketDataFor } from "./market.js";

export interface PremiumDataCfg {
  payTo: string; // the RESOURCE_SERVER address that receives USDC (foundation §3.6a)
  network: StellarNetwork;
  priceUsdc: string;
  facilitatorUrl: string;
}

export function createPremiumDataServer(cfg: PremiumDataCfg): express.Express {
  const app = express();
  app.use(
    buildStellarResourceServer({
      routes: { "GET /market/:pair": { payTo: cfg.payTo, price: cfg.priceUsdc, network: cfg.network } },
      network: cfg.network,
      facilitatorUrl: cfg.facilitatorUrl,
    }),
  );
  app.get("/market/:pair", (req, res) => {
    res.json(marketDataFor(req.params.pair));
  });
  return app;
}
