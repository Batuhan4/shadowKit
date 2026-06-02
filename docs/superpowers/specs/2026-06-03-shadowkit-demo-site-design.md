# ShadowKit Demo Site — Design Spec

**Date:** 2026-06-03
**Status:** Approved (key decisions locked via AskUserQuestion 2026-06-03)
**Goal:** One public, production-grade site at `shadowkit.pages.dev` that presents ShadowKit (the SDK) and runs **two fully-live testnet demos** + **SDK docs**, deployed to Cloudflare Pages.

---

## 1. Locked decisions

| Decision | Choice | Implication |
|---|---|---|
| Demo liveness | **Fully live, no replay fallback** | Real wallet, real ZK proof, real tlock, real on-chain swap every visit. No canned recording. |
| USDC | **Self-issued test USDC SAC** | Issuer = `DEMO_WALLET` (`GDWT…RGFDH`); mint on demand; pool never empties. |
| Site name | **shadowkit** | `shadowkit.pages.dev`; landing = SDK hero → `/demo/fund`, `/demo/agent`, `/docs`. |
| Hosting | **Cloudflare Pages + Pages Functions** | Static Astro + `functions/` Workers backend (same project, one deploy). |
| Brand | dark shadow→reveal | Void/Violet/Cyan/Gold/Green; Space Grotesk + JetBrains Mono + Cantarell; "Vote in the shadows. Execute in the light." |

## 2. Architecture

Single Astro project in `web/` (extends the existing app; reuses `AgentBoardTerminal`, `VoteModal`, `ProposalList`, `TallyView`). Output `web/dist` deployed to Cloudflare Pages. A `web/functions/` directory holds **Pages Functions** (Cloudflare Workers, `nodejs_compat`) for the server-side agent path.

```
Browser (Astro islands, React)                 Cloudflare Pages Functions (Worker)
─────────────────────────────────             ─────────────────────────────────────
/demo/fund                                     functions/api/agent/execute  (POST, SSE)
  • connect wallet (Stellar Wallets Kit)         • read GovVault: proposal approved?
  • client-side ZK proof (snarkjs+wasm)          • x402: pay premium-data, fetch quote
  • client-side tlock seal (tlock-js→drand)      • Gemini plan (key = Worker secret), bounded
  • submit cast_vote tx (wallet signs)           • policy-gate the plan
  • after close: client tlock reveal → tally     • submit swap tx (executor key = Worker secret)
                                                 • stream AgentBoard log lines back (SSE)
/demo/agent                                    functions/api/premium-data    (x402-charged GET)
  • AgentBoard terminal (live SSE)             functions/api/config          (contract IDs, RPC)
```

**Why this split:** the voter's secret/witness never leaves the browser (correct privacy); the Gemini key and the executor signing key never reach the browser (correct security). Both halves are genuinely live on testnet.

## 3. Site map & pages

- `/` — Landing. SDK hero (tagline, violet→cyan gradient, "The Seal" motif), the shadow→reveal story (sealed → timelock → reveal → agent executes), three cards: **Private Voting**, **AI AgentBoard**, **Docs**. Track badges (Privacy + Agentic). CTA → demos.
- `/demo/fund` — **ShadowFund**: SCF-style private community-fund vote. Grid of candidate projects (SCF-styled cards). Connect wallet → cast a **sealed** weighted vote (ZK proof hides identity/weight/direction; tlock hides the running tally). Live "X votes sealed, tally hidden until close" state. A **Close & Reveal** action (admin/demo button) runs the tlock reveal → animated unseal → winner gets the USDC pool disbursed on-chain.
- `/demo/agent` — **AgentBoard**: takes an approved proposal and runs the live agent loop via the Worker; the `AgentBoardTerminal` streams Gemini's bounded plan, the policy verdict, and the real swap tx (with Stellar Explorer links + before/after balances).
- `/docs` — **Starlight** docs for the ShadowKit SDK (install, the 4 packages, contracts, circuits, the agent, x402, quickstart, API reference).

## 4. Components

**Reuse (already tested in `web/src/components/`):** `AgentBoardTerminal`, `VoteModal`, `ProposalList`, `TallyView`.
**New (React islands):**
- `WalletConnect` — Stellar Wallets Kit connect/disconnect, account display.
- `FundProjectGrid` — SCF-styled candidate cards (image, name, ask, category, votes-sealed count).
- `SealedVoteFlow` — orchestrates: build witness → snarkjs proof → tlock seal → `cast_vote` submit; shows each step as a sealed-progress UI.
- `RevealStage` — Close & Reveal: tlock decrypt → tally animation → winner + disbursement tx.
- `AgentRunPanel` — kicks `functions/api/agent/execute`, binds the SSE stream into `AgentBoardTerminal`.
- `ExplorerLink`, `BalanceBadge`, `TrackBadge`, `CodeBlock` (docs).

**New (Astro):** `Layout.astro` (brand tokens, fonts, gradient bg, grain overlay), `Hero.astro`, `Nav.astro`, `Footer.astro`, the four page routes.

## 5. Backend — Pages Functions (Workers)

- `functions/api/config.ts` — returns public config: network passphrase, RPC URL, contract IDs (GovVault, Groth16Verifier, USDC SAC, SwapVenue), demo proposal id. No secrets.
- `functions/api/premium-data.ts` — x402-charged endpoint returning the "market quote" the agent pays for (proves x402 inbound).
- `functions/api/agent/execute.ts` — the live agent. Streams Server-Sent Events. Steps: verify proposal approved on-chain → x402-pay `premium-data` → Gemini bounded plan → policy gate → submit swap → emit balances + tx hash. Reuses `agent/` package logic (planner, executor, policy guard) compiled for the Worker runtime.
- **Secrets (via `wrangler pages secret put`):** `GEMINI_API_KEY`, `EXECUTOR_SECRET` (the agent's Stellar signing key — a scoped demo key, NOT the main DEMO_WALLET seed), `X402_*` as needed.
- **Compat:** `compatibility_flags = ["nodejs_compat"]`; `@stellar/stellar-sdk`, `@google/genai`, `tlock-js`, `drand-client` all run over `fetch`.

## 6. Testnet wiring

- Reuse `scripts/deploy-testnet.sh` (from M6 finale) to deploy GovVault + Groth16Verifier + self-issued USDC SAC + SwapVenue/FallbackAMM to **testnet**, fund the treasury, register the merkle root + executor, and emit a `deploy-testnet.json` of contract IDs consumed by `functions/api/config.ts` and the site build.
- DEMO_WALLET funds the pool (mints self-issued USDC). A separate scoped `EXECUTOR_SECRET` is the agent signer (set via policy `set_executor`).
- The circuit artifacts (`vote.wasm`, `vote_final.zkey`, `verification_key.json`) ship as static assets under `web/public/zk/` for client-side proving.

## 7. Testing strategy (TDD, no cheating — per charter)

- **Components (vitest + Testing Library):** each new React island gets red→green tests: render, state transitions (sealed → revealed), error states. Reuse existing component tests as the pattern.
- **Worker logic (vitest, Miniflare/`unstable_dev` or pure unit):** `agent/execute` happy path + negatives (proposal NOT approved → 403; Gemini plan violates policy → rejected, no tx; x402 payment missing → 402). Real planner/executor/policy code under test — mock only the network boundary (RPC/Gemini) with recorded cassettes, never the unit under test.
- **ZK/tlock (browser-path):** unit test the witness-builder + proof-marshal + seal/reveal round-trip using the real snarkjs/tlock libs (real proof, real beacon), asserting public-signal binding order `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]`.
- **e2e against testnet (`scripts/`):** a headless script that deploys to testnet, casts a real sealed vote, closes+reveals, and triggers the agent swap, asserting real balance movement + tx success. This is the "100% works on testnet" gate.
- **No-cheating gates:** grep gates for `.skip`/`.only`/always-true asserts; real crypto (no stubbed proofs/sigs); the live path must pass WITHOUT a replay fallback.

## 8. Deploy

- `wrangler pages project create shadowkit` (once), then `wrangler pages deploy web/dist --project-name shadowkit`.
- Secrets via `wrangler pages secret put` (Gemini, executor).
- Verify the live URL: load `/`, run a real vote on `/demo/fund`, run the agent on `/demo/agent`, confirm tx hashes resolve on Stellar Explorer (testnet).

## 9. Brand / design direction

Dark, cinematic "shadow → reveal." Void base with a violet→cyan aurora gradient + subtle grain; gold accent reserved for the unseal moment; on-chain-green for tx success. Space Grotesk display, JetBrains Mono for hashes/code, Cantarell body. Octagon "Seal" motif on the hero. Motion: staggered hero reveal on load; the sealed→revealed tally is the signature animation (blurred/redacted → gold flash → numbers count up). Honor `docs/design/` (aurora scene) + `docs/marketing/` brief.

## 10. Out of scope (YAGNI)

No multi-tenant DAO creation UI, no mainnet, no custom domain (use `*.pages.dev`), no auth beyond wallet connect, no replay/recording mode.
