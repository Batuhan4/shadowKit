# ShadowKit & AgentBoard — Design Spec

**Date:** 2026-06-02
**Status:** Approved (brainstorming complete; pre-implementation)
**Target:** Build On Stellar Hackathon — IBW 2026 (Main + Hack Agentic + Hack Privacy)

---

## 1. Summary

**ShadowKit** is a ZK- and AI-powered autonomous governance infrastructure (SDK/middleware) for Stellar projects, DAOs, and communities. Members vote **privately** (zero-knowledge proofs hide who voted, how they voted, and how much weight they hold); once a proposal reaches quorum, an **autonomous AI agent** executes the approved on-chain action (e.g., a treasury swap on a Stellar DEX) with **no human approval in the loop**. The agent's spending authority is mathematically gated by an on-chain policy, so a hallucinating agent literally cannot move funds incorrectly.

**AgentBoard** is the front-end dashboard: private voting UI + a live "agent terminal" that streams the agent's reasoning and on-chain execution.

The demo product, **ShadowDAO**, is a sample DeFi treasury built on ShadowKit.

---

## 2. Problem & Solution

**Problem.** Web3 votes are public by default → small holders are visible to and manipulable by whales and analytics firms. Executing decisions then requires slow, centralized manual multisig approval.

**Solution.** Passwordless (passkey) login → client-side ZK proof hides identity, vote direction linkage, and token weight → Soroban contract verifies the proof on-chain → on quorum, an AI agent autonomously executes the smart-contract action (DEX swap / transfer), bounded by an on-chain spending policy.

---

## 3. Hackathon Track Alignment

| Track | Fit |
|---|---|
| **Main** ($2,600, automatic) | Soroban contracts deployed to testnet, working demo, real problem (governance manipulation + execution latency), strong UX (passkey, agent terminal), clear ecosystem fit. |
| **Hack Agentic** ($1,200) | Agent autonomously executes approved proposals (no per-tx human approval). Safeguards = on-chain scoped-auth policy (spending limit / session key — a listed track example). Why Stellar = fast finality + ~zero fees + native assets + on-chain ZK + custom-account auth. |
| **Hack Privacy** ($1,200) | Private voting via ZK proofs (a listed track example). Explicit threat model: what's hidden, from whom, with which tech and assumptions. |

---

## 4. Locked Design Decisions

| # | Decision | Choice | Notes |
|---|---|---|---|
| D1 | ZK verification fidelity | **On-chain Groth16 verify** (BLS12-381) | Architected with off-chain-verify fallback so the demo never breaks. |
| D2 | Agent autonomy | **LLM-bounded execution** | LLM decides *how* (slippage/route/split/timing) within on-chain-enforced limits. |
| D3 | x402 scope | **Wide — both directions** | Agent *pays* for premium data; ShadowKit *sells* a paid verify/execute API. |
| D4 | Stack | **TypeScript everywhere + Rust contracts** | passkey-kit & x402 are TS-only; agent LLM calls are first-class in TS. |
| D5 | Vote weighting | **Token-weighted, weight hidden** | Hardest piece; built last (M5) with fallbacks to "weight-unlinked" then 1p1v. |
| D6 | Vote secrecy | **Unlinkable** (direction count public, identity unlinkable) | Weighted totals revealed only at close. |
| D7 | Treasury custody | **Agent scoped-auth (session-key smart wallet)** | Treasury = AgentPolicy wallet balance; GovVault holds no funds. |
| D8 | Swap venue | **External testnet AMM (Soroswap) via adapter** | Always ship our own FallbackAMM + config switch (Soroswap unconfirmed — see §13). |

---

## 5. Verified Technical Facts (source-of-truth, 2026-06-02)

- **BLS12-381 (CAP-0059):** `Final`, shipped in **Protocol 22**. Adds 16 host functions (G1/G2 add, scalar-mul, MSM, map/hash-to-curve, multi-pairing check, Fr ops). → On-chain Groth16 verify is solid.
- **Current networks:** mainnet & testnet are on **Protocol 25** (Jan 2026) → BLS12-381 is unquestionably live.
- **Bonus (Protocol 25):** **BN254** and **Poseidon/Poseidon2** host functions are now live on all networks. We keep the core on the proven BLS12-381 path and treat these as optional optimizations (e.g., cheaper on-chain hashing) — not core dependencies.
- **Reference verifier:** `stellar/soroban-examples/groth16_verifier` uses **Circom 2.2.1 + snarkjs + BLS12-381**. We adapt it. → **Tooling decision: Circom + snarkjs** (not Noir). ⚠️ Reference is explicitly *demo-only / unaudited*; we are hackathon-grade and disclose it.
- **Soroswap testnet:** ⚠️ **Not confirmed** from docs (intro page only). Mitigated by the adapter + FallbackAMM design (§13).

---

## 6. Architecture & End-to-End Flow

### Components (high level)
1. **Frontend — AgentBoard** (Astro/React, Scaffold Stellar): connect (passkey/keypair), proposals, private vote flow (browser-side proof), live tally, **agent terminal**, treasury panel.
2. **ZK layer** (Circom): circuit = snapshot membership + hidden weight + nullifier + direction + proposalId binding; proving in-browser (wasm + snarkjs).
3. **Soroban contracts** (Rust): `Groth16Verifier`, `GovVault`, `AgentPolicy` (smart wallet = treasury), `FallbackAMM` (+ `SwapVenue` interface).
4. **Agent middleware** (TS): event watcher → x402 data purchase → Claude planner → session-key signer → submitter → AgentBoard log.
5. **x402 services** (TS): premium-data endpoint (agent pays) + ShadowKit paid API (provider).

### End-to-end demo loop
```
1. User connects (passkey/keypair)
2. Proposal: "Swap 15k USDC -> XLM on DEX"
3. PRIVATE VOTE: browser builds Circom/snarkjs proof
   (in snapshot + weight=balance[HIDDEN] + nullifier + direction)
        |
        v
4. GovVault: Groth16 verify (BLS12-381) -> nullifier check (+ proposalId binding)
   -> increment public direction count -> accumulate hidden weight (G1 add)
        |
        v
5. Quorum reached at close -> GovVault: reveal weighted tally -> set approved flag + cap
        |
        v  (event)
6. Agent middleware: x402-pay premium data -> Claude plan (<= cap)
   -> sign via session key -> AgentPolicy.__check_auth validates -> swap on AMM
        |
        v
7. AgentBoard terminal: agent reasoning + on-chain tx + new treasury; final weighted tally shown
```

---

## 7. Threat Model & Safeguards

### 7.1 Hack Privacy (required statements)

**(1) What is hidden, from whom**
- **Hidden:** (a) the link between *who voted* and *how they voted*; (b) a member's token weight/balance; (c) which eligible members actually voted.
- **From:** chain-analytics firms, rival DAOs, whales, and even other members.
- **Public by design (auditability):** per-direction vote *counts*, final *weighted* tally, proof that a valid vote occurred, nullifiers (opaque), Merkle root.

**(2) Privacy technology**
- Groth16 zk-SNARK (Circom + snarkjs), **on-chain verification via BLS12-381**.
- Nullifier scheme (double-vote prevention, bound to proposalId).
- Merkle-tree commitment for eligibility (leaf = `Poseidon(addrCommit, weight)`).
- Pedersen / homomorphic commitment for the hidden weighted tally, accumulated on-chain via G1 add/MSM.

**(3) Threat model & assumptions**
- **Adversaries:** passive chain/analytics observer; active whale (coercion/bribery); malicious member (double-vote or vote without eligibility).
- **Guarantees:** eligibility soundness (ZK membership); no double-vote (nullifier); vote unlinkability; weight privacy.
- **Assumptions (honest):** per-circuit Groth16 trusted setup (toxic-waste; hackathon runs its own — production would use an MPC ceremony); BLS12-381 pairing/DL hardness; snapshot integrity (root is reproducible); reference verifier is demo-grade/unaudited.
- **Known limitation:** the running per-direction *count* is public (timing/strategic leakage) — mitigated by short voting windows; full secrecy is the (deferred) "hidden-until-tally" upgrade.

### 7.2 Hack Agentic (required statements)

**(1) What the agent does autonomously**
Manages *execution* of an already-approved proposal: pays via x402 for market data, chooses slippage/split/timing/route, signs and submits the swap. **No human approves the final tx**; the only trigger is the ZK-verified quorum.

**(2) Safeguards (the mathematical lock)**
`AgentPolicy.__check_auth` refuses *any* tx unless **all** hold:
`(a)` GovVault reports quorum approved · `(b)` proposal not yet executed (single-shot) · `(c)` target = approved AMM · `(d)` asset = treasury asset · `(e)` amount ≤ proposal cap.
→ Even a hallucinating LLM (wrong amount/target/asset/proposal) is **rejected on-chain**. "Cannot touch funds" is mathematical, not procedural. Extras: per-proposal cap, single-shot replay guard, time-boxed/revocable session key. Defense-in-depth: the cap is also a hard constraint in the planner prompt and validated client-side before submit.

**(3) Why Stellar**
Fast finality + ~zero fees → real-time reaction, order splitting, and per-call x402 data payments are economical (gas-prohibitive on Ethereum). Native USDC/XLM → no `approve`/`transferFrom`. BLS12-381 host functions → on-chain ZK verify is cheap, so the safeguard is enforced by the chain itself. Custom-account `__check_auth` → session-key/scoped-auth is a first-class Stellar primitive.

---

## 8. Component Boundaries & Interfaces

### On-chain (Rust / Soroban)

**`Groth16Verifier`** *(isolated Verifier layer)*
- **Does:** verify a Groth16 proof vs embedded VK + public inputs (BLS12-381 host fns).
- **Interface:** `verify(proof, public_inputs) -> bool`
- **Depends on:** BLS12-381 host fns; embedded VK. (Adapted from official example.)

**`GovVault`** *(Application + quorum policy; holds no funds)*
- **State:** admin, verifier addr, Merkle root, treasury asset, quorum cfg, proposals, nullifier set, per-proposal {yes_count, no_count, yes_weight_acc(G1), no_weight_acc(G1), cap, status, revealed?}.
- **Interface:**
  - `init(admin, verifier, merkle_root, treasury_asset, quorum_cfg)`
  - `create_proposal(action_spec, cap, deadline) -> id`
  - `cast_vote(id, proof, {nullifier, direction, weight_commitment})`
  - `close_and_reveal(id, total_yes_w, total_no_w, opening)`
  - `is_approved(id) -> bool` · `proposal(id) -> ProposalView` · `mark_executed(id)`
- **Depends on:** Groth16Verifier, BLS12-381 host fns, storage.

**`AgentPolicy`** *(custom account = agent smart wallet = treasury; the Policy/lock)*
- **Does:** `__check_auth` authorizes only the approved, capped, correctly-targeted swap of an approved-and-unexecuted proposal, with a valid owner signature.
- **Interface:** `__check_auth(payload, sigs, auth_contexts)` · `init(owner_key, gov_vault, approved_amm, treasury_asset)`
- **Depends on:** GovVault (read), AMM address, ed25519 host fn.

**`FallbackAMM`** *(guaranteed demo liquidity)* + **`SwapVenue` interface**
- **Does:** minimal constant-product USDC/XLM pool; both this and a Soroswap-wrapper satisfy `SwapVenue` so AgentPolicy is venue-agnostic.
- **Interface:** `swap(asset_in, amount_in, min_out, to) -> out` · `add_liquidity(...)` · `reserves()`
- **Depends on:** SAC tokens (USDC/XLM), storage.

### Off-chain (TypeScript)

- **`zk-prover` (client lib):** `generateVoteProof({secret, merklePath, weight, proposalId, direction}) -> {proof, publicSignals}`. Deps: circuit.wasm + .zkey, snarkjs.
- **`snapshot-tool`:** `buildSnapshot(holders) -> {root, getPath(addr)}`. Used at setup (root → GovVault) and by client (path). Deps: poseidon, merkle lib.
- **`agent-middleware`:** modules `watcher · dataClient(x402) · planner(Claude) · executor · logBus`. Deps: stellar-sdk, GovVault/AgentPolicy, `@x402/*`, Anthropic SDK, RPC.
- **`x402-services`:** (a) `PremiumData` (x402-protected price+signal; agent pays); (b) `ShadowKitAPI` (x402-protected verify/execute; provider). Deps: express, `@x402/express`, `@x402/stellar`.
- **`frontend` (AgentBoard):** components `ConnectBar · ProposalList · VoteModal · LiveTally · AgentBoardTerminal · TreasuryPanel`. Deps: stellar-sdk, passkey-kit, zk-prover, typed contract bindings, agent log stream.

### Dependency graph
```
Groth16Verifier <-- GovVault <-- AgentPolicy --> SwapVenue{FallbackAMM | Soroswap}
                       ^             ^   (treasury = this wallet)
        snapshot-tool--+             |
        zk-prover (client)           agent-middleware --> x402 PremiumData
                       ^             |                --> Claude
        frontend (AgentBoard) -------+
        ShadowKitAPI (x402) --> GovVault (read)
```

### Proposed workspace layout
```
shadowkit/
  contracts/      # Rust: gov-vault, groth16-verifier, agent-policy, fallback-amm, shared
  circuits/       # Circom: vote/
  packages/       # TS: zk-prover, snapshot-tool, shared (types + bindings)
  agent/          # TS middleware
  x402-services/  # TS: premium-data, shadowkit-api
  web/            # Astro/React AgentBoard
  docs/
  justfile        # just test / just deploy across all layers
```

---

## 9. Data Contracts

- **publicSignals:** `[merkleRoot, nullifier, proposalId, direction, weightCommitmentX, weightCommitmentY]` — `proposalId` binds the proof (anti-replay).
- **ProposalView:** `{id, action_spec, cap, deadline, yes_count, no_count, status: Open|Approved|Rejected|Executed, weighted_yes?, weighted_no?}`
- **ActionSpec:** `{kind:"swap", asset_in, asset_out, amount, min_out_policy}` — cap bounds `amount`.
- **AgentLog:** `{ts, phase:"data|plan|sign|submit|done", message, txHash?}`

**Quorum config (demo default):** proposal passes if `weighted_yes > weighted_no` **and** participation ≥ threshold (default: ≥ 3 distinct voters). Configurable per deployment.

**Circuit constraints (M4 core):** `leaf = Poseidon(Poseidon(secret), weight)`; `MerkleVerify(leaf, path, root)`; `nullifier = Poseidon(secret, proposalId)`; `direction ∈ {0,1}`. **M5 extension:** `weightCommitment = weight·G + r·H` (Pedersen, in-circuit) — hardest part; see fallbacks (§11).

---

## 10. Test Strategy (TDD: red → green → refactor)

**Soroban (Rust `Env`):**
- `Groth16Verifier`: valid→true; tampered/wrong-inputs/malformed→false/error (no panic). Fixtures committed.
- `GovVault`: init; create; happy vote; **double-vote (nullifier)→reject**; **replay (other proposalId)→reject**; post-deadline→reject; invalid proof→reject; correct reveal→weighted tally; wrong opening→reject; quorum pass/fail; `mark_executed` single-shot.
- `AgentPolicy.__check_auth` **(= safeguard proof, real auth, NOT mock_all_auths):** approved+in-cap+correct-target+valid-sig→allow; **not-approved→reject; over-cap→reject; wrong target→reject; wrong asset→reject; already-executed→reject; bad sig→reject; multi-call auth→reject.**
- `FallbackAMM`: add_liquidity; constant-product swap; `min_out` slippage revert; reserves update.
- **Cross-contract integration:** deploy all → vote → close → policy allows → swap → balances move. **Negative:** execute without quorum → blocked.

**Circuit (Circom):** witness satisfiable; `direction∈{0,1}`; weight↔leaf; nullifier derivation; snarkjs↔on-chain verify round-trip.

**Off-chain (TS, Vitest):**
- `zk-prover`: proof verifies in snarkjs; deterministic signals; bad input→error.
- `snapshot-tool`: root determinism; valid path accepted by circuit; tamper→invalid.
- `agent-middleware`: planner rejects over-cap plan (LLM stubbed); executor builds correct tx + client cap guard + idempotent; watcher triggers on event (RPC mock).
- `x402-services`: no payment→402; valid payment→data; provider gating.
- `frontend`: VoteModal calls prover + submits; LiveTally renders; terminal streams.

**E2E (demo loop):** snapshot → proposal → N private votes → close → agent executes → assert treasury changed + tally revealed. Run repeatedly = "demo never dies."

**Infra:** real auth in AgentPolicy tests; local network via `stellar` quickstart container; committed circuit fixtures (no re-proving per test); single `just test` runs all layers.

---

## 11. Build Order — Walking Skeleton (M0–M6), each demoable + fallbacks

| M | Deliverable | Demoable | Fallback |
|---|---|---|---|
| **M0** | Scaffold, workspace, local net, SAC tokens, `just test/deploy` green | pipeline | — |
| **M1** | GovVault **plaintext** voting + quorum + approved; FallbackAMM w/ liquidity; FE list+vote+tally | ✅ vote→approve | — |
| **M2** | AgentPolicy (treasury) + `__check_auth`; **deterministic** agent swap; agent terminal | ✅ **FULL HERO LOOP** | — |
| **M3** | Claude planner (split/slippage/timing ≤cap), streamed reasoning | ✅ agent "thinks" | deterministic (M2) |
| **M4** | Circom circuit + snarkjs + adapted verifier → `cast_vote` requires proof; browser prover; snapshot-tool | ✅ **private vote** | on-chain hard → off-chain verify; circuit hard → membership+nullifier (1p1v) |
| **M5** | Pedersen weight commitment + G1 accumulation + `close_and_reveal` | ✅ **hidden weighted tally** | opening hard → "weight visible but unlinked"; harder → 1p1v |
| **M6** | x402 both directions; passkey (if time); README + threat-model + slides; testnet deploy | ✅ **full product** | x402 one-way; drop passkey |

**Key:** after **M2** we already have a complete, demoable hero loop. M3–M6 are track-strengthening upgrades, each with a fallback → we never end with "nothing works."

---

## 12. Cryptographic Assumptions (explicit)

- Groth16 soundness under the BLS12-381 pairing assumptions (and the chosen toxic-waste being discarded after our local trusted setup).
- Poseidon collision/preimage resistance for commitments and nullifiers.
- Snapshot Merkle root correctly reflects eligibility at snapshot time (reproducible/auditable).
- The reference-derived verifier is unaudited and hackathon-grade.

---

## 13. Open Items & Risks

1. **Soroswap testnet integration (D8) — UNCONFIRMED.** Could not verify addresses/SDK/liquidity. Mitigation: `SwapVenue` adapter + always-deployed FallbackAMM + config switch. Action: verify via Soroswap GitHub/contracts during M2/M6; ship FallbackAMM regardless.
2. **In-circuit Pedersen commitment over BLS12-381 (M5)** is the single hardest piece. Mitigation: layered fallbacks (weight-unlinked → 1p1v).
3. **Trusted setup** for Groth16: acceptable for hackathon; documented assumption.
4. **LLM latency/cost** in a live demo: use a fast capable Claude model, prompt caching (claude-api skill), and pre-warm; deterministic fallback (M2) always available.
5. **BN254/Poseidon CAP numbering** showed a minor doc discrepancy; irrelevant to core (we use BLS12-381). Re-verify only if we opt into Protocol-25 optimizations.

---

## 14. Out of Scope (YAGNI)

- Full hidden-until-tally vote secrecy (Q2-B) — deferred upgrade.
- Multi-proposal-type execution beyond `swap` (transfers, LP add) — roadmap.
- Production MPC trusted-setup ceremony.
- Mainnet deployment (testnet is the target; mainnet is a "plus").
- Mobile-native passkey polish beyond browser WebAuthn.
