# ShadowKit & AgentBoard — Design Spec

**Date:** 2026-06-02
**Status:** Approved (brainstorming in progress; pre-implementation)
**Target:** Build On Stellar Hackathon — IBW 2026 (Main + Hack Agentic + Hack Privacy)

> **Revision note (2026-06-02):** D6 upgraded to **fully hidden tally until close** (no running results/percentages visible during voting). Primary reveal mechanism = **timelock encryption (drand/tlock)**. `AgentPolicy` now built on **OZ Smart Accounts via `smart-account-kit`**.

---

## 1. Summary

**ShadowKit** is a ZK- and AI-powered autonomous governance infrastructure (SDK/middleware) for Stellar projects, DAOs, and communities. Members vote **privately**: zero-knowledge proofs hide who voted, how they voted, and how much weight they hold — and **the running tally itself stays sealed until voting closes**, so no one can see which option is winning while the vote is live. Once a proposal reaches quorum at close, an **autonomous AI agent** executes the approved on-chain action (e.g., a treasury swap on a Stellar DEX) with **no human approval in the loop**. The agent's spending authority is mathematically gated by an on-chain policy, so a hallucinating agent literally cannot move funds incorrectly.

**AgentBoard** is the front-end dashboard: private voting UI (with a sealed "results hidden until close" panel + countdown) and a live "agent terminal" that streams the agent's reasoning and on-chain execution.

The demo product, **ShadowDAO**, is a sample DeFi treasury built on ShadowKit.

---

## 2. Problem & Solution

**Problem.** Web3 votes are public by default → small holders are visible to and manipulable by whales and analytics firms. Worse, **live tallies invite last-minute and bandwagon manipulation** (whales wait, watch the running result, then swing it). Executing decisions then requires slow, centralized manual multisig approval.

**Solution.** Passwordless (passkey) login → client-side ZK proof hides identity, vote choice, and token weight → the vote is **timelock-encrypted so nobody (not even the DAO/agent) can read the running tally before the deadline** → Soroban contract verifies each proof on-chain and stores sealed votes → at close, the tally is decrypted, verified, and revealed; on quorum an AI agent autonomously executes the approved action, bounded by an on-chain spending policy.

---

## 3. Hackathon Track Alignment

| Track | Fit |
|---|---|
| **Main** ($2,600, automatic) | Soroban contracts on testnet, working demo, real problem (manipulation + execution latency), strong UX (passkey, sealed-vote countdown, agent terminal), clear ecosystem fit. |
| **Hack Agentic** ($1,200) | Agent autonomously executes approved proposals (no per-tx human approval). Safeguards = on-chain scoped-auth policy (spending limit / session key — a listed example). Why Stellar = fast finality + ~zero fees + native assets + on-chain ZK/BLS + custom-account auth. |
| **Hack Privacy** ($1,200) | Private voting via ZK proofs **with sealed-until-close tallying** (a listed example, taken further). Explicit threat model: what's hidden, from whom, with which tech and assumptions. |

---

## 4. Locked Design Decisions

| # | Decision | Choice | Notes |
|---|---|---|---|
| D1 | ZK verification fidelity | **On-chain Groth16 verify** (BLS12-381) | Off-chain-verify fallback so the demo never breaks. |
| D2 | Agent autonomy | **LLM-bounded execution** | LLM decides *how* (slippage/route/split/timing) within on-chain-enforced limits. **M3 LLM = Gemini** (`@google/genai`, `gemini-2.5-flash`; pivoted from Claude 2026-06-03); M3 implements sizing + slippage floor (see M3 plan SCOPE DEVIATION). |
| D3 | x402 scope | **Wide — both directions** | Agent *pays* for premium data; ShadowKit *sells* a paid verify/execute API. |
| D4 | Stack | **TypeScript everywhere + Rust contracts** | passkey/smart-account-kit & x402 are TS; agent LLM calls first-class in TS. |
| D5 | Vote weighting | **Token-weighted, weight hidden** | Merged with D6 into one encrypted-tally mechanism. Fallbacks: weight-unlinked → 1p1v. |
| **D6** | **Vote secrecy** | **Fully hidden until close** (no running counts/%/direction visible during voting) | **Reveal mechanism = timelock encryption (drand/tlock) [primary]; coordinator commit-reveal [fallback].** Kills bandwagon/whale-timing manipulation. |
| D7 | Treasury custody | **Agent scoped-auth (session-key smart wallet)** | Treasury = AgentPolicy wallet balance; GovVault holds no funds. **Built on OZ Smart Accounts via `smart-account-kit`** (custom GovVault-gating policy); hand-rolled `__check_auth` is the fallback. |
| D8 | Swap venue | **External testnet AMM (Soroswap) via adapter** | Always ship our own FallbackAMM + config switch (Soroswap unconfirmed — §13). |

---

## 5. Verified Technical Facts & Key Dependencies (2026-06-02)

- **BLS12-381 (CAP-0059):** `Final`, shipped in **Protocol 22**. 16 host functions (G1/G2 add, scalar-mul, MSM, map/hash-to-curve, multi-pairing check, Fr ops). → On-chain Groth16 verify **and** drand BLS-signature verification are both feasible on-chain.
- **Current networks:** mainnet & testnet on **Protocol 25** (Jan 2026) → BLS12-381 unquestionably live.
- **Bonus (Protocol 25):** BN254 + Poseidon/Poseidon2 host functions now live on all networks — optional optimizations (cheaper on-chain hashing), not core deps.
- **Reference verifier:** `stellar/soroban-examples/groth16_verifier` uses **Circom 2.2.1 + snarkjs + BLS12-381**. → **Tooling: Circom + snarkjs** (not Noir). ⚠️ Reference is demo-only/unaudited; we disclose hackathon-grade.
- **`smart-account-kit` (kalepail) + OpenZeppelin `stellar-contracts`:** TS SDK for OZ Smart Accounts on Soroban — passkey (WebAuthn/secp256r1), Ed25519 + **policy signers**, **context rules**, **spending limits**, **custom policies**, plus indexer/relayer (fee sponsorship). → basis for `AgentPolicy` (D7) + eases passkey. ⚠️ Verify a custom policy can cross-contract-read `GovVault` state at M2 (§13).
- **drand / tlock + `kaankacar/Drand-Relay`:** timelock encryption over drand (BLS12-381 threshold beacon). → basis for D6 sealed-until-close tally. ⚠️ Verify tlock-js + Drand-Relay flow and on-chain beacon verification path at M5 (§13).
- **Soroswap testnet:** ⚠️ **Not confirmed** from docs. Mitigated by adapter + FallbackAMM (§13).

---

## 6. Architecture & End-to-End Flow

### Components (high level)
1. **Frontend — AgentBoard** (Astro/React, Scaffold Stellar): connect (passkey/keypair via smart-account-kit), proposals, private vote flow (browser proof + timelock-encrypt), **sealed-tally panel + countdown**, post-close result, **agent terminal**, treasury panel.
2. **ZK layer** (Circom): circuit = snapshot membership + hidden weight + nullifier + proposalId binding + *well-formed sealed vote* (proves the ciphertext encrypts a valid `direction ∈ {0,1}` with the voter's true weight) — **direction is never a public signal**.
3. **Timelock layer** (tlock/drand): client encrypts the vote to the deadline round; at close the beacon enables decryption + tally.
4. **Soroban contracts** (Rust): `Groth16Verifier`, `GovVault`, `AgentPolicy` (OZ Smart Account = treasury), `FallbackAMM` (+ `SwapVenue` interface).
5. **Agent middleware** (TS): event watcher → at close: tally-reveal (decrypt + verify) → x402 data purchase → Claude planner → session-key signer → submitter → AgentBoard log.
6. **x402 services** (TS): premium-data endpoint (agent pays) + ShadowKit paid API (provider).

### End-to-end demo loop
```
1. User connects (passkey/keypair)
2. Proposal: "Swap 15k USDC -> XLM on DEX", with a voting deadline T
3. PRIVATE + SEALED VOTE: browser builds Circom/snarkjs proof
   (in snapshot + weight=balance[HIDDEN] + nullifier + proposalId)
   and timelock-encrypts the (direction,weight) vote to round(T)
        |
        v
4. GovVault: Groth16 verify (BLS12-381) -> nullifier check (+ proposalId binding)
   -> store sealed ciphertext. REVEALS NOTHING about the tally.
   (UI shows only: "N votes cast, results hidden until T" + countdown)
        |
        v
5. At deadline T: drand beacon released -> votes decryptable
   -> tally computed -> close_and_reveal verifies result on-chain
   -> if quorum: set approved flag + cap
        |
        v  (event)
6. Agent: x402-pay premium data -> Claude plan (<= cap)
   -> sign via session key -> AgentPolicy policy validates -> swap on AMM
        |
        v
7. AgentBoard terminal: agent reasoning + on-chain tx + new treasury;
   final weighted tally revealed (first time anyone sees the result)
```

---

## 7. Threat Model & Safeguards

### 7.1 Hack Privacy (required statements)

**(1) What is hidden, from whom**
- **Hidden during voting:** (a) who voted ↔ how they voted; (b) a member's token weight/balance; (c) which eligible members voted; **(d) the running tally — counts, percentages, and which option leads — is sealed until close.**
- **From:** chain-analytics firms, rival DAOs, whales, other members — **and, until the deadline, even the DAO/agent itself** (timelock).
- **Public by design:** that valid votes were cast (opaque nullifiers), the number of votes cast (participation, no direction), the Merkle root, and — only after close — the final weighted tally.

**(2) Privacy technology**
- Groth16 zk-SNARK (Circom + snarkjs), **on-chain verification via BLS12-381**.
- Nullifier scheme (double-vote prevention, bound to proposalId).
- Merkle-tree commitment for eligibility (leaf = `Poseidon(addrCommit, weight)`).
- **Timelock encryption (drand/tlock)** of the (direction, weight) vote → sealed-until-close. (Fallback: coordinator commit-reveal.)
- On-chain tally verification at close (and, as a stretch, on-chain drand-beacon BLS verification for full trustlessness).

**(3) Threat model & assumptions**
- **Adversaries:** passive chain/analytics observer; **active whale watching the running tally to time/swing the vote**; malicious member (double-vote or vote without eligibility).
- **Guarantees:** eligibility soundness (ZK membership); no double-vote (nullifier); vote-choice + weight privacy; **tally secrecy until close (no early signal to manipulate)**.
- **Assumptions (honest):** per-circuit Groth16 trusted setup (toxic-waste; hackathon runs its own; production = MPC ceremony); BLS12-381 pairing/DL hardness; Poseidon resistance; snapshot integrity (reproducible root); reference verifier demo-grade. **For D6:** drand network liveness + honest threshold for timelock (primary); *or* a non-colluding coordinator for the commit-reveal fallback.
- **Residual:** at close, with tlock, individual votes become decryptable but remain **unlinked to identities** (ZK/nullifier) → holdings stay private; this also serves auditability.

### 7.2 Hack Agentic (required statements)

**(1) What the agent does autonomously**
At close it performs the tally-reveal (decrypt + verify), then manages *execution* of the approved proposal: pays via x402 for market data, chooses slippage/split/timing/route, signs and submits the swap. **No human approves the final tx**; the only trigger is the ZK-verified, quorum-passing tally.

**(2) Safeguards (the mathematical lock)**
`AgentPolicy` (OZ Smart Account custom policy) refuses *any* tx unless **all** hold:
`(a)` GovVault reports the proposal approved · `(b)` not yet executed (single-shot) · `(c)` target = approved AMM · `(d)` asset = treasury asset · `(e)` amount ≤ proposal cap.
→ A hallucinating LLM (wrong amount/target/asset/proposal, or executing a non-passing vote) is **rejected on-chain**. Extras: per-proposal cap, single-shot replay guard, time-boxed/revocable session key. Defense-in-depth: cap is a hard constraint in the planner prompt + validated client-side before submit.

**(3) Why Stellar**
Fast finality + ~zero fees → real-time reaction, order splitting, per-call x402 data payments (gas-prohibitive on Ethereum). Native USDC/XLM → no `approve`/`transferFrom`. BLS12-381 host functions → on-chain ZK verify **and** drand verification are cheap → privacy + safeguard enforced by the chain. Custom-account auth (OZ Smart Accounts) → session-key/scoped-auth is a first-class Stellar primitive.

---

## 8. Component Boundaries & Interfaces

### On-chain (Rust / Soroban)

**`Groth16Verifier`** *(isolated Verifier layer)* — **Does:** verify a Groth16 proof vs embedded VK + public inputs (BLS12-381 host fns). **Interface:** `verify(proof, public_inputs) -> bool`. **Deps:** BLS12-381 host fns; embedded VK. *(adapted from official example.)*

**`GovVault`** *(Application + quorum policy; holds no funds)*
- **State:** admin, verifier addr, Merkle root, treasury asset, quorum cfg, deadline, proposals, nullifier set, per-proposal {sealed_votes[], yes_weight (post-reveal), no_weight (post-reveal), cap, status, revealed?}.
- **Interface:**
  - `init(admin, verifier, merkle_root, treasury_asset, quorum_cfg)`
  - `create_proposal(action_spec, cap, deadline) -> id`
  - `cast_vote(id, proof, {nullifier, sealed_ciphertext})` → verify → nullifier+proposalId check → store sealed vote. **Exposes no tally.**
  - `close_and_reveal(id, revealed_yes_w, revealed_no_w, reveal_proof)` → verify the reveal against sealed votes / beacon → set weighted tally → pass/fail → `approved` + cap.
  - `is_approved(id) -> bool` · `proposal(id) -> ProposalView` · `mark_executed(id)`
- **Deps:** Groth16Verifier, BLS12-381 host fns, storage.

**`AgentPolicy`** *(OZ Smart Account custom policy = agent wallet = treasury; the lock)*
- **Does:** authorizes only the approved, capped, correctly-targeted swap of an approved-and-unexecuted proposal (policy reads GovVault), with a valid session-key signature.
- **Built on:** `smart-account-kit` / OZ `stellar-contracts` (spending-limit + custom policy). **Fallback:** hand-rolled custom account `__check_auth`.
- **Interface:** OZ policy/context-rule registration · `init(owner/session signer, gov_vault, approved_amm, treasury_asset, cap source)`.
- **Deps:** GovVault (cross-contract read), AMM address, OZ account contracts, signature host fns.

**`FallbackAMM`** *(guaranteed demo liquidity)* + **`SwapVenue` interface** — **Does:** minimal constant-product USDC/XLM pool; both this and a Soroswap-wrapper satisfy `SwapVenue` → AgentPolicy venue-agnostic. **Interface:** `swap(asset_in, amount_in, min_out, to) -> out` · `add_liquidity(...)` · `reserves()`. **Deps:** SAC tokens, storage.

### Off-chain (TypeScript)

- **`zk-prover` (client lib):** `generateVoteProof({secret, merklePath, weight, proposalId, direction}) -> {proof, publicSignals, sealedCiphertext}`. Deps: circuit.wasm + .zkey, snarkjs, **tlock-js/Drand-Relay** (encrypt to deadline round).
- **`snapshot-tool`:** `buildSnapshot(holders) -> {root, getPath(addr)}`. Deps: poseidon, merkle lib.
- **`tally-reveal`:** at close, fetch drand beacon → decrypt sealed votes → compute weighted tally → produce `reveal_proof` for `close_and_reveal`. (Lives in the agent or a standalone revealer.) Deps: tlock-js/Drand-Relay, stellar-sdk.
- **`agent-middleware`:** modules `watcher · tallyReveal · dataClient(x402) · planner(Claude) · executor · logBus`. Deps: stellar-sdk, GovVault/AgentPolicy, `@x402/*`, Anthropic SDK, RPC.
- **`x402-services`:** (a) `PremiumData` (x402-protected price+signal; agent pays); (b) `ShadowKitAPI` (x402-protected verify/execute; provider). Deps: express, `@x402/express`, `@x402/stellar`.
- **`frontend` (AgentBoard):** components `ConnectBar · ProposalList · VoteModal · SealedTallyPanel (countdown, no results) · RevealedResult · AgentBoardTerminal · TreasuryPanel`. Deps: stellar-sdk, **smart-account-kit** (passkey/WebAuthn), zk-prover, typed contract bindings, agent log stream.

### Dependency graph
```
Groth16Verifier <-- GovVault <-- AgentPolicy(OZ) --> SwapVenue{FallbackAMM | Soroswap}
                       ^             ^   (treasury = this wallet)
        snapshot-tool--+             |
        zk-prover+tlock (client)     agent-middleware --> x402 PremiumData
                       ^             |  (watcher, tallyReveal) --> Claude
        frontend (AgentBoard) -------+                          --> drand beacon
        ShadowKitAPI (x402) --> GovVault (read)
```

### Proposed workspace layout
```
shadowkit/
  contracts/      # Rust: gov-vault, groth16-verifier, agent-policy (OZ), fallback-amm, shared
  circuits/       # Circom: vote/
  packages/       # TS: zk-prover, snapshot-tool, tally-reveal, shared (types + bindings)
  agent/          # TS middleware
  x402-services/  # TS: premium-data, shadowkit-api
  web/            # Astro/React AgentBoard
  docs/
  justfile        # just test / just deploy across all layers
```

---

## 9. Data Contracts

- **publicSignals:** `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]` — `proposalId` binds the proof (anti-replay); **direction & weight are NOT public** (sealed).
- **ProposalView:** `{id, action_spec, cap, deadline, votes_cast, status: Open|Tallying|Approved|Rejected|Executed, weighted_yes?, weighted_no?}` — `weighted_*` are null until close.
- **ActionSpec:** `{kind:"swap", asset_in, asset_out, amount, min_out_policy}` — cap bounds `amount`.
- **AgentLog:** `{ts, phase:"reveal|data|plan|sign|submit|done", message, txHash?}`

**Quorum config (demo default):** passes if `weighted_yes > weighted_no` **and** participation ≥ threshold (default ≥ 3 voters). Configurable.

**Circuit constraints (core):** `leaf = Poseidon(Poseidon(secret), weight)`; `MerkleVerify(leaf, path, root)`; `nullifier = Poseidon(secret, proposalId)`; the sealed vote encrypts `direction ∈ {0,1}` with `weight` matching the leaf (proof attests well-formedness without revealing them). **Weighted reveal** at close via tlock decrypt + on-chain tally check (M5).

---

## 10. Test Strategy (TDD: red → green → refactor)

**Soroban (Rust `Env`):**
- `Groth16Verifier`: valid→true; tampered/wrong-inputs/malformed→false/error (no panic). Committed fixtures.
- `GovVault`: init; create; happy sealed vote; **double-vote (nullifier)→reject**; **replay (other proposalId)→reject**; post-deadline vote→reject; invalid proof→reject; **`proposal()` exposes no tally before close**; correct `close_and_reveal`→weighted tally; wrong reveal→reject; quorum pass/fail; `mark_executed` single-shot.
- `AgentPolicy` **(= safeguard proof, real auth):** approved+in-cap+correct-target+valid-sig→allow; **not-approved→reject; over-cap→reject; wrong target→reject; wrong asset→reject; already-executed→reject; bad sig→reject; multi-call auth→reject.**
- `FallbackAMM`: add_liquidity; constant-product swap; `min_out` slippage revert; reserves update.
- **Cross-contract integration:** deploy all → sealed votes → close+reveal → policy allows → swap → balances move. **Negative:** execute without quorum/approval → blocked.

**Circuit (Circom):** witness satisfiable; sealed-vote well-formedness; weight↔leaf; nullifier derivation; snarkjs↔on-chain verify round-trip.

**Timelock (tlock):** vote encrypted to round T is **undecryptable before T**; decryptable after beacon; tally over decrypted votes matches expected.

**Off-chain (TS, Vitest):**
- `zk-prover`: proof verifies; deterministic signals; sealed ciphertext round-trips; bad input→error.
- `snapshot-tool`: root determinism; valid path accepted; tamper→invalid.
- `tally-reveal`: correct aggregate from sealed votes; reveal proof accepted on-chain; pre-deadline reveal attempt fails.
- `agent-middleware`: planner rejects over-cap plan (LLM stubbed); executor builds correct tx + client cap guard + idempotent; watcher triggers at close (RPC mock).
- `x402-services`: no payment→402; valid payment→data; provider gating.
- `frontend`: VoteModal proves + seals + submits; SealedTallyPanel shows NO results pre-close; RevealedResult renders post-close; terminal streams.

**E2E (demo loop):** snapshot → proposal w/ deadline → N sealed votes (no tally visible) → deadline → reveal → agent executes → assert treasury changed + tally first revealed. Run repeatedly = "demo never dies."

**Infra:** real auth in AgentPolicy tests; local network via `stellar` quickstart container; committed circuit fixtures; single `just test`.

---

## 11. Build Order — Walking Skeleton (M0–M6), each demoable + fallbacks

| M | Deliverable | Demoable | Fallback |
|---|---|---|---|
| **M0** | Scaffold, workspace, local net, SAC tokens, `just test/deploy` green | pipeline | — |
| **M1** | GovVault **plaintext** voting + quorum + approved; FallbackAMM w/ liquidity; FE list+vote+tally | ✅ vote→approve | — |
| **M2** | AgentPolicy (treasury) on **OZ Smart Account** + custom GovVault-gating policy; **deterministic** agent swap; agent terminal | ✅ **FULL HERO LOOP** | hand-rolled `__check_auth` |
| **M3** | Claude planner (split/slippage/timing ≤cap), streamed reasoning | ✅ agent "thinks" | deterministic (M2) |
| **M4** | Circom circuit + snarkjs + adapted verifier → `cast_vote` requires proof; browser prover; snapshot-tool. **Sealed votes (direction hidden), no tally exposed** | ✅ **private + sealed vote** | on-chain hard → off-chain verify; circuit hard → membership+nullifier only |
| **M5** | **D6 reveal:** timelock-encrypt votes (tlock/Drand-Relay) + weighted `close_and_reveal` at deadline | ✅ **hidden-until-close weighted tally** | coordinator commit-reveal; harder → weight-unlinked; → 1p1v |
| **M6** | x402 both directions; passkey via smart-account-kit; README + threat-model + slides; testnet deploy | ✅ **full product** | x402 one-way; drop passkey |

**Key:** after **M2** we already have a complete, demoable hero loop. M3–M6 are track-strengthening upgrades, each with a fallback → we never end with "nothing works."

---

## 12. Cryptographic Assumptions (explicit)

- Groth16 soundness under BLS12-381 pairing assumptions (toxic waste discarded after our local trusted setup).
- Poseidon collision/preimage resistance (commitments, nullifiers).
- Snapshot Merkle root correctly reflects eligibility at snapshot time (reproducible/auditable).
- **Timelock (D6 primary):** drand network liveness and honest threshold (votes undecryptable before the round). **Fallback:** non-colluding coordinator for commit-reveal.
- Reference-derived verifier is unaudited / hackathon-grade.

---

## 13. Open Items & Risks

1. **Soroswap testnet integration (D8) — UNCONFIRMED.** Mitigation: `SwapVenue` adapter + always-deployed FallbackAMM + config switch. Verify via Soroswap GitHub/contracts at M2/M6.
2. **In-circuit sealed-vote + weighted reveal (M4/M5)** is the hardest crypto. Mitigation: layered fallbacks (off-chain verify; coordinator reveal; weight-unlinked; 1p1v).
3. **Timelock feasibility (D6).** Verify `tlock-js` + `kaankacar/Drand-Relay` flow, drand round↔deadline mapping, and (stretch) on-chain drand-beacon BLS verification at M5. Fallback: coordinator commit-reveal.
4. **OZ Smart Account custom policy → external contract read (D7).** Verify a custom policy can cross-contract-read `GovVault.is_approved(id)`/cap during authorization, and confirm OZ `stellar-contracts` testnet maturity, at M2. Fallback: hand-rolled `__check_auth`.
5. **Trusted setup** for Groth16: acceptable for hackathon; documented.
6. **LLM latency/cost** in a live demo: fast capable Claude model + prompt caching + pre-warm; deterministic fallback (M2) always available.

---

## 14. Out of Scope (YAGNI)

- Multi-proposal-type execution beyond `swap` (transfers, LP add) — roadmap.
- Production MPC trusted-setup ceremony / threshold timelock key.
- Mainnet deployment (testnet target; mainnet a "plus").
- Mobile-native passkey polish beyond browser WebAuthn.
