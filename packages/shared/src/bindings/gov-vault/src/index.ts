import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  type ClientOptions as ContractClientOptions,
  type MethodOptions,
  type Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  standalone: {
    networkPassphrase: "Standalone Network ; February 2017",
    contractId: "CDNEFRVFPDKKNZ3S4U3KH4K4WVJEZPUOEOXOAFDGEJ7DIREP54SXTFE4",
  }
} as const

export const GovError = {
  1: {message:"AlreadyInitialized"},
  2: {message:"NotInitialized"},
  3: {message:"NotAdmin"},
  4: {message:"ProposalNotFound"},
  5: {message:"DeadlinePassed"},
  6: {message:"DeadlineNotReached"},
  7: {message:"NullifierUsed"},
  8: {message:"WrongProposalId"},
  9: {message:"InvalidProof"},
  10: {message:"StaleMerkleRoot"},
  11: {message:"AlreadyRevealed"},
  12: {message:"NotRevealed"},
  13: {message:"RevealMismatch"},
  14: {message:"AlreadyExecuted"},
  15: {message:"NotApproved"},
  16: {message:"AlreadyVoted"},
  17: {message:"NotEligible"},
  18: {message:"ZeroWeight"},
  19: {message:"QuorumNotMet"},
  20: {message:"InvalidDirection"},
  21: {message:"ProposalAmountOverCap"},
  22: {message:"DeadlineInPast"}
}





/**
 * Storage keys. Binding subset (foundation §2.2): Admin, Verifier, MerkleRoot, TreasuryAsset,
 * QuorumCfg, Executor, NextId, Proposal(u32), SealedVotes(u32), Nullifier(BytesN<32>).
 * M1-additive plaintext keys (recorded divergence — see plan header): VoteWeights, VoterVoted,
 * YesWeight, NoWeight. These are M1's plaintext mechanism; M4/M5 replace VoterVoted/YesWeight/NoWeight
 * with the SealedVotes + Nullifier flow. Verifier/MerkleRoot are unused in M1 but kept in the enum
 * so the binding discriminant order never changes. `Executor` (foundation §2.2) is the authorized
 * `mark_executed` caller (the AgentPolicy address); it is kept in the enum here (discriminant order)
 * and POPULATED in M2 via `set_executor` (M1 ships `mark_executed` without the auth gate; M2 tightens it).
 */
export type DataKey = {tag: "Admin", values: void} | {tag: "Verifier", values: void} | {tag: "MerkleRoot", values: void} | {tag: "TreasuryAsset", values: void} | {tag: "QuorumCfg", values: void} | {tag: "Executor", values: void} | {tag: "NextId", values: void} | {tag: "Proposal", values: readonly [u32]} | {tag: "SealedVotes", values: readonly [u32]} | {tag: "Nullifier", values: readonly [Buffer]} | {tag: "VoteWeights", values: void} | {tag: "VoterVoted", values: readonly [u32, string]} | {tag: "YesWeight", values: readonly [u32]} | {tag: "NoWeight", values: readonly [u32]};


/**
 * Internal persistent record projected into ProposalView by `proposal()`.
 */
export interface ProposalRecord {
  action_spec: ActionSpec;
  cap: i128;
  deadline: u64;
  executed: boolean;
  status: ProposalStatus;
  votes_cast: u32;
  weighted_no: Option<i128>;
  weighted_yes: Option<i128>;
}

export type SwapKind = {tag: "Swap", values: void};


export interface QuorumCfg {
  min_voters: u32;
  yes_must_exceed_no: boolean;
}


export interface ActionSpec {
  amount: i128;
  asset_in: string;
  asset_out: string;
  kind: SwapKind;
  min_out: i128;
}


/**
 * Opaque tlock ciphertext envelope (foundation §2.6). Unused in M1.
 */
export interface SealedVote {
  ciphertext: Buffer;
  round: u64;
  sealed_commitment_hash: Buffer;
}


export interface ProposalView {
  action_spec: ActionSpec;
  cap: i128;
  deadline: u64;
  id: u32;
  status: ProposalStatus;
  votes_cast: u32;
  weighted_no: Option<i128>;
  weighted_yes: Option<i128>;
}

export type ProposalStatus = {tag: "Open", values: void} | {tag: "Tallying", values: void} | {tag: "Approved", values: void} | {tag: "Rejected", values: void} | {tag: "Executed", values: void};


/**
 * A single revealed (tlock-decrypted) vote (foundation §2.6). Unused in M1.
 */
export interface VoteDecryption {
  direction: u32;
  sealed_commitment_hash: Buffer;
  weight: i128;
}

export interface Client {
  /**
   * Construct and simulate a init transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize once. `vote_weights` is the M1 plaintext snapshot (voter -> token weight).
   * Admin must auth. Default quorum_cfg per foundation §5: {min_voters:3, yes_must_exceed_no:true}.
   */
  init: ({admin, treasury_asset, quorum_cfg, vote_weights}: {admin: string, treasury_asset: string, quorum_cfg: QuorumCfg, vote_weights: Map<string, i128>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a close transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Close after deadline: compute plaintext weighted tally from running yes/no weights,
   * apply QuorumCfg (yes>no AND votes_cast>=min_voters), set Approved|Rejected. Single close only.
   * M1 PLAINTEXT analogue of foundation §2.2 close_and_reveal (no sealed votes / re-aggregation).
   * DIVERGENCE (recorded, see task header): M1 transitions Open -> Approved|Rejected atomically and
   * never sets ProposalStatus::Tallying (no observable intermediate window in single-shot plaintext
   * close). M5's multi-step close_and_reveal is where Tallying becomes observable.
   * CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!) so the charter's
   * try_close() == Err(Ok(GovError::X)) negatives hold.
   */
  close: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cap_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Approved-proposal spending cap (read by AgentPolicy). ProposalNotFound if absent.
   * CARRY-FORWARD: returns Result<i128, GovError> (NOT panic_with_error!) so the charter's
   * try_cap_of() == Err(Ok(GovError::ProposalNotFound)) negative holds.
   */
  cap_of: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Full read model. weighted_yes/no are None until close. Never leaks tally early.
   */
  proposal: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<ProposalView>>>

  /**
   * Construct and simulate a action_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The approved ActionSpec (read by AgentPolicy). ProposalNotFound if absent.
   * CARRY-FORWARD: returns Result<ActionSpec, GovError> (NOT panic_with_error!).
   */
  action_of: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<ActionSpec>>>

  /**
   * Construct and simulate a cast_vote transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * PLAINTEXT vote (M1). `voter` must auth; `direction` is 1 (yes) or 0 (no).
   * Reads the voter's snapshot weight, prevents double-vote, enforces deadline,
   * updates the running plaintext tally (kept private until `close`), bumps participation.
   * M4/M5 REPLACE this with the sealed signature (foundation §2.2).
   * CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!) so the charter's
   * try_cast_vote() == Err(Ok(GovError::X)) negatives hold.
   */
  cast_vote: ({id, voter, direction}: {id: u32, voter: string, direction: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a weight_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read a voter's snapshot weight (0 if not eligible). View; no auth.
   */
  weight_of: ({voter}: {voter: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a votes_cast transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Participation count (safe — no direction).
   */
  votes_cast: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a is_approved transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * True iff status == Approved (read by AgentPolicy in M2). View; no auth.
   * Returns false for an absent proposal (it is, trivially, not approved).
   */
  is_approved: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a set_executor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configure the authorized executor (the AgentPolicy smart-account wallet address) permitted to
   * call `mark_executed`. Admin-auth (`admin.require_auth()`). Stored at `DataKey::Executor`.
   * Idempotent (admin may re-point it). Set after AgentPolicy is deployed (M2 wires this into the
   * deploy/config flow). This is the "configured AgentPolicy address" referenced by the
   * `mark_executed` auth gate (foundation §2.2). Task M2-0c.
   */
  set_executor: ({executor}: {executor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a mark_executed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Single-shot replay guard. Requires status==Approved & not executed. Sets status -> Executed.
   * AUTH (foundation §2.2, NEW in M2 / Task M2-0c): ONLY the configured executor (the AgentPolicy
   * address stored at `DataKey::Executor` via `set_executor`) may call this — `mark_executed`
   * reads `DataKey::Executor` and `require_auth`s it. A non-executor caller is rejected by the host
   * auth check (the executor's `require_auth` is unsatisfied), NOT by a GovError. The Executor in
   * the hero-loop integration (M2-6) is the AgentPolicy smart-account wallet.
   * CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!) so the charter's
   * try_mark_executed() == Err(Ok(GovError::X)) business-rule negatives hold.
   */
  mark_executed: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create a proposal. Sequential u32 id starting at 0. `cap` bounds ActionSpec.amount;
   * `deadline` = unix-seconds ledger timestamp. Admin auth required.
   * INVARIANTS (foundation §5 / §2.6 / spec §9): ActionSpec.amount must be in (0, cap]; the
   * deadline must be strictly in the future. These guarantee the cap invariant that AgentPolicy
   * (M2) and the safeguard "amount <= proposal cap" rely on, and that the proposal is votable.
   */
  create_proposal: ({action_spec, cap, deadline}: {action_spec: ActionSpec, cap: i128, deadline: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAALZJbml0aWFsaXplIG9uY2UuIGB2b3RlX3dlaWdodHNgIGlzIHRoZSBNMSBwbGFpbnRleHQgc25hcHNob3QgKHZvdGVyIC0+IHRva2VuIHdlaWdodCkuCkFkbWluIG11c3QgYXV0aC4gRGVmYXVsdCBxdW9ydW1fY2ZnIHBlciBmb3VuZGF0aW9uIMKnNToge21pbl92b3RlcnM6MywgeWVzX211c3RfZXhjZWVkX25vOnRydWV9LgAAAAAABGluaXQAAAAEAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAADnRyZWFzdXJ5X2Fzc2V0AAAAAAATAAAAAAAAAApxdW9ydW1fY2ZnAAAAAAfQAAAACVF1b3J1bUNmZwAAAAAAAAAAAAAMdm90ZV93ZWlnaHRzAAAD7AAAABMAAAALAAAAAQAAA+kAAAACAAAH0AAAAAhHb3ZFcnJvcg==",
        "AAAAAAAAAqlDbG9zZSBhZnRlciBkZWFkbGluZTogY29tcHV0ZSBwbGFpbnRleHQgd2VpZ2h0ZWQgdGFsbHkgZnJvbSBydW5uaW5nIHllcy9ubyB3ZWlnaHRzLAphcHBseSBRdW9ydW1DZmcgKHllcz5ubyBBTkQgdm90ZXNfY2FzdD49bWluX3ZvdGVycyksIHNldCBBcHByb3ZlZHxSZWplY3RlZC4gU2luZ2xlIGNsb3NlIG9ubHkuCk0xIFBMQUlOVEVYVCBhbmFsb2d1ZSBvZiBmb3VuZGF0aW9uIMKnMi4yIGNsb3NlX2FuZF9yZXZlYWwgKG5vIHNlYWxlZCB2b3RlcyAvIHJlLWFnZ3JlZ2F0aW9uKS4KRElWRVJHRU5DRSAocmVjb3JkZWQsIHNlZSB0YXNrIGhlYWRlcik6IE0xIHRyYW5zaXRpb25zIE9wZW4gLT4gQXBwcm92ZWR8UmVqZWN0ZWQgYXRvbWljYWxseSBhbmQKbmV2ZXIgc2V0cyBQcm9wb3NhbFN0YXR1czo6VGFsbHlpbmcgKG5vIG9ic2VydmFibGUgaW50ZXJtZWRpYXRlIHdpbmRvdyBpbiBzaW5nbGUtc2hvdCBwbGFpbnRleHQKY2xvc2UpLiBNNSdzIG11bHRpLXN0ZXAgY2xvc2VfYW5kX3JldmVhbCBpcyB3aGVyZSBUYWxseWluZyBiZWNvbWVzIG9ic2VydmFibGUuCkNBUlJZLUZPUldBUkQ6IHJldHVybnMgUmVzdWx0PCgpLCBHb3ZFcnJvcj4gKE5PVCBwYW5pY193aXRoX2Vycm9yISkgc28gdGhlIGNoYXJ0ZXIncwp0cnlfY2xvc2UoKSA9PSBFcnIoT2soR292RXJyb3I6OlgpKSBuZWdhdGl2ZXMgaG9sZC4AAAAAAAAFY2xvc2UAAAAAAAABAAAAAAAAAAJpZAAAAAAABAAAAAEAAAPpAAAAAgAAB9AAAAAIR292RXJyb3I=",
        "AAAAAAAAAOxBcHByb3ZlZC1wcm9wb3NhbCBzcGVuZGluZyBjYXAgKHJlYWQgYnkgQWdlbnRQb2xpY3kpLiBQcm9wb3NhbE5vdEZvdW5kIGlmIGFic2VudC4KQ0FSUlktRk9SV0FSRDogcmV0dXJucyBSZXN1bHQ8aTEyOCwgR292RXJyb3I+IChOT1QgcGFuaWNfd2l0aF9lcnJvciEpIHNvIHRoZSBjaGFydGVyJ3MKdHJ5X2NhcF9vZigpID09IEVycihPayhHb3ZFcnJvcjo6UHJvcG9zYWxOb3RGb3VuZCkpIG5lZ2F0aXZlIGhvbGRzLgAAAAZjYXBfb2YAAAAAAAEAAAAAAAAAAmlkAAAAAAAEAAAAAQAAA+kAAAALAAAH0AAAAAhHb3ZFcnJvcg==",
        "AAAABAAAAAAAAAAAAAAACEdvdkVycm9yAAAAFgAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAAAAAAAITm90QWRtaW4AAAADAAAAAAAAABBQcm9wb3NhbE5vdEZvdW5kAAAABAAAAAAAAAAORGVhZGxpbmVQYXNzZWQAAAAAAAUAAAAAAAAAEkRlYWRsaW5lTm90UmVhY2hlZAAAAAAABgAAAAAAAAANTnVsbGlmaWVyVXNlZAAAAAAAAAcAAAAAAAAAD1dyb25nUHJvcG9zYWxJZAAAAAAIAAAAAAAAAAxJbnZhbGlkUHJvb2YAAAAJAAAAAAAAAA9TdGFsZU1lcmtsZVJvb3QAAAAACgAAAAAAAAAPQWxyZWFkeVJldmVhbGVkAAAAAAsAAAAAAAAAC05vdFJldmVhbGVkAAAAAAwAAAAAAAAADlJldmVhbE1pc21hdGNoAAAAAAANAAAAAAAAAA9BbHJlYWR5RXhlY3V0ZWQAAAAADgAAAAAAAAALTm90QXBwcm92ZWQAAAAADwAAAAAAAAAMQWxyZWFkeVZvdGVkAAAAEAAAAAAAAAALTm90RWxpZ2libGUAAAAAEQAAAAAAAAAKWmVyb1dlaWdodAAAAAAAEgAAAAAAAAAMUXVvcnVtTm90TWV0AAAAEwAAAAAAAAAQSW52YWxpZERpcmVjdGlvbgAAABQAAAAAAAAAFVByb3Bvc2FsQW1vdW50T3ZlckNhcAAAAAAAABUAAAAAAAAADkRlYWRsaW5lSW5QYXN0AAAAAAAW",
        "AAAABQAAAAAAAAAAAAAACFZvdGVDYXN0AAAAAQAAAAl2b3RlX2Nhc3QAAAAAAAACAAAAAAAAAAJpZAAAAAAABAAAAAEAAAAAAAAACW51bGxpZmllcgAAAAAAA+4AAAAgAAAAAAAAAAI=",
        "AAAAAAAAAE9GdWxsIHJlYWQgbW9kZWwuIHdlaWdodGVkX3llcy9ubyBhcmUgTm9uZSB1bnRpbCBjbG9zZS4gTmV2ZXIgbGVha3MgdGFsbHkgZWFybHkuAAAAAAhwcm9wb3NhbAAAAAEAAAAAAAAAAmlkAAAAAAAEAAAAAQAAA+kAAAfQAAAADFByb3Bvc2FsVmlldwAAB9AAAAAIR292RXJyb3I=",
        "AAAAAAAAAJdUaGUgYXBwcm92ZWQgQWN0aW9uU3BlYyAocmVhZCBieSBBZ2VudFBvbGljeSkuIFByb3Bvc2FsTm90Rm91bmQgaWYgYWJzZW50LgpDQVJSWS1GT1JXQVJEOiByZXR1cm5zIFJlc3VsdDxBY3Rpb25TcGVjLCBHb3ZFcnJvcj4gKE5PVCBwYW5pY193aXRoX2Vycm9yISkuAAAAAAlhY3Rpb25fb2YAAAAAAAABAAAAAAAAAAJpZAAAAAAABAAAAAEAAAPpAAAH0AAAAApBY3Rpb25TcGVjAAAAAAfQAAAACEdvdkVycm9y",
        "AAAAAAAAAbpQTEFJTlRFWFQgdm90ZSAoTTEpLiBgdm90ZXJgIG11c3QgYXV0aDsgYGRpcmVjdGlvbmAgaXMgMSAoeWVzKSBvciAwIChubykuClJlYWRzIHRoZSB2b3RlcidzIHNuYXBzaG90IHdlaWdodCwgcHJldmVudHMgZG91YmxlLXZvdGUsIGVuZm9yY2VzIGRlYWRsaW5lLAp1cGRhdGVzIHRoZSBydW5uaW5nIHBsYWludGV4dCB0YWxseSAoa2VwdCBwcml2YXRlIHVudGlsIGBjbG9zZWApLCBidW1wcyBwYXJ0aWNpcGF0aW9uLgpNNC9NNSBSRVBMQUNFIHRoaXMgd2l0aCB0aGUgc2VhbGVkIHNpZ25hdHVyZSAoZm91bmRhdGlvbiDCpzIuMikuCkNBUlJZLUZPUldBUkQ6IHJldHVybnMgUmVzdWx0PCgpLCBHb3ZFcnJvcj4gKE5PVCBwYW5pY193aXRoX2Vycm9yISkgc28gdGhlIGNoYXJ0ZXIncwp0cnlfY2FzdF92b3RlKCkgPT0gRXJyKE9rKEdvdkVycm9yOjpYKSkgbmVnYXRpdmVzIGhvbGQuAAAAAAAJY2FzdF92b3RlAAAAAAAAAwAAAAAAAAACaWQAAAAAAAQAAAAAAAAABXZvdGVyAAAAAAAAEwAAAAAAAAAJZGlyZWN0aW9uAAAAAAAABAAAAAEAAAPpAAAAAgAAB9AAAAAIR292RXJyb3I=",
        "AAAAAAAAAEJSZWFkIGEgdm90ZXIncyBzbmFwc2hvdCB3ZWlnaHQgKDAgaWYgbm90IGVsaWdpYmxlKS4gVmlldzsgbm8gYXV0aC4AAAAAAAl3ZWlnaHRfb2YAAAAAAAABAAAAAAAAAAV2b3RlcgAAAAAAABMAAAABAAAACw==",
        "AAAAAAAAACxQYXJ0aWNpcGF0aW9uIGNvdW50IChzYWZlIOKAlCBubyBkaXJlY3Rpb24pLgAAAAp2b3Rlc19jYXN0AAAAAAABAAAAAAAAAAJpZAAAAAAABAAAAAEAAAAE",
        "AAAAAAAAAI5UcnVlIGlmZiBzdGF0dXMgPT0gQXBwcm92ZWQgKHJlYWQgYnkgQWdlbnRQb2xpY3kgaW4gTTIpLiBWaWV3OyBubyBhdXRoLgpSZXR1cm5zIGZhbHNlIGZvciBhbiBhYnNlbnQgcHJvcG9zYWwgKGl0IGlzLCB0cml2aWFsbHksIG5vdCBhcHByb3ZlZCkuAAAAAAALaXNfYXBwcm92ZWQAAAAAAQAAAAAAAAACaWQAAAAAAAQAAAABAAAAAQ==",
        "AAAAAAAAAaNDb25maWd1cmUgdGhlIGF1dGhvcml6ZWQgZXhlY3V0b3IgKHRoZSBBZ2VudFBvbGljeSBzbWFydC1hY2NvdW50IHdhbGxldCBhZGRyZXNzKSBwZXJtaXR0ZWQgdG8KY2FsbCBgbWFya19leGVjdXRlZGAuIEFkbWluLWF1dGggKGBhZG1pbi5yZXF1aXJlX2F1dGgoKWApLiBTdG9yZWQgYXQgYERhdGFLZXk6OkV4ZWN1dG9yYC4KSWRlbXBvdGVudCAoYWRtaW4gbWF5IHJlLXBvaW50IGl0KS4gU2V0IGFmdGVyIEFnZW50UG9saWN5IGlzIGRlcGxveWVkIChNMiB3aXJlcyB0aGlzIGludG8gdGhlCmRlcGxveS9jb25maWcgZmxvdykuIFRoaXMgaXMgdGhlICJjb25maWd1cmVkIEFnZW50UG9saWN5IGFkZHJlc3MiIHJlZmVyZW5jZWQgYnkgdGhlCmBtYXJrX2V4ZWN1dGVkYCBhdXRoIGdhdGUgKGZvdW5kYXRpb24gwqcyLjIpLiBUYXNrIE0yLTBjLgAAAAAMc2V0X2V4ZWN1dG9yAAAAAQAAAAAAAAAIZXhlY3V0b3IAAAATAAAAAQAAA+kAAAACAAAH0AAAAAhHb3ZFcnJvcg==",
        "AAAAAAAAAr5TaW5nbGUtc2hvdCByZXBsYXkgZ3VhcmQuIFJlcXVpcmVzIHN0YXR1cz09QXBwcm92ZWQgJiBub3QgZXhlY3V0ZWQuIFNldHMgc3RhdHVzIC0+IEV4ZWN1dGVkLgpBVVRIIChmb3VuZGF0aW9uIMKnMi4yLCBORVcgaW4gTTIgLyBUYXNrIE0yLTBjKTogT05MWSB0aGUgY29uZmlndXJlZCBleGVjdXRvciAodGhlIEFnZW50UG9saWN5CmFkZHJlc3Mgc3RvcmVkIGF0IGBEYXRhS2V5OjpFeGVjdXRvcmAgdmlhIGBzZXRfZXhlY3V0b3JgKSBtYXkgY2FsbCB0aGlzIOKAlCBgbWFya19leGVjdXRlZGAKcmVhZHMgYERhdGFLZXk6OkV4ZWN1dG9yYCBhbmQgYHJlcXVpcmVfYXV0aGBzIGl0LiBBIG5vbi1leGVjdXRvciBjYWxsZXIgaXMgcmVqZWN0ZWQgYnkgdGhlIGhvc3QKYXV0aCBjaGVjayAodGhlIGV4ZWN1dG9yJ3MgYHJlcXVpcmVfYXV0aGAgaXMgdW5zYXRpc2ZpZWQpLCBOT1QgYnkgYSBHb3ZFcnJvci4gVGhlIEV4ZWN1dG9yIGluCnRoZSBoZXJvLWxvb3AgaW50ZWdyYXRpb24gKE0yLTYpIGlzIHRoZSBBZ2VudFBvbGljeSBzbWFydC1hY2NvdW50IHdhbGxldC4KQ0FSUlktRk9SV0FSRDogcmV0dXJucyBSZXN1bHQ8KCksIEdvdkVycm9yPiAoTk9UIHBhbmljX3dpdGhfZXJyb3IhKSBzbyB0aGUgY2hhcnRlcidzCnRyeV9tYXJrX2V4ZWN1dGVkKCkgPT0gRXJyKE9rKEdvdkVycm9yOjpYKSkgYnVzaW5lc3MtcnVsZSBuZWdhdGl2ZXMgaG9sZC4AAAAAAA1tYXJrX2V4ZWN1dGVkAAAAAAAAAQAAAAAAAAACaWQAAAAAAAQAAAABAAAD6QAAAAIAAAfQAAAACEdvdkVycm9y",
        "AAAABQAAAAAAAAAAAAAADlByb3Bvc2FsQ2xvc2VkAAAAAAABAAAAD3Byb3Bvc2FsX2Nsb3NlZAAAAAAEAAAAAAAAAAJpZAAAAAAABAAAAAEAAAAAAAAACGFwcHJvdmVkAAAAAQAAAAAAAAAAAAAADHdlaWdodGVkX3llcwAAAAsAAAAAAAAAAAAAAAt3ZWlnaHRlZF9ubwAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1Byb3Bvc2FsQ3JlYXRlZAAAAAABAAAAEHByb3Bvc2FsX2NyZWF0ZWQAAAADAAAAAAAAAAJpZAAAAAAABAAAAAEAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAAAAAAA2NhcAAAAAALAAAAAAAAAAI=",
        "AAAAAAAAAaZDcmVhdGUgYSBwcm9wb3NhbC4gU2VxdWVudGlhbCB1MzIgaWQgc3RhcnRpbmcgYXQgMC4gYGNhcGAgYm91bmRzIEFjdGlvblNwZWMuYW1vdW50OwpgZGVhZGxpbmVgID0gdW5peC1zZWNvbmRzIGxlZGdlciB0aW1lc3RhbXAuIEFkbWluIGF1dGggcmVxdWlyZWQuCklOVkFSSUFOVFMgKGZvdW5kYXRpb24gwqc1IC8gwqcyLjYgLyBzcGVjIMKnOSk6IEFjdGlvblNwZWMuYW1vdW50IG11c3QgYmUgaW4gKDAsIGNhcF07IHRoZQpkZWFkbGluZSBtdXN0IGJlIHN0cmljdGx5IGluIHRoZSBmdXR1cmUuIFRoZXNlIGd1YXJhbnRlZSB0aGUgY2FwIGludmFyaWFudCB0aGF0IEFnZW50UG9saWN5CihNMikgYW5kIHRoZSBzYWZlZ3VhcmQgImFtb3VudCA8PSBwcm9wb3NhbCBjYXAiIHJlbHkgb24sIGFuZCB0aGF0IHRoZSBwcm9wb3NhbCBpcyB2b3RhYmxlLgAAAAAAD2NyZWF0ZV9wcm9wb3NhbAAAAAADAAAAAAAAAAthY3Rpb25fc3BlYwAAAAfQAAAACkFjdGlvblNwZWMAAAAAAAAAAAADY2FwAAAAAAsAAAAAAAAACGRlYWRsaW5lAAAABgAAAAEAAAPpAAAABAAAB9AAAAAIR292RXJyb3I=",
        "AAAABQAAAAAAAAAAAAAAEFByb3Bvc2FsRXhlY3V0ZWQAAAABAAAAEXByb3Bvc2FsX2V4ZWN1dGVkAAAAAAAAAQAAAAAAAAACaWQAAAAAAAQAAAABAAAAAg==",
        "AAAAAgAAAwNTdG9yYWdlIGtleXMuIEJpbmRpbmcgc3Vic2V0IChmb3VuZGF0aW9uIMKnMi4yKTogQWRtaW4sIFZlcmlmaWVyLCBNZXJrbGVSb290LCBUcmVhc3VyeUFzc2V0LApRdW9ydW1DZmcsIEV4ZWN1dG9yLCBOZXh0SWQsIFByb3Bvc2FsKHUzMiksIFNlYWxlZFZvdGVzKHUzMiksIE51bGxpZmllcihCeXRlc048MzI+KS4KTTEtYWRkaXRpdmUgcGxhaW50ZXh0IGtleXMgKHJlY29yZGVkIGRpdmVyZ2VuY2Ug4oCUIHNlZSBwbGFuIGhlYWRlcik6IFZvdGVXZWlnaHRzLCBWb3RlclZvdGVkLApZZXNXZWlnaHQsIE5vV2VpZ2h0LiBUaGVzZSBhcmUgTTEncyBwbGFpbnRleHQgbWVjaGFuaXNtOyBNNC9NNSByZXBsYWNlIFZvdGVyVm90ZWQvWWVzV2VpZ2h0L05vV2VpZ2h0CndpdGggdGhlIFNlYWxlZFZvdGVzICsgTnVsbGlmaWVyIGZsb3cuIFZlcmlmaWVyL01lcmtsZVJvb3QgYXJlIHVudXNlZCBpbiBNMSBidXQga2VwdCBpbiB0aGUgZW51bQpzbyB0aGUgYmluZGluZyBkaXNjcmltaW5hbnQgb3JkZXIgbmV2ZXIgY2hhbmdlcy4gYEV4ZWN1dG9yYCAoZm91bmRhdGlvbiDCpzIuMikgaXMgdGhlIGF1dGhvcml6ZWQKYG1hcmtfZXhlY3V0ZWRgIGNhbGxlciAodGhlIEFnZW50UG9saWN5IGFkZHJlc3MpOyBpdCBpcyBrZXB0IGluIHRoZSBlbnVtIGhlcmUgKGRpc2NyaW1pbmFudCBvcmRlcikKYW5kIFBPUFVMQVRFRCBpbiBNMiB2aWEgYHNldF9leGVjdXRvcmAgKE0xIHNoaXBzIGBtYXJrX2V4ZWN1dGVkYCB3aXRob3V0IHRoZSBhdXRoIGdhdGU7IE0yIHRpZ2h0ZW5zIGl0KS4AAAAAAAAAAAdEYXRhS2V5AAAAAA4AAAAAAAAAAAAAAAVBZG1pbgAAAAAAAAAAAAAAAAAACFZlcmlmaWVyAAAAAAAAAAAAAAAKTWVya2xlUm9vdAAAAAAAAAAAAAAAAAANVHJlYXN1cnlBc3NldAAAAAAAAAAAAAAAAAAACVF1b3J1bUNmZwAAAAAAAAAAAAAAAAAACEV4ZWN1dG9yAAAAAAAAAAAAAAAGTmV4dElkAAAAAAABAAAAAAAAAAhQcm9wb3NhbAAAAAEAAAAEAAAAAQAAAAAAAAALU2VhbGVkVm90ZXMAAAAAAQAAAAQAAAABAAAAAAAAAAlOdWxsaWZpZXIAAAAAAAABAAAD7gAAACAAAAAAAAAAAAAAAAtWb3RlV2VpZ2h0cwAAAAABAAAAAAAAAApWb3RlclZvdGVkAAAAAAACAAAABAAAABMAAAABAAAAAAAAAAlZZXNXZWlnaHQAAAAAAAABAAAABAAAAAEAAAAAAAAACE5vV2VpZ2h0AAAAAQAAAAQ=",
        "AAAAAQAAAEdJbnRlcm5hbCBwZXJzaXN0ZW50IHJlY29yZCBwcm9qZWN0ZWQgaW50byBQcm9wb3NhbFZpZXcgYnkgYHByb3Bvc2FsKClgLgAAAAAAAAAADlByb3Bvc2FsUmVjb3JkAAAAAAAIAAAAAAAAAAthY3Rpb25fc3BlYwAAAAfQAAAACkFjdGlvblNwZWMAAAAAAAAAAAADY2FwAAAAAAsAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAIZXhlY3V0ZWQAAAABAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAOUHJvcG9zYWxTdGF0dXMAAAAAAAAAAAAKdm90ZXNfY2FzdAAAAAAABAAAAAAAAAALd2VpZ2h0ZWRfbm8AAAAD6AAAAAsAAAAAAAAADHdlaWdodGVkX3llcwAAA+gAAAAL",
        "AAAAAgAAAAAAAAAAAAAACFN3YXBLaW5kAAAAAQAAAAAAAAAAAAAABFN3YXA=",
        "AAAAAQAAAAAAAAAAAAAACVF1b3J1bUNmZwAAAAAAAAIAAAAAAAAACm1pbl92b3RlcnMAAAAAAAQAAAAAAAAAEnllc19tdXN0X2V4Y2VlZF9ubwAAAAAAAQ==",
        "AAAAAQAAAAAAAAAAAAAACkFjdGlvblNwZWMAAAAAAAUAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAIYXNzZXRfaW4AAAATAAAAAAAAAAlhc3NldF9vdXQAAAAAAAATAAAAAAAAAARraW5kAAAH0AAAAAhTd2FwS2luZAAAAAAAAAAHbWluX291dAAAAAAL",
        "AAAAAQAAAEJPcGFxdWUgdGxvY2sgY2lwaGVydGV4dCBlbnZlbG9wZSAoZm91bmRhdGlvbiDCpzIuNikuIFVudXNlZCBpbiBNMS4AAAAAAAAAAAAKU2VhbGVkVm90ZQAAAAAAAwAAAAAAAAAKY2lwaGVydGV4dAAAAAAADgAAAAAAAAAFcm91bmQAAAAAAAAGAAAAAAAAABZzZWFsZWRfY29tbWl0bWVudF9oYXNoAAAAAAPuAAAAIA==",
        "AAAAAQAAAAAAAAAAAAAADFByb3Bvc2FsVmlldwAAAAgAAAAAAAAAC2FjdGlvbl9zcGVjAAAAB9AAAAAKQWN0aW9uU3BlYwAAAAAAAAAAAANjYXAAAAAACwAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAAAAAAJpZAAAAAAABAAAAAAAAAAGc3RhdHVzAAAAAAfQAAAADlByb3Bvc2FsU3RhdHVzAAAAAAAAAAAACnZvdGVzX2Nhc3QAAAAAAAQAAAAAAAAAC3dlaWdodGVkX25vAAAAA+gAAAALAAAAAAAAAAx3ZWlnaHRlZF95ZXMAAAPoAAAACw==",
        "AAAAAgAAAAAAAAAAAAAADlByb3Bvc2FsU3RhdHVzAAAAAAAFAAAAAAAAAAAAAAAET3BlbgAAAAAAAAAAAAAACFRhbGx5aW5nAAAAAAAAAAAAAAAIQXBwcm92ZWQAAAAAAAAAAAAAAAhSZWplY3RlZAAAAAAAAAAAAAAACEV4ZWN1dGVk",
        "AAAAAQAAAEpBIHNpbmdsZSByZXZlYWxlZCAodGxvY2stZGVjcnlwdGVkKSB2b3RlIChmb3VuZGF0aW9uIMKnMi42KS4gVW51c2VkIGluIE0xLgAAAAAAAAAAAA5Wb3RlRGVjcnlwdGlvbgAAAAAAAwAAAAAAAAAJZGlyZWN0aW9uAAAAAAAABAAAAAAAAAAWc2VhbGVkX2NvbW1pdG1lbnRfaGFzaAAAAAAD7gAAACAAAAAAAAAABndlaWdodAAAAAAACw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    init: this.txFromJSON<Result<void>>,
        close: this.txFromJSON<Result<void>>,
        cap_of: this.txFromJSON<Result<i128>>,
        proposal: this.txFromJSON<Result<ProposalView>>,
        action_of: this.txFromJSON<Result<ActionSpec>>,
        cast_vote: this.txFromJSON<Result<void>>,
        weight_of: this.txFromJSON<i128>,
        votes_cast: this.txFromJSON<u32>,
        is_approved: this.txFromJSON<boolean>,
        set_executor: this.txFromJSON<Result<void>>,
        mark_executed: this.txFromJSON<Result<void>>,
        create_proposal: this.txFromJSON<Result<u32>>
  }
}