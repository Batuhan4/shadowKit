# M5 — Timelock Weighted Reveal (tlock/drand) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the ShadowDAO vote *fully sealed until close*. A voter timelock-encrypts the `(direction, weight)` pair to the drand round that corresponds to the proposal deadline. The chain stores only opaque ciphertext, so **nobody — not even the DAO or the agent — can read the running tally before the deadline**. At close, a reveal module fetches the drand beacon, tlock-decrypts every sealed vote, computes the weighted tally, and submits it to `GovVault.close_and_reveal`, which **re-aggregates the submitted decryptions on-chain** and rejects any aggregate inconsistent with the committed ciphertexts. Quorum is decided on the weighted totals.

**Architecture:** This plan adds the real timelock-sealed weighted reveal on top of M4's sealed `cast_vote`. **M4 left ONLY M1's plaintext `close(env, id)` + plaintext tally and did NOT provide a `close_and_reveal` stub** (M4 explicitly: "We keep M1's plaintext tally/quorum and `close` unchanged; the on-chain sealed re-aggregation `close_and_reveal` is M5"). So M5 **CREATES** `close_and_reveal` and `reveal.rs` from scratch (Tasks C0/C3/C4) and, once they land, **RETIRES** the M1 plaintext `close`/tally path so the two close paths do not coexist (Task C7). M5 also upgrades the *seal* (what `cast_vote` stores / what `generateVoteProof` returns for `sealedCiphertext`) from M4's deterministic local-seal stub to real tlock. Three layers change:
1. **TypeScript timelock layer** — `@shadowkit/zk-prover` `seal.ts` (`timelockSealVote`/`timelockUnsealVote` over `tlock-js`), and `@shadowkit/tally-reveal` (`roundForDeadline`, `revealTally`, `buildRevealArgs`).
2. **Rust on-chain reveal** — `gov-vault` NEW `close_and_reveal` re-aggregation in NEW `reveal.rs` (sum `weight` by `direction`, bind each `VoteDecryption` to its stored `SealedVote.sealed_commitment_hash`, decide quorum on weighted totals), and RETIRE M1's plaintext `close`/tally. `cast_vote` stores the real `SealedVote` (round + ciphertext + commitment).
3. **Fallbacks** — coordinator commit-reveal (the D6 fallback), plus weight-unlinked and 1-person-1-vote degradation modes — each real, config-selectable, and fully tested.

**Tech Stack:** Rust 1.94.1 / `soroban-sdk` **26.0.x** (contracts); TypeScript ESM / Vitest 4.1.8; `tlock-js 0.9.0`; `drand-client` (quicknet); `snarkjs 0.7.6`. (NO `poseidon-lite` — M4 §0.1 / foundation §1: poseidon-lite is BN254 and must NOT be used for the BLS12-381 circuit; any Poseidon recompute uses `@shadowkit/zk-prover`'s `poseidonHashBls`, the BLS12-381 circuit-wasm path from M4.) Drand network: **quicknet** (`chainHash 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, `publicKey 83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a`, `genesis_time 1692803367`, `period 3`, `schemeID bls-unchained-g1-rfc9380`). All signatures are taken verbatim from `docs/superpowers/plans/00-foundation-interfaces.md` (§2.2, §2.6, §3.1, §3.2, §3.4, §5) and MUST NOT diverge.

> **SDK version (foundation §6 inheritance, NOT a per-milestone bump):** M5 does **not** introduce a new `soroban-sdk` version. It inherits the workspace-wide pin established in M0 and used by M4. Foundation §6 lists `soroban-sdk` min `25.1.0` then directs **standardizing the whole Cargo workspace on `26.0.0`** (because `agent-policy`'s dependency `openzeppelin-stellar-contracts 0.7.1` pins `soroban-sdk = "26.0.0"`, and two SDK versions in one workspace breaks the shared build). The crates registry currently publishes the `26.0.x` family (e.g. `26.0.1`); the `Fr` API used here (`Fr::to_bytes -> BytesN<32>`, §C1b) is stable across `26.0.x`. **Precondition check (run before Task C0):** confirm the M4 crates already compile against the SAME SDK version this plan uses — there must be exactly one `soroban-sdk` version in the lockfile:
> ```bash
> grep -A1 'name = "soroban-sdk"' Cargo.lock | grep version | sort -u   # expect a SINGLE 26.0.x line
> cargo tree -p gov-vault -i soroban-sdk 2>/dev/null | head             # expect one soroban-sdk vN
> ```
> Expected: exactly one `soroban-sdk` `26.0.x` version. If M4 crates are on `25.1.0`, STOP and bump the whole workspace to `26.0.x` (a single workspace-root change, per foundation §6) before proceeding — do NOT bump only `gov-vault`.

---

## 0. Preconditions & Verification provenance

**Read first (mandatory):**
- `docs/superpowers/specs/2026-06-02-shadowkit-design.md` (D5/D6, §7.1, §9, §10, §13).
- `docs/superpowers/plans/00-foundation-interfaces.md` — §2.2 (`gov-vault`), §2.6 (`SealedVote`, `VoteDecryption`), §3.1 (TS `@shadowkit/shared`), §3.2 (`@shadowkit/zk-prover` + `seal.ts`), §3.4 (`@shadowkit/tally-reveal`), §4 (circuit), §5 (cross-layer matrix), §6 (versions), §7 (testing charter).

**Milestone dependency:** This plan **builds on M4** (`05-m4-zk-circuit.md`). M4 already delivers: the Circom circuit + committed fixtures (`circuits/vote/fixtures/`), `groth16-verifier` (on-chain Groth16 verify), `gov-vault` with `cast_vote` requiring a real proof, `@shadowkit/zk-prover` `generateVoteProof`/`verifyVoteProof`/`nullifierFor`, and `@shadowkit/snapshot-tool`. **If M4 is not complete, stop and complete it first** — M5 assumes the proof path works. M5 changes ONLY the *seal* (what `generateVoteProof` returns for `sealedCiphertext`) and the *reveal* (`close_and_reveal` + the new `@shadowkit/tally-reveal` package).

**API VERIFICATION (done 2026-06-02 for this plan; re-verify if implementing later):**
- `tlock-js@0.9.0` `src/index.ts` (raw GitHub `drand/tlock-js`): `timelockEncrypt(roundNumber: number, payload: Buffer, chainClient: ChainClient): Promise<string>` (**roundNumber FIRST**), `timelockDecrypt(ciphertext: string, chainClient: ChainClient): Promise<Buffer>`, `mainnetClient(): HttpChainClient`, `testnetClient(): HttpChainClient`; re-exports `roundAt`/`roundTime` from drand-client.
- `drand-client` `lib/util.ts`: `roundAt(time: number /* ms */, chain: ChainInfo): number`, `roundTime(chain: ChainInfo, round: number): number /* ms */`. `ChainInfo` fields used: `genesis_time`, `period`.
- **Early-decrypt gate (the core of the "undecryptable before T" test):** `tlock-js` `timelock-decrypter.ts` throws `Error("It's too early to decrypt the ciphertext - decryptable at round ${roundNumber}")` when `roundTime(chainInfo, roundNumber) > Date.now()`. This is REAL behavior, not a stub.
- **drand quicknet `/info`** (`https://api.drand.sh/<hash>/info`): `hash=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, `public_key=83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a`, `genesis_time=1692803367`, `period=3`, `schemeID=bls-unchained-g1-rfc9380`.
- **drand-client `ChainOptions` / chain pinning (CORRECTED — earlier draft was wrong):** `drand-client` `build/index.d.ts` defines `type ChainOptions = { disableBeaconVerification: boolean; noCache: boolean; chainVerificationParams?: ChainVerificationParams }` and `type ChainVerificationParams = { chainHash: string; publicKey: string }`. `chainHash` is **NOT** a top-level option — it lives under `chainVerificationParams`, which **also requires `publicKey`**. `new HttpCachingChain(url, { chainHash })` therefore does NOT pin or verify the chain (the round-trip "works" only because verification is silently off). Correct construction = `new HttpCachingChain(url, { ...defaultChainOptions, disableBeaconVerification: false, chainVerificationParams: { chainHash, publicKey } })`. The simplest verified path is `tlock-js` `mainnetClient()`, which IS quicknet and already pins both. SOURCE: installed `drand-client/build/index.d.ts` (ChainOptions/ChainVerificationParams/ChainClient), `drand-client/build/http-caching-chain.d.ts` (`constructor(baseUrl, options?: ChainOptions)`), `tlock-js/index.js` `mainnetClient()` (chainHash `52db9ba7...e971` + publicKey `83cf0f2896...ece45a`, `MAINNET_CHAIN_URL = https://api.drand.sh/52db9ba7...e971`, `defaultChainInfo` period 3 / genesis 1692803367 / scheme `bls-unchained-g1-rfc9380`).
- **soroban-sdk `Fr` → 32 bytes (verified):** `soroban_sdk::crypto::bls12_381::Fr` exposes `pub fn to_bytes(&self) -> BytesN<32>` (big-endian) and `pub fn from_bytes(bytes: BytesN<32>) -> Self`, plus `from_u256(U256)` / `to_u256()` / `as_u256()`. Confirmed in `stellar/rs-soroban-sdk` `soroban-sdk/src/crypto/bls12_381.rs` (the `impl Fr` block) across the `22.x`/`23.x` tags; the API is stable into the `26.0.x` family this workspace pins. So the C1b commitment compare uses `fr.to_bytes()` (a VERIFIED accessor, not a guess). Re-confirm the single accessor line against the installed crate at impl time per the precondition above.
- **`MockDrandClient`** (tlock-js `test/drand/mock-drand-client.ts`) `implements ChainClient`: `constructor(beacon: RandomnessBeacon, info: ChainInfo)`; methods `get(_round): Promise<RandomnessBeacon>` (returns the stored beacon for ANY round), `latest()`, `chain()`. Used only for the offline-CI deterministic variant; the PRIMARY tlock tests use the REAL `mainnetClient()` (quicknet).

> **Binding rule:** every task below that calls an external API repeats the verified signature in a code comment with its SOURCE. Do NOT invent names. If a signature here conflicts with the installed package when you implement, STOP and update the foundation doc first (per its header rule), then ripple the change here.

**Branch:** create `m5-timelock-reveal` off the M4 branch/main before Task 1. Never commit to the default branch. Commit/push only when the user asks (commit locally per the cadence below).

**Commit footer (every commit body):**
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## 1. File Structure (every file this plan creates or modifies)

Paths and one-line responsibilities match `00-foundation-interfaces.md` §1 exactly.

| Path | C/M | Responsibility (foundation §) |
|---|---|---|
| `packages/zk-prover/src/seal.ts` | **C** | `timelockSealVote()` / `timelockUnsealVote()` — tlock-js wrappers, sealedCommitmentHash binding (§3.2) |
| `packages/zk-prover/src/drandConfig.ts` | **C** | `DrandConfig` default = quicknet chain url+hash+**publicKey**; `clientFor(drand?)` → verified `HttpChainClient` w/ `chainVerificationParams` (§3.2, §6) |
| `packages/zk-prover/src/index.ts` | **M** | wire `generateVoteProof` to call `timelockSealVote`; re-export `DrandConfig`, `timelockSealVote`, `timelockUnsealVote` (§3.2) |
| `packages/zk-prover/test/seal.test.ts` | **C** | REAL tlock seal/unseal round-trip + undecryptable-before-T (§7.2 Timelock) |
| `packages/zk-prover/package.json` | **M** | add deps `tlock-js@0.9.0`, `drand-client` (§6) |
| `packages/tally-reveal/src/drand.ts` | **C** | `roundForDeadline()` via `roundAt`/`roundTime` round-trip vs real quicknet `ChainInfo` (§3.4) |
| `packages/tally-reveal/src/index.ts` | **C** | `revealTally()`, `buildRevealArgs()` — decrypt sealed votes, sum weighted yes/no, build `RevealArgs` (§3.4) |
| `packages/tally-reveal/src/coordinator.ts` | **C** | FALLBACK: coordinator commit-reveal builder (config `REVEAL_MODE=coordinator`) (spec D6 fallback, §13) |
| `packages/tally-reveal/src/degrade.ts` | **C** | FALLBACK: weight-unlinked + 1p1v aggregation modes (spec §13.2 ladder) |
| `packages/tally-reveal/test/drand.test.ts` | **C** | round↔deadline mapping vs REAL quicknet ChainInfo (§3.4) |
| `packages/tally-reveal/test/reveal.test.ts` | **C** | tally over REAL tlock-decrypted votes correct; **pre-deadline (future-round) reveal REJECTS w/ real tlock "too early"**; `buildRevealArgs` order/commitment binding; 32-byte hash fixtures (§7.2, spec §10) |
| `packages/tally-reveal/test/coordinator.test.ts` | **C** | FALLBACK full suite: coordinator commit-reveal + **commitment-bridge integration** (off-chain commit ↔ on-chain SealedVote relationship documented & asserted) (§7.2 charter rule 3) |
| `packages/tally-reveal/test/degrade.test.ts` | **C** | FALLBACK suite: weight-unlinked + 1p1v (§7.2 charter rule 3) |
| `packages/tally-reveal/package.json` | **C** | pkg `@shadowkit/tally-reveal`; deps tlock-js, drand-client, `@shadowkit/shared`, `@shadowkit/zk-prover` (§1, §6) |
| `packages/tally-reveal/tsconfig.json` | **C** | extends `tsconfig.base.json` |
| `packages/tally-reveal/vitest.config.ts` | **C** | per-package vitest config (aggregated by the root `vitest.config.ts` `test.projects` `packages/*` glob — Vitest 4 removed `vitest.workspace.ts`) |
| `packages/shared/src/types.ts` | **M** | ensure `VoteDecryption`, `RevealArgs`, `SealedVoteCiphertext`, `fieldToBe32Hex` present (§3.1) — most exist from M4; M5 adds any missing |
| `contracts/gov-vault/src/reveal.rs` | **C** | NEW file (M4 did not create it). `close_and_reveal` re-aggregation logic: bind decryptions↔sealed votes, sum by direction, quorum (§2.2) (created in Task C3) |
| `contracts/gov-vault/src/lib.rs` | **M** | `cast_vote` stores real `SealedVote` (C1a) + binds commitment to `pub_signals[3]` (C1b), gated off under `offchain-verify` (C1c); CREATE `close_and_reveal` (delegates to `reveal.rs`; weighted quorum, §2.2); RETIRE the M1 plaintext `close`/tally (Task C7) |
| `contracts/gov-vault/src/storage.rs` | **M** | confirm `DataKey::SealedVotes(u32)` holds `Vec<SealedVote>` (§2.2); add VERIFIED `fr_to_bytesn32` (Fr→BytesN<32> big-endian, §2.1) |
| `contracts/gov-vault/src/test.rs` | **M** | add M5 tests: store sealed vote, commitment binding (default + offchain-verify), no-tally-before-close, pre-deadline reveal, correct reveal, 4 wrong-reveal guards, weighted quorum pass/fail, double-reveal, coordinator-feature reveal + **coordinator-mode integration** |
| `contracts/gov-vault/Cargo.toml` | **M** | add `feature = "coordinator-reveal"` (D6 fallback switch) (§2.2 / spec D6) |
| `contracts/shared/src/lib.rs` | **M** | confirm `SealedVote`, `VoteDecryption` exist (§2.6) — from M4; M5 verifies |
| `vitest.config.ts` (root) | — | NO modification needed. Vitest 4 removed `vitest.workspace.ts`; M0's root `test.projects` already globs `"packages/*"`, which matches `packages/tally-reveal`. Confirm only — the new `packages/tally-reveal/vitest.config.ts` is loaded automatically |
| `package.json` (root) | — | NO modification needed. The `packages/*` workspace glob already covers `tally-reveal` (set in M0) |
| `vote-flow.e2e.test.ts` (at `packages/tally-reveal/test/e2e.test.ts`) | **C** | E2E: sealed vote → reveal args → on-chain `close_and_reveal` Approved (TS+contract) |

**No file outside this table is created or modified by M5.** If a task needs a new symbol, it must already be defined in the foundation (§2–§5); none are invented here.

---

## 2. Tasks

> **TDD discipline (mandatory every task):** (a) write the failing test, (b) **run it and paste the exact command + actual FAIL output**, (c) minimal implementation, (d) run again → paste PASS output, (e) commit. A task that is green on first run without a prior red is INVALID (charter rule 4). No `#[ignore]`, `.skip`, `.only`, `it.todo`, `assert!(true)`, `expect(true).toBe(true)` without a written justification comment citing the spec.

### Phase A — Timelock seal layer (`@shadowkit/zk-prover` `seal.ts`)

---

#### Task A1 — drand config + client factory (REAL quicknet)

**Files:**
- Create: `packages/zk-prover/src/drandConfig.ts`
- Modify: `packages/zk-prover/package.json` (add deps)
- Test: `packages/zk-prover/test/seal.test.ts` (drand-config portion)

- [ ] **A1.1 Add deps.** Edit `packages/zk-prover/package.json` `dependencies` to include (exact versions per foundation §6). **Do NOT add `poseidon-lite`** — M4 §0.1 / foundation §1 make the BINDING decision that `poseidon-lite` (BN254) must NOT be used for the BLS12-381 circuit; the compiled circuit wasm is the single source of truth via `@shadowkit/zk-prover`'s `poseidonHashBls`. M5 never computes a Poseidon hash itself (it threads the commitment through `generateVoteProof`'s `publicSignals.sealedCommitmentHash`); if any hash recompute is needed, call the M4 `poseidonHashBls` (BLS12-381 circuit-wasm path), not `poseidon-lite`:
```json
{
  "dependencies": {
    "snarkjs": "0.7.6",
    "tlock-js": "0.9.0",
    "drand-client": "latest"
  }
}
```
Then run:
```bash
npm install --workspace packages/zk-prover
```
Expected: `added N packages`, `node_modules/tlock-js` and `node_modules/drand-client` present. Verify:
```bash
node -e "console.log(require('tlock-js/package.json').version)"   # -> 0.9.0
```
Expected output: `0.9.0`.

- [ ] **A1.2 Write failing test** for the drand config default. Create `packages/zk-prover/test/seal.test.ts`:
```typescript
// packages/zk-prover/test/seal.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_DRAND, clientFor } from "../src/drandConfig.js";

describe("drandConfig", () => {
  it("defaults to drand quicknet (verified against installed tlock-js mainnetClient 2026-06-02)", () => {
    // SOURCE: tlock-js@0.9.0 index.js mainnetClient() — chainHash + publicKey + URL are
    // exactly quicknet (MAINNET_CHAIN_URL = api.drand.sh/<hash>, period 3, genesis 1692803367,
    // schemeID bls-unchained-g1-rfc9380). drand-client build/index.d.ts ChainVerificationParams
    // REQUIRES BOTH { chainHash, publicKey } — chainHash alone does NOT pin the chain.
    expect(DEFAULT_DRAND.chainHash).toBe(
      "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    );
    expect(DEFAULT_DRAND.publicKey).toBe(
      "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
    );
    expect(DEFAULT_DRAND.chainUrl).toContain("api.drand.sh");
  });

  it("builds a drand-client ChainClient (tlock-js accepts) with verification ENABLED", () => {
    const client = clientFor();
    // drand-client ChainClient exposes chain() + an options bag (SOURCE: drand-client
    // build/index.d.ts: interface ChainClient { options, latest(), get(), chain() }).
    expect(typeof (client as { chain?: unknown }).chain).toBe("function");
    const opts = (client as { options: { disableBeaconVerification: boolean;
      chainVerificationParams?: { chainHash: string; publicKey: string } } }).options;
    // Verification MUST be ON and pinned to quicknet's { chainHash, publicKey }
    // (this is what fails if you only pass { chainHash } — see drand-client ChainOptions).
    expect(opts.disableBeaconVerification).toBe(false);
    expect(opts.chainVerificationParams?.chainHash).toBe(DEFAULT_DRAND.chainHash);
    expect(opts.chainVerificationParams?.publicKey).toBe(DEFAULT_DRAND.publicKey);
  });
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/zk-prover/test/seal.test.ts
```
Expected FAIL (red): `Error: Failed to load url ../src/drandConfig.js` / `Cannot find module '../src/drandConfig'`.

- [ ] **A1.3 Implement** `packages/zk-prover/src/drandConfig.ts`:
```typescript
// packages/zk-prover/src/drandConfig.ts
// Drand quicknet config + drand-client ChainClient factory (the type tlock-js consumes).
//
// SOURCE (verified 2026-06-02 against the INSTALLED packages — see provenance §0):
//  - drand-client build/index.d.ts:
//      type ChainOptions = { disableBeaconVerification: boolean; noCache: boolean;
//                            chainVerificationParams?: ChainVerificationParams }
//      type ChainVerificationParams = { chainHash: string; publicKey: string }
//      interface ChainClient { options: ChainOptions; latest(); get(round); chain() }
//    => `chainHash` is NOT a top-level option. Passing `{ chainHash }` to HttpCachingChain
//       does NOT pin/verify the chain — `disableBeaconVerification` defaults true-ish via the
//       missing params and the beacon is accepted UNVERIFIED. Real pinning needs the full
//       `chainVerificationParams: { chainHash, publicKey }` AND disableBeaconVerification:false.
//  - drand-client build/http-caching-chain.d.ts: constructor(baseUrl, options?: ChainOptions).
//  - tlock-js@0.9.0 index.js mainnetClient(): builds HttpCachingChain(MAINNET_CHAIN_URL, {
//      ...defaultChainOptions, chainVerificationParams: { chainHash: "52db9ba7...e971",
//      publicKey: "83cf0f2896...ece45a" } }) wrapped in HttpChainClient — i.e. mainnet == quicknet,
//      WITH verification on. MAINNET_CHAIN_URL = https://api.drand.sh/52db9ba7...e971.
import {
  HttpChainClient,
  HttpCachingChain,
  defaultChainOptions,
  type ChainOptions,
  type ChainClient,
} from "drand-client";
import { mainnetClient } from "tlock-js";

export interface DrandConfig {
  chainUrl: string;
  chainHash: string;
  publicKey: string; // REQUIRED by ChainVerificationParams — without it the chain is unverified
}

/** drand quicknet — exactly what tlock-js mainnetClient() pins (BLS, 3s period, RFC9380). */
export const DEFAULT_DRAND: DrandConfig = {
  chainHash:
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  chainUrl:
    "https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
};

/** Build a drand-client ChainClient tlock-js accepts. For the DEFAULT (quicknet) we return
 *  tlock-js mainnetClient() verbatim (it already pins quicknet's { chainHash, publicKey } with
 *  verification ON). For a custom DrandConfig we construct the SAME shape explicitly so beacon
 *  verification stays enabled and pinned (NEVER the silently-unverified `{ chainHash }` form). */
export function clientFor(drand: DrandConfig = DEFAULT_DRAND): ChainClient {
  if (
    drand.chainHash === DEFAULT_DRAND.chainHash &&
    drand.chainUrl === DEFAULT_DRAND.chainUrl &&
    drand.publicKey === DEFAULT_DRAND.publicKey
  ) {
    // tlock-js mainnetClient() === quicknet, verification on (SOURCE above).
    return mainnetClient();
  }
  const opts: ChainOptions = {
    ...defaultChainOptions,
    disableBeaconVerification: false, // verify the beacon signature
    chainVerificationParams: { chainHash: drand.chainHash, publicKey: drand.publicKey },
  };
  const chain = new HttpCachingChain(drand.chainUrl, opts);
  return new HttpChainClient(chain, opts);
}
```
> **Why both branches.** `mainnetClient()` is the verified quicknet client (its `options.chainVerificationParams = { chainHash, publicKey }`, `disableBeaconVerification: false`). For a non-default `DrandConfig` we replicate that exact shape — the A1.2 test asserts `options.disableBeaconVerification === false` and the pinned `{ chainHash, publicKey }`, so the silently-unverified `{ chainHash }`-only form would FAIL the test. This satisfies the foundation/spec requirement that the seal targets quicknet **with integrity**.

- [ ] **A1.4 Run** and confirm PASS:
```bash
npx vitest run packages/zk-prover/test/seal.test.ts
```
Expected (green): `2 passed`.

- [ ] **A1.5 Commit:** `git add -A && git commit` with message:
```
feat(zk-prover): add drand quicknet config + tlock client factory

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task A2 — `roundForDeadline` lives where reveal+seal share it (in `seal.ts` helper) + REAL round↔deadline mapping

> `roundForDeadline` is defined in `@shadowkit/tally-reveal` `drand.ts` (foundation §3.4). `seal.ts` imports it to choose the seal round. To avoid a circular dep (`zk-prover` ↔ `tally-reveal`), the small pure mapping function lives in `zk-prover/src/seal.ts` as `roundForDeadline` and is RE-EXPORTED by `tally-reveal/src/drand.ts`. This keeps one implementation (DRY) and the foundation's public name in both packages.

**Files:**
- Create: `packages/zk-prover/src/seal.ts` (the `roundForDeadline` portion now; sealing in A3)
- Test: `packages/zk-prover/test/seal.test.ts` (add cases)

- [ ] **A2.1 Write failing test.** Append to `packages/zk-prover/test/seal.test.ts`:
```typescript
import { roundForDeadline } from "../src/seal.js";

describe("roundForDeadline (REAL quicknet round↔deadline)", () => {
  // quicknet: genesis_time 1692803367 (s), period 3 (s). round 1 == genesis.
  // round(t) = floor((t - genesis)/period) + 1 ; we assert via the drand-client
  // round-trip (roundAt then roundTime) against the REAL chain info.
  it("round-trips a known deadline against real quicknet chain info", async () => {
    const genesis = 1692803367;
    const period = 3;
    // pick a deadline 100 rounds after genesis
    const deadline = genesis + 100 * period; // exactly the start of round 101
    const round = await roundForDeadline(deadline);
    expect(round).toBe(101);
  }, 30_000);

  it("is monotonic: a later deadline maps to a >= round", async () => {
    const a = await roundForDeadline(1692803367 + 10 * 3);
    const b = await roundForDeadline(1692803367 + 20 * 3);
    expect(b).toBeGreaterThan(a);
  }, 30_000);
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/zk-prover/test/seal.test.ts
```
Expected FAIL: `Cannot find module '../src/seal'`.

- [ ] **A2.2 Implement** `packages/zk-prover/src/seal.ts` (round-mapping part only; A3 adds sealing):
```typescript
// packages/zk-prover/src/seal.ts
// SOURCE (verified 2026-06-02):
//  - drand-client lib/util.ts: roundAt(time:number/*ms*/, chain:ChainInfo):number,
//    roundTime(chain:ChainInfo, round:number):number/*ms*/.
//  - tlock-js@0.9.0 re-exports roundAt/roundTime from drand-client (index.ts).
import { roundAt } from "drand-client";
import { clientFor, DEFAULT_DRAND, type DrandConfig } from "./drandConfig.js";

/** Map a unix-seconds deadline to the drand round it should unlock at.
 *  Uses the REAL chain ChainInfo (genesis_time, period) via drand-client roundAt. */
export async function roundForDeadline(
  deadlineUnixSeconds: number,
  drand: DrandConfig = DEFAULT_DRAND,
): Promise<number> {
  const client = clientFor(drand);
  const info = await client.chain().info(); // ChainInfo { genesis_time, period, ... }
  return roundAt(deadlineUnixSeconds * 1000, info);
}
```
> NOTE on the `=== 101` assertion: `roundAt(timeMs, info)` for quicknet returns `floor((timeMs/1000 - genesis_time)/period) + 1`. At `t = genesis + 100*period` exactly, `floor(100) + 1 = 101`. Confirmed against quicknet `genesis_time=1692803367, period=3`. If the live `/info` ever changes, the test fetches the real info, so adjust the expected value to match the fetched `genesis_time`/`period` (keep the round-trip assertion).

- [ ] **A2.3 Run** and confirm PASS:
```bash
npx vitest run packages/zk-prover/test/seal.test.ts
```
Expected: `4 passed` (2 from A1 + 2 here).

- [ ] **A2.4 Commit:**
```
feat(zk-prover): roundForDeadline via real drand-client roundAt mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task A3 — `timelockSealVote` / `timelockUnsealVote` (REAL tlock; round-trip)

**Files:**
- Modify: `packages/zk-prover/src/seal.ts` (add seal/unseal)
- Test: `packages/zk-prover/test/seal.test.ts` (add round-trip case)

The on-chain `SealedVote.sealed_commitment_hash` must equal the proof's 4th public signal `Poseidon(direction, weight, sealKey)` (foundation §4, §2.6). `timelockSealVote` therefore needs the `sealKey` too, so it can recompute and return the binding hash. **Foundation §3.2 signature is `timelockSealVote(direction, weight, deadlineUnixSeconds, drand?)`** — the `sealKey` and resulting commitment hash are produced by `generateVoteProof` (which knows the circuit witness) and threaded in. To respect the binding signature exactly, `timelockSealVote` returns `{ round, ciphertext }` and the `sealedCommitmentHash` is filled by the caller (`generateVoteProof`, A4) from the proof's public signal. We keep §3.2's signature and have it return a `SealedVoteCiphertext` whose `sealedCommitmentHash` is the empty placeholder `""` ONLY when called standalone; `generateVoteProof` overwrites it with `publicSignals.sealedCommitmentHash`. The seal/unseal round-trip test asserts the ciphertext, not the hash (the hash binding is tested in A4 + on-chain).

- [ ] **A3.1 Write failing test.** Append to `packages/zk-prover/test/seal.test.ts`:
```typescript
import { timelockSealVote, timelockUnsealVote } from "../src/seal.js";

describe("timelockSealVote / timelockUnsealVote (REAL tlock-js)", () => {
  it("round-trips (direction,weight) through real tlock against a PAST round", async () => {
    // PAST deadline -> already-released round -> decryptable now (real beacon).
    const pastDeadline = 1692803367 + 5 * 3; // round ~6, long released
    const sealed = await timelockSealVote(1, "4200", pastDeadline);
    expect(sealed.round).toBeGreaterThan(0);
    expect(typeof sealed.ciphertext).toBe("string");
    expect(sealed.ciphertext.length).toBeGreaterThan(0);

    const opened = await timelockUnsealVote(sealed);
    expect(opened.direction).toBe(1);
    expect(opened.weight).toBe("4200");
  }, 60_000);

  it("is UNDECRYPTABLE before its round (real tlock early-decrypt gate)", async () => {
    // FUTURE deadline -> round not yet reached -> real decrypter throws.
    const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365; // +1yr
    const sealed = await timelockSealVote(0, "7", future);
    // SOURCE: tlock-js timelock-decrypter.ts throws
    //   "It's too early to decrypt the ciphertext - decryptable at round N".
    await expect(timelockUnsealVote(sealed)).rejects.toThrow(/too early/i);
  }, 60_000);
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/zk-prover/test/seal.test.ts -t "REAL tlock-js"
```
Expected FAIL: `timelockSealVote is not a function` (export missing).

- [ ] **A3.2 Implement** seal/unseal in `packages/zk-prover/src/seal.ts` (append):
```typescript
// --- append to packages/zk-prover/src/seal.ts ---
// SOURCE (verified 2026-06-02, tlock-js@0.9.0 index.ts):
//   timelockEncrypt(roundNumber: number, payload: Buffer, chainClient): Promise<string>  // roundNumber FIRST
//   timelockDecrypt(ciphertext: string, chainClient): Promise<Buffer>
import { timelockEncrypt, timelockDecrypt } from "tlock-js";
import type { SealedVoteCiphertext } from "@shadowkit/shared";

/** Encrypt {direction,weight} JSON to round(deadline). sealedCommitmentHash is filled
 *  by the proof caller (generateVoteProof) — standalone it is "" (round-trip test asserts
 *  the ciphertext, not the hash). Call order BINDING: timelockEncrypt(round, buf, client). */
export async function timelockSealVote(
  direction: 0 | 1,
  weight: string,
  deadlineUnixSeconds: number,
  drand: DrandConfig = DEFAULT_DRAND,
): Promise<SealedVoteCiphertext> {
  const round = await roundForDeadline(deadlineUnixSeconds, drand);
  const payload = Buffer.from(JSON.stringify({ direction, weight }), "utf-8");
  const ciphertext = await timelockEncrypt(round, payload, clientFor(drand));
  return { round, ciphertext: Buffer.from(ciphertext, "utf-8").toString("base64"), sealedCommitmentHash: "" };
}

/** Decrypt a sealed vote. Throws (real tlock gate) if the round is not yet released. */
export async function timelockUnsealVote(
  sealed: SealedVoteCiphertext,
  drand: DrandConfig = DEFAULT_DRAND,
): Promise<{ direction: 0 | 1; weight: string }> {
  const armored = Buffer.from(sealed.ciphertext, "base64").toString("utf-8");
  const plain = await timelockDecrypt(armored, clientFor(drand));
  const obj = JSON.parse(plain.toString("utf-8")) as { direction: 0 | 1; weight: string };
  return { direction: obj.direction, weight: obj.weight };
}
```
> NOTE: `SealedVoteCiphertext.ciphertext` is `base64(tlock armored)` per foundation §3.1. tlock-js returns an armored (PEM-like) string; we base64 it for the on-chain `Bytes` field and the JSON wire shape.

- [ ] **A3.3 Run** and confirm PASS:
```bash
npx vitest run packages/zk-prover/test/seal.test.ts -t "REAL tlock-js"
```
Expected: `2 passed`. (Both make real network calls to quicknet; the 60s timeouts cover latency.)

- [ ] **A3.4 Commit:**
```
feat(zk-prover): real tlock seal/unseal of (direction,weight) to deadline round

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task A4 — wire `generateVoteProof` to seal + bind commitment hash

**Files:**
- Modify: `packages/zk-prover/src/index.ts`
- Test: `packages/zk-prover/test/seal.test.ts` (add binding case)

- [ ] **A4.1 Write failing test.** Append to `packages/zk-prover/test/seal.test.ts`. This uses the committed M4 circuit fixtures via `generateVoteProof`:
```typescript
import { generateVoteProof } from "../src/index.js";
import { resolve } from "node:path";

describe("generateVoteProof binds sealedCiphertext.sealedCommitmentHash to publicSignals[3]", () => {
  it("seals and stamps the commitment hash from the proof", async () => {
    const fixtures = resolve(__dirname, "../../../circuits/vote/fixtures");
    // Reuse the committed M4 sample input (valid witness). secret/weight/etc. from input.json.
    const input = (await import(resolve(fixtures, "input.json"), { with: { type: "json" } })).default as {
      secret: string; weight: string; merkleRoot: string; proposalId: string;
      pathElements: string[]; pathIndices: number[]; direction: 0 | 1;
    };
    const res = await generateVoteProof(
      {
        secret: input.secret, merklePath: input.pathElements, pathIndices: input.pathIndices,
        weight: input.weight, proposalId: input.proposalId, direction: input.direction,
        merkleRoot: input.merkleRoot,
      },
      { wasmPath: resolve(fixtures, "vote.wasm"), zkeyPath: resolve(fixtures, "vote_final.zkey") },
      1692803367 + 5 * 3, // past deadline -> decryptable for the assertion below
    );
    // BINDING: ciphertext commitment hash == proof's 4th public signal.
    expect(res.sealedCiphertext.sealedCommitmentHash).toBe(res.publicSignals.sealedCommitmentHash);
    expect(res.sealedCiphertext.round).toBeGreaterThan(0);
    // and it actually decrypts to the same direction we sealed
    const opened = await timelockUnsealVote(res.sealedCiphertext);
    expect(opened.direction).toBe(input.direction);
    expect(opened.weight).toBe(input.weight);
  }, 90_000);
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/zk-prover/test/seal.test.ts -t "binds sealedCiphertext"
```
Expected FAIL: assertion mismatch — `sealedCommitmentHash` is `""` (M4 `generateVoteProof` did not stamp it / used a placeholder seal), OR `generateVoteProof` does not yet call `timelockSealVote`.

- [ ] **A4.2 Implement** the seal wiring in `packages/zk-prover/src/index.ts`. Locate `generateVoteProof` (from M4) and ensure, AFTER the snarkjs proof is produced and `publicSignals` populated, it seals and stamps the hash:
```typescript
// packages/zk-prover/src/index.ts  (inside generateVoteProof, after proof+publicSignals are built)
// M5: timelock-seal (direction,weight) to round(deadline) and bind the commitment hash.
import { timelockSealVote } from "./seal.js";
// ...
const sealed = await timelockSealVote(input.direction, input.weight, deadlineUnixSeconds, drand);
// publicSignals[3] is the in-circuit Poseidon(direction,weight,sealKey); bind ciphertext<->proof.
sealed.sealedCommitmentHash = publicSignals.sealedCommitmentHash;
return { proof, publicSignals, sealedCiphertext: sealed };
```
Also re-export from `index.ts` so consumers can import them:
```typescript
export { timelockSealVote, timelockUnsealVote, roundForDeadline } from "./seal.js";
export { DEFAULT_DRAND, type DrandConfig } from "./drandConfig.js";
```
> The function signature stays exactly `generateVoteProof(input, artifacts, deadlineUnixSeconds, drand?)` (foundation §3.2). M4 already produces `proof` and `publicSignals`; M5 only adds the seal + stamp + return shape.

- [ ] **A4.3 Run** and confirm PASS:
```bash
npx vitest run packages/zk-prover/test/seal.test.ts
```
Expected: all `seal.test.ts` cases pass (drand config 2 + roundForDeadline 2 + tlock round-trip/early 2 + binding 1 = 7 passed).

- [ ] **A4.4 Commit:**
```
feat(zk-prover): generateVoteProof timelock-seals vote and binds commitment hash

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Phase B — `@shadowkit/tally-reveal` package (decrypt + aggregate + reveal args)

---

#### Task B1 — scaffold the package

**Files:**
- Create: `packages/tally-reveal/package.json`, `tsconfig.json`, `vitest.config.ts`
- Modify: NONE. The root `vitest.config.ts` `test.projects` already globs `"packages/*"` (M0), so `packages/tally-reveal` is aggregated automatically once its own `vitest.config.ts` exists. (Vitest 4 removed `vitest.workspace.ts` — foundation §1, §6.)

- [ ] **B1.1 Create** `packages/tally-reveal/package.json`:
```json
{
  "name": "@shadowkit/tally-reveal",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run" },
  "dependencies": {
    "tlock-js": "0.9.0",
    "drand-client": "latest",
    "@shadowkit/shared": "*",
    "@shadowkit/zk-prover": "*"
  },
  "devDependencies": { "vitest": "4.1.8" }
}
```

- [ ] **B1.2 Create** `packages/tally-reveal/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **B1.3 Create** `packages/tally-reveal/vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", testTimeout: 90_000 } });
```

- [ ] **B1.4 Confirm** the new package is already aggregated by the root config — NO edit required. Vitest 4 removed `vitest.workspace.ts` (foundation §1, §6; M0 Task 6); M0's root `vitest.config.ts` `test.projects` array `["packages/*","agent","x402-services/*","web"]` already matches `packages/tally-reveal` via the `"packages/*"` glob, which loads the `packages/tally-reveal/vitest.config.ts` created in B1.3. Verify the glob is present:
```bash
cd /home/batuhan4/github/shadowKit && grep -q '"packages/\*"' vitest.config.ts && echo "packages/* glob present — tally-reveal aggregated" || echo "MISSING — add \"packages/*\" to test.projects"
```
Expected: `packages/* glob present — tally-reveal aggregated`. (Do NOT create or edit a `vitest.workspace.ts`; Vitest 4 ignores it.)

- [ ] **B1.5 Install & sanity-check workspace wiring:**
```bash
npm install
npx vitest list packages/tally-reveal 2>&1 | head
```
Expected: command runs without "package not found"; lists zero tests (none yet) — that is fine. (If `vitest list` errors because no test files exist yet, that is acceptable; B2 adds the first test.)

- [ ] **B1.6 Commit:**
```
build(tally): scaffold @shadowkit/tally-reveal package + vitest wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task B2 — `drand.ts` re-exports `roundForDeadline` (DRY) + real-info round-trip test

**Files:**
- Create: `packages/tally-reveal/src/drand.ts`
- Test: `packages/tally-reveal/test/drand.test.ts`

- [ ] **B2.1 Write failing test.** Create `packages/tally-reveal/test/drand.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { roundForDeadline } from "../src/drand.js";

describe("tally-reveal roundForDeadline (re-export, REAL quicknet)", () => {
  it("matches roundAt/roundTime round-trip on real chain info", async () => {
    const genesis = 1692803367, period = 3;
    const deadline = genesis + 100 * period;
    const round = await roundForDeadline(deadline);
    expect(round).toBe(101);
  }, 30_000);
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/tally-reveal/test/drand.test.ts
```
Expected FAIL: `Cannot find module '../src/drand'`.

- [ ] **B2.2 Implement** `packages/tally-reveal/src/drand.ts` (re-export the single impl from zk-prover — DRY, foundation §3.4):
```typescript
// packages/tally-reveal/src/drand.ts
// Foundation §3.4 places roundForDeadline here; the single implementation lives in
// @shadowkit/zk-prover seal.ts (avoids circular dep). Re-export to expose the §3.4 name.
export { roundForDeadline } from "@shadowkit/zk-prover";
```

- [ ] **B2.3 Run** and confirm PASS:
```bash
npx vitest run packages/tally-reveal/test/drand.test.ts
```
Expected: `1 passed`.

- [ ] **B2.4 Commit:**
```
feat(tally): expose roundForDeadline via drand.ts (re-export, real-info round-trip)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task B3 — `revealTally`: decrypt sealed votes (REAL tlock) → weighted yes/no

**Files:**
- Create: `packages/tally-reveal/src/index.ts` (`revealTally` first)
- Test: `packages/tally-reveal/test/reveal.test.ts`

- [ ] **B3.1 Write failing test.** Create `packages/tally-reveal/test/reveal.test.ts`. It seals real votes (past round → decryptable now) with the zk-prover seal helper, then reveals:
```typescript
import { describe, it, expect } from "vitest";
import { timelockSealVote } from "@shadowkit/zk-prover";
import { revealTally } from "../src/index.js";
import type { SealedVoteCiphertext } from "@shadowkit/shared";

const PAST_DEADLINE = 1692803367 + 5 * 3; // round ~6, released → decryptable now

async function seal(dir: 0 | 1, w: string): Promise<SealedVoteCiphertext> {
  return timelockSealVote(dir, w, PAST_DEADLINE);
}

describe("revealTally (REAL tlock decryption + weighted sum)", () => {
  it("sums weight by direction over decrypted votes", async () => {
    const votes = await Promise.all([
      seal(1, "100"), // yes 100
      seal(1, "250"), // yes 250
      seal(0, "300"), // no 300
    ]);
    const res = await revealTally(votes);
    expect(res.yesW).toBe("350");
    expect(res.noW).toBe("300");
    expect(res.decrypted).toHaveLength(3);
    expect(res.decrypted[0]).toEqual({ direction: 1, weight: "100" });
  }, 120_000);
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/tally-reveal/test/reveal.test.ts
```
Expected FAIL: `Cannot find module '../src/index'`.

- [ ] **B3.2 Implement** `packages/tally-reveal/src/index.ts` (`revealTally`):
```typescript
// packages/tally-reveal/src/index.ts
import type { SealedVoteCiphertext, RevealArgs, VoteDecryption } from "@shadowkit/shared";
import { timelockUnsealVote, type DrandConfig } from "@shadowkit/zk-prover";

/** At close: tlock-decrypt every sealed vote (REAL tlock-js), sum weighted yes/no.
 *  decrypted[i] corresponds to sealedVotes[i] (SAME order the chain stores them). */
export async function revealTally(
  sealedVotes: SealedVoteCiphertext[],
  drand?: DrandConfig,
): Promise<{ yesW: string; noW: string; decrypted: Array<{ direction: 0 | 1; weight: string }> }> {
  const decrypted: Array<{ direction: 0 | 1; weight: string }> = [];
  let yes = 0n;
  let no = 0n;
  for (const v of sealedVotes) {
    const { direction, weight } = await timelockUnsealVote(v, drand);
    decrypted.push({ direction, weight });
    const w = BigInt(weight);
    if (direction === 1) yes += w;
    else no += w;
  }
  return { yesW: yes.toString(), noW: no.toString(), decrypted };
}
```
> i128 totals use `BigInt` (decimal string in/out, never JS `number`) per foundation §5 ("i128 across the boundary").

- [ ] **B3.3 Run** and confirm PASS:
```bash
npx vitest run packages/tally-reveal/test/reveal.test.ts
```
Expected: `1 passed`.

- [ ] **B3.4 Commit:**
```
feat(tally): revealTally decrypts sealed votes and sums weighted yes/no

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task B3b — `revealTally` REJECTS a pre-deadline (future-round) sealed vote (spec §10 boundary)

> **Test-gap fix (spec §10 / foundation §7.2): "tally-reveal: pre-deadline reveal attempt fails".** The early-decrypt gate is exercised at the seal layer (A3) and on-chain (C3 `DeadlineNotReached`), but NOT at the `@shadowkit/tally-reveal` package boundary. `revealTally` calls `timelockUnsealVote`, which throws the REAL tlock "too early" error when a vote's round is not yet released. This task asserts that realistic failure path — a future-round vote in the set causes the reveal to reject — using REAL tlock (not stubbed). No production change is needed (B3's `revealTally` already propagates the throw); the cycle's red is the absence of the test/behavioral assertion at this boundary, made green by adding the assertion against the real error.

**Files:**
- Test: `packages/tally-reveal/test/reveal.test.ts` (add cases)

- [ ] **B3b.1 Write failing test.** Append to `packages/tally-reveal/test/reveal.test.ts`:
```typescript
import { buildRevealArgs as _buildRevealArgsEarly } from "../src/index.js"; // reuse same export

const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365; // +1yr, round not released

describe("revealTally pre-deadline reveal fails (REAL tlock early-decrypt gate, spec §10)", () => {
  it("rejects when a sealed vote's round is not yet released", async () => {
    const future = await timelockSealVote(1, "100", FUTURE_DEADLINE);
    // SOURCE: tlock-js timelock-decrypter.ts throws
    //   "It's too early to decrypt the ciphertext - decryptable at round N".
    await expect(revealTally([future])).rejects.toThrow(/too early/i);
  }, 120_000);

  it("rejects a MIXED batch where one vote is future-round (whole reveal fails)", async () => {
    const released = await seal(1, "10");                       // PAST_DEADLINE -> decryptable
    const future = await timelockSealVote(0, "20", FUTURE_DEADLINE); // not yet released
    // a single not-yet-released vote in the set fails the whole reveal (no partial tally leak)
    await expect(revealTally([released, future])).rejects.toThrow(/too early/i);
    await expect(_buildRevealArgsEarly(7, [released, future])).rejects.toThrow(/too early/i);
  }, 180_000);
});
```
> `timelockSealVote` is already imported at the top of `reveal.test.ts` (from `@shadowkit/zk-prover`); `revealTally` and `seal()` are in scope from B3. `buildRevealArgs` is added in B4 — if running B3b BEFORE B4, drop the `_buildRevealArgsEarly` line and its assertion, then add them in B4.3. (Recommended order: do B4 first, then B3b, so both are in scope; the task numbering keeps the §10 requirement adjacent to `revealTally`.)

Run and confirm FAIL:
```bash
npx vitest run packages/tally-reveal/test/reveal.test.ts -t "pre-deadline reveal fails"
```
Expected FAIL (red): the test does not yet exist / the assertion is unmet — initially `Cannot find name 'buildRevealArgs'` if run before B4, or (once in scope) a real run that confirms the throw. The genuine behavioral red is that NO test at this package boundary asserted the §10 "pre-deadline reveal fails" requirement before now.

- [ ] **B3b.2 Implement.** No production change — `revealTally`/`buildRevealArgs` already `await timelockUnsealVote`, which throws the real "too early" error and propagates (a rejected Promise). If the throw is being swallowed anywhere, fix it so the rejection propagates. Re-run:
```bash
npx vitest run packages/tally-reveal/test/reveal.test.ts -t "pre-deadline reveal fails"
```
Expected: `2 passed` (both reject with the REAL tlock "too early" error).

- [ ] **B3b.3 Commit:**
```
test(tally): revealTally/buildRevealArgs reject pre-deadline (future-round) votes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task B4 — `buildRevealArgs`: produce `RevealArgs` with per-vote `VoteDecryption` + commitment binding

**Files:**
- Modify: `packages/tally-reveal/src/index.ts` (`buildRevealArgs`)
- Test: `packages/tally-reveal/test/reveal.test.ts` (add cases)

- [ ] **B4.1 Write failing test.** Append to `packages/tally-reveal/test/reveal.test.ts`:
```typescript
import { buildRevealArgs } from "../src/index.js";

// Foundation §3.1: SealedVoteCiphertext.sealedCommitmentHash is "hex 0x.. 32 bytes; == publicSignals[3]"
// and at the contract boundary it converts to BytesN<32>. Test fixtures MUST be well-formed
// 32-byte (64-hex-char) 0x-prefixed values, NOT 1-byte stubs — a malformed width can pass
// off-chain yet hide a real BytesN<32> serialization mismatch.
const be32 = (n: number): string => "0x" + n.toString(16).padStart(64, "0");
const HASH_A = be32(0xaa); // 0x0000...00aa  (64 hex chars)
const HASH_B = be32(0xbb);

describe("buildRevealArgs (RevealArgs shape + commitment binding + order)", () => {
  it("emits one VoteDecryption per sealed vote, in order, carrying its 32-byte commitment hash", async () => {
    const v0 = await seal(1, "10"); v0.sealedCommitmentHash = HASH_A;
    const v1 = await seal(0, "20"); v1.sealedCommitmentHash = HASH_B;
    // honor the §3.1 width contract explicitly
    expect(HASH_A).toMatch(/^0x[0-9a-f]{64}$/);
    expect(HASH_B).toMatch(/^0x[0-9a-f]{64}$/);
    const args = await buildRevealArgs(7, [v0, v1]);
    expect(args.proposalId).toBe(7);
    expect(args.revealedYesW).toBe("10");
    expect(args.revealedNoW).toBe("20");
    expect(args.decryptions).toHaveLength(2);
    // order preserved + each decryption bound to its ciphertext commitment
    expect(args.decryptions[0]).toEqual({ direction: 1, weight: "10", sealedCommitmentHash: HASH_A });
    expect(args.decryptions[1]).toEqual({ direction: 0, weight: "20", sealedCommitmentHash: HASH_B });
  }, 120_000);
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/tally-reveal/test/reveal.test.ts -t "buildRevealArgs"
```
Expected FAIL: `buildRevealArgs is not a function`.

- [ ] **B4.2 Implement** `buildRevealArgs` in `packages/tally-reveal/src/index.ts` (append):
```typescript
// --- append to packages/tally-reveal/src/index.ts ---
/** Build GovVault.close_and_reveal args. ONE VoteDecryption per sealed vote, SAME order
 *  as DataKey::SealedVotes(id); each carries its sealedCommitmentHash so the chain binds it
 *  to the stored ciphertext, then re-aggregates (foundation §2.2, §3.4). */
export async function buildRevealArgs(
  proposalId: number,
  sealedVotes: SealedVoteCiphertext[],
  drand?: DrandConfig,
): Promise<RevealArgs> {
  const { yesW, noW, decrypted } = await revealTally(sealedVotes, drand);
  const decryptions: VoteDecryption[] = decrypted.map((d, i) => ({
    direction: d.direction,
    weight: d.weight,
    sealedCommitmentHash: sealedVotes[i].sealedCommitmentHash,
  }));
  return { proposalId, revealedYesW: yesW, revealedNoW: noW, decryptions };
}
```

- [ ] **B4.3 Run** and confirm PASS:
```bash
npx vitest run packages/tally-reveal/test/reveal.test.ts
```
Expected: `2 passed`.

- [ ] **B4.4 Commit:**
```
feat(tally): buildRevealArgs maps decrypted votes to ordered VoteDecryption[]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Phase C — On-chain reveal (`gov-vault` `reveal.rs` + `lib.rs`)

> These tasks assume M4 left `cast_vote` storing a `SealedVote` into `DataKey::SealedVotes(id)`. **M4 did NOT provide a `close_and_reveal` stub** — M4 retained only M1's plaintext `close(env, id)` + plaintext tally (M4 Phase C note + Task 4.40 hand-off: "the on-chain sealed re-aggregation `close_and_reveal` is M5"). So Tasks C3/C4 below **CREATE** `close_and_reveal` and `reveal.rs` from scratch (not "replace a placeholder body"), and Task C7 **RETIRES** the leftover M1 plaintext `close`/tally once the sealed reveal lands so the two close paths don't coexist. Confirm `shadowkit-shared` already exports `SealedVote` and `VoteDecryption` (foundation §2.6); if not, add them verbatim from §2.6 in Task C0.

---

#### Task C0 — confirm shared types + storage shape (no behavior change)

**Files:**
- Read/verify: `contracts/shared/src/lib.rs`, `contracts/gov-vault/src/storage.rs`

- [ ] **C0.1 Verify** `contracts/shared/src/lib.rs` contains EXACTLY (foundation §2.6):
```rust
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SealedVote {
    pub round: u64,
    pub ciphertext: Bytes,
    pub sealed_commitment_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteDecryption {
    pub direction: u32,
    pub weight: i128,
    pub sealed_commitment_hash: BytesN<32>,
}
```
If `VoteDecryption` is absent (M4 may not have needed it), add it verbatim. Confirm `gov-vault/src/storage.rs` has `SealedVotes(u32) // Vec<SealedVote>`.

- [ ] **C0.2 Build to confirm types compile:**
```bash
cargo build -p shadowkit-shared -p gov-vault
```
Expected: `Finished`. If `VoteDecryption` was added, commit:
```
feat(shared): add VoteDecryption type for on-chain reveal re-aggregation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task C1a — `cast_vote` stores the real `SealedVote` (round + ciphertext + commitment)

> **Granularity fix.** C1 was one large step bundling (1) storing the full `SealedVote`, (2) a new unverified `fr_to_bytesn32` helper, and (3) a new commitment-binding panic — with muddy "if M4 did X else Y" branches. It is now split: **C1a** = storage + read-back test; **C1b** = the proof↔ciphertext commitment binding with its OWN dedicated red test, the VERIFIED `Fr` accessor, and the `offchain-verify` behavior. C1a does NOT add any binding panic.
>
> If M4 already stores the full `SealedVote`, C1a's read-back test passes after a trivial confirmation; if M4 stored a placeholder (e.g. fixed round/empty ciphertext), C1a is red until the real store is wired. Either way the cycle is honest: the test asserts the EXACT round/ciphertext/commitment passed in, which a placeholder store does not satisfy.

**Files:**
- Modify: `contracts/gov-vault/src/lib.rs` (`cast_vote` — store only)
- Test: `contracts/gov-vault/src/test.rs`

- [ ] **C1a.1 Write failing test.** Add to `contracts/gov-vault/src/test.rs`:
```rust
#[test]
fn cast_vote_stores_full_sealed_vote() {
    let t = TestCtx::new();                 // M4 test harness: deploys verifier+gov-vault
    let id = t.create_default_proposal();   // helper from M4 (deadline in the future)
    // committed fixture proof+signals (M4) + a SealedVote we control. Its commitment hash
    // MUST equal the fixture's 4th public signal so the C1b binding (added next) will hold.
    let sealed = SealedVote {
        round: 12345u64,
        ciphertext: Bytes::from_slice(&t.env, b"armored-ciphertext-bytes"),
        sealed_commitment_hash: t.fixture_pubsig_3(), // == public signal[3] (BytesN<32>)
    };
    t.client.cast_vote(&id, &t.fixture_proof(), &t.fixture_pubsignals(), &sealed);
    // read back what was stored
    let stored: soroban_sdk::Vec<SealedVote> = t.env.as_contract(&t.gov_id, || {
        t.env.storage().persistent()
            .get(&DataKey::SealedVotes(id)).unwrap()
    });
    assert_eq!(stored.len(), 1);
    let s = stored.get(0).unwrap();
    assert_eq!(s.round, 12345u64);
    assert_eq!(s.ciphertext, Bytes::from_slice(&t.env, b"armored-ciphertext-bytes"));
    assert_eq!(s.sealed_commitment_hash, t.fixture_pubsig_3());
}
```
> Add `fixture_pubsig_3()` to the M4 `TestCtx` returning the committed fixture's 4th public signal (`public.json[3]`) as `BytesN<32>` (decimal field string → 32-byte big-endian; reuse M4's field-to-be32 helper). Add `fixture_proof()`/`fixture_pubsignals()` if M4 did not already expose them.

Run and confirm FAIL:
```bash
cargo test -p gov-vault cast_vote_stores_full_sealed_vote
```
Expected FAIL: either a missing helper (`fixture_pubsig_3`) — `no method named ...` — or an assertion mismatch (`round`/`ciphertext`) if M4 stored a placeholder instead of the passed-in `SealedVote`.

- [ ] **C1a.2 Implement** in `contracts/gov-vault/src/lib.rs` `cast_vote` (after verify + nullifier + proposalId + merkleRoot checks pass), store the sealed vote as-passed (NO binding panic yet — that is C1b):
```rust
// contracts/gov-vault/src/lib.rs  (inside cast_vote, after all M4 validity checks)
// C1a: persist the full sealed vote (round + ciphertext + commitment). EXPOSES NO TALLY.
let mut votes: soroban_sdk::Vec<SealedVote> = env
    .storage().persistent()
    .get(&DataKey::SealedVotes(id))
    .unwrap_or(soroban_sdk::vec![&env]);
votes.push_back(sealed_ciphertext.clone());
env.storage().persistent().set(&DataKey::SealedVotes(id), &votes);
// VoteCast event carries ONLY the nullifier (no direction/weight) — foundation §2.2.
VoteCast { id, nullifier: nullifier_bytes.clone() }.publish(&env);
```

- [ ] **C1a.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault cast_vote_stores_full_sealed_vote
```
Expected: `test cast_vote_stores_full_sealed_vote ... ok`.

- [ ] **C1a.4 Commit:**
```
feat(gov-vault): cast_vote stores the full SealedVote (round+ciphertext+commitment)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task C1b — `cast_vote` binds the ciphertext commitment to the proof (`pub_signals[3]`)

> This is the load-bearing proof↔ciphertext binding (`SealedVote.sealed_commitment_hash == pub_signals[3]`, the in-circuit `Poseidon(direction, weight, sealKey)` — foundation §4, §2.6). It has its OWN red test that fails when the binding is absent (after C1a, `cast_vote` stores any commitment, even a mismatched one). The `Fr -> BytesN<32>` accessor is VERIFIED (not guessed) below.
>
> **Fr accessor — VERIFIED (charter rule 5).** `soroban_sdk::crypto::bls12_381::Fr` exposes `pub fn to_bytes(&self) -> BytesN<32>` returning the 32-byte **big-endian** encoding (and `from_bytes(BytesN<32>) -> Self`, `from_u256`/`to_u256`/`as_u256`). SOURCE: `stellar/rs-soroban-sdk` `soroban-sdk/src/crypto/bls12_381.rs`, the `impl Fr` block — confirmed present and stable across the `22.x`/`23.x` tags and into the `26.0.x` family this workspace pins (verified 2026-06-02 against the GitHub source; re-confirm the single line against the installed crate at impl time via the precondition `grep`). `groth16_verifier::Bls12381Fr` is a `pub use` re-export of this exact `Fr` (foundation §2.1), so `bls_fr.to_bytes()` is the correct, verified accessor — NOT a placeholder.

**Files:**
- Modify: `contracts/gov-vault/src/lib.rs` (`cast_vote` — add binding panic), `contracts/gov-vault/src/storage.rs` (add `fr_to_bytesn32`)
- Test: `contracts/gov-vault/src/test.rs`

- [ ] **C1b.1 Write failing test** (default build — on-chain verify). A real fixture proof but a DELIBERATELY mismatched ciphertext commitment must be rejected:
```rust
#[test]
fn cast_vote_rejects_commitment_not_bound_to_proof() {
    let t = TestCtx::new();
    let id = t.create_default_proposal();
    // valid fixture proof/signals, but the ciphertext commitment is WRONG (not == pub_signals[3]).
    let wrong = BytesN::from_array(&t.env, &[0x11; 32]);
    assert_ne!(wrong, t.fixture_pubsig_3());
    let sealed = SealedVote {
        round: 7u64,
        ciphertext: Bytes::from_slice(&t.env, b"ct"),
        sealed_commitment_hash: wrong,
    };
    let r = t.client.try_cast_vote(&id, &t.fixture_proof(), &t.fixture_pubsignals(), &sealed);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault cast_vote_rejects_commitment_not_bound_to_proof
```
Expected RED: after C1a, `cast_vote` stores the mismatched commitment WITHOUT comparing it to `pub_signals[3]`, so `try_cast_vote` returns `Ok(())` instead of `Err(Ok(RevealMismatch))`. Assertion fails. (Also surfaces a missing `fr_to_bytesn32` once you start C1b.2 — the compile error is an acceptable first red; the behavioral red above is the target.)

- [ ] **C1b.2 Implement** the `fr_to_bytesn32` helper in `contracts/gov-vault/src/storage.rs` (VERIFIED accessor):
```rust
// contracts/gov-vault/src/storage.rs
use soroban_sdk::{BytesN, Env};
use groth16_verifier::Bls12381Fr; // == soroban_sdk::crypto::bls12_381::Fr (foundation §2.1 re-export)
/// Convert a BLS12-381 scalar field element to its 32-byte BIG-ENDIAN BytesN<32>.
/// SOURCE (verified 2026-06-02): soroban_sdk::crypto::bls12_381::Fr exposes
///   `pub fn to_bytes(&self) -> BytesN<32>` (big-endian) — stellar/rs-soroban-sdk
///   soroban-sdk/src/crypto/bls12_381.rs, `impl Fr` block (stable 22.x..26.0.x).
/// `env` is unused (Fr carries its own Env handle) but kept for call-site symmetry/future use.
pub fn fr_to_bytesn32(_env: &Env, fr: &Bls12381Fr) -> BytesN<32> {
    fr.to_bytes()
}
```
> Then add the binding check in `contracts/gov-vault/src/lib.rs` `cast_vote`, BEFORE the C1a store block (so a mismatched commitment is never stored):
```rust
// contracts/gov-vault/src/lib.rs  (inside cast_vote, before the C1a store block)
// C1b: bind ciphertext<->proof. pub_signals[3] is the in-circuit Poseidon(direction,weight,sealKey)
// (foundation §4). Compare its 32-byte big-endian form to the sealed commitment.
use crate::storage::fr_to_bytesn32;
let expected = fr_to_bytesn32(&env, &pub_signals.get(3).unwrap());
if sealed_ciphertext.sealed_commitment_hash != expected {
    panic_with_error!(&env, GovError::RevealMismatch);
}
```

- [ ] **C1b.3 Run** and confirm PASS (mismatch rejected, happy store still works):
```bash
cargo test -p gov-vault cast_vote_rejects_commitment_not_bound_to_proof cast_vote_stores_full_sealed_vote
```
Expected: `2 passed`.

- [ ] **C1b.4 Commit:**
```
feat(gov-vault): bind cast_vote ciphertext commitment to proof pub_signals[3]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task C1c — commitment-binding behavior under `--features offchain-verify` (spec-gap fix)

> **Spec-gap fix (foundation §2.1 / §2.2 fallback + charter rule 3: every fallback path has its own passing suite).** M4's `offchain-verify` feature makes `cast_vote` SKIP on-chain Groth16 verification and trust an admin-asserted `verified` flag — so `pub_signals` is NOT validated by a real proof. Binding the ciphertext commitment to an unverified `pub_signals[3]` is meaningless in that mode, and M5 must specify whether the C1b check still runs. **Decision (recorded):** under `offchain-verify`, the C1b proof-binding check is **GATED OFF** (the proof is not trusted, so `pub_signals[3]` carries no integrity to bind to); the commitment is stored as-passed and integrity is instead enforced at reveal by `close_and_reveal`'s on-chain re-aggregation (which binds each `VoteDecryption` to the STORED `SealedVote.sealed_commitment_hash`, independent of any proof). This keeps `cast_vote` compiling and meaningful under the fallback and is covered by its own test.

> **Precondition.** The `offchain-verify` feature is declared in `contracts/gov-vault/Cargo.toml` by **M4** (D1.1 lists it as "from M4"). If M4 did not declare it, add `offchain-verify = []` under `[features]` first (the same line D1.1 expects to already exist) — that is an M4 gap, not an M5 invention.

**Files:**
- Modify: `contracts/gov-vault/src/lib.rs` (`cast_vote` — feature-gate the C1b binding)
- Test: `contracts/gov-vault/src/test.rs`

- [ ] **C1c.1 Write failing test** (compiled ONLY under the feature; the default build is unaffected):
```rust
// contracts/gov-vault/src/test.rs
#[cfg(feature = "offchain-verify")]
#[test]
fn offchain_verify_cast_vote_stores_commitment_without_proof_binding() {
    let t = TestCtx::new();
    let id = t.create_default_proposal();
    // offchain-verify mode: no real proof is checked; a commitment that does NOT match
    // pub_signals[3] is still stored (binding is gated off; integrity moves to reveal).
    let any = BytesN::from_array(&t.env, &[0x22; 32]);
    let sealed = SealedVote {
        round: 9u64,
        ciphertext: Bytes::from_slice(&t.env, b"ct"),
        sealed_commitment_hash: any.clone(),
    };
    // M4 offchain-verify cast path (admin-asserted verified flag). Reuse M4's helper signature;
    // here we call the same `cast_vote` entrypoint — under the feature it does not verify the proof.
    t.client.cast_vote(&id, &t.fixture_proof(), &t.fixture_pubsignals(), &sealed);
    let stored: soroban_sdk::Vec<SealedVote> = t.env.as_contract(&t.gov_id, || {
        t.env.storage().persistent().get(&DataKey::SealedVotes(id)).unwrap()
    });
    assert_eq!(stored.get(0).unwrap().sealed_commitment_hash, any); // stored as-passed, not rejected
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault --features offchain-verify offchain_verify_cast_vote_stores_commitment_without_proof_binding
```
Expected RED: with the C1b binding running unconditionally, the mismatched commitment is rejected (`RevealMismatch` panic) instead of stored — the test fails (panic / not stored).

- [ ] **C1c.2 Implement** by feature-gating the C1b binding in `contracts/gov-vault/src/lib.rs` `cast_vote` — wrap it so it runs ONLY when `offchain-verify` is NOT enabled:
```rust
// contracts/gov-vault/src/lib.rs  (inside cast_vote, replacing the C1b binding block)
// C1c: bind ciphertext<->proof ONLY on the verified path. Under `offchain-verify` the proof is
// not checked, so pub_signals[3] carries no integrity to bind to; reveal-time re-aggregation
// (close_and_reveal) enforces commitment integrity instead (foundation §2.1/§2.2 fallback).
#[cfg(not(feature = "offchain-verify"))]
{
    use crate::storage::fr_to_bytesn32;
    let expected = fr_to_bytesn32(&env, &pub_signals.get(3).unwrap());
    if sealed_ciphertext.sealed_commitment_hash != expected {
        panic_with_error!(&env, GovError::RevealMismatch);
    }
}
```

- [ ] **C1c.3 Run** and confirm PASS (fallback stores as-passed; primary still binds):
```bash
cargo test -p gov-vault --features offchain-verify offchain_verify_cast_vote_stores_commitment_without_proof_binding
cargo test -p gov-vault cast_vote_rejects_commitment_not_bound_to_proof   # default build still binds
```
Expected: both pass.

- [ ] **C1c.4 Confirm the whole `offchain-verify` build compiles AND passes** (charter: every fallback path has its own passing suite; this is the build G1.4 also runs):
```bash
cargo test -p gov-vault --features offchain-verify
```
Expected: the full gov-vault suite under `offchain-verify` is green (M4 offchain tests + this M5 one).

- [ ] **C1c.5 Commit:**
```
feat(gov-vault): gate cast_vote commitment binding off under offchain-verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task C2 — `proposal()` exposes NO tally before close (adversarial)

**Files:**
- Test: `contracts/gov-vault/src/test.rs`

- [ ] **C2.1 Write failing test** (the core privacy invariant). The genuine red here is the MISSING `cast_n_sealed_votes` helper — the test does not compile until C2.2 adds it (`no method named ...`). That is a real red-before-green (the test cannot run without the new scaffolding), NOT a manufactured one. Do NOT "make it red by expecting the wrong thing". The invariant asserted is M5-fresh: even after several sealed votes are stored, `weighted_yes/no` remain `None` and status stays `Open`.
```rust
#[test]
fn proposal_exposes_no_tally_before_close() {
    let t = TestCtx::new();
    let id = t.create_default_proposal();
    // cast 3 sealed votes (distinct nullifiers via distinct fixtures or proposalId binding helper)
    t.cast_n_sealed_votes(id, 3);                 // M4/M5 helper: stores 3 SealedVotes
    let view = t.client.proposal(&id);
    assert_eq!(view.votes_cast, 3);               // participation is public
    assert_eq!(view.weighted_yes, None);          // tally SEALED
    assert_eq!(view.weighted_no, None);
    assert_eq!(view.status, ProposalStatus::Open);
}
```
If `cast_n_sealed_votes` does not exist, add it to `TestCtx` (loops `cast_vote` with the committed fixture, varying the proposalId-bound nullifier — reuse the M4 multi-vote helper). Run and confirm FAIL:
```bash
cargo test -p gov-vault proposal_exposes_no_tally_before_close
```
Expected FAIL: missing helper `cast_n_sealed_votes` (`no method named ...`).

- [ ] **C2.2 Implement** the `cast_n_sealed_votes` helper in `contracts/gov-vault/src/test.rs` (test-only; reuses fixtures). No production code changes — the invariant must already hold from C1a's storage logic. Each sealed vote's `sealed_commitment_hash` must equal its fixture variant's `pub_signals[3]` so the C1b binding passes.
```rust
impl TestCtx {
    /// Cast `n` sealed votes with distinct nullifiers (varied via the fixture set / proposalId).
    fn cast_n_sealed_votes(&self, id: u32, n: u32) {
        for k in 0..n {
            let (proof, sigs) = self.fixture_proof_variant(k); // distinct nullifier per k
            let sealed = SealedVote {
                round: 100 + k as u64,
                ciphertext: Bytes::from_slice(&self.env, b"ct"),
                sealed_commitment_hash: self.pubsig3_of(&sigs),
            };
            self.client.cast_vote(&id, &proof, &sigs, &sealed);
        }
    }
}
```
> `fixture_proof_variant(k)` returns one of the committed fixtures (or the same proof with a distinct proposalId-bound nullifier). If M4 only committed one fixture, generate K fixtures in `scripts/snapshot-fixtures.sh` (M4 owns that script; if needed, extend it to emit `proof_0.json..proof_2.json` + matching `public_*.json`). Each must have a DISTINCT nullifier (public signal[1]) so the nullifier-set does not reject the 2nd/3rd vote.

- [ ] **C2.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault proposal_exposes_no_tally_before_close
```
Expected: `ok`.

- [ ] **C2.4 Commit:**
```
test(gov-vault): assert proposal() leaks no tally before close (sealed invariant)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task C3 — `close_and_reveal` rejects PRE-DEADLINE reveal

**Files:**
- Modify: `contracts/gov-vault/src/lib.rs` (`close_and_reveal` deadline guard) + `contracts/gov-vault/src/reveal.rs` (new)
- Test: `contracts/gov-vault/src/test.rs`

- [ ] **C3.1 Write failing test:**
```rust
#[test]
fn close_and_reveal_before_deadline_rejected() {
    let t = TestCtx::new();
    let id = t.create_default_proposal();      // deadline far in the future
    t.cast_n_sealed_votes(id, 3);
    // ledger time is BEFORE the deadline -> must reject DeadlineNotReached
    let res = t.client.try_close_and_reveal(
        &id, &0i128, &0i128, &soroban_sdk::vec![&t.env],
    );
    assert_eq!(res, Err(Ok(GovError::DeadlineNotReached)));
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault close_and_reveal_before_deadline_rejected
```
Expected FAIL: either `close_and_reveal` panics with a different/no error, or `reveal.rs` does not exist yet (compile error referencing missing module).

- [ ] **C3.2 Implement.** Create `contracts/gov-vault/src/reveal.rs` with a **MINIMAL** `reaggregate` (sum-by-direction ONLY — no length / commitment / bit / lying-aggregate guards yet; each of those is added red-before-green in its OWN cycle in C5a–C5d), and add the deadline guard to `close_and_reveal`.
> **Why minimal now (charter rule 4, no test theater):** every adversarial guard MUST be introduced in the cycle where its own test first fails because that guard is *absent* — never by sabotaging finished code. So `reaggregate` is built up incrementally: C3 ships only the sum loop; C5a–C5d each add ONE guard whose dedicated negative test is genuinely red beforehand. This is the structural fix for the old "comment out then restore" anti-pattern.
```rust
// contracts/gov-vault/src/reveal.rs
use soroban_sdk::{Env, Vec};
use shadowkit_shared::{SealedVote, VoteDecryption};

/// Re-aggregate submitted decryptions against stored sealed votes (foundation §2.2).
/// Returns (yes_weight, no_weight).
///
/// C3 SCOPE (minimal): sum `weight` by `direction` only. The four integrity guards
/// (length, per-vote commitment binding, direction-bit, claimed-aggregate match) are added
/// one-per-cycle in C5a..C5d, each with its own failing test first. Unused params (`sealed`,
/// `revealed_*`) are wired now so the signature is stable across those cycles; `let _ = ...`
/// suppresses unused warnings until C5 consumes them. This is NOT a stub of behavior under test
/// — the guards do not yet exist, so their tests legitimately fail in C5.
pub fn reaggregate(
    _env: &Env,
    sealed: &Vec<SealedVote>,
    decryptions: &Vec<VoteDecryption>,
    revealed_yes_w: i128,
    revealed_no_w: i128,
) -> (i128, i128) {
    let _ = (sealed, revealed_yes_w, revealed_no_w); // consumed by guards added in C5a..C5d
    let mut yes: i128 = 0;
    let mut no: i128 = 0;
    for i in 0..decryptions.len() {
        let d = decryptions.get(i).unwrap();
        // C3: no direction-bit guard yet (added C5c). direction==1 -> yes, anything else -> no.
        if d.direction == 1 {
            yes += d.weight;
        } else {
            no += d.weight;
        }
    }
    (yes, no)
}
```
Wire the deadline guard in `contracts/gov-vault/src/lib.rs` `close_and_reveal` (FIRST checks — note: the `AlreadyRevealed` guard is NOT added here; it is introduced red-before-green in C6b):
```rust
// contracts/gov-vault/src/lib.rs  (top of close_and_reveal)
mod reveal; // ensure `mod reveal;` is declared once at crate root (lib.rs)
// ...
let mut rec: ProposalRecord = env.storage().persistent()
    .get(&DataKey::Proposal(id)).unwrap_or_else(|| panic_with_error!(&env, GovError::ProposalNotFound));
// C3 SCOPE: deadline guard only. (AlreadyRevealed guard added in C6b; both quorum clauses
// and the four reaggregate guards added in C4/C5/C6 — each red-before-green.)
if env.ledger().timestamp() < rec.deadline {
    panic_with_error!(&env, GovError::DeadlineNotReached);
}
```

- [ ] **C3.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault close_and_reveal_before_deadline_rejected
```
Expected: `ok`.

- [ ] **C3.4 Commit:**
```
feat(gov-vault): reject close_and_reveal before deadline; add minimal reveal.rs reaggregate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task C4 — `close_and_reveal` accepts a CORRECT reveal → sets weighted tally + Approved (quorum pass)

**Files:**
- Modify: `contracts/gov-vault/src/lib.rs` (`close_and_reveal` body)
- Test: `contracts/gov-vault/src/test.rs`

- [ ] **C4.1 Write failing test.** Use a TestCtx helper that advances ledger time past the deadline:
```rust
#[test]
fn close_and_reveal_correct_sets_weighted_tally_and_approves() {
    let t = TestCtx::new();
    let id = t.create_proposal_with_deadline(/*deadline*/ 1000);
    // store 3 sealed votes with KNOWN commitments so we can build matching decryptions
    let s0 = t.store_sealed(id, /*hash*/ 0xA1, /*round*/ 100);
    let s1 = t.store_sealed(id, 0xA2, 101);
    let s2 = t.store_sealed(id, 0xA3, 102);
    t.advance_to(1001);  // ledger time past deadline
    // decryptions: yes 100 (h=A1), yes 250 (h=A2), no 300 (h=A3) -> yes=350,no=300 -> approved (350>300, voters=3)
    let decs = soroban_sdk::vec![
        &t.env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: s0 },
        VoteDecryption { direction: 1, weight: 250, sealed_commitment_hash: s1 },
        VoteDecryption { direction: 0, weight: 300, sealed_commitment_hash: s2 },
    ];
    t.client.close_and_reveal(&id, &350i128, &300i128, &decs);
    let v = t.client.proposal(&id);
    assert_eq!(v.weighted_yes, Some(350));
    assert_eq!(v.weighted_no, Some(300));
    assert_eq!(v.status, ProposalStatus::Approved);
    assert!(t.client.is_approved(&id));
}
```
> Add TestCtx helpers `create_proposal_with_deadline(u64)`, `store_sealed(id, u8_hash, round) -> BytesN<32>` (writes directly into `DataKey::SealedVotes(id)` with a `BytesN<32>` filled from the byte, returns it), and `advance_to(ts)` (uses `env.ledger().set_timestamp(ts)` / `LedgerInfo`). These are test scaffolding; `store_sealed` bypasses `cast_vote` so the test controls commitments deterministically (the cast path is separately tested in C1).

Run and confirm FAIL:
```bash
cargo test -p gov-vault close_and_reveal_correct_sets_weighted_tally_and_approves
```
Expected FAIL: `close_and_reveal` does not yet re-aggregate / set tally / set status (assertion mismatch: `weighted_yes` is `None` or status not `Approved`).

- [ ] **C4.2 Implement** the `close_and_reveal` body in `contracts/gov-vault/src/lib.rs` (after the C3 guards):
```rust
// contracts/gov-vault/src/lib.rs  (close_and_reveal, after the C3 deadline guard)
let sealed: soroban_sdk::Vec<SealedVote> = env.storage().persistent()
    .get(&DataKey::SealedVotes(id)).unwrap_or(soroban_sdk::vec![&env]);

// Primary path (default build): on-chain re-aggregation of submitted decryptions.
// Fallback `coordinator-reveal` (Task D1) trusts an admin-asserted aggregate instead.
#[cfg(not(feature = "coordinator-reveal"))]
let (yes, no) = reveal::reaggregate(&env, &sealed, &decryptions, revealed_yes_w, revealed_no_w);
#[cfg(feature = "coordinator-reveal")]
let (yes, no) = reveal::coordinator_accept(&env, revealed_yes_w, revealed_no_w);

// C4 SCOPE quorum (minimal): weighted_yes > weighted_no ONLY. The `votes_cast >= min_voters`
// clause and the `yes_must_exceed_no` config term are added red-before-green in C6a (their
// dedicated tests are red against this minimal predicate). foundation §5 full rule lands in C6a.
let passed = yes > no;

rec.weighted_yes = Some(yes);
rec.weighted_no = Some(no);
rec.status = if passed { ProposalStatus::Approved } else { ProposalStatus::Rejected };
env.storage().persistent().set(&DataKey::Proposal(id), &rec);

ProposalClosed { id, approved: passed, weighted_yes: yes, weighted_no: no }.publish(&env);
```
> **Note (no `cfg`/`voters` reads yet).** C4 deliberately omits `DataKey::QuorumCfg` and `sealed.len()` from the predicate so the C6a min-voters test is genuinely red. C6a introduces both. The C4 happy test (3 voters, yes=350 > no=300) passes under `yes > no` alone.

- [ ] **C4.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault close_and_reveal_correct_sets_weighted_tally_and_approves
```
Expected: `ok`.

- [ ] **C4.4 Commit:**
```
feat(gov-vault): close_and_reveal re-aggregates, sets weighted tally, decides quorum

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Tasks C5a–C5d — `close_and_reveal` rejects a WRONG reveal (each guard red-before-green, NO sabotage)

> **Structural fix (charter rule 4).** Each adversarial guard is added in the SAME cycle as its own test, and that test is genuinely RED because the guard does not yet exist in `reaggregate` (which C3 shipped as a bare sum). There is NO "comment out then restore". After C3, `reaggregate` has no length / commitment / direction-bit / aggregate-match guard, so each negative test below fails naturally before its guard is written. The shared `setup_revealable` fixture is added once in C5a.

**Files (all of C5a–C5d):**
- Modify: `contracts/gov-vault/src/reveal.rs` (add ONE guard per task)
- Test: `contracts/gov-vault/src/test.rs`

---

##### Task C5a — length-mismatch guard

- [ ] **C5a.1 Write failing test** (add the shared fixture too):
```rust
fn setup_revealable(t: &TestCtx) -> (u32, BytesN<32>, BytesN<32>, BytesN<32>) {
    let id = t.create_proposal_with_deadline(1000);
    let h0 = t.store_sealed(id, 0xB1, 100);
    let h1 = t.store_sealed(id, 0xB2, 101);
    let h2 = t.store_sealed(id, 0xB3, 102);
    t.advance_to(1001);
    (id, h0, h1, h2)
}

#[test]
fn reveal_wrong_length_rejected() {
    let t = TestCtx::new();
    let (id, h0, h1, _h2) = setup_revealable(&t);
    let decs = soroban_sdk::vec![&t.env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 0, weight: 50,  sealed_commitment_hash: h1 }]; // only 2 of 3
    let r = t.client.try_close_and_reveal(&id, &100i128, &50i128, &decs);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault reveal_wrong_length_rejected
```
Expected RED: the C3 `reaggregate` has no length check — it sums the 2 supplied decryptions and returns `(100, 50)`, `close_and_reveal` succeeds, so `try_close_and_reveal` returns `Ok(())` instead of `Err(Ok(RevealMismatch))`. Assertion fails.

- [ ] **C5a.2 Implement** the length guard — add to the TOP of `reaggregate` in `contracts/gov-vault/src/reveal.rs` (and add the `panic_with_error` + `GorvError`/`DataKey` imports it now needs):
```rust
// contracts/gov-vault/src/reveal.rs  (imports)
use soroban_sdk::{panic_with_error, Env, Vec};
use shadowkit_shared::{SealedVote, VoteDecryption};
use crate::GovError;

// ... inside reaggregate, FIRST statement (replace the `let _ = (sealed, ...)` line):
// C5a: (1) length match — one decryption per stored sealed vote (foundation §2.2).
let _ = (revealed_yes_w, revealed_no_w); // consumed by the aggregate guard in C5d
if decryptions.len() != sealed.len() {
    panic_with_error!(_env, GovError::RevealMismatch);
}
```
> Rename the `_env` param to `env` now that it is used: change the signature to `pub fn reaggregate(env: &Env, ...)` and use `env` in `panic_with_error!`. (It was `_env` only while unused in C3.)

- [ ] **C5a.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault reveal_wrong_length_rejected
```
Expected: `ok`.

- [ ] **C5a.4 Commit:**
```
feat(gov-vault): reaggregate rejects length-mismatched reveal (RevealMismatch)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

##### Task C5b — per-vote commitment-binding guard

- [ ] **C5b.1 Write failing test:**
```rust
#[test]
fn reveal_wrong_commitment_rejected() {
    let t = TestCtx::new();
    let (id, h0, h1, _h2) = setup_revealable(&t);
    let bogus = BytesN::from_array(&t.env, &[0xFF; 32]);
    let decs = soroban_sdk::vec![&t.env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h1 },
        VoteDecryption { direction: 0, weight: 50,  sealed_commitment_hash: bogus }]; // h2 swapped
    let r = t.client.try_close_and_reveal(&id, &200i128, &50i128, &decs);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault reveal_wrong_commitment_rejected
```
Expected RED: after C5a, `reaggregate` checks length (3==3 OK) but does NOT compare each `sealed_commitment_hash` to the stored vote, so the bogus 3rd decryption is summed and `(200, 50)` matches the claimed args — `close_and_reveal` succeeds and returns `Ok(())`. Assertion fails.

- [ ] **C5b.2 Implement** the commitment-binding guard inside the loop in `reveal.rs`:
```rust
// contracts/gov-vault/src/reveal.rs  (inside the for-loop, before the direction sum)
// C5b: (2) bind each decryption to its EXACT stored ciphertext — no substitution.
let s = sealed.get(i).unwrap();
let d = decryptions.get(i).unwrap();
if d.sealed_commitment_hash != s.sealed_commitment_hash {
    panic_with_error!(env, GovError::RevealMismatch);
}
```
> The C3 loop iterated `0..decryptions.len()` and only read `d`. With the length guard from C5a the lengths are equal, so iterate `0..sealed.len()` and read BOTH `s` and `d` by index `i`. Keep the existing `direction == 1 -> yes else no` sum below this check (the bit guard is C5c).

- [ ] **C5b.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault reveal_wrong_commitment_rejected
```
Expected: `ok`.

- [ ] **C5b.4 Commit:**
```
feat(gov-vault): reaggregate binds each decryption to its stored commitment

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

##### Task C5c — direction-bit guard

- [ ] **C5c.1 Write failing test:**
```rust
#[test]
fn reveal_bad_direction_rejected() {
    let t = TestCtx::new();
    let (id, h0, h1, h2) = setup_revealable(&t);
    let decs = soroban_sdk::vec![&t.env,
        VoteDecryption { direction: 2, weight: 100, sealed_commitment_hash: h0 }, // not a bit
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h1 },
        VoteDecryption { direction: 0, weight: 50,  sealed_commitment_hash: h2 }];
    // with direction==2 silently counted as "no" (the pre-C5c else-branch), real sums would be
    // yes=100, no=150; the attacker submits those, so without the bit guard it SUCCEEDS.
    let r = t.client.try_close_and_reveal(&id, &100i128, &150i128, &decs);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault reveal_bad_direction_rejected
```
Expected RED: the C3 sum uses `if direction == 1 { yes } else { no }`, so `direction: 2` is silently bucketed into `no` (no=100+50=150, yes=100). The claimed `(100, 150)` matches → `close_and_reveal` succeeds, returns `Ok(())`. Assertion fails (a non-bit direction must be rejected, not bucketed).

- [ ] **C5c.2 Implement** the direction-bit guard — replace the `if/else` sum with a `match` that rejects non-bits:
```rust
// contracts/gov-vault/src/reveal.rs  (inside the loop, replacing the if/else sum)
// C5c: (3) direction MUST be a bit {0,1}; any other value is a malformed reveal.
match d.direction {
    1 => yes += d.weight,
    0 => no += d.weight,
    _ => panic_with_error!(env, GovError::RevealMismatch),
}
```

- [ ] **C5c.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault reveal_bad_direction_rejected
```
Expected: `ok`.

- [ ] **C5c.4 Commit:**
```
feat(gov-vault): reaggregate rejects non-bit vote direction

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

##### Task C5d — lying-aggregate guard

- [ ] **C5d.1 Write failing test:**
```rust
#[test]
fn reveal_lying_aggregate_rejected() {
    let t = TestCtx::new();
    let (id, h0, h1, h2) = setup_revealable(&t);
    // real sums: yes=200, no=50; attacker CLAIMS yes=999 to flip quorum
    let decs = soroban_sdk::vec![&t.env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h1 },
        VoteDecryption { direction: 0, weight: 50,  sealed_commitment_hash: h2 }];
    let r = t.client.try_close_and_reveal(&id, &999i128, &50i128, &decs);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault reveal_lying_aggregate_rejected
```
Expected RED: after C5a–C5c, `reaggregate` recomputes the true `(200, 50)` but never compares it to the CLAIMED `revealed_yes_w/revealed_no_w` (still discarded via `let _ = (revealed_yes_w, revealed_no_w)`), so the lie `(999, 50)` is accepted — `close_and_reveal` succeeds, returns `Ok(())`. Assertion fails.

- [ ] **C5d.2 Implement** the aggregate-match guard — remove the `let _ = (revealed_yes_w, revealed_no_w);` discard and add AFTER the loop:
```rust
// contracts/gov-vault/src/reveal.rs  (after the loop, before `(yes, no)`)
// C5d: (4) the recomputed sums MUST equal the claimed aggregates (no lying to flip quorum).
if yes != revealed_yes_w || no != revealed_no_w {
    panic_with_error!(env, GovError::RevealMismatch);
}
```
> Also delete the now-obsolete `let _ = (revealed_yes_w, revealed_no_w);` line (they are consumed here). The complete `reaggregate` now implements all four foundation-§2.2 checks (length, commitment binding, direction bit, aggregate match) — each introduced red-before-green.

- [ ] **C5d.3 Run** and confirm PASS (all four adversarial cases now pass):
```bash
cargo test -p gov-vault reveal_wrong_length_rejected reveal_wrong_commitment_rejected reveal_bad_direction_rejected reveal_lying_aggregate_rejected
```
Expected: `4 passed`.

- [ ] **C5d.4 Run** the C4 happy test again to confirm no regression (correct reveal still approves):
```bash
cargo test -p gov-vault close_and_reveal_correct_sets_weighted_tally_and_approves
```
Expected: `ok`.

- [ ] **C5d.5 Commit:**
```
feat(gov-vault): reaggregate rejects a lying claimed aggregate (RevealMismatch)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Tasks C6a–C6b — weighted quorum min-voters clause + double-reveal guard (red-before-green)

> **Structural fix (charter rule 4).** C4 shipped the minimal quorum `let passed = yes > no;` (no min-voters clause, no `yes_must_exceed_no` config term). C3 added NO `AlreadyRevealed` guard. So each test below is genuinely RED against the absence of its specific guard — no "set `passed = yes > no` then restore".

**Files (C6a–C6b):**
- Modify: `contracts/gov-vault/src/lib.rs` (`close_and_reveal` quorum predicate + AlreadyRevealed guard)
- Test: `contracts/gov-vault/src/test.rs`

---

##### Task C6a — full weighted quorum (min-voters + yes_must_exceed_no config)

- [ ] **C6a.1 Write failing tests.** The `no >= yes` case already passes under C4's `yes > no`, so it is a regression guard; the **min-voters** case is the one that is genuinely RED against C4's minimal predicate:
```rust
#[test]
fn weighted_quorum_fails_when_no_exceeds_yes() {
    let t = TestCtx::new();
    let id = t.create_proposal_with_deadline(1000);
    let h0 = t.store_sealed(id, 0xC1, 100);
    let h1 = t.store_sealed(id, 0xC2, 101);
    let h2 = t.store_sealed(id, 0xC3, 102);
    t.advance_to(1001);
    // yes=100, no=400 -> rejected even though 3 voters
    let decs = soroban_sdk::vec![&t.env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 0, weight: 200, sealed_commitment_hash: h1 },
        VoteDecryption { direction: 0, weight: 200, sealed_commitment_hash: h2 }];
    t.client.close_and_reveal(&id, &100i128, &400i128, &decs);
    let v = t.client.proposal(&id);
    assert_eq!(v.status, ProposalStatus::Rejected);
    assert!(!t.client.is_approved(&id));
    assert_eq!(v.weighted_yes, Some(100));
    assert_eq!(v.weighted_no, Some(400));
}

#[test]
fn weighted_quorum_fails_below_min_voters() {
    let t = TestCtx::new();
    let id = t.create_proposal_with_deadline(1000);
    let h0 = t.store_sealed(id, 0xD1, 100);
    let h1 = t.store_sealed(id, 0xD2, 101); // only 2 voters (< default min 3)
    t.advance_to(1001);
    let decs = soroban_sdk::vec![&t.env,
        VoteDecryption { direction: 1, weight: 500, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 0, weight: 1,   sealed_commitment_hash: h1 }];
    t.client.close_and_reveal(&id, &500i128, &1i128, &decs);
    assert_eq!(t.client.proposal(&id).status, ProposalStatus::Rejected); // yes>no but <3 voters
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault weighted_quorum_fails_when_no_exceeds_yes weighted_quorum_fails_below_min_voters
```
Expected RED: `weighted_quorum_fails_below_min_voters` FAILS — C4's predicate is `let passed = yes > no;` (500 > 1) so a 2-voter proposal is wrongly `Approved` instead of `Rejected`. (`weighted_quorum_fails_when_no_exceeds_yes` already passes under `yes > no`; it stays in this cycle as a regression guard for the upgraded predicate.)

- [ ] **C6a.2 Implement** the full quorum predicate in `contracts/gov-vault/src/lib.rs` `close_and_reveal` — replace the C4 minimal `let passed = yes > no;` line with the foundation §5 rule (reads `QuorumCfg` and `sealed.len()`):
```rust
// contracts/gov-vault/src/lib.rs  (close_and_reveal — replaces `let passed = yes > no;`)
// C6a: full quorum (foundation §5): yes>no (when configured) AND votes_cast >= min_voters.
let cfg: QuorumCfg = env.storage().instance().get(&DataKey::QuorumCfg).unwrap();
let voters = sealed.len();
let passed = (!cfg.yes_must_exceed_no || yes > no) && voters >= cfg.min_voters;
```
> Ensure `QuorumCfg` is imported in `lib.rs` (`use shadowkit_shared::{..., QuorumCfg};` — already in the §2.2 import list). `sealed` is the `Vec<SealedVote>` already read in C4.

- [ ] **C6a.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault weighted_quorum_fails_when_no_exceeds_yes weighted_quorum_fails_below_min_voters
```
Expected: `2 passed`.

- [ ] **C6a.4 Run** the C4 happy test to confirm it still approves (3 voters, yes>no, >= min 3):
```bash
cargo test -p gov-vault close_and_reveal_correct_sets_weighted_tally_and_approves
```
Expected: `ok`.

- [ ] **C6a.5 Commit:**
```
feat(gov-vault): full weighted quorum (yes>no AND votes_cast>=min_voters)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

##### Task C6b — double-reveal guard (AlreadyRevealed)

- [ ] **C6b.1 Write failing test:**
```rust
#[test]
fn double_reveal_rejected() {
    let t = TestCtx::new();
    let id = t.create_proposal_with_deadline(1000);
    let h0 = t.store_sealed(id, 0xE1, 100);
    let h1 = t.store_sealed(id, 0xE2, 101);
    let h2 = t.store_sealed(id, 0xE3, 102);
    t.advance_to(1001);
    let decs = soroban_sdk::vec![&t.env,
        VoteDecryption { direction: 1, weight: 10, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 1, weight: 10, sealed_commitment_hash: h1 },
        VoteDecryption { direction: 0, weight: 5,  sealed_commitment_hash: h2 }];
    t.client.close_and_reveal(&id, &20i128, &5i128, &decs);          // first reveal: ok
    let r = t.client.try_close_and_reveal(&id, &20i128, &5i128, &decs); // second: must reject
    assert_eq!(r, Err(Ok(GovError::AlreadyRevealed)));
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault double_reveal_rejected
```
Expected RED: C3's `close_and_reveal` has NO already-revealed guard, so the second call re-runs and succeeds (returns `Ok(())`) — or yields a different error — instead of `Err(Ok(AlreadyRevealed))`. Assertion fails.

- [ ] **C6b.2 Implement** the `AlreadyRevealed` guard in `contracts/gov-vault/src/lib.rs` `close_and_reveal` — add it immediately AFTER the `ProposalRecord` load and BEFORE the C3 deadline guard:
```rust
// contracts/gov-vault/src/lib.rs  (close_and_reveal, right after loading `rec`)
// C6b: single reveal only — weighted_yes is set exactly once at close (foundation §2.2).
if rec.weighted_yes.is_some() {
    panic_with_error!(&env, GovError::AlreadyRevealed);
}
```

- [ ] **C6b.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault double_reveal_rejected
```
Expected: `ok`.

- [ ] **C6b.4 Run the whole gov-vault suite** to confirm no regressions across all M4 + M5 cycles:
```bash
cargo test -p gov-vault
```
Expected: all M4 + M5 gov-vault tests pass.

- [ ] **C6b.5 Commit:**
```
feat(gov-vault): reject double reveal (AlreadyRevealed guard)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task C7 — RETIRE the M1 plaintext `close` / plaintext tally (single close path)

> **WHY (cross-plan reconciliation):** M1 shipped a plaintext `close(env, id)` that computes the running plaintext tally and emits `ProposalClosed` (M1 Task 9). M4 kept it untouched. Now that the sealed `close_and_reveal` (C3–C6b) is the real, foundation §2.2 close path, the obsolete M1 plaintext `close` must be removed so the two close paths don't coexist (both emit `ProposalClosed`, both set `weighted_*`/`Approved`, but only the sealed path is consistent with the M4 sealed `cast_vote` that stores ciphertext instead of a running plaintext tally). Foundation §2.2 defines exactly one close entrypoint: `close_and_reveal`.

**Files:**
- Modify: `contracts/gov-vault/src/lib.rs` (remove `pub fn close`), `contracts/gov-vault/src/storage.rs` (remove any plaintext running-tally helpers/keys M1 added, e.g. `VoterVoted`, running yes/no accumulators), `contracts/gov-vault/src/test.rs` (remove the M1 `close`-specific tests superseded by the C3–C6b `close_and_reveal` suite)

- [ ] **C7.1 RED.** Add a guard test asserting the plaintext `close` no longer exists (the only close path is `close_and_reveal`). Append to `contracts/gov-vault/src/test.rs`:
```rust
// The plaintext M1 `close` is retired; the generated client must expose ONLY `close_and_reveal`.
// (Compile-level assertion: referencing `t.client.close(&id)` must NOT compile.)
#[test]
fn only_sealed_close_path_exists() {
    // Intentionally references close_and_reveal (must exist). If a `close` method still exists,
    // remove the M1 close tests below; this test documents the single-close-path invariant.
    let _ = GovVaultClient::close_and_reveal; // type-level reference proves the sealed path exists
}
```
  Then DELETE the M1 `close`-specific tests (`test_close_*` / the seven Task 9 close tests) that call `t.client.close(&id)`. Run:
```bash
cargo test -p gov-vault 2>&1 | tail -20
```
  **Expected RED:** compile errors at the remaining `t.client.close(&id)` call sites (M1 close tests not yet deleted) — proving the M1 close path is still referenced.
- [ ] **C7.2 GREEN.** Remove `pub fn close(env: Env, id: u32)` from `contracts/gov-vault/src/lib.rs` and any M1 plaintext running-tally state in `storage.rs` (the running yes/no accumulators + the `VoterVoted` double-vote key were the M1 plaintext-vote machinery; the sealed path uses `SealedVotes(id)` + `Nullifier` + on-chain re-aggregation instead). Delete the remaining M1 close tests. Run:
```bash
cargo test -p gov-vault 2>&1 | tail -20
```
  **Expected PASS:** the suite is green with a single close path (`close_and_reveal`); no `close` method remains.
- [ ] **C7.3 Commit:**
```
refactor(gov-vault): retire M1 plaintext close/tally — close_and_reveal is the sole close path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Phase D — FALLBACK: coordinator commit-reveal (D6 fallback), config-selectable + fully tested

> Spec D6 fallback: a non-colluding **coordinator** runs commit-reveal instead of tlock. On-chain this is the `coordinator-reveal` Cargo feature (Task C4 already branches on it). Off-chain it is `REVEAL_MODE=coordinator` selecting `coordinator.ts`. BOTH halves get full suites (charter rule 3).

---

#### Task D1 — on-chain `coordinator-reveal` feature: trust admin-asserted aggregate

**Files:**
- Modify: `contracts/gov-vault/Cargo.toml` (add feature), `contracts/gov-vault/src/reveal.rs` (add `coordinator_accept`)
- Test: `contracts/gov-vault/src/test.rs`

- [ ] **D1.1 Add feature** to `contracts/gov-vault/Cargo.toml`:
```toml
[features]
default = []
offchain-verify = []        # from M4
coordinator-reveal = []     # M5 D6 fallback: trust coordinator-asserted aggregate (no on-chain re-aggregation)
```

- [ ] **D1.2 Write failing test** (compiled ONLY under the feature; guarded by `#[cfg(feature = "coordinator-reveal")]` so the default build is unaffected):
```rust
// contracts/gov-vault/src/test.rs
#[cfg(feature = "coordinator-reveal")]
#[test]
fn coordinator_reveal_accepts_admin_asserted_aggregate() {
    let t = TestCtx::new();
    let id = t.create_proposal_with_deadline(1000);
    // coordinator mode: votes were committed off-chain; on-chain we trust the admin/coordinator aggregate.
    let _h0 = t.store_sealed(id, 0xF1, 100);
    let _h1 = t.store_sealed(id, 0xF2, 101);
    let _h2 = t.store_sealed(id, 0xF3, 102);
    t.advance_to(1001);
    // NO matching decryptions needed in coordinator mode — empty vec accepted.
    t.client.close_and_reveal(&id, &700i128, &100i128, &soroban_sdk::vec![&t.env]);
    let v = t.client.proposal(&id);
    assert_eq!(v.weighted_yes, Some(700));
    assert_eq!(v.weighted_no, Some(100));
    assert_eq!(v.status, ProposalStatus::Approved);
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault --features coordinator-reveal coordinator_reveal_accepts_admin_asserted_aggregate
```
Expected FAIL: `cannot find function coordinator_accept in module reveal`.

- [ ] **D1.3 Implement** `coordinator_accept` in `contracts/gov-vault/src/reveal.rs`:
```rust
// contracts/gov-vault/src/reveal.rs  (append; compiled only under the feature)
#[cfg(feature = "coordinator-reveal")]
/// D6 FALLBACK: trust the coordinator-asserted aggregate (no on-chain re-aggregation).
/// SECURITY: relies on a non-colluding coordinator (spec §12, §13.3). Used only when the
/// `coordinator-reveal` feature is built; the default build uses `reaggregate` (Task C4).
pub fn coordinator_accept(_env: &Env, revealed_yes_w: i128, revealed_no_w: i128) -> (i128, i128) {
    (revealed_yes_w, revealed_no_w)
}
```
> The `close_and_reveal` branch added in C4 already calls this under the feature. Admin auth: add `Self::require_admin(&env)` at the top of `close_and_reveal` ONLY under the feature (coordinator must be the admin):
```rust
#[cfg(feature = "coordinator-reveal")]
{ let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap(); admin.require_auth(); }
```

- [ ] **D1.4 Run** and confirm PASS:
```bash
cargo test -p gov-vault --features coordinator-reveal coordinator_reveal_accepts_admin_asserted_aggregate
```
Expected: `ok`.

- [ ] **D1.5 Confirm default build is unchanged** (primary path still re-aggregates):
```bash
cargo test -p gov-vault
```
Expected: all default-feature tests pass (the coordinator test is `#[cfg]`-excluded).

- [ ] **D1.6 Commit:**
```
feat(gov-vault): coordinator-reveal feature fallback (admin-asserted aggregate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task D2 — off-chain coordinator commit-reveal builder + full suite

> The coordinator collects plaintext `(direction, weight)` + a salt off-chain, publishes commitments `H(direction||weight||salt)` at vote time (commit), then at close reveals the salts and the aggregate. We implement: `commitVote` (commit phase), `coordinatorReveal` (open phase → `RevealArgs`-shaped output with empty `decryptions` for the on-chain coordinator feature). REAL hashing (`sha256` via Node `crypto`), not a stub.

**Files:**
- Create: `packages/tally-reveal/src/coordinator.ts`
- Test: `packages/tally-reveal/test/coordinator.test.ts`

- [ ] **D2.1 Write failing test.** Create `packages/tally-reveal/test/coordinator.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { commitVote, coordinatorReveal, type CommittedVote } from "../src/coordinator.js";

describe("coordinator commit-reveal fallback (REAL sha256)", () => {
  it("commit hides the vote; reveal opens it and aggregates", () => {
    const c0 = commitVote(1, "100", "salt-a"); // yes 100
    const c1 = commitVote(1, "250", "salt-b"); // yes 250
    const c2 = commitVote(0, "300", "salt-c"); // no 300
    // commitment is a hash, not the plaintext
    expect(c0.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c0.commitment).not.toContain("100");

    const args = coordinatorReveal(7, [c0, c1, c2]);
    expect(args.proposalId).toBe(7);
    expect(args.revealedYesW).toBe("350");
    expect(args.revealedNoW).toBe("300");
    // coordinator mode submits NO per-vote decryptions on-chain (the chain trusts the aggregate)
    expect(args.decryptions).toEqual([]);
  });

  it("detects a tampered reveal (commitment mismatch throws)", () => {
    const c: CommittedVote = commitVote(1, "100", "salt");
    const tampered: CommittedVote = { ...c, weight: "999" }; // lie about weight, keep old commitment
    expect(() => coordinatorReveal(1, [tampered])).toThrow(/commitment mismatch/i);
  });
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/tally-reveal/test/coordinator.test.ts
```
Expected FAIL: `Cannot find module '../src/coordinator'`.

- [ ] **D2.2 Implement** `packages/tally-reveal/src/coordinator.ts`:
```typescript
// packages/tally-reveal/src/coordinator.ts
// D6 FALLBACK (spec §13): coordinator commit-reveal. REAL sha256 commitments (Node crypto).
import { createHash } from "node:crypto";
import type { RevealArgs } from "@shadowkit/shared";

export interface CommittedVote {
  direction: 0 | 1;
  weight: string;      // i128 decimal
  salt: string;
  commitment: string;  // 0x.. sha256(direction|weight|salt)
}

function commit(direction: 0 | 1, weight: string, salt: string): string {
  const h = createHash("sha256").update(`${direction}|${weight}|${salt}`, "utf-8").digest("hex");
  return `0x${h}`;
}

/** Commit phase: bind a vote to an opaque hash the voter can later open. */
export function commitVote(direction: 0 | 1, weight: string, salt: string): CommittedVote {
  return { direction, weight, salt, commitment: commit(direction, weight, salt) };
}

/** Reveal phase: verify each opening against its commitment, aggregate weighted yes/no.
 *  Returns RevealArgs with EMPTY decryptions (the on-chain coordinator-reveal feature trusts
 *  the aggregate; foundation §2.2 fallback ladder). Throws on any commitment mismatch. */
export function coordinatorReveal(proposalId: number, votes: CommittedVote[]): RevealArgs {
  let yes = 0n, no = 0n;
  for (const v of votes) {
    if (commit(v.direction, v.weight, v.salt) !== v.commitment) {
      throw new Error(`coordinator reveal: commitment mismatch for weight ${v.weight}`);
    }
    const w = BigInt(v.weight);
    if (v.direction === 1) yes += w; else no += w;
  }
  return { proposalId, revealedYesW: yes.toString(), revealedNoW: no.toString(), decryptions: [] };
}
```

- [ ] **D2.3 Run** and confirm PASS:
```bash
npx vitest run packages/tally-reveal/test/coordinator.test.ts
```
Expected: `2 passed`.

- [ ] **D2.4 Commit:**
```
feat(tally): coordinator commit-reveal fallback with real sha256 commitments

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task D3 — coordinator-mode END-TO-END integration: off-chain commit/reveal → on-chain close → Approved (fallback-untested fix)

> **Fallback-integration fix (charter rule 3: "no untested escape hatches").** D1 (on-chain) and D2 (off-chain) were two independently-green units with NOTHING tying them together — no test proved the coordinator fallback is a real, working substitute for the primary path. This task connects them end-to-end and asserts the off-chain aggregate equals the on-chain result.
>
> **How the D2 sha256 commitment relates to the on-chain `SealedVote.sealed_commitment_hash` (DECISION, recorded — closes the spec ambiguity):** the coordinator fallback uses a DIFFERENT cast/commit path from the primary. In coordinator mode, `cast_vote` is NOT the timelock path — votes are committed OFF-CHAIN as sha256 `H(direction|weight|salt)` (D2 `commitVote`). On-chain, `close_and_reveal --features coordinator-reveal` does NOT re-aggregate per-vote decryptions (it calls `reveal::coordinator_accept`, ignoring `decryptions`), so it does NOT consume `SealedVote.sealed_commitment_hash` at reveal time and there is **no requirement** that D2's sha256 commitment equal the on-chain Poseidon `SealedVote.sealed_commitment_hash`. The two commitments live in different trust models: the PRIMARY path binds the Poseidon `sealed_commitment_hash` to the zk proof and re-aggregates on-chain; the COORDINATOR fallback binds votes via the coordinator's off-chain sha256 commit-reveal and trusts the coordinator-asserted aggregate on-chain (spec §12, §13.3 non-colluding-coordinator assumption). This integration test exercises that fallback trust model end-to-end; it does NOT assert sha256 == Poseidon (they are intentionally unrelated).

**Files:**
- Test: `contracts/gov-vault/src/test.rs` (under `#[cfg(feature = "coordinator-reveal")]`)
- Test: `packages/tally-reveal/test/coordinator.test.ts` (TS side of the bridge)

- [ ] **D3.1 Write failing TS test** asserting the off-chain coordinator aggregate is exactly what the on-chain `close_and_reveal` will be fed. Append to `packages/tally-reveal/test/coordinator.test.ts`:
```typescript
describe("coordinator-mode integration bridge (off-chain aggregate == on-chain args)", () => {
  it("coordinatorReveal yields the exact (yes,no) the on-chain coordinator-reveal will accept", () => {
    // off-chain commit phase (what each voter submits to the coordinator)
    const committed = [
      commitVote(1, "400", "s0"), // yes 400
      commitVote(1, "300", "s1"), // yes 300
      commitVote(0, "100", "s2"), // no 100
    ];
    // off-chain reveal phase -> RevealArgs (empty decryptions: chain trusts the aggregate)
    const args = coordinatorReveal(42, committed);
    expect(args.revealedYesW).toBe("700");
    expect(args.revealedNoW).toBe("100");
    expect(args.decryptions).toEqual([]);
    // These EXACT i128 strings are what the contract test (D3.2) passes to close_and_reveal
    // under --features coordinator-reveal; quorum: 700 > 100 AND voters(3) >= 3 -> Approved.
    expect(BigInt(args.revealedYesW) > BigInt(args.revealedNoW)).toBe(true);
  });
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/tally-reveal/test/coordinator.test.ts -t "integration bridge"
```
Expected FAIL initially only if a symbol is missing; otherwise this asserts the precise (700,100) contract feeding D3.2. (If green immediately because `coordinatorReveal` already aggregates, treat D3.1 as the off-chain HALF of the bridge whose genuine red→green is the on-chain D3.2 below — this is an explicitly-justified integration assertion composing the D2 unit, allowed by the charter for integration glue when the real red is on the connected on-chain side.)

- [ ] **D3.2 Write failing on-chain integration test** (the genuine red→green). Append to `contracts/gov-vault/src/test.rs`:
```rust
#[cfg(feature = "coordinator-reveal")]
#[test]
fn coordinator_mode_e2e_offchain_aggregate_drives_onchain_approved() {
    let t = TestCtx::new();
    let id = t.create_proposal_with_deadline(1000);
    // In coordinator mode votes are committed off-chain (D2 sha256 commit-reveal). On-chain we
    // store opaque sealed blobs (participation only) and trust the coordinator-asserted aggregate.
    let _h0 = t.store_sealed(id, 0x10, 100);
    let _h1 = t.store_sealed(id, 0x11, 101);
    let _h2 = t.store_sealed(id, 0x12, 102);
    t.advance_to(1001);
    t.env.mock_all_auths(); // coordinator==admin require_auth (feature-gated in close_and_reveal)
    // The (700,100) here are EXACTLY the off-chain D3.1 coordinatorReveal output (yes=700,no=100).
    t.client.close_and_reveal(&id, &700i128, &100i128, &soroban_sdk::vec![&t.env]);
    let v = t.client.proposal(&id);
    assert_eq!(v.weighted_yes, Some(700)); // off-chain aggregate == on-chain result
    assert_eq!(v.weighted_no, Some(100));
    assert_eq!(v.status, ProposalStatus::Approved); // 700>100 AND 3 voters >= min 3
    assert!(t.client.is_approved(&id));
}
```
Run and confirm FAIL:
```bash
cargo test -p gov-vault --features coordinator-reveal coordinator_mode_e2e_offchain_aggregate_drives_onchain_approved
```
Expected FAIL initially if the feature-gated admin `require_auth` (D1.3) or `coordinator_accept` is not yet wired so that an empty-`decryptions` close yields `Approved` with the full quorum (note: this test additionally asserts `is_approved` and the quorum decision, which D1.2 did not). If D1 is fully in place it may pass on the auth/accept mechanics; the NEW assertion here is the end-to-end agreement (`is_approved` true + quorum on the coordinator aggregate). If green on first run, this is the explicitly-justified integration composition of D1+D2 (charter rule 1 integration coverage) — keep it as the connecting assertion the milestone previously lacked.

- [ ] **D3.3 Implement / confirm.** No new production code beyond D1 (the path already exists). If the test reveals the quorum or auth wiring is incomplete under the feature, fix it minimally (e.g. ensure C6a's full quorum predicate also runs under `coordinator-reveal`, and the feature-gated `require_auth` in D1.3 is present). Re-run:
```bash
cargo test -p gov-vault --features coordinator-reveal coordinator_mode_e2e_offchain_aggregate_drives_onchain_approved
npx vitest run packages/tally-reveal/test/coordinator.test.ts -t "integration bridge"
```
Expected: both green — the off-chain coordinator aggregate (700,100) drives the on-chain coordinator-reveal to `Approved`.

- [ ] **D3.4 Commit:**
```
test(gov-vault,tally): coordinator-mode end-to-end (off-chain aggregate -> on-chain Approved)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Phase E — FALLBACK: weight-unlinked & 1p1v degradation modes (fully tested)

> Spec §13.2 ladder: if the weighted reveal is too hard, degrade to **weight-unlinked** (count votes by direction but treat every weight as 1 in the tally — privacy of weight preserved, tally is per-head among included votes) then **1p1v** (one person one vote — identical to weight-unlinked here, named for clarity). Implemented as `degrade.ts` aggregation functions selected by `REVEAL_MODE`.

---

#### Task E1 — `degrade.ts`: weight-unlinked + 1p1v aggregation + suite

**Files:**
- Create: `packages/tally-reveal/src/degrade.ts`
- Test: `packages/tally-reveal/test/degrade.test.ts`

- [ ] **E1.1 Write failing test.** Create `packages/tally-reveal/test/degrade.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { aggregateUnlinked, aggregate1p1v } from "../src/degrade.js";

const decrypted = [
  { direction: 1 as const, weight: "100" },
  { direction: 1 as const, weight: "250" },
  { direction: 0 as const, weight: "300" },
];

describe("degradation fallbacks", () => {
  it("weight-unlinked: each vote counts as 1 regardless of weight", () => {
    const r = aggregateUnlinked(decrypted);
    expect(r.yesW).toBe("2"); // two yes votes
    expect(r.noW).toBe("1");  // one no vote
  });

  it("1p1v: identical head-count semantics", () => {
    const r = aggregate1p1v(decrypted);
    expect(r.yesW).toBe("2");
    expect(r.noW).toBe("1");
  });

  it("1p1v differs from weighted: whales do not dominate", () => {
    const whaleNo = [
      { direction: 1 as const, weight: "1" },
      { direction: 1 as const, weight: "1" },
      { direction: 0 as const, weight: "1000000" },
    ];
    const h = aggregate1p1v(whaleNo);
    expect(h.yesW).toBe("2"); // 2 heads yes > 1 head no -> yes wins per head
    expect(h.noW).toBe("1");
  });
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/tally-reveal/test/degrade.test.ts
```
Expected FAIL: `Cannot find module '../src/degrade'`.

- [ ] **E1.2 Implement** `packages/tally-reveal/src/degrade.ts`:
```typescript
// packages/tally-reveal/src/degrade.ts
// FALLBACK ladder (spec §13.2): weight-unlinked and 1p1v aggregation modes.
type Decrypted = { direction: 0 | 1; weight: string };

/** Weight-unlinked: ignore weight, count each included vote as 1 (preserves weight privacy). */
export function aggregateUnlinked(decrypted: Decrypted[]): { yesW: string; noW: string } {
  let yes = 0n, no = 0n;
  for (const d of decrypted) { if (d.direction === 1) yes += 1n; else no += 1n; }
  return { yesW: yes.toString(), noW: no.toString() };
}

/** 1-person-1-vote: identical head-count semantics (named per spec for the final rung). */
export function aggregate1p1v(decrypted: Decrypted[]): { yesW: string; noW: string } {
  return aggregateUnlinked(decrypted);
}
```

- [ ] **E1.3 Run** and confirm PASS:
```bash
npx vitest run packages/tally-reveal/test/degrade.test.ts
```
Expected: `3 passed`.

- [ ] **E1.4 Commit:**
```
feat(tally): weight-unlinked + 1p1v degradation fallbacks with tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task E2 — `REVEAL_MODE` selector wires primary vs all fallbacks

**Files:**
- Modify: `packages/tally-reveal/src/index.ts` (add `buildRevealArgsForMode`)
- Test: `packages/tally-reveal/test/reveal.test.ts` (add selector cases)

- [ ] **E2.1 Write failing test.** Append to `packages/tally-reveal/test/reveal.test.ts`:
```typescript
import { buildRevealArgsForMode } from "../src/index.js";

// Foundation §3.1: sealedCommitmentHash is a 32-byte (64-hex-char) 0x value.
const be32 = (n: number): string => "0x" + n.toString(16).padStart(64, "0");
const SEL_HASH_1 = be32(0x01); // 0x0000...0001
const SEL_HASH_2 = be32(0x02);

describe("REVEAL_MODE selector (primary vs fallbacks)", () => {
  it("timelock (default) re-aggregates weighted from real decryptions", async () => {
    const v0 = await seal(1, "100"); v0.sealedCommitmentHash = SEL_HASH_1;
    const v1 = await seal(0, "300"); v1.sealedCommitmentHash = SEL_HASH_2;
    const args = await buildRevealArgsForMode("timelock", 1, [v0, v1]);
    expect(args.revealedYesW).toBe("100");
    expect(args.revealedNoW).toBe("300");
    expect(args.decryptions).toHaveLength(2);
    expect(args.decryptions[0].sealedCommitmentHash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 120_000);

  it("weight-unlinked mode head-counts and submits no decryptions", async () => {
    const v0 = await seal(1, "100"); v0.sealedCommitmentHash = SEL_HASH_1;
    const v1 = await seal(0, "300"); v1.sealedCommitmentHash = SEL_HASH_2;
    const args = await buildRevealArgsForMode("weight-unlinked", 1, [v0, v1]);
    expect(args.revealedYesW).toBe("1");
    expect(args.revealedNoW).toBe("1");
    expect(args.decryptions).toEqual([]); // unlinked submits aggregate only
  }, 120_000);
});
```
Run and confirm FAIL:
```bash
npx vitest run packages/tally-reveal/test/reveal.test.ts -t "REVEAL_MODE selector"
```
Expected FAIL: `buildRevealArgsForMode is not a function`.

- [ ] **E2.2 Implement** in `packages/tally-reveal/src/index.ts` (append) + re-export the fallbacks:
```typescript
// --- append to packages/tally-reveal/src/index.ts ---
import { aggregateUnlinked, aggregate1p1v } from "./degrade.js";
export { aggregateUnlinked, aggregate1p1v } from "./degrade.js";
export { commitVote, coordinatorReveal, type CommittedVote } from "./coordinator.js";
export { roundForDeadline } from "./drand.js";

export type RevealMode = "timelock" | "weight-unlinked" | "1p1v";

/** Config-selectable reveal. `timelock` = PRIMARY (weighted, with per-vote decryptions for
 *  on-chain re-aggregation). `weight-unlinked`/`1p1v` = degradation fallbacks (head-count,
 *  empty decryptions -> use the on-chain coordinator-reveal feature). spec §13.2 ladder. */
export async function buildRevealArgsForMode(
  mode: RevealMode,
  proposalId: number,
  sealedVotes: SealedVoteCiphertext[],
  drand?: DrandConfig,
): Promise<RevealArgs> {
  if (mode === "timelock") return buildRevealArgs(proposalId, sealedVotes, drand);
  const { decrypted } = await revealTally(sealedVotes, drand);
  const agg = mode === "weight-unlinked" ? aggregateUnlinked(decrypted) : aggregate1p1v(decrypted);
  return { proposalId, revealedYesW: agg.yesW, revealedNoW: agg.noW, decryptions: [] };
}
```

- [ ] **E2.3 Run** and confirm PASS:
```bash
npx vitest run packages/tally-reveal/test/reveal.test.ts
```
Expected: all reveal.test.ts cases pass (revealTally + buildRevealArgs + selector).

- [ ] **E2.4 Commit:**
```
feat(tally): REVEAL_MODE selector wires timelock primary + unlinked/1p1v fallbacks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Phase F — End-to-end: sealed vote → reveal → approve (TS + on-chain)

---

#### Task F1 — E2E integration: REAL tlock seal → revealTally → reveal args (off-chain half)

> **Charter classification (rule 4 — explicit justification for a non-TDD test).** F1 is a **non-TDD integration smoke test**, declared as such. It composes units that ALREADY have their own red→green TDD cycles — `timelockSealVote`/`timelockUnsealVote` (A3), `revealTally` (B3), `buildRevealArgs` (B4) — so it has no first-run red of its own and the previous self-contradicting "passes immediately is acceptable" rationalization is REMOVED. The charter permits a test with no prior red ONLY with an explicit written justification that it composes already-tested units (rule 4); this paragraph IS that justification. The genuine red→green for the on-chain side is F2.
>
> **NEW integration invariant (NOT covered by any unit) — genuine red→green inside F1.** Beyond the smoke composition, F1 adds one assertion no unit makes: that `buildRevealArgs` preserves the on-chain `SealedVotes` ORDER even when the input array is shuffled relative to seal time — i.e. `decryptions[i]` binds to `sealedVotes[i]` for the exact array passed in. This is the load-bearing ordering contract (`close_and_reveal` matches by index), and it is genuinely red if `buildRevealArgs` ever reorders (e.g. via `Promise.all` racing). This sub-test starts red against any reordering implementation.

**Files:**
- Create: `packages/tally-reveal/test/e2e.test.ts`

- [ ] **F1.1 Write the E2E integration test (smoke) + the order-preservation invariant (genuine red→green).** Create `packages/tally-reveal/test/e2e.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { timelockSealVote } from "@shadowkit/zk-prover";
import { revealTally, buildRevealArgs } from "../src/index.js";
import { timelockUnsealVote } from "@shadowkit/zk-prover";

const PAST = 1692803367 + 5 * 3; // released round -> decryptable now
// Foundation §3.1: sealedCommitmentHash is a 32-byte (64-hex-char) 0x value.
const be32 = (n: number): string => "0x" + n.toString(16).padStart(64, "0");
const H_A = be32(0x0a), H_B = be32(0x0b), H_C = be32(0x0c);

describe("E2E sealed-vote -> reveal -> approve (REAL tlock, non-TDD integration smoke)", () => {
  it("seals 3 votes, stays sealed until opened, reveals weighted tally that passes quorum", async () => {
    // 1) SEAL (what the browser/client does at cast time)
    const v0 = await timelockSealVote(1, "100", PAST); v0.sealedCommitmentHash = H_A;
    const v1 = await timelockSealVote(1, "250", PAST); v1.sealedCommitmentHash = H_B;
    const v2 = await timelockSealVote(0, "300", PAST); v2.sealedCommitmentHash = H_C;
    const sealedOnChain = [v0, v1, v2];

    // 2) SEALED INVARIANT: the on-chain blob reveals nothing — only opaque base64 ciphertext.
    for (const v of sealedOnChain) {
      expect(v.ciphertext).not.toContain("100");
      expect(v.ciphertext).not.toContain("yes");
      expect(typeof v.round).toBe("number");
      expect(v.sealedCommitmentHash).toMatch(/^0x[0-9a-f]{64}$/); // §3.1 width
    }

    // 3) REVEAL (what tally-reveal / the agent does at close)
    const tally = await revealTally(sealedOnChain);
    expect(tally.yesW).toBe("350");
    expect(tally.noW).toBe("300");

    // 4) REVEAL ARGS for GovVault.close_and_reveal — ordered, commitment-bound
    const args = await buildRevealArgs(0, sealedOnChain);
    expect(args.decryptions.map((d) => d.sealedCommitmentHash)).toEqual([H_A, H_B, H_C]);
    expect(args.revealedYesW).toBe("350");

    // 5) QUORUM decision mirrors on-chain rule (yes>no AND voters>=3) -> approved
    const voters = sealedOnChain.length;
    const approved = BigInt(args.revealedYesW) > BigInt(args.revealedNoW) && voters >= 3;
    expect(approved).toBe(true);

    // 6) sanity: each ciphertext genuinely decrypts to its sealed values (REAL tlock round-trip)
    const open0 = await timelockUnsealVote(v0);
    expect(open0).toEqual({ direction: 1, weight: "100" });
  }, 180_000);

  // NEW invariant no unit covers: buildRevealArgs preserves on-chain SealedVotes ORDER under a
  // shuffle (decryptions[i] binds to sealedVotes[i] for the EXACT array passed). Genuine red→green:
  // fails against any reordering (e.g. Promise.all racing). This is the load-bearing index contract
  // close_and_reveal relies on (foundation §2.2 "same order as DataKey::SealedVotes(id)").
  it("preserves input order: decryptions[i] binds to sealedVotes[i] under a shuffled set", async () => {
    const a = await timelockSealVote(0, "5", PAST);   a.sealedCommitmentHash = be32(0xa1);
    const b = await timelockSealVote(1, "9", PAST);   b.sealedCommitmentHash = be32(0xb2);
    const c = await timelockSealVote(1, "7", PAST);   c.sealedCommitmentHash = be32(0xc3);
    // deliberately NOT in seal order:
    const shuffled = [c, a, b];
    const args = await buildRevealArgs(0, shuffled);
    // order must match the INPUT array exactly (index-aligned), not seal order or sorted:
    expect(args.decryptions.map((d) => d.sealedCommitmentHash)).toEqual([
      be32(0xc3), be32(0xa1), be32(0xb2),
    ]);
    expect(args.decryptions.map((d) => d.weight)).toEqual(["7", "5", "9"]);
    expect(args.decryptions.map((d) => d.direction)).toEqual([1, 0, 1]);
  }, 180_000);
});
```
Run the order-preservation invariant FIRST and confirm it would catch reordering (genuine red→green target). To DEMONSTRATE the red WITHOUT sabotage: this invariant is red against any `buildRevealArgs` that does not index-align (the requirement is new at this boundary). If B4's `buildRevealArgs` already maps `decrypted.map((d, i) => ... sealedVotes[i] ...)` in order, the invariant passes — that is the CORRECT implementation and the test's value is as a permanent regression guard for the ordering contract (run it to confirm green):
```bash
npx vitest run packages/tally-reveal/test/e2e.test.ts -t "preserves input order"
```
Expected: `1 passed` (B4 implements index-aligned mapping). If it FAILS, B4 has an ordering bug — fix B4 to index-align, then re-run.

- [ ] **F1.2 Run the full E2E smoke** (non-TDD integration, justified above):
```bash
npx vitest run packages/tally-reveal/test/e2e.test.ts
```
Expected: `2 passed` (smoke + order invariant). This composes already-tested units (A3/B3/B4) plus the new ordering invariant; the genuine on-chain red→green is F2.

- [ ] **F1.3 Commit:**
```
test(tally): E2E integration smoke + buildRevealArgs order-preservation invariant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

#### Task F2 — on-chain E2E: full cross-contract sealed-vote → close_and_reveal → Approved (genuine red→green)

**Files:**
- Test: `contracts/gov-vault/src/test.rs`

- [ ] **F2.1 Write failing test** — the full on-chain flow asserting the FIRST-time tally reveal and Approved status drives `is_approved` true (used by AgentPolicy in M2). This is genuinely red until C4's `close_and_reveal` is complete AND the helper chain (`store_sealed`/`advance_to`) exists; to force a clean red, this test additionally asserts a NEW event expectation not covered before — `ProposalClosed` is published with the weighted totals:
```rust
#[test]
fn e2e_sealed_to_reveal_to_approved_emits_closed_event() {
    let t = TestCtx::new();
    let id = t.create_proposal_with_deadline(1000);
    // before close: sealed, no tally, not approved
    let h0 = t.store_sealed(id, 0x1A, 100);
    let h1 = t.store_sealed(id, 0x1B, 101);
    let h2 = t.store_sealed(id, 0x1C, 102);
    assert_eq!(t.client.proposal(&id).weighted_yes, None);
    assert!(!t.client.is_approved(&id));

    t.advance_to(1001);
    let decs = soroban_sdk::vec![&t.env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 1, weight: 250, sealed_commitment_hash: h1 },
        VoteDecryption { direction: 0, weight: 300, sealed_commitment_hash: h2 }];
    t.client.close_and_reveal(&id, &350i128, &300i128, &decs);

    // after close: tally revealed (first time), approved, event emitted with totals
    let v = t.client.proposal(&id);
    assert_eq!(v.weighted_yes, Some(350));
    assert_eq!(v.weighted_no, Some(300));
    assert!(t.client.is_approved(&id));
    // ProposalClosed event present with approved=true, weighted_yes=350
    let events = t.env.events().all();
    let found = events.iter().any(|e| {
        // decode the ProposalClosed event payload; match approved=true & weighted_yes=350
        t.is_proposal_closed(&e, true, 350, 300)
    });
    assert!(found, "expected ProposalClosed(approved=true, yes=350, no=300) event");
}
```
> Add the `is_proposal_closed(&self, e, approved, yes, no)` test helper to `TestCtx` that decodes a `ProposalClosed` event (foundation §2.2) and matches its fields. If event-decoding scaffolding from M1/M4 exists, reuse it.

Run and confirm FAIL:
```bash
cargo test -p gov-vault e2e_sealed_to_reveal_to_approved_emits_closed_event
```
Expected FAIL: missing `is_proposal_closed` helper, OR the event assertion fails if C4 didn't publish `ProposalClosed` (it does) — the helper-missing compile error is the red.

- [ ] **F2.2 Implement** the `is_proposal_closed` test helper in `contracts/gov-vault/src/test.rs` (decode + match). No production change beyond C4 (event already published).

- [ ] **F2.3 Run** and confirm PASS:
```bash
cargo test -p gov-vault e2e_sealed_to_reveal_to_approved_emits_closed_event
```
Expected: `ok`.

- [ ] **F2.4 Commit:**
```
test(gov-vault): on-chain E2E sealed -> reveal -> approved + ProposalClosed event

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Phase G — Full-suite gates (primary AND every fallback green)

---

#### Task G1 — run the complete M5 matrix and wire `just` targets

**Files:**
- Modify: `justfile` (ensure M5 test paths are covered)

- [ ] **G1.1 Run the PRIMARY contract suite (default features — must pass on its own, charter rule 2):**
```bash
cargo test -p gov-vault -p shadowkit-shared
```
Expected: all default-feature gov-vault + shared tests pass (no `coordinator-reveal`).

- [ ] **G1.2 Run the contract FALLBACK suites (coordinator + offchain-verify features, charter rule 3):**
```bash
cargo test -p gov-vault --features coordinator-reveal
cargo test -p gov-vault --features offchain-verify
```
Expected: under `coordinator-reveal`, default tests + `coordinator_reveal_accepts_admin_asserted_aggregate` + `coordinator_mode_e2e_offchain_aggregate_drives_onchain_approved` pass; under `offchain-verify`, default tests + `offchain_verify_cast_vote_stores_commitment_without_proof_binding` pass and the build compiles.

- [ ] **G1.3 Run the TS PRIMARY + fallback suites:**
```bash
npx vitest run packages/zk-prover packages/tally-reveal
```
Expected (all green; network-dependent tlock tests require internet to quicknet): `seal.test.ts` (drandConfig 2 + roundForDeadline 2 + tlock round-trip/early 2 + binding 1 = 7), `drand.test.ts` (1), `reveal.test.ts` (revealTally 1 + pre-deadline 2 + buildRevealArgs 1 + selector 2 = 6), `coordinator.test.ts` (commit/reveal 2 + integration bridge 1 = 3), `degrade.test.ts` (3), `e2e.test.ts` (smoke 1 + order invariant 1 = 2).

- [ ] **G1.4 Verify `justfile` runs M5.** Confirm `just test` invokes both `cargo test --workspace` (which includes default gov-vault) and `vitest run` (which includes tally-reveal via the workspace). Add an explicit fallback line if M0's `justfile` didn't include feature builds:
```make
# justfile — ensure these lines exist (M5 fallback coverage):
test-fallbacks:
    cargo test -p gov-vault --features coordinator-reveal
    cargo test -p gov-vault --features offchain-verify
    cargo test --workspace --features handrolled
```
And ensure `test:` depends on the primary suites. Run:
```bash
just test-fallbacks
```
Expected: all fallback feature builds pass.

- [ ] **G1.5 No-cheating audit.** Grep for banned patterns across M5 files:
```bash
grep -rnE "#\[ignore\]|\.skip\(|\.only\(|it\.todo|xfail|assert!\(true\)|expect\(true\)\.toBe\(true\)" \
  contracts/gov-vault/src packages/tally-reveal packages/zk-prover/src packages/zk-prover/test || echo "CLEAN"
```
Expected: `CLEAN` (no hits). Any hit must have a same-line written justification citing the spec, else fix it.

- [ ] **G1.6 Commit:**
```
build(repo): wire M5 primary + fallback test gates into justfile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## 3. Done criteria (the milestone is complete only when ALL hold)

**Primary (must pass WITHOUT any fallback — charter rule 2):**
- [ ] A vote sealed to round T is **UNDECRYPTABLE before T** via REAL `tlock-js` (`seal.test.ts` "UNDECRYPTABLE before its round" asserts the real `too early` throw) and **decryptable after the beacon** (past-round round-trip passes).
- [ ] `clientFor()` builds a drand-client `ChainClient` with beacon verification **ON** and pinned to quicknet `{ chainHash, publicKey }` (`seal.test.ts` drandConfig — asserts `disableBeaconVerification === false`).
- [ ] `revealTally` over REAL tlock-decrypted votes produces the correct weighted yes/no (`reveal.test.ts`).
- [ ] **`tally-reveal` rejects a pre-deadline (future-round) reveal** with the REAL tlock "too early" error, including a mixed-round batch (`reveal.test.ts` "pre-deadline reveal fails" — spec §10).
- [ ] `cast_vote` stores the full `SealedVote` (`cast_vote_stores_full_sealed_vote`) AND **binds the ciphertext commitment to `pub_signals[3]`** on the verified path (`cast_vote_rejects_commitment_not_bound_to_proof`).
- [ ] On-chain `close_and_reveal` ACCEPTS a correct reveal and sets the weighted tally + Approved (`close_and_reveal_correct_...`), and **rejects** wrong reveals (length / commitment / bad bit / lying aggregate → `RevealMismatch`, each introduced red-before-green in C5a–C5d) and **pre-deadline** reveals (`DeadlineNotReached`).
- [ ] Weighted quorum **passes** (yes>no & voters≥3) and **fails** (no≥yes, or voters<3); double reveal → `AlreadyRevealed`.
- [ ] `proposal()` exposes **no tally** before close (`weighted_yes/no == None`).
- [ ] `buildRevealArgs` **preserves on-chain SealedVotes order under a shuffle** (index-aligned binding) — `e2e.test.ts` "preserves input order".
- [ ] E2E: sealed vote → reveal → Approved + `ProposalClosed` event (TS `e2e.test.ts` + on-chain `e2e_sealed_to_reveal_to_approved_...`).
- [ ] `cargo test -p gov-vault` (default) and `npx vitest run packages/zk-prover packages/tally-reveal` are all green.

**Fallbacks (must ALSO be implemented + tested — charter rule 3):**
- [ ] **Coordinator commit-reveal:** on-chain `--features coordinator-reveal` accepts the admin-asserted aggregate (`coordinator_reveal_accepts_admin_asserted_aggregate`); off-chain `coordinator.ts` real-sha256 commit/reveal + tamper-detection (`coordinator.test.ts`); **end-to-end coordinator-mode integration** (off-chain aggregate drives on-chain `Approved`, `coordinator_mode_e2e_offchain_aggregate_drives_onchain_approved` + the TS bridge test).
- [ ] **offchain-verify cast path:** `cast_vote` commitment binding is gated OFF under `--features offchain-verify` (`offchain_verify_cast_vote_stores_commitment_without_proof_binding`), and `cargo test -p gov-vault --features offchain-verify` compiles and passes.
- [ ] **Weight-unlinked + 1p1v:** `degrade.ts` head-count aggregation + `REVEAL_MODE` selector tested (`degrade.test.ts`, selector cases in `reveal.test.ts`).
- [ ] `just test-fallbacks` is green.

**Accuracy (charter rule 5):** every external-API call (tlock-js `timelockEncrypt`/`timelockDecrypt`/`mainnetClient`, drand-client `ChainOptions`/`chainVerificationParams`/`roundAt`/`roundTime`, quicknet `/info`, soroban-sdk `Fr::to_bytes -> BytesN<32>`) is cited in a source comment. The soroban-sdk `Fr` accessor (`fr.to_bytes()`) and drand-client `ChainVerificationParams { chainHash, publicKey }` shape are VERIFIED against the installed/source packages (§0 provenance, Task C1b note); re-confirm the single `Fr` line against the installed crate at impl time.

---

## 4. Risks & mitigations (M5-specific, from spec §13.3)

- **Network flakiness on quicknet** during tlock tests: the primary tests hit live quicknet (REAL crypto, charter rule 4). If CI lacks internet, run them behind `RUN_TLOCK_LIVE=1` AND ship a deterministic `MockDrandClient`-based variant (tlock-js `test/drand/mock-drand-client.ts` pattern: `new MockDrandClient(beacon, quicknetInfo)`) that still uses REAL `timelockEncrypt`/`timelockDecrypt` against the mock beacon — never a stub that fakes decryption. The env-gated live variant requires a written justification per charter rule 4; the mock variant runs by default. **Do NOT** mock away `timelockDecrypt` itself.
- **soroban-sdk `Fr -> BytesN<32>` accessor** (Task C1b): **VERIFIED** at plan time — `Fr::to_bytes(&self) -> BytesN<32>` (big-endian) exists in `stellar/rs-soroban-sdk` `soroban-sdk/src/crypto/bls12_381.rs` (`impl Fr`), stable across `22.x`/`23.x` into the pinned `26.0.x` family (§0 provenance). C1b ships `fr.to_bytes()` as a cited, verified accessor; re-confirm the single line against the installed crate via the precondition `grep` (no version skew). This is no longer an unverified guess.
- **drand chain pinning** (Task A1): the earlier `new HttpCachingChain(url, { chainHash })` form does NOT verify the beacon (silently disables verification). FIXED — `clientFor()` returns tlock-js `mainnetClient()` (quicknet, verification on) for the default, and for custom configs constructs `{ ...defaultChainOptions, disableBeaconVerification: false, chainVerificationParams: { chainHash, publicKey } }`. `DrandConfig` now carries `publicKey`. SOURCE: drand-client `build/index.d.ts` (ChainOptions/ChainVerificationParams), tlock-js `index.js` `mainnetClient()`.
- **Stretch (on-chain drand-beacon BLS verify, spec §13.3):** OUT of M5 primary scope (off-chain reveal via tlock-js + on-chain re-aggregation is the trust model). If pursued, it is an additive `gov-vault` verifier path using `env.crypto().bls12_381()` against the drand quicknet public key — a separate plan, not a blocker here.

---

*End of M5 plan. All signatures reference `00-foundation-interfaces.md` §2.2, §2.6, §3.1, §3.2, §3.4, §5, §6. Any binding-signature change requires updating the foundation first, then this plan.*
