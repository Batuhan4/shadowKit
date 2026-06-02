// VERIFIED 2026-06-02/03 against the INSTALLED packages (charter rule 5; reconciles foundation §3.6/§3.6b):
//   server:      paymentMiddleware(routes, server) where
//                server = new x402ResourceServer(new HTTPFacilitatorClient({url}))
//                           .register(network, new ExactStellarScheme())
//                HTTPFacilitatorClient is from "@x402/core/server" (NOT "@x402/express")  — CONFIRMED.
//                ExactStellarScheme (SERVER) is from "@x402/stellar/exact/server"          — CONFIRMED.
//   facilitator: new x402Facilitator().register(network, new ExactStellarScheme([signer]))
//                from "@x402/core/facilitator" + "@x402/stellar/exact/facilitator"         — CONFIRMED.
//
// ⚠ API DRIFT vs the M6 plan (charter rule 5, recorded decision): the plan/foundation §3.6b cited
//   `createFacilitatorRouter` from a package `@x402/server` to expose the facilitator over HTTP.
//   NEITHER EXISTS in the installed surface: `@x402/server` is a 404 on npm, and no
//   `createFacilitatorRouter` symbol exists in ANY installed @x402 package (@x402/core/{server,http,
//   facilitator}, @x402/express, @x402/stellar, @x402/fetch all checked). We therefore expose the
//   facilitator over HTTP with a SMALL router that calls the facilitator's PUBLIC, VERIFIED two-arg
//   API exactly as HTTPFacilitatorClient invokes it — this is NOT a fake-402 stub: every byte of the
//   402→pay→verify→settle→200 flow runs the real @x402 scheme code. The wire protocol below was read
//   straight out of the installed HTTPFacilitatorClient impl
//   (node_modules/@x402/core/dist/esm/chunk-W4OPBTK7.mjs verify()/settle()/getSupported()):
//     POST {url}/verify   body { x402Version, paymentPayload, paymentRequirements } -> facilitator.verify(payload, requirements)
//     POST {url}/settle   body { x402Version, paymentPayload, paymentRequirements } -> facilitator.settle(payload, requirements)
//     GET  {url}/supported                                                          -> facilitator.getSupported()
//   The router passes BOTH args in the correct order (the exact concern foundation §3.6b raised about a
//   hand-roll passing one malformed arg is avoided here — both args are forwarded verbatim).
import express, { type RequestHandler } from "express";
import type { Server } from "node:http";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server"; // CONFIRMED path (foundation §3.6)
import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme as ExactStellarFacilitatorScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";

export type StellarNetwork = "stellar:testnet" | "stellar:pubnet";

export interface RouteSpec {
  payTo: string;
  /** x402 Money/Price — e.g. "$0.001" (USD-denominated) (CONFIRMED: Money = string | number). */
  price: string;
  network: StellarNetwork;
}

export interface BuildResourceServerCfg {
  routes: Record<string, RouteSpec>; // key e.g. "GET /thing"
  network: StellarNetwork;
  facilitatorUrl: string;
}

/** Build the express x402 middleware that paywalls the given routes on a Stellar network. */
export function buildStellarResourceServer(cfg: BuildResourceServerCfg): RequestHandler {
  const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register(
    cfg.network,
    new ExactStellarServerScheme(),
  );
  const routes = Object.fromEntries(
    Object.entries(cfg.routes).map(([k, r]) => [
      k,
      { accepts: { scheme: "exact" as const, payTo: r.payTo, price: r.price, network: r.network } },
    ]),
  );
  return paymentMiddleware(routes, server);
}

export interface TestFacilitatorCfg {
  network: StellarNetwork;
  signerSecret: string;
  port?: number;
}

/** Stand up a REAL local x402 facilitator (verifies + settles Stellar USDC payments on-chain).
 *  Uses x402Facilitator (@x402/core/facilitator) + ExactStellarScheme (facilitator subpath),
 *  exposed over HTTP with a thin router that forwards the EXACT two-arg verify/settle calls that
 *  HTTPFacilitatorClient makes (see the API DRIFT note at the top of this file). `signerSecret` is
 *  the FACILITATOR_SECRET account (distinct from the payer + payTo; foundation §3.6a). */
export async function startTestFacilitator(
  cfg: TestFacilitatorCfg,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const signer = createEd25519Signer(cfg.signerSecret, cfg.network);
  const facilitator = new x402Facilitator().register(
    cfg.network,
    new ExactStellarFacilitatorScheme([signer]),
  );
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Faithful HTTP boundary over the REAL facilitator (no faked responses). Each handler forwards the
  // client's payload + requirements verbatim into the verified two-arg facilitator API and returns
  // the scheme's real VerifyResponse / SettleResponse, which HTTPFacilitatorClient validates against
  // its zod schemas.
  app.post("/verify", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body ?? {};
      const result = await facilitator.verify(paymentPayload, paymentRequirements);
      res.json(result);
    } catch (e) {
      res.status(400).json({ isValid: false, invalidReason: String(e) });
    }
  });
  app.post("/settle", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body ?? {};
      const result = await facilitator.settle(paymentPayload, paymentRequirements);
      res.json(result);
    } catch (e) {
      res.status(400).json({ success: false, errorReason: String(e) });
    }
  });
  app.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });

  const srv: Server = await new Promise((r) => {
    const s = app.listen(cfg.port ?? 0, () => r(s));
  });
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port!;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
