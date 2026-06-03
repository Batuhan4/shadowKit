import { describe, it, expect, vi } from "vitest";
import { nativeToScVal, scValToNative, contract as sdkContract, xdr } from "@stellar/stellar-sdk";
import {
  demoActionSpec,
  sessionTtlSeconds,
  deadlineFrom,
  swapKindScVal,
  actionSpecScVal,
  createProposalArgs,
  createSessionProposal,
  onRequestPost,
  DEFAULT_SESSION_TTL_SECONDS,
  type CreateProposalRpc,
} from "./create-proposal";
import { CONFIG } from "../../../src/lib/config";
import fs from "node:fs";

// We unit-test the REAL action_spec/deadline building (the scval encoding under test is NEVER mocked
// — it is round-tripped AND byte-compared against the deployed gov-vault ContractSpec) plus the
// 503-no-admin path and the pure createSessionProposal orchestration (only the RPC boundary faked).

describe("create-proposal — demoActionSpec / deadline building", () => {
  it("builds the swap USDC->WXLM action_spec from CONFIG", () => {
    const spec = demoActionSpec();
    expect(spec).toEqual({
      amount: "10000",
      asset_in: CONFIG.usdcId,
      asset_out: CONFIG.wxlmId,
      kind: "Swap",
      min_out: "1",
    });
  });

  it("defaults the session TTL and overrides it from SESSION_TTL_SECONDS", () => {
    expect(sessionTtlSeconds({})).toBe(DEFAULT_SESSION_TTL_SECONDS);
    expect(sessionTtlSeconds({ SESSION_TTL_SECONDS: "300" })).toBe(300);
    // a non-numeric override falls back to the default (never NaN).
    expect(sessionTtlSeconds({ SESSION_TTL_SECONDS: "soon" })).toBe(DEFAULT_SESSION_TTL_SECONDS);
  });

  it("deadline = latest ledger close time + ttl", () => {
    expect(deadlineFrom(1_700_000_000, 150)).toBe(1_700_000_150);
  });
});

describe("create-proposal — scval encoding (real, not mocked)", () => {
  it("encodes SwapKind::Swap as a void union case scvVec([scvSymbol('Swap')])", () => {
    const sv = swapKindScVal();
    expect(sv.switch().name).toBe("scvVec");
    expect(scValToNative(sv)).toEqual(["Swap"]);
  });

  it("encodes ActionSpec as an ScMap with fields sorted by symbol", () => {
    const sv = actionSpecScVal(demoActionSpec());
    expect(sv.switch().name).toBe("scvMap");
    const keys = sv.map()!.map((e) => e.key().sym().toString());
    expect(keys).toEqual(["amount", "asset_in", "asset_out", "kind", "min_out"]);
    const native = scValToNative(sv);
    expect(native.amount).toBe(10000n);
    expect(native.asset_in).toBe(CONFIG.usdcId);
    expect(native.asset_out).toBe(CONFIG.wxlmId);
    expect(native.kind).toEqual(["Swap"]);
    expect(native.min_out).toBe(1n);
  });

  it("matches the deployed gov-vault ContractSpec byte-for-byte (create_proposal args)", () => {
    // Load the authoritative ContractSpec straight from the generated gov-vault binding source and
    // let IT encode create_proposal(action_spec, cap, deadline) from native JS — then assert our
    // hand-built ScVals are byte-identical (proves the encoding matches the deployed ABI).
    const src = fs.readFileSync(
      "../packages/shared/src/bindings/gov-vault/src/index.ts",
      "utf8",
    );
    const m = src.match(/new ContractSpec\(\[([\s\S]*?)\]\s*\)/);
    if (!m) throw new Error("could not locate ContractSpec in gov-vault binding");
    const entries = [...m[1].matchAll(/"([A-Za-z0-9+/=]+)"/g)].map((x) => x[1]);
    const spec = new sdkContract.Spec(entries);

    const deadline = 9_999_999_999;
    const specArgs = spec.funcArgsToScVals("create_proposal", {
      action_spec: {
        amount: 10000n,
        asset_in: CONFIG.usdcId,
        asset_out: CONFIG.wxlmId,
        kind: { tag: "Swap", values: undefined },
        min_out: 1n,
      },
      cap: 10000n,
      deadline: BigInt(deadline),
    });

    const ours = createProposalArgs(demoActionSpec(), "10000", deadline);
    expect(ours).toHaveLength(3);
    expect(ours[0]!.toXDR("base64")).toBe(specArgs[0]!.toXDR("base64")); // action_spec
    expect(ours[1]!.toXDR("base64")).toBe(specArgs[1]!.toXDR("base64")); // cap (i128)
    expect(ours[2]!.toXDR("base64")).toBe(specArgs[2]!.toXDR("base64")); // deadline (u64)
  });
});

describe("create-proposal — orchestration & handler", () => {
  it("createSessionProposal returns the on-chain id + deadline (RPC boundary faked only)", async () => {
    let receivedArgs: xdr.ScVal[] | null = null;
    let receivedDeadline = -1;
    const fakeRpc: CreateProposalRpc = {
      latestCloseTime: vi.fn(async () => 1_700_000_000),
      submitCreateProposal: vi.fn(async (args, deadline) => {
        receivedArgs = args;
        receivedDeadline = deadline;
        return 7;
      }),
    };
    const result = await createSessionProposal(fakeRpc, { SESSION_TTL_SECONDS: "150" });
    expect(result).toEqual({ proposalId: 7, deadline: 1_700_000_150 });
    // the submitted args are the REAL encoded create_proposal args (not stubbed).
    expect(receivedArgs).not.toBeNull();
    expect(receivedArgs!).toHaveLength(3);
    expect(scValToNative(receivedArgs![0]!).asset_in).toBe(CONFIG.usdcId);
    expect(receivedDeadline).toBe(1_700_000_150);
  });

  it("returns 503 when ADMIN_SECRET is not configured", async () => {
    const res = await onRequestPost({
      request: new Request("https://x/api/session/create-proposal", { method: "POST" }),
      env: {},
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("ADMIN_SECRET not configured");
  });
});

// sanity: nativeToScVal is the same primitive voteClient uses (kept to anchor the import surface).
it("nativeToScVal u64 round-trips (deadline primitive)", () => {
  expect(scValToNative(nativeToScVal(123n, { type: "u64" }))).toBe(123n);
});
