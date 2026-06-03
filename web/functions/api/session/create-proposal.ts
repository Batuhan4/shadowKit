// POST /api/session/create-proposal — admin-sign a FRESH short-deadline GovVault proposal so the
// ShadowFund /demo/fund flow always has an Open proposal to vote on (the deployed GovVault's
// create_proposal requires ADMIN auth + deadline>now, and close_and_reveal requires now>=deadline,
// so a persistent live demo needs a per-session proposal — see GOVVAULT CONSTRAINTS).
//
// FLOW (every byte is the real chain — no faked id):
//   1) read ADMIN_SECRET (the deployer/admin S… key) from the Worker env; absent -> 503.
//   2) deadline = latest-ledger close time (RPC) + SESSION_TTL_SECONDS (default 150s).
//   3) build create_proposal(action_spec, cap, deadline) on the LIVE GovVault, simulate+prepare,
//      sign with the admin keypair, submit, poll getTransaction, parse the returned u32 id.
//   4) return { proposalId, deadline }.
//
// scval encoding (verified byte-for-byte against the deployed gov-vault ContractSpec via
// spec.funcArgsToScVals — see create-proposal.test.ts):
//   create_proposal(action_spec: ActionSpec, cap: i128, deadline: u64) -> Result<u32, GovError>
//   ActionSpec is an ScMap (fields sorted by symbol): amount:i128, asset_in:Address,
//     asset_out:Address, kind:SwapKind, min_out:i128.
//   SwapKind::Swap is a VOID union case -> scvVec([scvSymbol("Swap")]).
// Args are built with @stellar/stellar-sdk nativeToScVal exactly like web/src/lib/voteClient.ts
// (the web gov-vault binding is the stale M1 plaintext ABI, so we marshal ScVals directly).
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  Address,
  Keypair,
  BASE_FEE,
  rpc,
} from "@stellar/stellar-sdk";
import { CONFIG } from "../../../src/lib/config";
import type { WorkerEnv } from "../_lib/env";

/** Default per-session proposal lifetime (seconds) added to the latest ledger close time. */
export const DEFAULT_SESSION_TTL_SECONDS = 150;

export interface ProposalActionSpec {
  amount: string;
  asset_in: string;
  asset_out: string;
  kind: "Swap";
  min_out: string;
}

/** The fixed demo action: swap 10000 (raw) USDC -> WXLM with a min_out floor of 1. */
export function demoActionSpec(): ProposalActionSpec {
  return {
    amount: "10000",
    asset_in: CONFIG.usdcId,
    asset_out: CONFIG.wxlmId,
    kind: "Swap",
    min_out: "1",
  };
}

/** Resolve the session TTL (seconds) from env, falling back to the default. */
export function sessionTtlSeconds(env: WorkerEnv): number {
  const v = env.SESSION_TTL_SECONDS;
  return v && /^[0-9]+$/.test(v) ? Number(v) : DEFAULT_SESSION_TTL_SECONDS;
}

/** deadline = latest ledger close time + ttl. Pure given the close time, so it is unit-tested. */
export function deadlineFrom(latestCloseTime: number, ttlSeconds: number): number {
  return latestCloseTime + ttlSeconds;
}

/** ScVal for SwapKind::Swap — a VOID union case is encoded as scvVec([scvSymbol(<case>)]). */
export function swapKindScVal(): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Swap")]);
}

/** ScVal for the ActionSpec struct (ScMap, fields sorted by symbol — exactly the deployed ABI). */
export function actionSpecScVal(spec: ProposalActionSpec): xdr.ScVal {
  return nativeToScVal(
    {
      amount: BigInt(spec.amount),
      asset_in: new Address(spec.asset_in),
      asset_out: new Address(spec.asset_out),
      kind: swapKindScVal(),
      min_out: BigInt(spec.min_out),
    },
    {
      type: {
        amount: ["symbol", "i128"],
        asset_in: ["symbol", "address"],
        asset_out: ["symbol", "address"],
        kind: ["symbol", null],
        min_out: ["symbol", "i128"],
      },
    },
  );
}

/** The three create_proposal ScVal args in ABI order: [action_spec, cap, deadline]. */
export function createProposalArgs(
  spec: ProposalActionSpec,
  cap: string,
  deadline: number,
): xdr.ScVal[] {
  return [
    actionSpecScVal(spec),
    nativeToScVal(BigInt(cap), { type: "i128" }),
    nativeToScVal(BigInt(deadline), { type: "u64" }),
  ];
}

/** The injectable RPC boundary (faked in tests; the scval encoding under test is NEVER mocked). */
export interface CreateProposalRpc {
  /** Latest ledger close time in unix seconds. */
  latestCloseTime(): Promise<number>;
  /** Simulate+prepare, admin-sign, submit, poll, and return the on-chain u32 proposal id. */
  submitCreateProposal(args: xdr.ScVal[], deadline: number): Promise<number>;
}

export interface CreateProposalResult {
  proposalId: number;
  deadline: number;
}

/** Pure orchestration over the RPC boundary: build args, submit, return {proposalId, deadline}. */
export async function createSessionProposal(
  rpcDeps: CreateProposalRpc,
  env: WorkerEnv,
): Promise<CreateProposalResult> {
  const spec = demoActionSpec();
  const cap = "10000";
  const closeTime = await rpcDeps.latestCloseTime();
  const deadline = deadlineFrom(closeTime, sessionTtlSeconds(env));
  const args = createProposalArgs(spec, cap, deadline);
  const proposalId = await rpcDeps.submitCreateProposal(args, deadline);
  return { proposalId, deadline };
}

// ---- The REAL RPC adapter: latest-ledger close time + admin-signed create_proposal -------------
function rpcServer(): rpc.Server {
  return new rpc.Server(CONFIG.rpcUrl, { allowHttp: CONFIG.rpcUrl.startsWith("http://") });
}

/** Build the REAL RPC boundary signed by the admin keypair (deployer/admin S… key). */
export function realRpc(adminSecret: string): CreateProposalRpc {
  const server = rpcServer();
  const admin = Keypair.fromSecret(adminSecret);
  return {
    async latestCloseTime(): Promise<number> {
      // getLatestLedger gives the sequence; getLedgers surfaces the wall-clock close time.
      const latest = await server.getLatestLedger();
      const ledgers = await server.getLedgers({ startLedger: latest.sequence, limit: 1 });
      return ledgers.latestLedgerCloseTime;
    },
    async submitCreateProposal(args: xdr.ScVal[], _deadline: number): Promise<number> {
      const contract = new Contract(CONFIG.govVaultId);
      const op = contract.call("create_proposal", ...args);
      const account = await server.getAccount(admin.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: CONFIG.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(120)
        .build();
      // prepareTransaction = simulate + assemble (Soroban footprint/auth/resource fee). Same path
      // voteClient.ts uses, except here the ADMIN signs server-side (admin.require_auth()).
      const prepared = await server.prepareTransaction(tx);
      prepared.sign(admin);
      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw new Error(`create_proposal sendTransaction ERROR: ${JSON.stringify(sent.errorResult ?? sent)}`);
      }
      const hash = sent.hash;
      for (let i = 0; i < 30; i++) {
        const res = await server.getTransaction(hash);
        if (res.status === "SUCCESS") {
          // create_proposal returns Result<u32>; the host unwraps Ok -> the u32 ScVal in returnValue.
          const rv = (res as { returnValue?: xdr.ScVal }).returnValue;
          if (!rv) throw new Error(`create_proposal SUCCESS but no returnValue: ${hash}`);
          return Number(scValToNative(rv));
        }
        if (res.status === "FAILED") {
          throw new Error(`create_proposal tx FAILED: ${hash} ${JSON.stringify((res as { resultXdr?: unknown }).resultXdr ?? "")}`);
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error(`create_proposal tx did not complete (timeout): ${hash}`);
    },
  };
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    ...extra,
  };
}

interface PagesContext {
  request: Request;
  env: WorkerEnv;
}

export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  const env = context.env ?? {};
  // Without the admin key we cannot admin-sign create_proposal — fail clearly (no fallback).
  if (!env.ADMIN_SECRET) {
    return new Response(JSON.stringify({ error: "ADMIN_SECRET not configured" }), {
      status: 503,
      headers: jsonHeaders(),
    });
  }
  try {
    const result = await createSessionProposal(realRpc(env.ADMIN_SECRET), env);
    return new Response(JSON.stringify(result), { status: 200, headers: jsonHeaders() });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: jsonHeaders(),
    });
  }
};

export const onRequestOptions = async (): Promise<Response> =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
