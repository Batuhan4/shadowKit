// GET /api/premium-data?pair=USDC-XLM — the x402-CHARGED endpoint the agent PAYS (proves x402 INBOUND
// on this site). This is the Pages Function port of x402-services/premium-data: it paywalls the route
// with the REAL @x402 server flow (x402HTTPResourceServer + ExactStellarScheme) instead of Express.
//
// FLOW (every byte is the real @x402 protocol — no faked 402):
//   1) no `x-payment` header        -> 402 PaymentRequired challenge (PAYMENT-REQUIRED header + body)
//   2) `x-payment` header present    -> verify the payment against requirements; on failure -> 402
//   3) verified                      -> settle via the facilitator; on success -> 200 + the quote
//                                       (PAYMENT-RESPONSE header carries the settlement reference)
//
// The agent's x402pay.ts (the payer fetch) drives the matching client half. Secrets/config come from
// the Worker env: RESOURCE_SERVER_ADDRESS (payTo), X402_FACILITATOR_URL (OZ Channels), OZ_API_KEY
// (Bearer auth on the facilitator), X402_NETWORK, X402_PRICE_RAW + X402_USDC_SAC (charge in OUR
// self-issued USDC SAC, NOT Circle's). The OZ Channels facilitator settles the channel; the client
// (x402pay.ts) is unchanged — it signs auth entries for whatever asset the 402 advertises.
import { x402ResourceServer } from "@x402/core/server";
import { x402HTTPResourceServer } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { quoteFor } from "./_lib/quote";
import type { WorkerEnv } from "./_lib/env";
import { CONFIG } from "../../src/lib/config";

/** The default OpenZeppelin Channels x402 facilitator (testnet). Override via X402_FACILITATOR_URL. */
export const DEFAULT_OZ_FACILITATOR_URL = "https://channels.openzeppelin.com/x402/testnet";

// Minimal Fetch-API HTTPAdapter (the same shape the express adapter implements). Lets the
// framework-agnostic x402HTTPResourceServer.processHTTPRequest run inside a Cloudflare Worker.
// The installed @x402/core HTTPResourceServer calls getAcceptHeader()/getUserAgent() (for its
// isWebBrowser() content-negotiation), getHeader(), getMethod(), getUrl() — ALL must exist or it
// throws "adapter.getAcceptHeader is not a function" at runtime (caught by the live e2e + the
// processHTTPRequest test below).
interface HTTPAdapterLike {
  getHeader(name: string): string | undefined;
  getMethod(): string;
  getPath(): string;
  getUrl(): string;
  // NB: getAcceptHeader/getUserAgent MUST return a string (not undefined) — the framework's
  // isWebBrowser() calls `.includes()` on them directly, so a missing header must be "" not undefined.
  getAcceptHeader(): string;
  getUserAgent(): string;
}

function fetchAdapter(request: Request): HTTPAdapterLike {
  const url = new URL(request.url);
  return {
    getHeader: (name: string) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => request.url,
    getAcceptHeader: () => request.headers.get("accept") ?? "",
    getUserAgent: () => request.headers.get("user-agent") ?? "",
  };
}

export interface PremiumDataCfg {
  payTo: string;
  network: "stellar:testnet" | "stellar:pubnet";
  /** Raw (stroop-scale) amount charged, e.g. "10000". */
  priceAmount: string;
  /** OUR self-issued USDC SAC contract id (NOT Circle's "$x" Money form). */
  usdcSac: string;
  facilitatorUrl: string;
  /** The OpenZeppelin Channels facilitator API key (Bearer auth on verify/settle/supported). */
  ozApiKey: string;
}

/** The OZ Channels facilitator auth-header factory (Bearer auth on verify/settle/supported). This is
 *  the exact `createAuthHeaders` callback the @x402/core HTTPFacilitatorClient invokes before each
 *  facilitator call (verified against FacilitatorConfig.createAuthHeaders in @x402/core types). */
export function ozAuthHeaders(ozApiKey: string): () => Promise<{
  verify: Record<string, string>;
  settle: Record<string, string>;
  supported: Record<string, string>;
}> {
  return async () => {
    const h = { Authorization: `Bearer ${ozApiKey}` };
    return { verify: h, settle: h, supported: h };
  };
}

/** The single paywalled route's config. price is the explicit { amount, asset } AssetAmount form so
 *  the 402 advertises OUR self-issued USDC SAC (the bare "$0.001" Money form would map to Circle's
 *  canonical USDC — verified against the @x402/core Price = Money | AssetAmount type). */
export function premiumDataRoutes(cfg: PremiumDataCfg) {
  return {
    "GET /api/premium-data": {
      accepts: {
        scheme: "exact" as const,
        payTo: cfg.payTo,
        price: { amount: cfg.priceAmount, asset: cfg.usdcSac },
        network: cfg.network,
      },
    },
  };
}

/** Build the x402 HTTP resource server that paywalls GET /api/premium-data. Exposed for tests.
 *  facilitator = the OZ Channels facilitator with Bearer auth. */
export function buildPremiumDataServer(cfg: PremiumDataCfg): x402HTTPResourceServer {
  const facilitator = new HTTPFacilitatorClient({
    url: cfg.facilitatorUrl,
    createAuthHeaders: ozAuthHeaders(cfg.ozApiKey),
  });
  const server = new x402ResourceServer(facilitator).register(cfg.network, new ExactStellarScheme());
  return new x402HTTPResourceServer(server, premiumDataRoutes(cfg));
}

function cfgFromEnv(env: WorkerEnv): PremiumDataCfg | null {
  // The OZ Channels facilitator needs an API key (Bearer); without payTo/url/key we 503 (no fallback).
  if (!env.RESOURCE_SERVER_ADDRESS || !env.OZ_API_KEY) return null;
  return {
    payTo: env.RESOURCE_SERVER_ADDRESS,
    network: (env.X402_NETWORK as "stellar:testnet" | "stellar:pubnet") ?? "stellar:testnet",
    priceAmount: env.X402_PRICE_RAW ?? "10000",
    usdcSac: env.X402_USDC_SAC ?? CONFIG.usdcId,
    facilitatorUrl: env.X402_FACILITATOR_URL ?? DEFAULT_OZ_FACILITATOR_URL,
    ozApiKey: env.OZ_API_KEY,
  };
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
    ...extra,
  };
}

/** Run the x402 charge for an incoming request; returns the 200 quote, a 402 challenge, or an error
 *  response. The server arg is injectable so tests can drive the protocol without real settlement. */
export async function handlePremiumData(
  request: Request,
  server: x402HTTPResourceServer,
): Promise<Response> {
  const url = new URL(request.url);
  const pair = url.searchParams.get("pair") ?? "USDC-XLM";
  const adapter = fetchAdapter(request);
  const context = {
    adapter,
    path: url.pathname,
    method: request.method,
    paymentHeader: request.headers.get("x-payment") ?? request.headers.get("payment-signature") ?? undefined,
  };

  // processHTTPRequest is the framework-agnostic entry point the express middleware wraps.
  const result = await (
    server as unknown as {
      processHTTPRequest(c: unknown): Promise<
        | { type: "no-payment-required" }
        | { type: "payment-verified"; paymentPayload: unknown; paymentRequirements: unknown }
        | { type: "payment-error"; response: { status: number; headers: Record<string, string>; body?: unknown } }
      >;
    }
  ).processHTTPRequest(context);

  if (result.type === "payment-error") {
    // 402 challenge or verification failure — return exactly the protocol's response instructions.
    return new Response(result.response.body ? JSON.stringify(result.response.body) : null, {
      status: result.response.status,
      headers: jsonHeaders(result.response.headers ?? {}),
    });
  }

  // Verified (or no-payment-required if mis-configured) — settle and return the quote.
  let settleHeaders: Record<string, string> = {};
  if (result.type === "payment-verified") {
    try {
      const settle = await (
        server as unknown as {
          processSettlement(p: unknown, r: unknown): Promise<{ success: boolean; headers?: Record<string, string>; response?: { status: number; body?: unknown } }>;
        }
      ).processSettlement(result.paymentPayload, result.paymentRequirements);
      if (!settle.success) {
        return new Response(JSON.stringify({ error: "settlement failed" }), {
          status: settle.response?.status ?? 402,
          headers: jsonHeaders(settle.headers ?? {}),
        });
      }
      settleHeaders = settle.headers ?? {};
    } catch (e) {
      return new Response(JSON.stringify({ error: `settlement error: ${(e as Error).message}` }), {
        status: 402,
        headers: jsonHeaders(),
      });
    }
  }

  return new Response(JSON.stringify(quoteFor(pair)), { status: 200, headers: jsonHeaders(settleHeaders) });
}

interface PagesContext {
  request: Request;
  env: WorkerEnv;
}

export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  const cfg = cfgFromEnv(context.env ?? {});
  if (!cfg) {
    return new Response(
      JSON.stringify({ error: "x402 not configured: RESOURCE_SERVER_ADDRESS / OZ_API_KEY missing" }),
      { status: 503, headers: jsonHeaders() },
    );
  }
  const server = buildPremiumDataServer(cfg);
  await (server as unknown as { initialize(): Promise<void> }).initialize();
  return handlePremiumData(context.request, server);
};

export const onRequestOptions = async (): Promise<Response> =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type, x-payment, payment-signature",
    },
  });
