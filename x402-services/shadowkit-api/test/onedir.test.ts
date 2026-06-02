import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import { createShadowKitApiServer } from "../src/server.js";

// Fallback path (X402_DIRECTION=agent-pays-only): SELL side runs UNGATED so a missing/flaky
// sell-side facilitator never blocks the demo. No facilitator needed -> NO funded key needed.
// readApproved + runAgent are injected so the gate + kick logic is exercised without a live RPC/agent.
describe("shadowkit-api UNGATED under agent-pays-only fallback", () => {
  let server: Server;
  let baseUrl: string;
  const runAgent = vi.fn(async (_id: number) => ({ txHash: "ungatedtxhash00" }));
  beforeAll(async () => {
    const app = createShadowKitApiServer({
      payTo: "GUNUSED0000000000000000000000000000000000000000000000000",
      network: "stellar:testnet",
      priceUsdc: "$0.001",
      facilitatorUrl: "http://unused",
      govVaultId: "CGOV",
      rpcUrl: "http://unused",
      direction: "agent-pays-only",
      readApproved: async (id: number) => id === 1,
      runAgent,
    });
    server = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });
    const a = server.address();
    baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns 200 on /execute WITHOUT any payment when ungated (approved id) and kicks the agent", async () => {
    const res = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, txHash: "ungatedtxhash00" });
    expect(runAgent).toHaveBeenCalledWith(1);
  });
  it("still applies the provider gate (403) even when ungated, for a non-approved id", async () => {
    const res = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: 2 }),
    });
    expect(res.status).toBe(403);
  });
});
