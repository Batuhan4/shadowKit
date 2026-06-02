import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { createShadowKitApiServer } from "../src/server.js";

// NON-ENV-GATED UNIT COVERAGE (charter rules 1 + 4): these run in EVERY CI without funded accounts.
// We drive the server in `agent-pays-only` (ungated) mode so NO x402 settlement / payer is needed —
// this isolates the REAL business logic: the /verify handler runs the REAL Groth16 verifyVoteProof
// over the committed circuit fixtures (a TAMPERED proof is genuinely rejected), and /execute runs the
// REAL provider gate (assertApproved) + agent kick with an injected readApproved/runAgent boundary.
const ROOT = new URL("../../../", import.meta.url).pathname; // repo root from x402-services/shadowkit-api/test/

const proof = JSON.parse(readFileSync(`${ROOT}circuits/vote/fixtures/proof.json`, "utf8"));
const publicRaw = JSON.parse(readFileSync(`${ROOT}circuits/vote/fixtures/public.json`, "utf8"));
// public.json native order = [nullifier, merkleRoot, proposalId, sealedCommitmentHash]
// (zk-prover src/index.ts:48 — VERIFIED 2026-06-03).
const validSignals = {
  nullifier: publicRaw[0],
  merkleRoot: publicRaw[1],
  proposalId: publicRaw[2],
  sealedCommitmentHash: publicRaw[3],
};

describe("shadowkit-api business logic (ungated; REAL verify + REAL provider gate)", () => {
  let server: Server;
  let baseUrl: string;
  const runAgent = vi.fn(async (_id: number) => ({ txHash: "unitkicktxhash00" }));

  beforeAll(async () => {
    const app = createShadowKitApiServer({
      payTo: "GUNUSED0000000000000000000000000000000000000000000000000",
      network: "stellar:testnet",
      priceUsdc: "$0.001",
      facilitatorUrl: "http://unused",
      govVaultId: "CGOV",
      rpcUrl: "http://unused",
      direction: "agent-pays-only", // no paywall -> isolates business logic from x402 settlement
      readApproved: async (id: number) => id === 1, // approved only for id 1
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

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("/verify returns { valid: true } for a REAL valid Groth16 proof", async () => {
    const res = await post("/verify", { proof, publicSignals: validSignals });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });

  it("/verify returns { valid: false } for a TAMPERED proof (real crypto rejects it)", async () => {
    // Tamper a public signal: bump the nullifier by 1. The REAL verifyVoteProof must reject it.
    const tampered = { ...validSignals, nullifier: (BigInt(validSignals.nullifier) + 1n).toString() };
    const res = await post("/verify", { proof, publicSignals: tampered });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false });
  });

  it("/verify returns { valid: false } for a structurally-mangled proof", async () => {
    // Corrupt a proof element. snarkjs must NOT accept it.
    const badProof = { ...proof, pi_a: [...proof.pi_a] };
    badProof.pi_a[0] = (BigInt(proof.pi_a[0]) + 1n).toString();
    const res = await post("/verify", { proof: badProof, publicSignals: validSignals });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false });
  });

  it("/execute kicks the agent (200) for an APPROVED proposal", async () => {
    runAgent.mockClear();
    const res = await post("/execute", { proposalId: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, proposalId: 1, txHash: "unitkicktxhash00" });
    expect(runAgent).toHaveBeenCalledWith(1);
  });

  it("/execute provider gate rejects (403) a NON-APPROVED proposal and does NOT kick the agent", async () => {
    runAgent.mockClear();
    const res = await post("/execute", { proposalId: 2 });
    expect(res.status).toBe(403);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
