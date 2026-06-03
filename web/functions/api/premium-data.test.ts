import { describe, it, expect, vi } from "vitest";
import { handlePremiumData } from "./premium-data";
import { quoteFor } from "./_lib/quote";
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
