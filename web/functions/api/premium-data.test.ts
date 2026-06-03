import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handlePremiumData,
  ozAuthHeaders,
  premiumDataRoutes,
  buildPremiumDataServer,
  type PremiumDataCfg,
} from "./premium-data";
import { quoteFor } from "./_lib/quote";
import { CONFIG } from "../../src/lib/config";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { x402HTTPResourceServer } from "@x402/core/http";

// We unit-test the HANDLER's translation of the REAL x402 HTTPProcessResult shapes into Fetch
// Responses. The network/protocol boundary (x402HTTPResourceServer.processHTTPRequest /
// processSettlement) is faked with the protocol's own documented result shapes — the actual
// 402->verify->settle->200 protocol code is exercised end-to-end by the x402-services package
// (REAL facilitator + funded accounts), which this site reuses. Here we never fake the quote, the
// handler control-flow, or the policy.

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://shadowkit.pages.dev/api/premium-data?pair=USDC-XLM", {
    method: "GET",
    headers,
  });
}

describe("handlePremiumData — x402 INBOUND charge", () => {
  it("returns the protocol's 402 challenge when there is NO payment header", async () => {
    const server = {
      processHTTPRequest: vi.fn(async () => ({
        type: "payment-error" as const,
        response: {
          status: 402,
          headers: { "PAYMENT-REQUIRED": "base64challenge" },
          body: { x402Version: 1, accepts: [{ scheme: "exact", network: "stellar:testnet" }] },
        },
      })),
    } as unknown as x402HTTPResourceServer;

    const res = await handlePremiumData(req(), server);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.accepts).toBeDefined(); // the PaymentRequired challenge body is surfaced verbatim
  });

  it("settles a verified payment and returns 200 + the quote", async () => {
    const server = {
      processHTTPRequest: vi.fn(async () => ({
        type: "payment-verified" as const,
        paymentPayload: { x402Version: 1 },
        paymentRequirements: { scheme: "exact" },
      })),
      processSettlement: vi.fn(async () => ({
        success: true,
        headers: { "PAYMENT-RESPONSE": "settle-ref-xyz" },
      })),
    } as unknown as x402HTTPResourceServer;

    const res = await handlePremiumData(req({ "x-payment": "signedpayload" }), server);
    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe("settle-ref-xyz");
    const body = await res.json();
    expect(body).toEqual(quoteFor("USDC-XLM")); // the real quote, not a stub
  });

  it("returns 402 when settlement FAILS (payment did not settle)", async () => {
    const server = {
      processHTTPRequest: vi.fn(async () => ({
        type: "payment-verified" as const,
        paymentPayload: {},
        paymentRequirements: {},
      })),
      processSettlement: vi.fn(async () => ({
        success: false,
        errorReason: "insufficient_funds",
        headers: {},
        response: { status: 402 },
      })),
    } as unknown as x402HTTPResourceServer;

    const res = await handlePremiumData(req({ "x-payment": "signedpayload" }), server);
    expect(res.status).toBe(402);
    // no quote leaks when the payment did not settle
    const body = await res.json();
    expect(body.pair).toBeUndefined();
  });
});

const cfg: PremiumDataCfg = {
  payTo: "GCULI6E2MGYMEBDOPQRKNWXBKVCQH4GLEJDSLSG4SKDUEARMCVZTBKVJ",
  network: "stellar:testnet",
  priceAmount: "10000",
  usdcSac: CONFIG.usdcId, // OUR self-issued USDC SAC
  facilitatorUrl: "https://channels.openzeppelin.com/x402/testnet",
  ozApiKey: "OZ_TEST_KEY",
};

describe("premium-data config — OZ Channels facilitator (Bearer auth) + our USDC SAC", () => {
  it("ozAuthHeaders emits the Bearer header for verify/settle/supported", async () => {
    const headers = await ozAuthHeaders(cfg.ozApiKey)();
    const expected = { Authorization: `Bearer ${cfg.ozApiKey}` };
    expect(headers.verify).toEqual(expected);
    expect(headers.settle).toEqual(expected);
    expect(headers.supported).toEqual(expected);
  });

  it("advertises OUR self-issued USDC SAC as the price asset (explicit { amount, asset })", () => {
    const route = premiumDataRoutes(cfg)["GET /api/premium-data"];
    expect(route.accepts.scheme).toBe("exact");
    // the explicit AssetAmount form — NOT Circle's "$x" Money form.
    expect(route.accepts.price).toEqual({ amount: "10000", asset: CONFIG.usdcId });
    expect(typeof route.accepts.price).toBe("object");
    expect(route.accepts.network).toBe("stellar:testnet");
    expect(route.accepts.payTo).toBe(cfg.payTo);
  });

  it("wires the Bearer auth into the real facilitator (auth reaches the network boundary)", async () => {
    // Mock ONLY the facilitator network boundary (fetch). buildPremiumDataServer constructs a real
    // HTTPFacilitatorClient with our createAuthHeaders; we prove the Bearer header is sent by reading
    // it off the actual outbound facilitator request.
    let captured: string | null = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers as HeadersInit);
      captured = h.get("Authorization");
      return new Response(JSON.stringify({ kinds: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      // build the resource server (creates the real facilitator) then make a real facilitator call.
      buildPremiumDataServer(cfg);
      const fac = new HTTPFacilitatorClient({
        url: cfg.facilitatorUrl,
        createAuthHeaders: ozAuthHeaders(cfg.ozApiKey),
      });
      await fac.getSupported();
      expect(captured).toBe(`Bearer ${cfg.ozApiKey}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

afterEach(() => vi.restoreAllMocks());
