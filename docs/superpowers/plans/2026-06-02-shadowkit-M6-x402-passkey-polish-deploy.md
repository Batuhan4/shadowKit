# M6 — x402 (Both Directions) + Passkey + Polish + Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.
>
> **READ FIRST (both, before any task):**
> - Spec: `docs/superpowers/specs/2026-06-02-shadowkit-design.md`
> - Foundation (BINDING interfaces): `docs/superpowers/plans/00-foundation-interfaces.md`
>
> Every crate name, package name, file path, type, and signature used here is defined in the foundation. This plan introduces NO type/function/package that is not either (a) defined in a foundation section (cited as `§N`) or (b) defined inline in a task below. If you discover a needed signature missing from the foundation, STOP and add it to the foundation first (foundation §0 rule), then ripple it here.

**Goal:** Ship the full ShadowKit product on testnet by adding the two M6 deliverables on top of the M0–M5 hero loop: **x402 in both directions** (the agent *pays* a real x402 call for premium market data; ShadowKit *sells* an x402-protected verify/execute API), **passkey login** (WebAuthn via `smart-account-kit`, with a keypair fallback), the **Soroswap adapter** behind `SwapVenue` (FallbackAMM fallback), and **polish + deploy** (README, threat-model doc, presentation outline, testnet deployment, and a repeatable full e2e demo script).

**Architecture:** Two Express services (`x402-services/premium-data`, `x402-services/shadowkit-api`) sit at the edge of the existing system. `premium-data` is what the **agent pays** (the agent's `DataClient` from foundation §3.5 wraps a `fetch` that auto-pays the HTTP 402 challenge). `shadowkit-api` is what ShadowKit **sells** — a paid `POST /verify` (off-chain Groth16 verify) + `POST /execute` (kick the agent for an approved proposal), gated by the SAME x402 middleware, reading `GovVault` via the bindings. The frontend gains a passkey connect path (`web/src/lib/wallet.ts`, foundation §3.7) layered over a keypair fallback. The swap layer gains `contracts/swap-venue/src/soroswap_adapter.rs` (foundation §2.4) selected by env `SWAP_VENUE=fallback|soroswap`. Finally a `scripts/deploy-testnet.sh` + `scripts/demo.sh` make the whole loop runnable on testnet, repeatedly green.

**Tech Stack:** TypeScript (ESM, `strict`, Vitest 4.1.8) for the x402 services, agent client, and frontend; Rust/Soroban (`soroban-sdk 26.0.0`) for the Soroswap adapter crate; bash for deploy/demo scripts. Key pinned deps (foundation §6): `@x402/express 2.14.0`, `@x402/stellar 2.14.0`, `@x402/core 2.14.0`, `smart-account-kit 0.2.10`, `@stellar/stellar-sdk 15.1.0`, `express 5.2.1`, `@anthropic-ai/sdk 0.100.1`, `astro 6.4.2`.

---

## 0. Prerequisites & Milestone Boundary

This plan **assumes M0–M5 are complete and green** (foundation §9 plan map):
- `cargo test --workspace` green (groth16-verifier, gov-vault, agent-policy OZ + handrolled, fallback-amm, swap-venue trait).
- `vitest run` green (`@shadowkit/shared`, `@shadowkit/zk-prover`, `@shadowkit/snapshot-tool`, `@shadowkit/tally-reveal`, `@shadowkit/agent` modules except `dataClient` real-x402, `web` components except passkey).
- `just e2e` runs the local-network hero loop (snapshot → proposal → sealed votes → reveal → agent deterministic/Claude swap → treasury moves) green.
- `@shadowkit/agent` `DataClient` (foundation §3.5) exists as a class shell whose `fetchMarket` is currently a non-x402 stub (M2/M3 used a local mock). **M6 makes it a REAL x402 payer.**
- `web/src/lib/wallet.ts` exists with `createKit` + `connect` whose `connect` currently only does the keypair path. **M6 adds the passkey path.**
- `contracts/swap-venue/src/lib.rs` defines the `SwapVenue` trait (foundation §2.4) AND already declares `#[cfg(feature="soroswap")] pub mod soroswap_adapter;`. `contracts/swap-venue/src/soroswap_adapter.rs` **already exists from M2** (Task M2-8): a trait-conformant `SoroswapAdapter` that delegates to a configured `SwapVenueClient` router, with an embedded `#[cfg(test)] mod test` that behaviorally tests delegation against a `MockRouter`. **M6 does NOT create it — M6 MODIFIES it** to call the LIVE Soroswap router (real router address + Soroswap-specific routing args via `swap_exact_tokens_for_tokens`) and adds the live-router test.

If any of the above is not true, finish the corresponding earlier plan first.

**Branch (foundation §8):** create `m6-x402-passkey-deploy` off the M5 branch. Never commit to the default branch. Commit after every red→green cycle. Footer every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

```bash
git checkout -b m6-x402-passkey-deploy
```

**M6 PRIMARY (must fully pass WITHOUT any fallback):**
1. Agent pays a REAL x402 call to `premium-data` on testnet (no-payment→402, valid-payment→data).
2. `shadowkit-api` charges callers via x402 (no-payment→402, valid-payment→verify/execute; provider gating).
3. Passkey (WebAuthn) login works.
4. Soroswap adapter satisfies `SwapVenue` (config `SWAP_VENUE=soroswap`).
5. Full demo loop runs on testnet, repeatably green.

**M6 FALLBACKS (real config-selectable code, each with its OWN passing suite):**
- **x402 one-direction** (`X402_DIRECTION=agent-pays-only`): only `premium-data` is enabled; `shadowkit-api` runs UNGATED (no paywall) so the demo never blocks on the sell-side facilitator. Tested.
- **keypair-login** (`WALLET_MODE=keypair`): `connect()` uses an Ed25519 keypair instead of a passkey. Tested.
- **FallbackAMM** (`SWAP_VENUE=fallback`): already exists from M1; M6 re-asserts the adapter swap is config-selected vs the FallbackAMM. Tested.

---

## 1. File Structure (every file this plan creates or modifies)

> Paths and one-line responsibilities are quoted from foundation §1. Only files listed here are touched by M6.

### Create

| Path | Responsibility (foundation §1) |
|---|---|
| `x402-services/premium-data/package.json` | pkg `@shadowkit/x402-premium-data`; deps express, `@x402/express`, `@x402/stellar` |
| `x402-services/premium-data/tsconfig.json` | extends `tsconfig.base.json` |
| `x402-services/premium-data/vitest.config.ts` | Vitest config for this package |
| `x402-services/premium-data/src/server.ts` | `createPremiumDataServer(cfg)` — `GET /market/:pair` behind `paymentMiddleware` (agent PAYS) |
| `x402-services/premium-data/src/market.ts` | pure `marketDataFor(pair)` → `{ pair, price, signal }` (the data being sold) |
| `x402-services/premium-data/test/server.test.ts` | no-payment→402; valid-payment→data (REAL x402 flow vs local facilitator) |
| `x402-services/premium-data/test/onedir.test.ts` | fallback: `X402_DIRECTION=agent-pays-only` keeps premium-data gated, asserts 402 |
| `x402-services/shadowkit-api/package.json` | pkg `@shadowkit/x402-api`; deps express, `@x402/express`, `@x402/stellar`, `@stellar/stellar-sdk`, `@shadowkit/zk-prover`, `@shadowkit/shared` |
| `x402-services/shadowkit-api/tsconfig.json` | extends base |
| `x402-services/shadowkit-api/vitest.config.ts` | Vitest config |
| `x402-services/shadowkit-api/src/server.ts` | `createShadowKitApiServer(cfg)` — `POST /verify`, `POST /execute` behind `paymentMiddleware`; reads GovVault (ShadowKit SELLS) |
| `x402-services/shadowkit-api/src/gating.ts` | `assertApproved(proposalId, readApproved)` provider gate (foundation §1; matches the impl/tests). `readApproved: (id) => Promise<boolean>` is injected; `server.ts` constructs it from the GovVault binding client using `govVaultId`/`rpcUrl` — those belong to the closure, NOT to `assertApproved`'s parameter list |
| `x402-services/shadowkit-api/test/server.test.ts` | no-payment→402; valid-payment→verify/execute; provider gating (REAL x402 flow) |
| `x402-services/shadowkit-api/test/onedir.test.ts` | fallback: `X402_DIRECTION=agent-pays-only` runs shadowkit-api UNGATED, asserts 200 with no payment |
| `x402-services/shared-x402/package.json` | pkg `@shadowkit/x402-shared` (foundation §1); the local test facilitator + x402 server-construction helper (DRY between the two services) |
| `x402-services/shared-x402/src/index.ts` | `buildStellarResourceServer(cfg)`, `startTestFacilitator(cfg)` (REAL `x402Facilitator` + `createFacilitatorRouter` over a funded FACILITATOR signer) |
| `x402-services/shared-x402/src/payerFetch.ts` | `makeX402Fetch(signerSecret, network)` — the client-side auto-paying fetch (used by agent DataClient + tests) |
| `x402-services/shared-x402/src/fixtures.ts` | `loadX402Accounts()` — reads `CLIENT_SECRET`/`FACILITATOR_SECRET`/`RESOURCE_SERVER_ADDRESS` (foundation §3.6a); the test harness |
| `x402-services/shared-x402/test/roundtrip.test.ts` | REAL 402→pay→200 round-trip through `buildStellarResourceServer` + `makeX402Fetch` with 3 distinct accounts (charter rule 4) |
| `scripts/x402-bootstrap.ts` | provision 3 x402 keypairs, Friendbot-fund, add USDC trustlines, fund payer USDC; writes `.env.x402` (foundation §3.6a) |
| `scripts/deploy-testnet.sh` | build wasm + deploy all contracts to testnet + create/seed SAC tokens + bootstrap x402 accounts/USDC + write `.env.testnet` |
| `scripts/demo.sh` | full e2e demo loop runner (snapshot→proposal→votes→reveal→x402→agent→swap) parameterized by `--network local|testnet` |
| `scripts/demo/_env.ts` | loads `.env.{local,testnet}` and exports typed contract ids + urls (foundation §1) |
| `scripts/demo/start-facilitator.ts` | stands up the local test facilitator on :4023 (uses `FACILITATOR_SECRET`) |
| `scripts/demo/create-proposal.ts` | `buildSnapshot` + `GovVault.create_proposal` with `--deadline` (foundation §1, §3.3) |
| `scripts/demo/cast-votes.ts` | `generateVoteProof` + timelock-seal + `GovVault.cast_vote` ×N (foundation §3.2) |
| `scripts/demo/assert-sealed.ts` | reads `ProposalView`; exit 1 if `weighted_*` non-null pre-close (foundation §1) |
| `scripts/demo/reveal.ts` | `buildRevealArgs` + `GovVault.close_and_reveal` at deadline (foundation §3.4) |
| `scripts/demo/run-agent.ts` | `AgentRunner.run` (x402 pay→plan→sign→swap); snapshots treasury balance before/after (foundation §3.5) |
| `scripts/demo/assert-final.ts` | exit 1 unless treasury balance changed AND tally revealed (foundation §1) |
| `web/test/passkey.test.ts` | passkey path of `connect()` (WebAuthn mocked at the navigator boundary only); keypair fallback path |
| `docs/README.md` | project README (product, architecture, run instructions, demo) |
| `docs/threat-model.md` | Hack Privacy + Hack Agentic threat-model doc (spec §7 materialized) |
| `docs/presentation-outline.md` | slide-by-slide presentation outline |

### Modify

| Path | Change | Approx lines |
|---|---|---|
| `agent/src/dataClient.ts` | replace the stub `fetchMarket` with the REAL x402 payer using `@shadowkit/x402-shared` `makeX402Fetch` (foundation §3.5 `DataClient`) | full file |
| `agent/test/dataClient.test.ts` | replace mock-only test with a REAL x402 round-trip test against the local facilitator | full file |
| `agent/package.json` | add dep `@shadowkit/x402-shared` | +1 line |
| `web/src/lib/wallet.ts` | implement the passkey path in `connect()` via `kit.createWallet`/`kit.connectWallet`; keypair fallback selected by `WALLET_MODE` (foundation §3.7) | `connect()` body |
| `web/src/components/ConnectBar.tsx` | wire `connect()` result + show passkey vs keypair mode badge (foundation §3.7 `ConnectBarProps`) | render + handler |
| `contracts/swap-venue/src/soroswap_adapter.rs` | **MODIFY (created by M2 Task M2-8).** M2 left a trait-conformant `SoroswapAdapter` delegating to a configured `SwapVenueClient` + an embedded `#[cfg(test)] mod test` (`MockRouter`). M6 makes it call the LIVE Soroswap router (`swap_exact_tokens_for_tokens`, verified Task 8.0) and APPENDS the live-router test to the same embedded `mod test` (keeps M2's embedded-mod convention; no separate test file) | swap/reserves body + tests |
| `contracts/swap-venue/src/lib.rs` | NO change to the module declaration — M2 Task M2-8 already added `#[cfg(feature="soroswap")] pub mod soroswap_adapter;`. M6 keeps that exact gated `pub mod` form (the embedded `#[cfg(test)] mod test` lives inside `soroswap_adapter.rs`, so NO `mod soroswap_adapter_test;` line is added) | 0 lines |
| `package.json` (root) | confirm the workspaces glob `"x402-services/*"` (foundation §1) actually matches `shared-x402`; if the glob is absent, ADD `"x402-services/*"` BEFORE the scaffold (Task 3.1) | none if glob present, else +1 entry |
| `vitest.config.ts` (root) | NO modification needed. Vitest 4 removed `vitest.workspace.ts`; M0's root `test.projects` already globs `"x402-services/*"` (covers `shared-x402`, `premium-data`, `shadowkit-api`) and `"agent"` (covers dataClient). The new per-package `x402-services/*/vitest.config.ts` files are loaded automatically — confirm only | confirm glob, 0 edits |
| `justfile` | add `just x402-up`, `just deploy-testnet`, `just demo`, fold x402 tests into `just test`, add `X402_DIRECTION`/`SWAP_VENUE`/`WALLET_MODE` fallback test targets | new recipes |
| `.env.example` | add `X402_NETWORK`, `X402_PRICE_USDC`, `X402_FACILITATOR_URL`, `X402_DIRECTION`, `PREMIUM_DATA_URL`, `PREMIUM_DATA_PORT`, `SHADOWKIT_API_PORT`, `CLIENT_SECRET`, `FACILITATOR_SECRET`, `FACILITATOR_ADDRESS`, `RESOURCE_SERVER_ADDRESS`, `X402_USDC_SAC`, `WALLET_MODE`, `PUBLIC_WALLET_MODE`, `PUBLIC_KEYPAIR_SECRET`, `ACCOUNT_WASM_HASH`, `WEBAUTHN_VERIFIER_ADDRESS`, `SWAP_VENUE`, `SOROSWAP_ROUTER_ID` (foundation §3.6a/§3.7) | new keys |

---

## 2. API VERIFICATION GATE (do this FIRST — charter rule 5)

Because `node_modules` is not yet installed in a fresh checkout and the foundation's signatures were captured on 2026-06-02, **the first task re-verifies the load-bearing x402 + smart-account-kit APIs against the actually-installed packages** before any API-bearing code is written. The foundation §3.6 / §3.7 already mandate this ("M6 binding requirement"). If the installed package's surface differs from what the foundation recorded, STOP and update the foundation §3.6/§3.7 + §6, then continue.

### Task 2.1 — Install + verify the x402 + smart-account-kit surface

- [ ] **Install workspace deps** (root):
  ```bash
  npm install
  ```
  Expected: completes; `node_modules/@x402/express`, `node_modules/@x402/stellar`, `node_modules/@x402/core`, `node_modules/smart-account-kit` all present.

- [ ] **Re-verify x402 docs via ctx7** (charter rule 5 — cite in code comments later):
  ```bash
  npx ctx7@latest library "x402" "stellar express paymentMiddleware resource server exact scheme facilitator"
  # pick /coinbase/x402, then:
  npx ctx7@latest docs "/coinbase/x402" "express paymentMiddleware stellar ExactStellarScheme server x402ResourceServer register HTTPFacilitatorClient wrapFetchWithPayment client"
  ```
  Expected: confirms client side `import { ExactStellarScheme, createEd25519Signer } from "@x402/stellar"`, `new x402Client().register("stellar:*", new ExactStellarScheme(signer))`, `wrapFetchWithPayment(fetch, client)` from `@x402/fetch`; server side `paymentMiddleware(routes, server)`.

- [ ] **Inspect the INSTALLED type defs to lock exact names** (the binding source; the docs above may show a different generation of the API). Note the CORRECTED import locations (foundation §3.6): `HTTPFacilitatorClient` is in `@x402/core/server`, `createFacilitatorRouter` is in `@x402/server/facilitator`, NOT in `@x402/express`:
  ```bash
  # paymentMiddleware + x402ResourceServer ARE in @x402/express; HTTPFacilitatorClient is NOT (it is in @x402/core/server).
  node -e "const d=require('fs').readFileSync('node_modules/@x402/express/dist/esm/index.d.mts','utf8'); console.log('paymentMiddleware', /paymentMiddleware/.test(d)); console.log('x402ResourceServer', /x402ResourceServer/.test(d)); console.log('HTTPFacilitatorClient-in-express', /HTTPFacilitatorClient/.test(d));"
  # HTTPFacilitatorClient + x402ResourceServer in @x402/core/server (the verified import path):
  node -e "const d=require('fs').readFileSync('node_modules/@x402/core/dist/esm/server.d.mts','utf8'); console.log('HTTPFacilitatorClient', /HTTPFacilitatorClient/.test(d)); console.log('x402ResourceServer', /x402ResourceServer/.test(d));" 2>/dev/null || node -e "const p=require('@x402/core/server'); console.log('core/server keys', Object.keys(p));"
  # createFacilitatorRouter in @x402/server/facilitator (the facilitator HTTP helper):
  node -e "const p=require('@x402/server/facilitator'); console.log('createFacilitatorRouter', typeof p.createFacilitatorRouter);" 2>/dev/null || echo "ASSERT-FAIL: @x402/server/facilitator missing createFacilitatorRouter — STOP and reconcile foundation §3.6b"
  # x402Facilitator in @x402/core/facilitator:
  node -e "const p=require('@x402/core/facilitator'); console.log('x402Facilitator', typeof p.x402Facilitator);"
  ls node_modules/@x402/stellar/dist/esm/exact/   # expect: client/ server/ facilitator/
  node -e "const d=require('fs').readFileSync('node_modules/@x402/stellar/dist/esm/exact/server/index.d.mts','utf8'); console.log('server ExactStellarScheme', /ExactStellarScheme/.test(d));"
  node -e "const d=require('fs').readFileSync('node_modules/@x402/stellar/dist/esm/exact/facilitator/index.d.mts','utf8'); console.log('facilitator ExactStellarScheme', /ExactStellarScheme/.test(d));"
  node -e "const p=require('@x402/stellar'); console.log('stellar top-level', Object.keys(p).filter(k=>/Stellar|Signer/.test(k)));"  # ExactStellarClient + createEd25519Signer
  node -e "const p=require('@x402/fetch'); console.log('@x402/fetch', Object.keys(p));"  # expect wrapFetchWithPayment
  # smart-account-kit: constructor REQUIRES accountWasmHash + webauthnVerifierAddress; createWallet/connectWallet present:
  node -e "const d=require('fs').readFileSync('node_modules/smart-account-kit/dist/index.d.ts','utf8'); for (const n of ['SmartAccountKit','createWebAuthnSigner','createEd25519Signer','createWallet','connectWallet','signAndSubmit','accountWasmHash','webauthnVerifierAddress','factoryContractId']) console.log(n, d.includes(n));"
  ```
  Expected: `@x402/express` exports `paymentMiddleware` + `x402ResourceServer` but the `HTTPFacilitatorClient-in-express` check may be `false` (it is allowed to be absent — import it from `@x402/core/server` per foundation §3.6); `@x402/core/server` exports `HTTPFacilitatorClient`; `@x402/server/facilitator` exports `createFacilitatorRouter`; `@x402/core/facilitator` exports `x402Facilitator`; `@x402/stellar/exact/server` and `@x402/stellar/exact/facilitator` both export `ExactStellarScheme`; `@x402/stellar` top-level exports `ExactStellarClient` + `createEd25519Signer`; `@x402/fetch` exports `wrapFetchWithPayment`; smart-account-kit `d.ts` contains `SmartAccountKit`, `createWebAuthnSigner`, `createEd25519Signer`, `accountWasmHash`, `webauthnVerifierAddress` and does NOT contain `factoryContractId`.
  **STOP conditions** (charter rule 5): if `@x402/core/server` does NOT export `HTTPFacilitatorClient`, or `@x402/server/facilitator` does NOT export `createFacilitatorRouter`, or the smart-account-kit `d.ts` shows `factoryContractId` instead of `accountWasmHash`/`webauthnVerifierAddress`, STOP and **update foundation §3.6/§3.6b/§3.7/§6 before writing code** (note the divergence as a recorded decision). Every task below cites the foundation; the foundation must match the install.

- [ ] **Verify the smart-account-kit passkey constructor with a REAL (env-gated) deploy check** (charter rule 5 — confirm the constructor against installed 0.2.10, not just the type defs). This is env-gated because it needs a funded testnet key + an `ACCOUNT_WASM_HASH` + `WEBAUTHN_VERIFIER_ADDRESS` (foundation §3.7); WebAuthn itself cannot run headless, so this asserts the constructor accepts the required keys and `kit.deployerPublicKey` resolves:
  ```bash
  # JUSTIFICATION (charter rule 4): the full WebAuthn ceremony needs a browser authenticator; this manual
  # check confirms the 0.2.10 constructor SHAPE (required keys accepted, deployerPublicKey resolves) against
  # the installed package. Run only when ACCOUNT_WASM_HASH + WEBAUTHN_VERIFIER_ADDRESS are set.
  [ -n "${ACCOUNT_WASM_HASH:-}" ] && node --input-type=module -e "
    import { SmartAccountKit } from 'smart-account-kit';
    const kit = new SmartAccountKit({ rpcUrl: process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      accountWasmHash: process.env.ACCOUNT_WASM_HASH,
      webauthnVerifierAddress: process.env.WEBAUTHN_VERIFIER_ADDRESS });
    console.log('kit ok, deployer:', kit.deployerPublicKey, 'connected:', kit.isConnected);
  " || echo "skipped passkey constructor check (set ACCOUNT_WASM_HASH + WEBAUTHN_VERIFIER_ADDRESS to run)"
  ```
  Expected (when run): prints `kit ok, deployer: G... connected: false`. A throw means the constructor keys are wrong — reconcile foundation §3.7 before Task 7.2.

- [ ] **Record provenance** in a short note at the top of `x402-services/shared-x402/src/index.ts` (created next) listing the exact verified import paths. No commit yet (no code).

> **DECISION (binding for this plan):** Following foundation §3.6/§3.6b (verified via ctx7 `/coinbase/x402` 2026-06-02), the **server (resource owner / paywall)** construction is:
> ```typescript
> import { paymentMiddleware, x402ResourceServer } from "@x402/express";
> import { HTTPFacilitatorClient } from "@x402/core/server";                // NOT @x402/express
> import { ExactStellarScheme } from "@x402/stellar/exact/server";          // SERVER scheme
> const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
> const server = new x402ResourceServer(facilitator).register(network, new ExactStellarScheme());
> app.use(paymentMiddleware(routes, server));
> ```
> The **local test facilitator** construction (foundation §3.6b) is:
> ```typescript
> import express from "express";
> import { x402Facilitator } from "@x402/core/facilitator";
> import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";     // FACILITATOR scheme
> import { createFacilitatorRouter } from "@x402/server/facilitator";       // HTTP router helper
> import { createEd25519Signer } from "@x402/stellar";
> const signer = createEd25519Signer(facilitatorSecret, network);          // FACILITATOR_SECRET (its own account)
> const facilitator = new x402Facilitator().register(network, new ExactStellarScheme([signer]));
> const app = express(); app.use(express.json());
> app.use("/", createFacilitatorRouter(facilitator));                       // mounts /verify, /settle, /supported
> ```
> The **client/payer** construction (agent + tests) is:
> ```typescript
> import { x402Client } from "@x402/core/client";
> import { ExactStellarClient, createEd25519Signer } from "@x402/stellar";  // CLIENT scheme + signer
> import { wrapFetchWithPayment } from "@x402/fetch";
> const signer = createEd25519Signer(clientSecret, network);               // CLIENT_SECRET (its own account, USDC-funded)
> const client = new x402Client().register("stellar:*", new ExactStellarClient(signer));
> const fetchWithPayment = wrapFetchWithPayment(fetch, client);
> ```
> If Task 2.1 finds the installed surface differs (e.g. the client scheme is `ExactStellarScheme` from top-level `@x402/stellar` rather than `ExactStellarClient`, or `wrapFetchWithPayment` lives in `@x402/core/client`), use the installed shape consistently in `buildStellarResourceServer`, `startTestFacilitator`, and `makeX402Fetch`, and record the change in the foundation. The TESTS below assert behavior (402 → pay → 200) over THREE distinct USDC-funded accounts, not the exact import path, so they remain valid either way.

---

## 3. Shared x402 helper + local test facilitator (DRY foundation)

Both services and the agent need the SAME server-construction and a REAL local facilitator for tests (charter rule 4: no faked 200). This lives in `@shadowkit/x402-shared`.

### Task 3.1 — Scaffold `@shadowkit/x402-shared` package

- [ ] **Create** `x402-services/shared-x402/package.json`:
  ```json
  {
    "name": "@shadowkit/x402-shared",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "main": "src/index.ts",
    "exports": {
      ".": "./src/index.ts",
      "./payerFetch": "./src/payerFetch.ts",
      "./fixtures": "./src/fixtures.ts"
    },
    "scripts": { "test": "vitest run" },
    "dependencies": {
      "@x402/express": "2.14.0",
      "@x402/stellar": "2.14.0",
      "@x402/core": "2.14.0",
      "@x402/server": "2.14.0",
      "@x402/fetch": "2.14.0",
      "@stellar/stellar-sdk": "15.1.0",
      "express": "5.2.1"
    },
    "devDependencies": { "vitest": "4.1.8", "@types/express": "5.0.0" }
  }
  ```
  > `@x402/server` is required for `createFacilitatorRouter` (foundation §3.6b). If Task 2.1 found `@x402/fetch` is absent, drop it here and use the `wrapFetchWithPayment` equivalent it identified (e.g. from `@x402/core/client`).

- [ ] **Create** `x402-services/shared-x402/tsconfig.json`:
  ```json
  { "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
  ```

- [ ] **Create** `x402-services/shared-x402/vitest.config.ts`:
  ```typescript
  import { defineConfig } from "vitest/config";
  export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 } });
  ```

- [ ] **Run** to confirm the package is picked up:
  ```bash
  npm install
  ```
  Expected: installs the new deps; no error.

- [ ] **Commit:** `build(x402): scaffold @shadowkit/x402-shared package`

### Task 3.1b — x402 account bootstrap (3 funded accounts + USDC) + fixtures loader

A REAL Stellar x402 settlement transfers USDC (SEP-41 SAC) and needs **three distinct funded testnet accounts**: client/payer (USDC trustline + balance), facilitator signer, resource-server/payTo (USDC trustline). Foundation §3.6a. This bootstrap provisions them once; every x402 test reads them from env via `loadX402Accounts()` and SKIPS (justified) when absent.

- [ ] **Create** `x402-services/shared-x402/src/fixtures.ts`:
  ```typescript
  // The 3-account x402 test harness (foundation §3.6a). REAL Stellar x402 settlement needs distinct
  // funded accounts: a CLIENT/payer (USDC trustline + USDC balance), a FACILITATOR signer, and a
  // RESOURCE_SERVER/payTo (USDC trustline). A single self-paying XLM account cannot settle USDC.
  import type { StellarNetwork } from "./index.js";

  export interface X402Accounts {
    clientSecret: string;       // CLIENT_SECRET (S...) — payer; holds USDC
    facilitatorSecret: string;  // FACILITATOR_SECRET (S...) — verifies/settles
    resourceServerAddress: string; // RESOURCE_SERVER_ADDRESS (G...) — payTo; receives USDC
    network: StellarNetwork;
    usdcSac: string;            // X402_USDC_SAC (C...) — SEP-41 USDC contract id
  }

  /** Read the 3 funded x402 accounts from env. Returns null if any required key is missing
   *  (tests then SKIP with a written justification, charter rule 4 — cannot fake a real settlement). */
  export function loadX402Accounts(): X402Accounts | null {
    const clientSecret = process.env.CLIENT_SECRET;
    const facilitatorSecret = process.env.FACILITATOR_SECRET;
    const resourceServerAddress = process.env.RESOURCE_SERVER_ADDRESS;
    if (!clientSecret || !facilitatorSecret || !resourceServerAddress) return null;
    return {
      clientSecret,
      facilitatorSecret,
      resourceServerAddress,
      network: (process.env.X402_NETWORK as StellarNetwork) ?? "stellar:testnet",
      // Default testnet USDC SAC (foundation §3.6a; coinbase/x402 stellar README, 7 decimals):
      usdcSac: process.env.X402_USDC_SAC ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    };
  }
  ```
  > `StellarNetwork` is exported by `src/index.ts` (Task 3.3). Create `src/index.ts` with at least the `StellarNetwork` type before this file type-checks, or order Task 3.3 first and split this into its own commit after.

- [ ] **Verify the Stellar SDK trustline + Friendbot APIs** (charter rule 5):
  ```bash
  npx ctx7@latest library "stellar-sdk" "stellar sdk js Operation.changeTrust Asset Horizon friendbot fund account submitTransaction TransactionBuilder"
  npx ctx7@latest docs "/stellar/js-stellar-sdk" "Operation.changeTrust Asset Horizon friendbot loadAccount TransactionBuilder submitTransaction networkPassphrase"
  ```
  Expected: confirms `new Asset(code, issuer)`, `Operation.changeTrust({ asset })`, `Horizon.Server`, `server.loadAccount`, `new TransactionBuilder(account, { fee, networkPassphrase }).addOperation(...).setTimeout(30).build()`, `tx.sign(kp)`, `server.submitTransaction(tx)`; Friendbot at `https://friendbot.stellar.org?addr=...`.

- [ ] **Create** `scripts/x402-bootstrap.ts` (provisions the 3 accounts; idempotent re-run safe):
  ```typescript
  // Provision the 3 x402 testnet accounts (foundation §3.6a): generate (or reuse) keypairs, Friendbot-fund
  // each, add a USDC trustline to CLIENT + RESOURCE_SERVER, and fund the CLIENT with USDC.
  // USDC on testnet is the Circle-issued classic asset wrapped as a SEP-41 SAC; testnet USDC is obtained
  // from the Circle faucet (https://faucet.circle.com/, Stellar Testnet). For an unattended CI bootstrap
  // without the faucet, set X402_USDC_FUNDER_SECRET to a key that already holds testnet USDC and this
  // script will send the CLIENT a starting balance; otherwise it prints the faucet instructions and exits 2.
  // SOURCE: ctx7 /stellar/js-stellar-sdk (changeTrust/Friendbot) + coinbase/x402 stellar README.
  import { Keypair, Asset, Operation, TransactionBuilder, Horizon, BASE_FEE, Networks } from "@stellar/stellar-sdk";
  import { writeFileSync } from "node:fs";

  const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
  const USDC_ISSUER = process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"; // Circle testnet
  const USDC = new Asset("USDC", USDC_ISSUER);
  const server = new Horizon.Server(HORIZON);

  async function friendbot(addr: string): Promise<void> {
    const r = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(addr)}`);
    if (!r.ok && r.status !== 400) throw new Error(`friendbot ${addr}: ${r.status}`); // 400 = already funded
  }
  async function addTrustline(secret: string): Promise<void> {
    const kp = Keypair.fromSecret(secret);
    const acct = await server.loadAccount(kp.publicKey());
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.changeTrust({ asset: USDC }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    await server.submitTransaction(tx);
  }
  async function payUsdc(funderSecret: string, toAddr: string, amount: string): Promise<void> {
    const kp = Keypair.fromSecret(funderSecret);
    const acct = await server.loadAccount(kp.publicKey());
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: toAddr, asset: USDC, amount }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    await server.submitTransaction(tx);
  }

  const client = process.env.CLIENT_SECRET ? Keypair.fromSecret(process.env.CLIENT_SECRET) : Keypair.random();
  const facilitator = process.env.FACILITATOR_SECRET ? Keypair.fromSecret(process.env.FACILITATOR_SECRET) : Keypair.random();
  const resource = process.env.RESOURCE_SERVER_SECRET ? Keypair.fromSecret(process.env.RESOURCE_SERVER_SECRET) : Keypair.random();

  for (const kp of [client, facilitator, resource]) await friendbot(kp.publicKey());
  await addTrustline(client.secret());
  await addTrustline(resource.secret());

  // Fund the CLIENT with USDC so it can pay. Prefer an explicit funder; else require the Circle faucet.
  const funder = process.env.X402_USDC_FUNDER_SECRET;
  if (funder) {
    await payUsdc(funder, client.publicKey(), process.env.X402_USDC_FUND_AMOUNT ?? "100");
  } else {
    console.error(`No X402_USDC_FUNDER_SECRET set. Fund CLIENT ${client.publicKey()} with testnet USDC`);
    console.error(`via the Circle faucet: https://faucet.circle.com/ (select Stellar Testnet), then re-run the x402 tests.`);
  }

  const usdcSac = process.env.X402_USDC_SAC ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  writeFileSync(".env.x402", [
    `CLIENT_SECRET=${client.secret()}`,
    `FACILITATOR_SECRET=${facilitator.secret()}`,
    `FACILITATOR_ADDRESS=${facilitator.publicKey()}`,
    `RESOURCE_SERVER_SECRET=${resource.secret()}`,
    `RESOURCE_SERVER_ADDRESS=${resource.publicKey()}`,
    `X402_NETWORK=stellar:testnet`,
    `X402_USDC_SAC=${usdcSac}`,
    "",
  ].join("\n"));
  console.log(`.env.x402 written. CLIENT=${client.publicKey()} FACILITATOR=${facilitator.publicKey()} RESOURCE=${resource.publicKey()}`);
  console.log(funder ? "CLIENT funded with USDC." : "CLIENT needs Circle-faucet USDC before tests will go green.");
  ```
  > Run with `node --experimental-strip-types scripts/x402-bootstrap.ts`. The Circle faucet step is manual unless `X402_USDC_FUNDER_SECRET` (an account already holding testnet USDC) is provided — record which path CI uses.

- [ ] **Run the bootstrap** (manual; provisions accounts for the round-trip test):
  ```bash
  node --experimental-strip-types scripts/x402-bootstrap.ts
  set -a; . ./.env.x402; set +a
  ```
  Expected: `.env.x402 written.` with three distinct `G...` addresses; the CLIENT has a USDC trustline (and a USDC balance once Circle-funded).
- [ ] **Commit:** `build(x402): 3-account bootstrap (Friendbot + USDC trustline) + fixtures loader`

### Task 3.2 — RED: round-trip test for the shared facilitator + payer fetch

This is the keystone "REAL x402 flow, not faked" test (charter rule 4). It stands up a real resource server (paywall) wired to a real local facilitator, then makes a paying request from a SEPARATE funded payer and asserts 402-before / 200-after. Uses the THREE distinct accounts from Task 3.1b (foundation §3.6a).

- [ ] **Create** `x402-services/shared-x402/test/roundtrip.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll } from "vitest";
  import express from "express";
  import type { Server } from "node:http";
  import { buildStellarResourceServer, startTestFacilitator } from "../src/index.js";
  import { makeX402Fetch } from "../src/payerFetch.js";
  import { loadX402Accounts } from "../src/fixtures.js";

  // REAL x402 round-trip over a LOCAL test facilitator (charter rule 4: not a faked 200).
  // Settlement network = Stellar TESTNET; the THREE x402 roles are DISTINCT funded accounts
  // (foundation §3.6a): the PAYER (client) holds USDC, the FACILITATOR signs settle txs, and the
  // payTo is the RESOURCE_SERVER address. A single self-paying XLM account cannot settle USDC.
  //
  // JUSTIFICATION (charter rule 4): a real on-chain USDC x402 settlement requires three distinct
  // funded testnet accounts + a USDC-funded payer; when CLIENT_SECRET/FACILITATOR_SECRET/
  // RESOURCE_SERVER_ADDRESS are unset the suite cannot perform a REAL payment, so it is SKIPPED
  // rather than faked. CI sets them via scripts/x402-bootstrap.ts (see Task 3.1b / deploy-testnet.sh).
  const ACCT = loadX402Accounts();
  const run = ACCT ? describe : describe.skip;

  run("x402 shared round-trip (REAL facilitator + 3 distinct accounts)", () => {
    const { clientSecret, facilitatorSecret, resourceServerAddress, network } = ACCT!;
    let facilitator: { url: string; stop: () => Promise<void> };
    let app: express.Express;
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      // Facilitator runs under its OWN signer (FACILITATOR_SECRET), distinct from the payer/payTo.
      facilitator = await startTestFacilitator({ network, signerSecret: facilitatorSecret });
      app = express();
      app.use(
        buildStellarResourceServer({
          // payTo is the RESOURCE_SERVER address (NOT the payer) — it receives the USDC.
          routes: { "GET /thing": { payTo: resourceServerAddress, price: "0.001", network } },
          network,
          facilitatorUrl: facilitator.url,
        }),
      );
      app.get("/thing", (_req, res) => res.json({ ok: true }));
      await new Promise<void>((r) => { server = app.listen(0, () => r()); });
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    });

    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await facilitator.stop();
    });

    it("returns 402 when called WITHOUT payment", async () => {
      const res = await fetch(`${baseUrl}/thing`);
      expect(res.status).toBe(402);
    });

    it("returns 200 + data when called WITH x402 payment (payer pays resource-server in USDC)", async () => {
      // The payer uses its OWN funded USDC account (CLIENT_SECRET), distinct from the payTo.
      const payingFetch = makeX402Fetch(clientSecret, network);
      const res = await payingFetch(`${baseUrl}/thing`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });
  });
  ```

- [ ] **Run (expect RED — module not found):**
  ```bash
  npx vitest run x402-services/shared-x402/test/roundtrip.test.ts
  ```
  Expected FAIL: `Error: Cannot find module '../src/index.js'` (or `Failed to resolve import "../src/index.js"`). This is the required red. (Note: with `.env.x402` NOT loaded the suite would SKIP, not RED; to see the import RED, run with the bootstrapped env loaded — `set -a; . ./.env.x402; set +a` — so `loadX402Accounts()` is non-null and the import is actually attempted.)

- [ ] **Commit:** `test(x402): add failing REAL round-trip test for shared facilitator + payer`

### Task 3.3 — GREEN: implement `buildStellarResourceServer` + `startTestFacilitator`

- [ ] **Create** `x402-services/shared-x402/src/index.ts`:
  ```typescript
  // VERIFIED 2026-06-02 (foundation §3.6 / §3.6b, ctx7 /coinbase/x402; re-verified Task 2.1):
  //   server:      paymentMiddleware(routes, server) where
  //                server = new x402ResourceServer(new HTTPFacilitatorClient({url}))
  //                           .register(network, new ExactStellarScheme())
  //                HTTPFacilitatorClient is from "@x402/core/server" (NOT "@x402/express").
  //                ExactStellarScheme (SERVER) is from "@x402/stellar/exact/server".
  //   facilitator: new x402Facilitator().register(network, new ExactStellarScheme([signer]))
  //                exposed over HTTP via createFacilitatorRouter(facilitator) from "@x402/server/facilitator".
  //                (Do NOT hand-roll /verify /settle — that passes one malformed arg; foundation §3.6b.)
  // SOURCE: coinbase/x402 typescript/packages/http/express/README.md + e2e/facilitators/typescript/README.md.
  import express, { type RequestHandler } from "express";
  import type { Server } from "node:http";
  import { paymentMiddleware, x402ResourceServer } from "@x402/express";
  import { HTTPFacilitatorClient } from "@x402/core/server"; // CORRECTED path (foundation §3.6)
  import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
  import { x402Facilitator } from "@x402/core/facilitator";
  import { ExactStellarScheme as ExactStellarFacilitatorScheme } from "@x402/stellar/exact/facilitator";
  import { createFacilitatorRouter } from "@x402/server/facilitator"; // facilitator HTTP helper (foundation §3.6b)
  import { createEd25519Signer } from "@x402/stellar";

  export type StellarNetwork = "stellar:testnet" | "stellar:pubnet";

  export interface RouteSpec { payTo: string; price: string; network: StellarNetwork; }

  export interface BuildResourceServerCfg {
    routes: Record<string, RouteSpec>; // key e.g. "GET /thing"
    network: StellarNetwork;
    facilitatorUrl: string;
  }

  /** Build the express x402 middleware that paywalls the given routes on a Stellar network. */
  export function buildStellarResourceServer(cfg: BuildResourceServerCfg): RequestHandler {
    const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
    const server = new x402ResourceServer(facilitator).register(cfg.network, new ExactStellarServerScheme());
    const routes = Object.fromEntries(
      Object.entries(cfg.routes).map(([k, r]) => [
        k,
        { accepts: { scheme: "exact" as const, payTo: r.payTo, price: r.price, network: r.network } },
      ]),
    );
    return paymentMiddleware(routes, server);
  }

  export interface TestFacilitatorCfg { network: StellarNetwork; signerSecret: string; port?: number; }

  /** Stand up a REAL local x402 facilitator (verifies + settles Stellar USDC payments on-chain).
   *  Uses x402Facilitator (@x402/core/facilitator) + ExactStellarScheme (facilitator subpath),
   *  exposed over HTTP with createFacilitatorRouter (@x402/server/facilitator) — the purpose-built
   *  router that matches what HTTPFacilitatorClient POSTs. `signerSecret` is the FACILITATOR_SECRET
   *  account (distinct from the payer + payTo; foundation §3.6a). */
  export async function startTestFacilitator(
    cfg: TestFacilitatorCfg,
  ): Promise<{ url: string; stop: () => Promise<void> }> {
    const signer = createEd25519Signer(cfg.signerSecret, cfg.network);
    const facilitator = new x402Facilitator().register(cfg.network, new ExactStellarFacilitatorScheme([signer]));
    const app = express();
    app.use(express.json());
    // createFacilitatorRouter mounts the canonical facilitator routes (/verify, /settle, /supported)
    // and calls facilitator.verify(payload, requirements) / facilitator.settle(payload, requirements)
    // with the CORRECT two-argument shape (foundation §3.6b). No hand-rolled handlers.
    app.use("/", createFacilitatorRouter(facilitator));
    const srv: Server = await new Promise((r) => {
      const s = app.listen(cfg.port ?? 0, () => r(s));
    });
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : cfg.port!;
    return {
      url: `http://127.0.0.1:${port}`,
      stop: () => new Promise<void>((r) => srv.close(() => r())),
    };
  }
  ```
  > **NOTE (Task 2.1 reconciliation):** `createFacilitatorRouter` is the official Express adapter for an `x402Facilitator` (foundation §3.6b, verified ctx7 `/coinbase/x402` `e2e/facilitators/typescript/README.md`). It owns the route paths and the two-arg `verify(payload, requirements)`/`settle(payload, requirements)` calls, so it always matches what `HTTPFacilitatorClient` sends — no manual path/arg alignment needed. If Task 2.1 finds `createFacilitatorRouter` lives at a different subpath (e.g. `@x402/server`), import it from there and update foundation §3.6b. The round-trip test asserts behavior, so a mismatch surfaces immediately.

- [ ] **Create** `x402-services/shared-x402/src/payerFetch.ts`:
  ```typescript
  // VERIFIED 2026-06-02 (ctx7 /coinbase/x402, foundation §3.5/§3.6): client pays the 402 automatically via
  //   const client = new x402Client().register("stellar:*", new ExactStellarClient(signer));
  //   const fetchWithPayment = wrapFetchWithPayment(fetch, client);  // from "@x402/fetch"
  // The Stellar CLIENT scheme is `ExactStellarClient` from top-level "@x402/stellar"
  // (SOURCE: coinbase/x402 e2e/clients/fetch/README.md). `signerSecret` is CLIENT_SECRET (the USDC-funded
  // payer account — distinct from facilitator + payTo; foundation §3.6a).
  import { x402Client } from "@x402/core/client";
  import { ExactStellarClient, createEd25519Signer } from "@x402/stellar";
  import { wrapFetchWithPayment } from "@x402/fetch";
  import type { StellarNetwork } from "./index.js";

  /** Build a fetch() that transparently pays any x402 (HTTP 402) challenge it encounters. */
  export function makeX402Fetch(signerSecret: string, network: StellarNetwork): typeof fetch {
    const signer = createEd25519Signer(signerSecret, network);
    const client = new x402Client().register("stellar:*", new ExactStellarClient(signer));
    return wrapFetchWithPayment(fetch, client) as typeof fetch;
  }
  ```
  > If Task 2.1 found the client scheme is exported as `ExactStellarScheme` (from top-level `@x402/stellar`) rather than `ExactStellarClient`, use that name. If `@x402/fetch` is absent, import `wrapFetchWithPayment` from `@x402/core/client` (Task 2.1). Keep the function signature identical.

- [ ] **Run (expect GREEN — requires the bootstrapped 3-account env):**
  ```bash
  node --experimental-strip-types scripts/x402-bootstrap.ts   # if not already run (Task 3.1b)
  set -a; . ./.env.x402; set +a                                # loads CLIENT_SECRET/FACILITATOR_SECRET/RESOURCE_SERVER_ADDRESS
  npx vitest run x402-services/shared-x402/test/roundtrip.test.ts
  ```
  Expected PASS: 2 passing (`returns 402 ...`, `returns 200 + data ...`). If the 3 account env vars are unset the suite is SKIPPED (the justified skip in the test) — run `scripts/x402-bootstrap.ts` and Circle-fund the CLIENT with testnet USDC (Task 3.1b) to actually exercise the REAL path. **The milestone is not complete until this runs PASS with the three funded accounts (CLIENT holding USDC).**

- [ ] **Commit:** `feat(x402): real shared resource server + local facilitator + payer fetch`

---

## 4. PremiumData service (agent PAYS) — foundation §3.6

### Task 4.1 — Scaffold `@shadowkit/x402-premium-data` + pure market data

- [ ] **Create** `x402-services/premium-data/package.json`:
  ```json
  {
    "name": "@shadowkit/x402-premium-data",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "main": "src/server.ts",
    "scripts": { "start": "node --experimental-strip-types src/main.ts", "test": "vitest run" },
    "dependencies": {
      "@shadowkit/x402-shared": "*",
      "express": "5.2.1"
    },
    "devDependencies": { "vitest": "4.1.8", "@types/express": "5.0.0", "@stellar/stellar-sdk": "15.1.0" }
  }
  ```
- [ ] **Create** `x402-services/premium-data/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`
- [ ] **Create** `x402-services/premium-data/vitest.config.ts` (same shape as Task 3.1's).
- [ ] **Create** `x402-services/premium-data/src/market.ts`:
  ```typescript
  // The (deterministic) premium data being sold. Real systems would proxy a feed; for the demo this is
  // a deterministic function so tests assert exact values. The x402 paywall (not the data) is the point.
  export interface MarketData { pair: string; price: string; signal: "buy" | "sell" | "hold"; }

  const TABLE: Record<string, MarketData> = {
    "USDC-XLM": { pair: "USDC-XLM", price: "0.1123", signal: "buy" },
    "XLM-USDC": { pair: "XLM-USDC", price: "8.9047", signal: "sell" },
  };

  export function marketDataFor(pair: string): MarketData {
    return TABLE[pair] ?? { pair, price: "1.0000", signal: "hold" };
  }
  ```
- [ ] **RED test** `x402-services/premium-data/test/market.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { marketDataFor } from "../src/market.js";
  describe("marketDataFor", () => {
    it("returns the table entry for a known pair", () => {
      expect(marketDataFor("USDC-XLM")).toEqual({ pair: "USDC-XLM", price: "0.1123", signal: "buy" });
    });
    it("returns a hold default for an unknown pair", () => {
      expect(marketDataFor("FOO-BAR")).toEqual({ pair: "FOO-BAR", price: "1.0000", signal: "hold" });
    });
  });
  ```
- [ ] **Run (expect RED before market.ts exists — write test FIRST, then market.ts; if you created market.ts already, temporarily `git stash` it to show red):**
  ```bash
  npx vitest run x402-services/premium-data/test/market.test.ts
  ```
  Expected FAIL: `Cannot find module '../src/market.js'`.
- [ ] Restore/create `market.ts`, **run (GREEN):** `npx vitest run x402-services/premium-data/test/market.test.ts` → 2 passing.
- [ ] **Commit:** `feat(x402): premium-data deterministic market table + tests`

### Task 4.2 — RED: premium-data server 402/200 (REAL x402)

- [ ] **Create** `x402-services/premium-data/test/server.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll } from "vitest";
  import type { Server } from "node:http";
  import { startTestFacilitator } from "@shadowkit/x402-shared";
  import { makeX402Fetch } from "@shadowkit/x402-shared/payerFetch";
  import { loadX402Accounts } from "@shadowkit/x402-shared/fixtures";
  import { createPremiumDataServer } from "../src/server.js";

  // REAL x402 over 3 distinct funded accounts (foundation §3.6a): CLIENT pays, FACILITATOR settles,
  // RESOURCE_SERVER is the payTo. JUSTIFICATION (charter rule 4): a real USDC settlement needs the
  // three funded accounts; skip (not fake) when absent.
  const ACCT = loadX402Accounts();
  const run = ACCT ? describe : describe.skip;

  run("premium-data x402 paywall (REAL, 3 accounts)", () => {
    const { clientSecret, facilitatorSecret, resourceServerAddress, network } = ACCT!;
    let fac: { url: string; stop: () => Promise<void> };
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      fac = await startTestFacilitator({ network, signerSecret: facilitatorSecret });
      const app = createPremiumDataServer({ payTo: resourceServerAddress, network, priceUsdc: "0.001", facilitatorUrl: fac.url });
      server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
      const a = server.address(); baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    });
    afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await fac.stop(); });

    it("402 without payment", async () => {
      const res = await fetch(`${baseUrl}/market/USDC-XLM`);
      expect(res.status).toBe(402);
    });
    it("200 + market data WITH payment", async () => {
      const pf = makeX402Fetch(clientSecret, network);
      const res = await pf(`${baseUrl}/market/USDC-XLM`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pair: "USDC-XLM", price: "0.1123", signal: "buy" });
    });
  });
  ```
- [ ] **Run (RED):** with `.env.x402` loaded (`set -a; . ./.env.x402; set +a`) so the suite is not skipped — `npx vitest run x402-services/premium-data/test/server.test.ts` → FAIL `Cannot find module '../src/server.js'`.
- [ ] **Commit:** `test(x402): failing premium-data 402/200 server test`

### Task 4.3 — GREEN: implement premium-data server

- [ ] **Create** `x402-services/premium-data/src/server.ts`:
  ```typescript
  // Agent PAYS this endpoint (foundation §3.6). Paywall via @shadowkit/x402-shared (REAL x402).
  // NOTE: premium-data is the AGENT-PAYS side; it is ALWAYS paywalled (in BOTH x402 directions), so there
  // is intentionally NO `direction` switch here — there is nothing to ungate. The X402_DIRECTION fallback
  // only affects the SELL side (shadowkit-api). (Removing a dead `direction` field, M6 review fix.)
  import express from "express";
  import { buildStellarResourceServer, type StellarNetwork } from "@shadowkit/x402-shared";
  import { marketDataFor } from "./market.js";

  export interface PremiumDataCfg {
    payTo: string;            // the RESOURCE_SERVER address that receives USDC (foundation §3.6a)
    network: StellarNetwork;
    priceUsdc: string;
    facilitatorUrl: string;
  }

  export function createPremiumDataServer(cfg: PremiumDataCfg): express.Express {
    const app = express();
    app.use(
      buildStellarResourceServer({
        routes: { "GET /market/:pair": { payTo: cfg.payTo, price: cfg.priceUsdc, network: cfg.network } },
        network: cfg.network,
        facilitatorUrl: cfg.facilitatorUrl,
      }),
    );
    app.get("/market/:pair", (req, res) => res.json(marketDataFor(req.params.pair)));
    return app;
  }
  ```
- [ ] **Add** `"exports": { ".": "./src/server.ts", "./server": "./src/server.ts" }` to `x402-services/premium-data/package.json` (so `@shadowkit/x402-premium-data/server` resolves for the agent DataClient test, Task 6.1).
- [ ] **Create** `x402-services/premium-data/src/main.ts` (the runnable entrypoint for the demo):
  ```typescript
  import { createPremiumDataServer } from "./server.js";
  const port = Number(process.env.PREMIUM_DATA_PORT ?? 4100);
  const app = createPremiumDataServer({
    // payTo = the resource-server account that receives USDC (foundation §3.6a):
    payTo: process.env.RESOURCE_SERVER_ADDRESS!,
    network: (process.env.X402_NETWORK as "stellar:testnet" | "stellar:pubnet") ?? "stellar:testnet",
    priceUsdc: process.env.X402_PRICE_USDC ?? "0.001",
    facilitatorUrl: process.env.X402_FACILITATOR_URL!,
  });
  app.listen(port, () => console.log(`premium-data x402 listening on :${port}`));
  ```
- [ ] **Run (GREEN, 3-account env loaded):** `set -a; . ./.env.x402; set +a; npx vitest run x402-services/premium-data/test/server.test.ts` → 2 passing.
- [ ] **Commit:** `feat(x402): premium-data x402-protected market endpoint (agent pays)`

### Task 4.4 — Negative: premium-data is ALWAYS gated (no ungate path exists)

The agent-pays side has no `direction` switch (Task 4.3 removed the dead field). This is a genuine **negative/adversarial** test (charter rule 1): it proves the premium-data server NEVER serves data without payment regardless of `X402_DIRECTION` in the environment — i.e. there is no accidental ungate. It is a red→green pair: the RED step asserts the negative against a hypothetical ungated build; the GREEN step confirms the shipped (always-gated) build.

- [ ] **Create** `x402-services/premium-data/test/onedir.test.ts` (genuine negative; asserts the unpaid response carries a 402 AND does NOT leak `marketDataFor` body, even with `X402_DIRECTION=agent-pays-only` in the environment):
  ```typescript
  import { describe, it, expect, beforeAll, afterAll } from "vitest";
  import type { Server } from "node:http";
  import { startTestFacilitator } from "@shadowkit/x402-shared";
  import { loadX402Accounts } from "@shadowkit/x402-shared/fixtures";
  import { createPremiumDataServer } from "../src/server.js";
  import { marketDataFor } from "../src/market.js";

  // JUSTIFICATION (charter rule 4): facilitator construction needs a real signer key; skip when absent.
  const ACCT = loadX402Accounts();
  const run = ACCT ? describe : describe.skip;

  run("premium-data NEVER serves data unpaid, even when X402_DIRECTION=agent-pays-only", () => {
    const { facilitatorSecret, resourceServerAddress, network } = ACCT!;
    let fac: { url: string; stop: () => Promise<void> };
    let server: Server; let baseUrl: string;
    beforeAll(async () => {
      process.env.X402_DIRECTION = "agent-pays-only"; // the env that would ungate the SELL side
      fac = await startTestFacilitator({ network, signerSecret: facilitatorSecret });
      const app = createPremiumDataServer({
        payTo: resourceServerAddress, network, priceUsdc: "0.001", facilitatorUrl: fac.url,
      });
      server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
      const a = server.address(); baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    });
    afterAll(async () => { delete process.env.X402_DIRECTION; await new Promise<void>((r) => server.close(() => r())); await fac.stop(); });

    it("returns 402 without payment", async () => {
      const res = await fetch(`${baseUrl}/market/USDC-XLM`);
      expect(res.status).toBe(402);
    });
    it("the unpaid response body does NOT contain the premium market data", async () => {
      const res = await fetch(`${baseUrl}/market/USDC-XLM`);
      const text = await res.text();
      const secret = marketDataFor("USDC-XLM"); // { pair, price:"0.1123", signal:"buy" }
      expect(text).not.toContain(secret.price);  // the price must NOT leak before payment
      expect(text).not.toContain(secret.signal);
    });
  });
  ```
- [ ] **Run (RED):** to demonstrate the negative genuinely catches an ungate regression, FIRST temporarily insert a leaking route ABOVE the paywall in `server.ts` (`app.get("/market/:pair", (req,res)=>res.json(marketDataFor(req.params.pair)))` placed BEFORE `app.use(buildStellarResourceServer(...))`), run:
  ```bash
  set -a; . ./.env.x402; set +a; npx vitest run x402-services/premium-data/test/onedir.test.ts
  ```
  Expected FAIL: the second test fails (`expected ... not to contain "0.1123"`) and the first fails (200, not 402) — proving the assertion is real. Then REMOVE the leaking route (restore the shipped order: paywall first), re-run.
- [ ] **Run (GREEN):** `set -a; . ./.env.x402; set +a; npx vitest run x402-services/premium-data/test/onedir.test.ts` → 2 passing. The negative now confirms the shipped server cannot leak premium data unpaid under any direction.
- [ ] **Commit:** `test(x402): premium-data never leaks data unpaid (negative, red→green)`

---

## 5. ShadowKitAPI service (ShadowKit SELLS) — provider gating — foundation §3.6

This is the SELL side: a paid `POST /verify` (off-chain Groth16 verify via `@shadowkit/zk-prover`) and `POST /execute` (provider gate + **kicks the agent** for an Approved proposal, returning the swap txHash — spec §6 step 6 / §3.6). `/execute` reads `GovVault.is_approved` and, only when approved, triggers `AgentRunner.run` and returns its `txHash` (the agent is injected for tests; the demo wires the real `AgentRunner`). It is the side that the x402 one-direction fallback can UNGATE.

### Task 5.1 — Scaffold + provider gating helper

- [ ] **Create** `x402-services/shadowkit-api/package.json`:
  ```json
  {
    "name": "@shadowkit/x402-api",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "main": "src/server.ts",
    "scripts": { "start": "node --experimental-strip-types src/main.ts", "test": "vitest run" },
    "dependencies": {
      "@shadowkit/x402-shared": "*",
      "@shadowkit/shared": "*",
      "@shadowkit/zk-prover": "*",
      "@shadowkit/agent": "*",
      "@stellar/stellar-sdk": "15.1.0",
      "express": "5.2.1"
    },
    "devDependencies": { "vitest": "4.1.8", "@types/express": "5.0.0" }
  }
  ```
  > `@shadowkit/agent` is needed because `/execute` kicks the agent for an approved proposal (Task 5.3, spec §6 step 6).
- [ ] **Create** `x402-services/shadowkit-api/tsconfig.json` + `vitest.config.ts` (same shapes as 3.1).
- [ ] **RED** `x402-services/shadowkit-api/test/gating.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from "vitest";
  import { assertApproved } from "../src/gating.js";

  // Provider gate: assertApproved reads GovVault.is_approved via the binding client. We inject a
  // fake readApproved fn (the network boundary) but the GATE LOGIC under test is real (throws/passes).
  describe("assertApproved (provider gate)", () => {
    it("passes when GovVault reports approved", async () => {
      await expect(assertApproved(7, async () => true)).resolves.toBeUndefined();
    });
    it("throws ProposalNotApproved when GovVault reports not approved", async () => {
      await expect(assertApproved(7, async () => false)).rejects.toThrow(/not approved/i);
    });
  });
  ```
- [ ] **Run (RED):** `npx vitest run x402-services/shadowkit-api/test/gating.test.ts` → FAIL `Cannot find module '../src/gating.js'`.
- [ ] **Create** `x402-services/shadowkit-api/src/gating.ts`:
  ```typescript
  // Provider gate for the SELL side. The actual on-chain read is injected (readApproved) so the gate
  // logic is unit-testable; src/server.ts wires the real GovVault binding client (foundation §1 bindings).
  export class ProposalNotApprovedError extends Error {
    constructor(id: number) { super(`proposal ${id} is not approved`); this.name = "ProposalNotApprovedError"; }
  }
  /** Throw unless GovVault.is_approved(id) is true. */
  export async function assertApproved(
    proposalId: number,
    readApproved: (id: number) => Promise<boolean>,
  ): Promise<void> {
    const ok = await readApproved(proposalId);
    if (!ok) throw new ProposalNotApprovedError(proposalId);
  }
  ```
- [ ] **Run (GREEN):** `npx vitest run x402-services/shadowkit-api/test/gating.test.ts` → 2 passing.
- [ ] **Commit:** `feat(x402): shadowkit-api provider gating helper + tests`

### Task 5.2 — RED: shadowkit-api server 402/200 + provider gating (REAL x402)

- [ ] **Create** `x402-services/shadowkit-api/test/server.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
  import type { Server } from "node:http";
  import { startTestFacilitator } from "@shadowkit/x402-shared";
  import { makeX402Fetch } from "@shadowkit/x402-shared/payerFetch";
  import { loadX402Accounts } from "@shadowkit/x402-shared/fixtures";
  import { createShadowKitApiServer } from "../src/server.js";

  // REAL x402 over 3 distinct funded accounts (foundation §3.6a). JUSTIFICATION (charter rule 4): a real
  // USDC settlement needs the three funded accounts; skip (not fake) when absent.
  const ACCT = loadX402Accounts();
  const run = ACCT ? describe : describe.skip;

  run("shadowkit-api x402 paywall + provider gating + agent kick (REAL, 3 accounts)", () => {
    const { clientSecret, facilitatorSecret, resourceServerAddress, network } = ACCT!;
    let fac: { url: string; stop: () => Promise<void> };
    let server: Server; let baseUrl: string;
    // Injected agent kick: /execute must trigger the agent for an approved proposal (spec §6 step 6).
    const runAgent = vi.fn(async (_id: number) => ({ txHash: "deadbeef00txhash" }));

    beforeAll(async () => {
      fac = await startTestFacilitator({ network, signerSecret: facilitatorSecret });
      const app = createShadowKitApiServer({
        payTo: resourceServerAddress, network, priceUsdc: "0.001", facilitatorUrl: fac.url,
        govVaultId: "CGOVVAULT000000000000000000000000000000000000000000000000",
        rpcUrl: "http://127.0.0.1:8000/rpc",
        direction: "both",
        // Inject the on-chain read so the test asserts the GATE without a live RPC: approved only for id 1.
        readApproved: async (id: number) => id === 1,
        // Inject the agent runner so the test asserts /execute actually kicks the agent.
        runAgent,
      });
      server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
      const a = server.address(); baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    });
    afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await fac.stop(); });

    it("402 on /execute without payment", async () => {
      const res = await fetch(`${baseUrl}/execute`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: 1 }),
      });
      expect(res.status).toBe(402);
    });

    it("200 on /execute with payment for an APPROVED proposal — kicks the agent and returns txHash", async () => {
      const pf = makeX402Fetch(clientSecret, network);
      const res = await pf(`${baseUrl}/execute`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: 1 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ accepted: true, proposalId: 1, txHash: "deadbeef00txhash" });
      expect(runAgent).toHaveBeenCalledWith(1); // the agent was actually triggered
    });

    it("403 (provider gate) on /execute with payment for a NON-APPROVED proposal — does NOT kick the agent", async () => {
      runAgent.mockClear();
      const pf = makeX402Fetch(clientSecret, network);
      const res = await pf(`${baseUrl}/execute`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: 2 }),
      });
      expect(res.status).toBe(403);
      expect(runAgent).not.toHaveBeenCalled();
    });

    it("200 on /verify with payment for a VALID proof (off-chain Groth16 verify)", async () => {
      // REAL proof from committed circuit fixtures (charter rule 4: no stubbed crypto).
      const fs = await import("node:fs");
      const proof = JSON.parse(fs.readFileSync("circuits/vote/fixtures/proof.json", "utf8"));
      const publicRaw = JSON.parse(fs.readFileSync("circuits/vote/fixtures/public.json", "utf8"));
      // public.json order is [merkleRoot, nullifier, proposalId, sealedCommitmentHash] (foundation §4):
      const publicSignals = {
        merkleRoot: publicRaw[0], nullifier: publicRaw[1], proposalId: publicRaw[2], sealedCommitmentHash: publicRaw[3],
      };
      const pf = makeX402Fetch(clientSecret, network);
      const res = await pf(`${baseUrl}/verify`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proof, publicSignals }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ valid: true });
    });
  });
  ```
- [ ] **Run (RED):** with `.env.x402` loaded — `set -a; . ./.env.x402; set +a; npx vitest run x402-services/shadowkit-api/test/server.test.ts` → FAIL `Cannot find module '../src/server.js'`.
- [ ] **Commit:** `test(x402): failing shadowkit-api 402/200/403 server test`

### Task 5.3 — GREEN: implement shadowkit-api server

- [ ] **Create** `x402-services/shadowkit-api/src/vkey.ts` (verified JSON loader — replaces the cross-package import attribute, which is unreliable under `node --experimental-strip-types`):
  ```typescript
  // Load the snarkjs verification key from the committed circuit fixtures WITHOUT a JSON import attribute.
  // (Cross-package `import vkey from "...json" with { type: "json" }` is not reliably supported under
  // `node --experimental-strip-types`; readFileSync + JSON.parse is portable. M6 review fix.)
  import { readFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  import { dirname, resolve } from "node:path";

  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> package root -> repo root -> circuits/vote/fixtures
  const VKEY_PATH =
    process.env.VKEY_PATH ?? resolve(here, "../../../circuits/vote/fixtures/verification_key.json");

  export function loadVkey(): object {
    return JSON.parse(readFileSync(VKEY_PATH, "utf8")) as object;
  }
  ```
- [ ] **Create** `x402-services/shadowkit-api/src/server.ts`:
  ```typescript
  // ShadowKit SELLS verify/execute (foundation §3.6). Paywall via @shadowkit/x402-shared (REAL x402).
  // Provider gate via assertApproved (src/gating.ts). Off-chain verify via @shadowkit/zk-prover.
  // /execute KICKS the agent for an approved proposal (spec §6 step 6) via an injected runAgent fn.
  import express from "express";
  import { buildStellarResourceServer, type StellarNetwork } from "@shadowkit/x402-shared";
  import { verifyVoteProof } from "@shadowkit/zk-prover";
  import { assertApproved, ProposalNotApprovedError } from "./gating.js";
  import { loadVkey } from "./vkey.js";

  export interface ShadowKitApiCfg {
    payTo: string;
    network: StellarNetwork;
    priceUsdc: string;
    facilitatorUrl: string;
    govVaultId: string;
    rpcUrl: string;
    /** Fallback (foundation M6): "agent-pays-only" runs this SELL side UNGATED (no paywall). */
    direction?: "both" | "agent-pays-only";
    /** Injected on-chain read of GovVault.is_approved (server.ts wires the real binding by default). */
    readApproved?: (id: number) => Promise<boolean>;
    /** Injected agent kick: triggers the agent for an approved proposal and returns its txHash
     *  (server.ts wires the real AgentRunner by default). Returns the swap tx hash. */
    runAgent?: (proposalId: number) => Promise<{ txHash: string }>;
  }

  export function createShadowKitApiServer(cfg: ShadowKitApiCfg): express.Express {
    const app = express();
    const vkey = loadVkey();
    const readApproved = cfg.readApproved ?? ((id: number) => defaultReadApproved(cfg, id));
    const runAgent = cfg.runAgent ?? ((id: number) => defaultRunAgent(cfg, id));

    // express.json() MUST run BEFORE the handlers so req.body is parsed. The x402 paywall is a
    // separate middleware that reads the X-PAYMENT header (not the JSON body), so json() can sit
    // alongside it; we register json() first so BOTH the paywall and the handlers see a parsed body.
    app.use(express.json());

    // FALLBACK SWITCH: in agent-pays-only mode the SELL side is NOT paywalled (one-direction x402).
    if ((cfg.direction ?? "both") === "both") {
      app.use(
        buildStellarResourceServer({
          routes: {
            "POST /verify": { payTo: cfg.payTo, price: cfg.priceUsdc, network: cfg.network },
            "POST /execute": { payTo: cfg.payTo, price: cfg.priceUsdc, network: cfg.network },
          },
          network: cfg.network,
          facilitatorUrl: cfg.facilitatorUrl,
        }),
      );
    }

    app.post("/verify", async (req, res) => {
      try {
        const { proof, publicSignals } = req.body;
        const ok = await verifyVoteProof(vkey, publicSignals, proof);
        res.json({ valid: ok });
      } catch (e) { res.status(400).json({ error: String(e) }); }
    });

    app.post("/execute", async (req, res) => {
      const proposalId = Number(req.body?.proposalId);
      try {
        await assertApproved(proposalId, readApproved);
        // KICK the agent for the approved proposal (spec §6 step 6) and return the resulting swap tx hash.
        const { txHash } = await runAgent(proposalId);
        res.json({ accepted: true, proposalId, txHash });
      } catch (e) {
        if (e instanceof ProposalNotApprovedError) return res.status(403).json({ error: e.message });
        res.status(400).json({ error: String(e) });
      }
    });
    return app;
  }

  // Real GovVault read via the generated binding client (foundation §1: packages/shared/src/bindings).
  // Imported lazily to keep the unit test (which injects readApproved) free of RPC.
  // VERIFY against the generated client before relying on it (charter rule 5) — see Task 5.5.
  async function defaultReadApproved(cfg: ShadowKitApiCfg, id: number): Promise<boolean> {
    const { Client: GovVaultClient } = await import("@shadowkit/shared/bindings/gov-vault");
    const client = new GovVaultClient({ contractId: cfg.govVaultId, rpcUrl: cfg.rpcUrl, networkPassphrase: process.env.NETWORK_PASSPHRASE! });
    // The generated binding's view methods return an AssembledTransaction; `.result` holds the simulated
    // return value (no submit needed for a read). is_approved(id) -> bool. (Verify shape in Task 5.5.)
    const tx = await client.is_approved({ id });
    return Boolean(tx.result);
  }

  // Real agent kick via @shadowkit/agent AgentRunner (foundation §3.5). Lazily imported so the unit/
  // server tests (which inject runAgent) need no agent deps at module load.
  async function defaultRunAgent(cfg: ShadowKitApiCfg, id: number): Promise<{ txHash: string }> {
    const { AgentRunner } = await import("@shadowkit/agent");
    const runner = new AgentRunner({
      rpcUrl: cfg.rpcUrl,
      networkPassphrase: process.env.NETWORK_PASSPHRASE!,
      govVaultId: cfg.govVaultId,
      agentPolicyId: process.env.AGENT_POLICY_ID!,
      swapVenueId: process.env.SWAP_VENUE_ID ?? process.env.FALLBACK_AMM_ID!,
      sessionSecretKey: process.env.AGENT_SESSION_SECRET!,
      premiumDataUrl: process.env.PREMIUM_DATA_URL!,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
      useDeterministicPlanner: (process.env.USE_DETERMINISTIC_PLANNER ?? "true") === "true",
    });
    return runner.run(id, () => {}); // streams to a no-op log sink here; the demo uses a real LogBus
  }
  ```
  > **NOTE:** the exact binding import path (`@shadowkit/shared/bindings/gov-vault`), the `is_approved({ id })` call shape, and whether `.result` is populated by a view call (vs requiring an explicit `.simulate()`) come from the `stellar contract bindings typescript` output generated in M0/M1 (foundation §1). Task 5.5 verifies these against the real generated client before relying on them (charter rule 5). The unit test (5.1) and server test (5.2) inject `readApproved`/`runAgent`, so they are unaffected; only the demo wiring uses the `default*` functions, which Task 5.5 covers.
- [ ] **Create** `x402-services/shadowkit-api/src/main.ts`:
  ```typescript
  import { createShadowKitApiServer } from "./server.js";
  const port = Number(process.env.SHADOWKIT_API_PORT ?? 4200);
  const app = createShadowKitApiServer({
    payTo: process.env.RESOURCE_SERVER_ADDRESS!, // the account that receives USDC (foundation §3.6a)
    network: (process.env.X402_NETWORK as "stellar:testnet" | "stellar:pubnet") ?? "stellar:testnet",
    priceUsdc: process.env.X402_PRICE_USDC ?? "0.001",
    facilitatorUrl: process.env.X402_FACILITATOR_URL!,
    govVaultId: process.env.GOV_VAULT_ID!,
    rpcUrl: process.env.RPC_URL!,
    direction: (process.env.X402_DIRECTION as "both" | "agent-pays-only") ?? "both",
  });
  app.listen(port, () => console.log(`shadowkit-api x402 listening on :${port}`));
  ```
- [ ] **Run (GREEN, 3-account env loaded):** `set -a; . ./.env.x402; set +a; npx vitest run x402-services/shadowkit-api/test/server.test.ts` → 4 passing (402, 200+kick, 403+no-kick, /verify valid).
- [ ] **Commit:** `feat(x402): shadowkit-api verify/execute behind x402 + provider gating + agent kick (sells)`

### Task 5.4 — Fallback: x402 one-direction UNGATES shadowkit-api

- [ ] **Create** `x402-services/shadowkit-api/test/onedir.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
  import type { Server } from "node:http";
  import { createShadowKitApiServer } from "../src/server.js";

  // Fallback path (X402_DIRECTION=agent-pays-only): SELL side runs UNGATED so a missing/flaky
  // sell-side facilitator never blocks the demo. No facilitator needed -> NO funded key needed.
  // readApproved + runAgent are injected so the gate + kick logic is exercised without a live RPC/agent.
  describe("shadowkit-api UNGATED under agent-pays-only fallback", () => {
    let server: Server; let baseUrl: string;
    const runAgent = vi.fn(async (_id: number) => ({ txHash: "ungatedtxhash00" }));
    beforeAll(async () => {
      const app = createShadowKitApiServer({
        payTo: "GUNUSED0000000000000000000000000000000000000000000000000",
        network: "stellar:testnet", priceUsdc: "0.001", facilitatorUrl: "http://unused",
        govVaultId: "CGOV", rpcUrl: "http://unused", direction: "agent-pays-only",
        readApproved: async (id: number) => id === 1,
        runAgent,
      });
      server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
      const a = server.address(); baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    });
    afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

    it("returns 200 on /execute WITHOUT any payment when ungated (approved id) and kicks the agent", async () => {
      const res = await fetch(`${baseUrl}/execute`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: 1 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ accepted: true, txHash: "ungatedtxhash00" });
      expect(runAgent).toHaveBeenCalledWith(1);
    });
    it("still applies the provider gate (403) even when ungated, for a non-approved id", async () => {
      const res = await fetch(`${baseUrl}/execute`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: 2 }),
      });
      expect(res.status).toBe(403);
    });
  });
  ```
- [ ] **Run (RED then GREEN):** First confirm it fails without the `direction` switch in `server.ts` (temporarily force `both`): `npx vitest run x402-services/shadowkit-api/test/onedir.test.ts` → the first test FAILS with 402. Restore the `direction` switch → re-run → 2 passing. (This demonstrates the fallback switch genuinely changes behavior — charter rule 3.)
- [ ] **Commit:** `test(x402): one-direction fallback ungates shadowkit-api (tested)`

### Task 5.5 — Integration: `defaultReadApproved` against a REAL on-chain GovVault (no injection)

`defaultReadApproved` is the REAL provider gate the demo uses (the SELL deliverable). Tasks 5.1/5.2 inject `readApproved`, so the default is NEVER exercised by them. This task adds an env-gated integration test that drives the server WITHOUT injecting `readApproved`, hitting a real deployed GovVault, and verifies the binding's method name + arg shape + result-access pattern (charter rules 1 + 5).

- [ ] **Verify the generated GovVault binding shape** (charter rule 5) before relying on `is_approved({ id }).result`:
  ```bash
  # Inspect the M2-generated @shadowkit/shared/bindings (Task M2-0b owns binding generation) for the exact module path, method name, arg key, and result access:
  node -e "const m=require('@shadowkit/shared/bindings/gov-vault'); const c=new m.Client({contractId:'C',rpcUrl:'http://x',networkPassphrase:'x'}); console.log('is_approved', typeof c.is_approved);"
  grep -RnoE "is_approved|AssembledTransaction|result" packages/shared/src/bindings/gov-vault* | head
  ```
  Expected: `is_approved` is a function; the generated method returns an `AssembledTransaction` whose `.result` holds the simulated bool (the `stellar contract bindings typescript` convention — view methods simulate on call). If the generated client instead requires an explicit `await tx.simulate()` before `.result`, update `defaultReadApproved` to `const tx = await client.is_approved({ id }); await tx.simulate(); return Boolean(tx.result);` and cite the generated source. **STOP and reconcile if the method name or arg key differs** (e.g. `isApproved` or `{ proposal_id }`).
- [ ] **Create** `x402-services/shadowkit-api/test/gating.integration.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll } from "vitest";
  import type { Server } from "node:http";
  import { createShadowKitApiServer } from "../src/server.js";

  // REAL on-chain provider gate (charter rules 1 + 5): drives /execute WITHOUT injecting readApproved,
  // so defaultReadApproved actually reads GovVault.is_approved via the generated binding against a live
  // deployed contract. Runs UNGATED (agent-pays-only) so NO x402 settlement / funded payer is needed —
  // this isolates the on-chain gate read from the payment layer.
  //
  // JUSTIFICATION (charter rule 4): this needs a live RPC + a deployed GovVault with a KNOWN-approved and
  // a KNOWN-not-approved proposal; those are provisioned by scripts/deploy-testnet.sh (or deploy-local).
  // It is env-gated on GOV_VAULT_ID + RPC_URL + APPROVED_PROPOSAL_ID + REJECTED_PROPOSAL_ID; SKIPPED
  // (not faked) when they are unset. CI's e2e stage sets them after deploy.
  const ready =
    process.env.GOV_VAULT_ID && process.env.RPC_URL &&
    process.env.APPROVED_PROPOSAL_ID && process.env.REJECTED_PROPOSAL_ID;
  const run = ready ? describe : describe.skip;

  run("defaultReadApproved against a REAL deployed GovVault", () => {
    const approved = Number(process.env.APPROVED_PROPOSAL_ID);
    const rejected = Number(process.env.REJECTED_PROPOSAL_ID);
    let server: Server; let baseUrl: string;
    // runAgent is injected ONLY to avoid actually moving the treasury in this read-focused test; the
    // gate (defaultReadApproved) is NOT injected — it is the thing under test.
    const runAgent = async (id: number) => ({ txHash: `noop-${id}` });
    beforeAll(async () => {
      const app = createShadowKitApiServer({
        payTo: "GUNUSED0000000000000000000000000000000000000000000000000",
        network: "stellar:testnet", priceUsdc: "0.001", facilitatorUrl: "http://unused",
        govVaultId: process.env.GOV_VAULT_ID!, rpcUrl: process.env.RPC_URL!,
        direction: "agent-pays-only", // no paywall -> isolates the on-chain gate from x402
        runAgent, // do NOT inject readApproved
      });
      server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
      const a = server.address(); baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    });
    afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

    it("200 for a REAL Approved proposal (defaultReadApproved returns true on-chain)", async () => {
      const res = await fetch(`${baseUrl}/execute`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: approved }),
      });
      expect(res.status).toBe(200);
    });
    it("403 for a REAL non-Approved proposal (defaultReadApproved returns false on-chain)", async () => {
      const res = await fetch(`${baseUrl}/execute`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: rejected }),
      });
      expect(res.status).toBe(403);
    });
  });
  ```
- [ ] **Run (GREEN, local net + deployed GovVault):**
  ```bash
  just net-up && just deploy-local   # M0/M1 recipes provide GOV_VAULT_ID; create one Approved + one Rejected proposal
  GOV_VAULT_ID=$GOV_VAULT_ID RPC_URL=$RPC_URL APPROVED_PROPOSAL_ID=1 REJECTED_PROPOSAL_ID=2 \
    npx vitest run x402-services/shadowkit-api/test/gating.integration.test.ts
  ```
  Expected: 2 passing (real on-chain Approved → 200; real on-chain not-approved → 403). This exercises `defaultReadApproved` end to end.
- [ ] **Commit:** `test(x402): integration test for defaultReadApproved against real GovVault`

---

## 6. Agent DataClient = REAL x402 payer — foundation §3.5

The agent's `DataClient.fetchMarket` (currently a stub) becomes a REAL x402 payer using the shared payer fetch. This is the PRIMARY "agent pays a real x402 call" deliverable.

### Task 6.1 — RED: agent DataClient real x402 round-trip

- [ ] **Replace** `agent/test/dataClient.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll } from "vitest";
  import type { Server } from "node:http";
  import { startTestFacilitator } from "@shadowkit/x402-shared";
  import { loadX402Accounts } from "@shadowkit/x402-shared/fixtures";
  import { createPremiumDataServer } from "@shadowkit/x402-premium-data/server";
  import { DataClient } from "../src/dataClient.js";

  // REAL x402 over 3 distinct funded accounts (foundation §3.6a): the agent (CLIENT) pays the premium-data
  // resource server (RESOURCE_SERVER payTo); the FACILITATOR settles. JUSTIFICATION (charter rule 4): a real
  // USDC settlement needs the three funded accounts; skip (not fake) when absent.
  const ACCT = loadX402Accounts();
  const run = ACCT ? describe : describe.skip;

  run("DataClient pays a REAL x402 premium-data call (3 accounts)", () => {
    const { clientSecret, facilitatorSecret, resourceServerAddress, network } = ACCT!;
    let fac: { url: string; stop: () => Promise<void> };
    let server: Server; let url: string;
    beforeAll(async () => {
      fac = await startTestFacilitator({ network, signerSecret: facilitatorSecret });
      const app = createPremiumDataServer({
        payTo: resourceServerAddress,
        network, priceUsdc: "0.001", facilitatorUrl: fac.url,
      });
      server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
      const a = server.address(); url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    });
    afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await fac.stop(); });

    it("fetchMarket auto-pays the 402 and returns parsed MarketData", async () => {
      const dc = new DataClient({ url, signerSecret: clientSecret, network });
      const data = await dc.fetchMarket("USDC-XLM");
      expect(data).toEqual({ pair: "USDC-XLM", price: "0.1123", signal: "buy" });
    });

    it("a plain (non-paying) fetch to the same endpoint is rejected with 402", async () => {
      const res = await fetch(`${url}/market/USDC-XLM`);
      expect(res.status).toBe(402);
    });
  });
  ```
  > The `"@shadowkit/x402-premium-data/server"` export was added to that package in Task 4.3 (`"exports": { ".": "./src/server.ts", "./server": "./src/server.ts" }`). Confirm it is present.
- [ ] **Run (RED):** with `.env.x402` loaded — `set -a; . ./.env.x402; set +a; npx vitest run agent/test/dataClient.test.ts` → FAIL (the current stub `fetchMarket` does not auto-pay, so it returns a 402 body / throws). Paste the actual assertion failure.
- [ ] **Commit:** `test(agent): failing real x402 DataClient test`

### Task 6.2 — GREEN: implement DataClient over makeX402Fetch

- [ ] **Replace** `agent/src/dataClient.ts`:
  ```typescript
  // foundation §3.5 DataClient: GET the x402-protected premium-data endpoint, auto-pay the 402, parse.
  // Uses the shared payer fetch (REAL x402, charter rule 4).
  import { makeX402Fetch } from "@shadowkit/x402-shared/payerFetch";
  import type { StellarNetwork } from "@shadowkit/x402-shared";

  export interface MarketData { pair: string; price: string; signal: "buy" | "sell" | "hold"; }

  export class DataClient {
    private readonly pay: typeof fetch;
    constructor(private cfg: { url: string; signerSecret: string; network: string }) {
      this.pay = makeX402Fetch(cfg.signerSecret, cfg.network as StellarNetwork);
    }
    /** GET /market/:pair behind x402; auto-pays; returns parsed MarketData. */
    async fetchMarket(pair: string): Promise<MarketData> {
      const res = await this.pay(`${this.cfg.url}/market/${encodeURIComponent(pair)}`);
      if (!res.ok) throw new Error(`premium-data fetch failed: ${res.status}`);
      return (await res.json()) as MarketData;
    }
  }
  ```
- [ ] **Add** `"@shadowkit/x402-shared": "*"` to `agent/package.json` dependencies; `npm install`.
- [ ] **Run (GREEN, 3-account env loaded):** `set -a; . ./.env.x402; set +a; npx vitest run agent/test/dataClient.test.ts` → 2 passing.
- [ ] **Commit:** `feat(agent): DataClient pays real x402 premium-data calls`

---

## 7. Passkey login (WebAuthn) + keypair fallback — foundation §3.7

### Task 7.1 — RED: passkey + keypair paths of `connect()`

WebAuthn cannot be exercised by a real authenticator in CI, so `createWebAuthnSigner`/`createWallet` are driven through a thin seam: `connect()` calls `kit.createWallet(...)` (passkey) or builds an Ed25519 signer (keypair). The test stubs ONLY the `kit` boundary (the WebAuthn ceremony), and asserts `connect()` routes correctly by `WALLET_MODE` and returns the contract address. This is allowed (charter rule 4): we are not faking the thing under test — the thing under test is `connect()`'s routing + return shape, and `smart-account-kit`'s WebAuthn ceremony is an external browser API legitimately stubbed at its boundary. The REAL passkey ceremony is exercised manually in the demo (Task 9.x checklist) and noted.

- [ ] **Create** `web/test/passkey.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from "vitest";
  import { Keypair } from "@stellar/stellar-sdk";
  import { connect } from "../src/lib/wallet.js";

  function fakeKit(overrides: Partial<any> = {}) {
    return {
      // smart-account-kit instance surface used by connect() (foundation §3.7: kit.createWallet, kit.connectWallet).
      // VERIFIED: kit.connectWallet() RETURNS null (does NOT throw) when no stored session exists.
      createWallet: vi.fn(async () => ({ contractId: "CPASSKEY00000000000000000000000000000000000000000000000", credentialId: "cred-1" })),
      connectWallet: vi.fn(async () => ({ contractId: "CPASSKEY00000000000000000000000000000000000000000000000", credentialId: "cred-1" })),
      ...overrides,
    } as any;
  }

  describe("connect() wallet routing", () => {
    it("WALLET_MODE=passkey restores an EXISTING passkey session and returns the smart-account address", async () => {
      const kit = fakeKit();
      const out = await connect(kit, { mode: "passkey", appName: "ShadowKit", userName: "alice" });
      expect(kit.connectWallet).toHaveBeenCalledTimes(1); // tries existing passkey session first
      expect(kit.createWallet).not.toHaveBeenCalled();    // existing session -> no new wallet
      expect(out.address).toMatch(/^C[A-Z2-7]{55}$/);     // a C... contract strkey
      expect(out.mode).toBe("passkey");
    });

    it("WALLET_MODE=passkey: connectWallet RETURNS null (no session) -> createWallet is called (real contract)", async () => {
      // Models the REAL smart-account-kit contract: connectWallet() resolves to `null` (NOT a throw)
      // when there is no stored session. connect() MUST then create a wallet for the new user.
      const kit = fakeKit({ connectWallet: vi.fn(async () => null) });
      const out = await connect(kit, { mode: "passkey", appName: "ShadowKit", userName: "alice" });
      expect(kit.connectWallet).toHaveBeenCalledTimes(1);
      expect(kit.createWallet).toHaveBeenCalledTimes(1);  // null -> fall through to createWallet
      expect(out.address).toMatch(/^C[A-Z2-7]{55}$/);
      expect(out.mode).toBe("passkey");
    });

    it("WALLET_MODE=keypair uses an ed25519 keypair (fallback) and returns its address", async () => {
      const kit = fakeKit();
      // Use a REAL, valid testnet secret (a fixed strkey would fail Keypair.fromSecret's checksum).
      const kp = Keypair.random();
      const out = await connect(kit, { mode: "keypair", keypairSecret: kp.secret() });
      // keypair path does NOT touch WebAuthn
      expect(kit.createWallet).not.toHaveBeenCalled();
      expect(kit.connectWallet).not.toHaveBeenCalled();
      expect(out.mode).toBe("keypair");
      expect(out.address).toBe(kp.publicKey());
      expect(out.address).toMatch(/^G[A-Z2-7]{55}$/);
    });
  });
  ```
- [ ] **Run (RED):** `npx vitest run web/test/passkey.test.ts` → FAIL: `connect` does not accept the second options arg / does not return `mode` / does not handle the null-return contract (current keypair-only impl). Paste the actual failure.
- [ ] **Commit:** `test(web): failing passkey + keypair connect routing test`

### Task 7.2 — GREEN: implement passkey + keypair `connect()`

- [ ] **Replace** `web/src/lib/wallet.ts`:
  ```typescript
  // foundation §3.7. Passkey via smart-account-kit (kit.connectWallet existing / kit.createWallet new),
  // keypair fallback via @stellar/stellar-sdk Keypair.
  // VERIFIED 2026-06-02 (ctx7 /kalepail/smart-account-kit):
  //   constructor REQUIRES { rpcUrl, networkPassphrase, accountWasmHash, webauthnVerifierAddress }
  //     (NO factoryContractId option exists).
  //   kit.connectWallet()           -> SILENT session restore; RETURNS null (does NOT throw) on no session.
  //   kit.connectWallet({prompt:true}) -> shows the passkey selector.
  //   kit.createWallet(appName, userName, { autoSubmit, autoFund }) -> { contractId, credentialId, ... }.
  import { SmartAccountKit } from "smart-account-kit";
  import { Keypair } from "@stellar/stellar-sdk";

  export function createKit(cfg: {
    rpcUrl: string;
    networkPassphrase: string;
    accountWasmHash: string;         // smart-account contract WASM hash (REQUIRED, foundation §3.7)
    webauthnVerifierAddress: string; // WebAuthn verifier contract id C... (REQUIRED, foundation §3.7)
    rpId?: string;                   // optional WebAuthn relying-party id
    rpName?: string;                 // optional WebAuthn relying-party name
  }): SmartAccountKit {
    return new SmartAccountKit({
      rpcUrl: cfg.rpcUrl,
      networkPassphrase: cfg.networkPassphrase,
      accountWasmHash: cfg.accountWasmHash,
      webauthnVerifierAddress: cfg.webauthnVerifierAddress,
      ...(cfg.rpId ? { rpId: cfg.rpId } : {}),
      ...(cfg.rpName ? { rpName: cfg.rpName } : {}),
    });
  }

  export type WalletMode = "passkey" | "keypair";
  export interface ConnectOptions {
    mode?: WalletMode;          // default from import.meta.env.PUBLIC_WALLET_MODE or "passkey"
    appName?: string;           // passkey relying-party app name
    userName?: string;          // passkey user handle
    keypairSecret?: string;     // keypair fallback secret (S...)
    prompt?: boolean;           // passkey: force the selector (kit.connectWallet({prompt:true}))
  }
  export interface ConnectResult { address: string; mode: WalletMode; }

  /** Connect a wallet. PRIMARY: passkey (WebAuthn). FALLBACK: ed25519 keypair (WALLET_MODE=keypair). */
  export async function connect(kit: SmartAccountKit, opts: ConnectOptions = {}): Promise<ConnectResult> {
    const mode: WalletMode =
      opts.mode ??
      (((import.meta as any).env?.PUBLIC_WALLET_MODE as WalletMode | undefined) ?? "passkey");

    if (mode === "keypair") {
      const secret = opts.keypairSecret ?? ((import.meta as any).env?.PUBLIC_KEYPAIR_SECRET as string);
      const kp = Keypair.fromSecret(secret);
      return { address: kp.publicKey(), mode: "keypair" };
    }

    // passkey: try to RESTORE an existing session/credential first. connectWallet RETURNS null (no throw)
    // when none exists — so we branch on the null, NOT on a thrown error (foundation §3.7).
    const existing = await kit.connectWallet(opts.prompt ? { prompt: true } : undefined);
    if (existing) return { address: existing.contractId, mode: "passkey" };

    // No existing credential -> create a new passkey wallet for this user.
    const created = await kit.createWallet(opts.appName ?? "ShadowKit", opts.userName ?? "user", {
      autoSubmit: true,
      autoFund: true, // Friendbot on testnet (foundation §3.7 / ctx7 createWallet docs)
    });
    return { address: created.contractId, mode: "passkey" };
  }
  ```
  > **NOTE (charter rule 5):** the `SmartAccountKit` constructor keys (`rpcUrl`/`networkPassphrase`/`accountWasmHash`/`webauthnVerifierAddress`), the `connectWallet()` null-return contract, and the `createWallet`/`connectWallet` return shapes (`{ contractId, credentialId }`) were verified via ctx7 `/kalepail/smart-account-kit` on 2026-06-02 (foundation §3.7) and re-asserted against installed `0.2.10` in Task 2.1's env-gated passkey constructor check. The routing test stubs `kit`, so the routing is stable; the demo wiring needs the real `accountWasmHash` + `webauthnVerifierAddress` (provisioned in `.env`, Task 9.2).
- [ ] **Run (GREEN):** `npx vitest run web/test/passkey.test.ts` → 3 passing.
- [ ] **Commit:** `feat(web): passkey connect via smart-account-kit + keypair fallback`

### Task 7.3 — Wire ConnectBar to show passkey vs keypair mode

- [ ] **Modify** `web/src/components/ConnectBar.tsx` to call `connect(kit, { mode })`, store the result, and render a small badge of `result.mode`. Use the existing `ConnectBarProps` (foundation §3.7: `{ kit, onConnect }`). RED first with a component test:
  - **Create/extend** `web/test/connectbar.test.tsx`:
    ```tsx
    import { describe, it, expect, vi } from "vitest";
    import { render, screen, fireEvent, waitFor } from "@testing-library/react";
    import { ConnectBar } from "../src/components/ConnectBar.js";

    // Mock the wallet module so ConnectBar's button handler is exercised without a real kit.
    vi.mock("../src/lib/wallet.js", () => ({
      connect: vi.fn(async () => ({ address: "CPASSKEY00000000000000000000000000000000000000000000000", mode: "passkey" })),
    }));

    describe("ConnectBar", () => {
      it("connects and shows the address + passkey badge", async () => {
        const onConnect = vi.fn();
        render(<ConnectBar kit={{} as any} onConnect={onConnect} />);
        fireEvent.click(screen.getByRole("button", { name: /connect/i }));
        await waitFor(() => expect(onConnect).toHaveBeenCalledWith("CPASSKEY00000000000000000000000000000000000000000000000"));
        expect(screen.getByText(/passkey/i)).toBeTruthy();
      });
    });
    ```
  - **Run (RED):** `npx vitest run web/test/connectbar.test.tsx` → FAIL (no badge / handler not wired to `connect`).
- [ ] **Modify** `web/src/components/ConnectBar.tsx` handler to `const r = await connect(props.kit); setMode(r.mode); props.onConnect(r.address);` and render `{address && <span data-testid="mode-badge">{mode}</span>}`.
- [ ] **Run (GREEN):** `npx vitest run web/test/connectbar.test.tsx` → 1 passing.
- [ ] **Commit:** `feat(web): ConnectBar shows passkey/keypair mode and wires connect()`

---

## 8. Soroswap adapter behind SwapVenue (FallbackAMM fallback) — foundation §2.4

The adapter wraps a Soroswap router to satisfy the `SwapVenue` trait (foundation §2.4). Selection is config (`SWAP_VENUE=fallback|soroswap`), never a code fork in `AgentPolicy`. Soroswap testnet is UNCONFIRMED (spec §13.1), so the adapter is tested against a **minimal mock router contract** registered in the test `Env` that mimics the verified Soroswap router `swap_exact_tokens_for_tokens` signature; the FallbackAMM (M1) remains the always-green default.

> **OWNERSHIP (cross-plan reconciliation — M2 creates, M6 modifies):** `contracts/swap-venue/src/soroswap_adapter.rs` was **CREATED by M2 Task M2-8** as a trait-conformant `#[contractimpl] impl SwapVenue for SoroswapAdapter` that delegates to a configured `SwapVenueClient` router, with an embedded `#[cfg(test)] mod test` exercising a `MockRouter` (M2 scope = trait-conformance only). `contracts/swap-venue/src/lib.rs` ALREADY declares `#[cfg(feature="soroswap")] pub mod soroswap_adapter;` (M2). **M6 does NOT create the file and does NOT add a module declaration** — M6 MODIFIES the existing `soroswap_adapter.rs` to call the LIVE Soroswap router (`swap_exact_tokens_for_tokens`) and APPENDS the live-router test to the SAME embedded `mod test` (M2's convention — no standalone `soroswap_adapter_test.rs`). The adapter KEEPS implementing the `SwapVenue` trait (the load-bearing contract AgentPolicy authorizes against); only the `swap`/`reserves` bodies and `init` change to wire the real router.

### Task 8.0 — Verify the Soroswap router interface (charter rule 5)

- [ ] **Verify** the Soroswap router signature before writing the adapter:
  ```bash
  npx ctx7@latest library "soroswap" "soroswap router contract swap_exact_tokens_for_tokens soroban interface"
  # if a Context7 id exists, fetch docs; ELSE WebFetch the GitHub contract:
  ```
  ```bash
  # Fallback verification source (cite in the adapter comment):
  # https://github.com/soroswap/core  (contracts/router) — SoroswapRouter::swap_exact_tokens_for_tokens(
  #   amount_in: i128, amount_out_min: i128, path: Vec<Address>, to: Address, deadline: u64) -> Vec<i128>
  ```
  Record the EXACT signature found in a comment at the top of `soroswap_adapter.rs`. If the live signature differs, use the verified one and update the adapter + its mock router accordingly.

### Task 8.1 — RED: adapter `swap` delegates to the LIVE Soroswap router and satisfies SwapVenue

> M2 Task M2-8 already left `soroswap_adapter.rs` with an embedded `#[cfg(test)] mod test` containing a `MockRouter` that implements OUR `SwapVenue` trait and a `adapter_delegates_swap_to_router` test (delegation via `SwapVenueClient`). M6 now points the adapter at the LIVE Soroswap router (`swap_exact_tokens_for_tokens`), so the M6 RED test uses a Soroswap-shaped `MockRouter` (the real router signature, Task 8.0). **APPEND** the M6 live-router tests to that SAME embedded `mod test` — do NOT create a separate `soroswap_adapter_test.rs` and do NOT touch `lib.rs` (the gated `pub mod soroswap_adapter;` is already there from M2).

- [ ] **APPEND** the live-router tests to the embedded `#[cfg(test)] mod test` block inside `contracts/swap-venue/src/soroswap_adapter.rs` (the block M2 created). The M2 `adapter_delegates_swap_to_router` test (delegation to a `SwapVenue` `MockRouter`) is REPLACED by these Soroswap-router tests, since M6 changes the adapter to call `swap_exact_tokens_for_tokens` rather than `SwapVenueClient::swap`:
  ```rust
  // Inside `mod test` in soroswap_adapter.rs (M2's embedded test module). M6 live-router tests.
  // Soroswap-shaped MockRouter: mimics the verified swap_exact_tokens_for_tokens signature (Task 8.0).
  use soroban_sdk::{vec, Vec};

  #[contract]
  pub struct MockSoroswapRouter;
  #[contractimpl]
  impl MockSoroswapRouter {
      pub fn swap_exact_tokens_for_tokens(
          env: Env, amount_in: i128, amount_out_min: i128, path: Vec<Address>, to: Address, _deadline: u64,
      ) -> Vec<i128> {
          // Pretend a 1:2 rate; assert min-out respected (slippage) like the real router.
          let out = amount_in * 2;
          assert!(out >= amount_out_min, "slippage");
          let _ = (path, to);
          vec![&env, amount_in, out]
      }
  }

  #[test]
  fn adapter_swap_forwards_to_soroswap_router_and_returns_out() {
      let env = Env::default();
      env.mock_all_auths();
      let router_id = env.register(MockSoroswapRouter, ());
      let asset_in = Address::generate(&env);
      let asset_out = Address::generate(&env);
      let to = Address::generate(&env);

      let adapter_id = env.register(SoroswapAdapter, ());
      let adapter = SoroswapAdapterClient::new(&env, &adapter_id);
      adapter.init(&router_id, &asset_in, &asset_out);

      // BEHAVIORAL: the adapter (impl SwapVenue) forwards to the live router and returns its out.
      let out = adapter.swap(&asset_in, &1_000i128, &1_500i128, &to);
      assert_eq!(out, 2_000i128); // 1000 * 2
  }

  #[test]
  #[should_panic(expected = "slippage")]
  fn adapter_swap_respects_min_out() {
      let env = Env::default();
      env.mock_all_auths();
      let router_id = env.register(MockSoroswapRouter, ());
      let asset_in = Address::generate(&env);
      let asset_out = Address::generate(&env);
      let to = Address::generate(&env);
      let adapter_id = env.register(SoroswapAdapter, ());
      let adapter = SoroswapAdapterClient::new(&env, &adapter_id);
      adapter.init(&router_id, &asset_in, &asset_out);
      adapter.swap(&asset_in, &1_000i128, &5_000i128, &to); // demand 5000, router gives 2000 -> panic
  }
  ```
- [ ] **NO change to `contracts/swap-venue/src/lib.rs`** — the `#[cfg(feature="soroswap")] pub mod soroswap_adapter;` declaration is already present from M2 Task M2-8. (Do NOT add `mod soroswap_adapter_test;`; the tests live in the embedded `mod test`.)
- [ ] **Run (RED):** `cargo test -p swap-venue --features soroswap adapter_swap_forwards_to_soroswap_router_and_returns_out` → FAIL: the M2 adapter still calls `SwapVenueClient::swap` (and `init` takes only `router`), so `adapter.init(&router_id, &asset_in, &asset_out)` is an arity error / the swap forwards to the wrong interface — genuine red until Task 8.2 rewrites the bodies.
- [ ] **Commit:** `test(amm): failing live-Soroswap-router adapter swap tests`

### Task 8.2 — GREEN: rewrite the adapter bodies to call the LIVE Soroswap router

- [ ] **MODIFY** `contracts/swap-venue/src/soroswap_adapter.rs` (created by M2 Task M2-8). Replace M2's trait-conformance bodies — `init(env, router)` + `impl SwapVenue` delegating to `SwapVenueClient` — with the live-router wiring below. **KEEP** `#[contractimpl] impl SwapVenue for SoroswapAdapter` (trait conformance is the load-bearing contract AgentPolicy authorizes against — do NOT switch to an inherent impl). Expand `init` to take the canonical asset pair and add the `SoroswapRouter` `#[contractclient]`. The file remains `#![cfg(feature = "soroswap")]`:
  ```rust
  // contracts/swap-venue/src/soroswap_adapter.rs  (M6 MODIFY of the M2 trait-conformant adapter)
  // Soroswap adapter satisfying SwapVenue (foundation §2.4). Config-switched via env SWAP_VENUE=soroswap.
  // VERIFIED 2026-06-02 (Task 8.0, soroswap/core contracts/router): SoroswapRouter exposes
  //   swap_exact_tokens_for_tokens(amount_in: i128, amount_out_min: i128, path: Vec<Address>,
  //                                to: Address, deadline: u64) -> Vec<i128>  (last element = amount out).
  #![cfg(feature = "soroswap")]
  use soroban_sdk::{contract, contractclient, contractimpl, contracttype, vec, Address, Env, Vec};
  use crate::{SwapVenue, SwapVenueClient as _}; // SwapVenue trait (impl below); SwapVenueClient no longer used directly

  #[contractclient(name = "RouterClient")]
  pub trait SoroswapRouter {
      fn swap_exact_tokens_for_tokens(
          env: Env, amount_in: i128, amount_out_min: i128, path: Vec<Address>, to: Address, deadline: u64,
      ) -> Vec<i128>;
  }

  #[contracttype]
  #[derive(Clone)]
  pub enum AdapterKey { Router, AssetIn, AssetOut }

  #[contract]
  pub struct SoroswapAdapter;

  #[contractimpl]
  impl SoroswapAdapter {
      /// Configure the adapter: the Soroswap router id + the canonical asset pair.
      /// (M6 widens M2's `init(env, router)` to carry the pair needed to build the swap path.)
      pub fn init(env: Env, router: Address, asset_a: Address, asset_b: Address) {
          let s = env.storage().instance();
          s.set(&AdapterKey::Router, &router);
          s.set(&AdapterKey::AssetIn, &asset_a);
          s.set(&AdapterKey::AssetOut, &asset_b);
      }
      pub fn router(env: Env) -> Address {
          env.storage().instance().get(&AdapterKey::Router).unwrap()
      }
  }

  #[contractimpl]
  impl SwapVenue for SoroswapAdapter {
      /// SwapVenue::swap — forwards to the LIVE Soroswap router; returns the actual out amount.
      fn swap(env: Env, asset_in: Address, amount_in: i128, min_out: i128, to: Address) -> i128 {
          let s = env.storage().instance();
          let router: Address = s.get(&AdapterKey::Router).unwrap();
          let a: Address = s.get(&AdapterKey::AssetIn).unwrap();
          let b: Address = s.get(&AdapterKey::AssetOut).unwrap();
          // path = [asset_in, other_asset]
          let other = if asset_in == a { b.clone() } else { a.clone() };
          let path = vec![&env, asset_in.clone(), other];
          let deadline = env.ledger().timestamp() + 300; // 5 min
          let client = RouterClient::new(&env, &router);
          let amounts = client.swap_exact_tokens_for_tokens(&amount_in, &min_out, &path, &to, &deadline);
          // Soroswap returns the path amounts; the LAST element is the output amount.
          amounts.get(amounts.len() - 1).unwrap()
      }

      /// SwapVenue::reserves — Soroswap reserves live in the pair contract; for the adapter demo we
      /// expose (0,0) as the router itself is reserve-less. (Reserves are read off-chain via Soroswap UI.)
      fn reserves(_env: Env) -> (i128, i128) { (0, 0) }
  }
  ```
  > The `use crate::{SwapVenue, ...}` brings the trait into scope so `impl SwapVenue for SoroswapAdapter` resolves (foundation §2.4). M2 imported `SwapVenueClient` for delegation; M6 no longer delegates to a `SwapVenue` router (it calls the Soroswap `RouterClient`), so drop the now-unused `SwapVenueClient` import if the compiler warns.
- [ ] **Run (GREEN):** `cargo test -p swap-venue --features soroswap soroswap_adapter` → both M6 tests pass (`adapter_swap_forwards_to_soroswap_router_and_returns_out`, `adapter_swap_respects_min_out`).
- [ ] **Commit:** `feat(amm): Soroswap adapter calls live router (foundation §2.4); still impl SwapVenue`

### Task 8.3 — Fallback parity: config switch picks FallbackAMM or adapter

- [ ] **Create** `agent/test/swapVenueSelect.test.ts` (the config switch lives in the agent/executor wiring, not in `AgentPolicy`):
  ```typescript
  import { describe, it, expect } from "vitest";
  import { selectSwapVenueId } from "../src/executor.js";

  // SWAP_VENUE config switch (foundation §2.4): never a code fork — a pure id selector.
  describe("selectSwapVenueId", () => {
    it("returns the FallbackAMM id when SWAP_VENUE=fallback", () => {
      expect(selectSwapVenueId("fallback", { fallbackAmmId: "CFALLBACK", soroswapAdapterId: "CSORO" })).toBe("CFALLBACK");
    });
    it("returns the Soroswap adapter id when SWAP_VENUE=soroswap", () => {
      expect(selectSwapVenueId("soroswap", { fallbackAmmId: "CFALLBACK", soroswapAdapterId: "CSORO" })).toBe("CSORO");
    });
    it("defaults to FallbackAMM for an unknown value", () => {
      expect(selectSwapVenueId("nope", { fallbackAmmId: "CFALLBACK", soroswapAdapterId: "CSORO" })).toBe("CFALLBACK");
    });
  });
  ```
- [ ] **Run (RED):** `npx vitest run agent/test/swapVenueSelect.test.ts` → FAIL `selectSwapVenueId is not a function`.
- [ ] **Add** to `agent/src/executor.ts`:
  ```typescript
  /** Config switch (foundation §2.4): pick the swap venue contract id by SWAP_VENUE, never a code fork. */
  export function selectSwapVenueId(
    mode: string,
    ids: { fallbackAmmId: string; soroswapAdapterId: string },
  ): string {
    return mode === "soroswap" ? ids.soroswapAdapterId : ids.fallbackAmmId;
  }
  ```
- [ ] **Run (GREEN):** `npx vitest run agent/test/swapVenueSelect.test.ts` → 3 passing.
- [ ] **Commit:** `feat(agent): SWAP_VENUE config switch (fallback|soroswap)`

---

## 9. justfile + env wiring

### Task 9.1 — Add M6 recipes + fold tests into `just test`

- [ ] **Modify** `justfile` to add:
  ```just
  # --- M6: x402 services ---
  # Start the local test facilitator (needs FACILITATOR_SECRET) + both x402 services (demo wiring).
  # Loads .env.x402 / .env.testnet for the 3 x402 accounts (foundation §3.6a).
  x402-up:
      set -a; [ -f .env.x402 ] && . ./.env.x402; set +a; \
        node --experimental-strip-types scripts/demo/start-facilitator.ts &
      sleep 1
      X402_DIRECTION=${X402_DIRECTION:-both} node --experimental-strip-types x402-services/premium-data/src/main.ts &
      X402_DIRECTION=${X402_DIRECTION:-both} node --experimental-strip-types x402-services/shadowkit-api/src/main.ts &
      @echo "facilitator :4023  premium-data :4100  shadowkit-api :4200"

  # M6 primary x402 tests (need the 3 funded accounts from scripts/x402-bootstrap.ts -> .env.x402).
  # Loads .env.x402 if present so CLIENT_SECRET/FACILITATOR_SECRET/RESOURCE_SERVER_ADDRESS are set;
  # otherwise the REAL-x402 suites SKIP (justified) and only the env-independent suites run.
  test-x402:
      set -a; [ -f .env.x402 ] && . ./.env.x402; set +a; \
        npx vitest run x402-services/shared-x402 x402-services/premium-data x402-services/shadowkit-api agent/test/dataClient.test.ts

  # M6 FALLBACK suites (config-selectable, must also pass). The onedir suites still need the 3 accounts
  # for facilitator construction (premium-data) but the shadowkit-api onedir needs none (no facilitator).
  test-fallbacks-m6:
      set -a; [ -f .env.x402 ] && . ./.env.x402; set +a; \
        X402_DIRECTION=agent-pays-only npx vitest run x402-services/shadowkit-api/test/onedir.test.ts x402-services/premium-data/test/onedir.test.ts
      WALLET_MODE=keypair npx vitest run web/test/passkey.test.ts
      cargo test -p swap-venue soroswap_adapter
      npx vitest run agent/test/swapVenueSelect.test.ts

  # Testnet deploy + demo
  deploy-testnet:
      bash scripts/deploy-testnet.sh

  demo NETWORK="local":
      bash scripts/demo.sh --network {{NETWORK}}
  ```
- [ ] **Modify** the existing `test` recipe to append `test-x402` and `test-fallbacks-m6` (after the existing rust + ts + circuit targets):
  ```just
  test: test-rust test-ts test-circuit test-fallbacks test-x402 test-fallbacks-m6
  ```
  > Use whatever the existing M0 `test` recipe names are; the point is `just test` runs the M6 suites too.
- [ ] **Run** to confirm the recipe parses: `just --list` → shows `x402-up`, `test-x402`, `test-fallbacks-m6`, `deploy-testnet`, `demo`.
- [ ] **Commit:** `build(repo): justfile recipes for x402, fallbacks, testnet deploy, demo`

### Task 9.2 — Extend `.env.example`

- [ ] **Modify** `.env.example` to add (no secrets, placeholders only):
  ```bash
  # --- M6 x402 (3 distinct accounts required for REAL settlement; foundation §3.6a) ---
  X402_NETWORK=stellar:testnet
  X402_PRICE_USDC=0.001
  X402_FACILITATOR_URL=http://127.0.0.1:4023        # the local test facilitator started by the harness
  X402_DIRECTION=both                               # fallback: agent-pays-only
  PREMIUM_DATA_URL=http://127.0.0.1:4100
  PREMIUM_DATA_PORT=4100
  SHADOWKIT_API_PORT=4200
  # The THREE x402 roles (provisioned by scripts/x402-bootstrap.ts -> .env.x402; foundation §3.6a):
  CLIENT_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX   # payer; USDC trustline + USDC balance
  FACILITATOR_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX    # facilitator signer
  FACILITATOR_ADDRESS=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX   # facilitator public key
  RESOURCE_SERVER_ADDRESS=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX # payTo; USDC trustline (receives USDC)
  X402_USDC_SAC=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA   # testnet USDC SEP-41 SAC (7 decimals)
  USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5     # Circle testnet issuer (trustline asset)
  # X402_USDC_FUNDER_SECRET=...   # optional: an account already holding testnet USDC to seed the CLIENT
  # --- M6 wallet (smart-account-kit constructor; foundation §3.7) ---
  WALLET_MODE=passkey                 # fallback: keypair
  PUBLIC_WALLET_MODE=passkey
  PUBLIC_KEYPAIR_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  ACCOUNT_WASM_HASH=0000000000000000000000000000000000000000000000000000000000000000  # smart-account WASM hash (REQUIRED)
  WEBAUTHN_VERIFIER_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX     # WebAuthn verifier contract id (REQUIRED)
  # --- M6 swap venue ---
  SWAP_VENUE=fallback                 # primary demo can use: soroswap
  SOROSWAP_ROUTER_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  ```
- [ ] **Commit:** `docs(repo): add M6 env keys to .env.example`

---

## 10. Testnet deploy + repeatable demo

### Task 10.1 — `scripts/deploy-testnet.sh`

- [ ] **Verify** the stellar CLI deploy/keys/contract commands before scripting (charter rule 5). Confirm EACH subcommand+flag actually exists; record any difference and adjust the script (do NOT leave `|| true` on a step whose failure must abort):
  ```bash
  stellar --version
  stellar keys --help | head; stellar contract deploy --help | head; stellar contract invoke --help | head
  stellar contract asset --help        # confirm `asset deploy` and `id asset` subcommands + --asset/--network flags
  stellar contract asset deploy --help # confirm exact flags (--asset CODE:ISSUER, --source, --network)
  stellar contract id asset --help     # confirm --asset native / --asset CODE:ISSUER
  stellar keys --help | grep -E "show|reveal|secret"  # confirm how to print a secret (e.g. `keys show` vs `keys secret`)
  ```
  Expected: subcommands `keys generate/fund/address`, a way to print a secret (`keys show` OR `keys secret` — use whichever the installed CLI exposes), `contract deploy --wasm ... --source ... --network testnet`, `contract invoke`, `contract asset deploy --asset CODE:ISSUER`, `contract id asset --asset native|CODE:ISSUER`. Also confirm the `--quorum_cfg` JSON arg form by dry-running ONE invoke against a local deploy (`stellar contract invoke --id $GOV --network local -- init --help` shows the expected arg encoding for the `QuorumCfg` struct + `--merkle_root` BytesN<32> hex). Record the exact forms; the script below MUST match them.
- [ ] **Create** `scripts/deploy-testnet.sh`:
  ```bash
  #!/usr/bin/env bash
  # Deploy all ShadowKit contracts to Stellar TESTNET and write .env.testnet.
  # Idempotent-ish: re-running redeploys fresh contract ids (demo is designed to be re-run).
  set -euo pipefail
  NET=testnet
  SRC=${DEPLOY_SOURCE:-shadowkit-deployer}

  echo "==> ensure deployer key ($SRC) exists + funded"
  stellar keys address "$SRC" >/dev/null 2>&1 || stellar keys generate --global "$SRC" --network "$NET" --fund
  stellar keys fund "$SRC" --network "$NET" || true   # Friendbot top-up (idempotent)
  DEPLOYER=$(stellar keys address "$SRC")
  echo "deployer: $DEPLOYER"

  echo "==> build wasm (release)"
  stellar contract build

  deploy() { # $1 = wasm name (crate, dashes), echoes contract id
    stellar contract deploy \
      --wasm "target/wasm32v1-none/release/${1//-/_}.wasm" \
      --source "$SRC" --network "$NET"
  }

  echo "==> deploy contracts"
  VERIFIER_ID=$(deploy groth16-verifier)
  GOV_VAULT_ID=$(deploy gov-vault)
  FALLBACK_AMM_ID=$(deploy fallback-amm)
  AGENT_POLICY_ID=$(deploy agent-policy)
  SOROSWAP_ADAPTER_ID=$(deploy swap-venue)   # adapter wasm; init points it at SOROSWAP_ROUTER_ID if set

  echo "==> resolve treasury SAC ids (USDC + XLM)"
  # The TREASURY asset is the x402 USDC SEP-41 SAC (foundation §3.6a). The Circle testnet USDC SAC id is
  # fixed; resolve the contract id for the USDC classic asset to confirm it matches. XLM has a native SAC.
  # NOTE: failures here MUST abort (no `|| true`) — an unresolved treasury asset breaks the whole demo.
  USDC_ISSUER=${USDC_ISSUER:-GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5}  # Circle testnet
  USDC_ID=${X402_USDC_SAC:-$(stellar contract id asset --asset "USDC:$USDC_ISSUER" --network "$NET")}
  XLM_ID=$(stellar contract id asset --asset native --network "$NET")
  echo "USDC SAC: $USDC_ID   XLM SAC: $XLM_ID"

  echo "==> init contracts (failures abort)"
  MERKLE_ROOT=${MERKLE_ROOT:-0000000000000000000000000000000000000000000000000000000000000000}
  # --quorum_cfg encodes the QuorumCfg struct (foundation §2.2); confirm the exact JSON/arg form in the
  # verify step above and match it here. If the CLI wants per-field flags instead of JSON, use those.
  stellar contract invoke --id "$GOV_VAULT_ID" --source "$SRC" --network "$NET" -- \
    init --admin "$DEPLOYER" --verifier "$VERIFIER_ID" --merkle_root "$MERKLE_ROOT" \
         --treasury_asset "$USDC_ID" --quorum_cfg '{"min_voters":3,"yes_must_exceed_no":true}'
  stellar contract invoke --id "$FALLBACK_AMM_ID" --source "$SRC" --network "$NET" -- \
    init --asset_a "$USDC_ID" --asset_b "$XLM_ID"
  if [ "${SWAP_VENUE:-fallback}" = "soroswap" ] && [ -n "${SOROSWAP_ROUTER_ID:-}" ]; then
    stellar contract invoke --id "$SOROSWAP_ADAPTER_ID" --source "$SRC" --network "$NET" -- \
      init --router "$SOROSWAP_ROUTER_ID" --asset_a "$USDC_ID" --asset_b "$XLM_ID"
  fi

  echo "==> seed FallbackAMM liquidity (failure aborts — no liquidity = no demo swap)"
  # Requires the DEPLOYER to hold USDC + XLM; the x402 bootstrap below funds USDC. This step MUST abort
  # on failure (removed the `|| true` mask): a silently-empty pool makes the demo unpayable/unswappable.
  stellar contract invoke --id "$FALLBACK_AMM_ID" --source "$SRC" --network "$NET" -- \
    add_liquidity --from "$DEPLOYER" --amount_a 100000 --amount_b 1000000

  echo "==> bootstrap the 3 x402 accounts (CLIENT/FACILITATOR/RESOURCE) + USDC trustlines + payer USDC"
  # foundation §3.6a: REAL x402 settlement needs 3 distinct funded accounts and a USDC-funded payer.
  # x402-bootstrap.ts writes .env.x402; failure aborts (the x402 demo cannot settle without funds).
  X402_USDC_SAC="$USDC_ID" USDC_ISSUER="$USDC_ISSUER" node --experimental-strip-types scripts/x402-bootstrap.ts
  set -a; . ./.env.x402; set +a   # pull CLIENT_SECRET/FACILITATOR_*/RESOURCE_SERVER_ADDRESS into scope

  echo "==> reveal deployer secret"
  # Use whichever the installed CLI exposes (verify step): `stellar keys show` OR `stellar keys secret`.
  DEPLOYER_SECRET=$(stellar keys show "$SRC" 2>/dev/null || stellar keys secret "$SRC")

  echo "==> write .env.testnet"
  cat > .env.testnet <<EOF
  RPC_URL=https://soroban-testnet.stellar.org
  NETWORK_PASSPHRASE=Test SDF Network ; September 2015
  X402_NETWORK=stellar:testnet
  X402_FACILITATOR_URL=\${X402_FACILITATOR_URL:-http://127.0.0.1:4023}
  X402_PRICE_USDC=0.001
  X402_DIRECTION=\${X402_DIRECTION:-both}
  X402_USDC_SAC=$USDC_ID
  USDC_ISSUER=$USDC_ISSUER
  # x402 roles (3 distinct accounts; foundation §3.6a) — from .env.x402:
  CLIENT_SECRET=$CLIENT_SECRET
  FACILITATOR_SECRET=$FACILITATOR_SECRET
  FACILITATOR_ADDRESS=$FACILITATOR_ADDRESS
  RESOURCE_SERVER_ADDRESS=$RESOURCE_SERVER_ADDRESS
  DEPLOYER_SECRET=$DEPLOYER_SECRET
  GROTH16_VERIFIER_ID=$VERIFIER_ID
  GOV_VAULT_ID=$GOV_VAULT_ID
  FALLBACK_AMM_ID=$FALLBACK_AMM_ID
  AGENT_POLICY_ID=$AGENT_POLICY_ID
  SOROSWAP_ADAPTER_ID=$SOROSWAP_ADAPTER_ID
  USDC_ID=$USDC_ID
  XLM_ID=$XLM_ID
  SWAP_VENUE=\${SWAP_VENUE:-fallback}
  EOF
  echo "==> .env.testnet written. Deploy complete."
  ```
  > **NOTE (charter rule 5):** the exact `stellar` subcommand flags (`contract asset deploy`, `contract id asset`, `keys show`/`keys secret`, `--quorum_cfg` JSON form, the i128/Address arg encodings) MUST be confirmed against the installed CLI in Task 10.1's verify step; adjust the script to the real flags. The init arg shapes (`--merkle_root` BytesN<32> hex, `--quorum_cfg` QuorumCfg) follow `gov-vault::init` (foundation §2.2). The `|| true` masks were REMOVED from `add_liquidity` and the SAC resolution — those failures must abort because the demo cannot run without liquidity + a resolvable treasury asset. The x402 bootstrap funds the payer USDC so the x402 settlement has funds (foundation §3.6a); the CLIENT still needs Circle-faucet USDC unless `X402_USDC_FUNDER_SECRET` is set.
- [ ] **Make executable:** `chmod +x scripts/deploy-testnet.sh`.
- [ ] **Run (real testnet deploy):**
  ```bash
  bash scripts/deploy-testnet.sh
  ```
  Expected output ends with `.env.testnet written. Deploy complete.` and `.env.testnet` contains all `*_ID` values (C... strkeys).
- [ ] **Commit:** `build(repo): testnet deploy script (all contracts + SAC + init)`

### Task 10.2 — RED: a demo-script test that asserts the full loop is green

The demo script must be testable (the user's "demo script test" requirement). We test it on the **local** network first (fast, deterministic), then run it on testnet manually.

- [ ] **Create** `scripts/demo.sh`:
  ```bash
  #!/usr/bin/env bash
  # Full ShadowKit e2e demo loop. --network local|testnet. Exits 0 ONLY if treasury moved + tally revealed.
  set -euo pipefail
  NETWORK=local
  while [ $# -gt 0 ]; do case "$1" in --network) NETWORK="$2"; shift 2;; *) shift;; esac; done

  if [ "$NETWORK" = "testnet" ]; then
    set -a; . ./.env.testnet; set +a
  else
    set -a; . ./.env.local; set +a   # written by scripts/deploy-local.sh (M0)
  fi

  echo "==> [1/7] start the local x402 facilitator + both x402 services"
  # The facilitator needs FACILITATOR_SECRET (foundation §3.6a). A tiny launcher stands it up and prints
  # its URL; demo helpers + services read X402_FACILITATOR_URL. (On testnet .env.testnet already carries
  # the 3 x402 accounts written by deploy-testnet.sh.)
  node --experimental-strip-types scripts/demo/start-facilitator.ts & FAC=$!
  sleep 1
  X402_DIRECTION=${X402_DIRECTION:-both} node --experimental-strip-types x402-services/premium-data/src/main.ts & PD=$!
  X402_DIRECTION=${X402_DIRECTION:-both} GOV_VAULT_ID=$GOV_VAULT_ID node --experimental-strip-types x402-services/shadowkit-api/src/main.ts & API=$!
  trap 'kill $FAC $PD $API 2>/dev/null || true' EXIT
  sleep 2

  echo "==> [2/7] build snapshot + create proposal (deadline now+15s)"
  DEADLINE=$(( $(date +%s) + 15 ))
  node --experimental-strip-types scripts/demo/create-proposal.ts --deadline "$DEADLINE"

  echo "==> [3/7] cast N sealed votes (direction hidden)"
  node --experimental-strip-types scripts/demo/cast-votes.ts

  echo "==> [4/7] assert NO tally visible before close"
  node --experimental-strip-types scripts/demo/assert-sealed.ts   # exits non-zero if weighted_* != null

  echo "==> [5/7] wait for deadline + reveal"
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do sleep 1; done
  node --experimental-strip-types scripts/demo/reveal.ts

  echo "==> [6/7] agent: x402 pay premium-data -> plan -> sign -> swap"
  node --experimental-strip-types scripts/demo/run-agent.ts

  echo "==> [7/7] assert treasury moved + tally revealed"
  node --experimental-strip-types scripts/demo/assert-final.ts    # exits non-zero unless balance changed + tally != null
  echo "DEMO OK ($NETWORK)"
  ```
  > The `scripts/demo/*.ts` helpers are thin wrappers over `@shadowkit/snapshot-tool`, `@shadowkit/zk-prover`, `@shadowkit/tally-reveal`, `@shadowkit/agent`, and the contract bindings — all already built in M1–M5. They take their contract ids from the env loaded above. Each is implemented in its own sub-task (10.3a–10.3h) with concrete code below. **If M5's `06-m5-timelock-reveal.md` plan already ships equivalent e2e step scripts, REUSE them by path (cite the M5 task) instead of re-creating — DRY.** Where M5 has no equivalent, implement the skeleton given in 10.3a–10.3h.
- [ ] **Make executable:** `chmod +x scripts/demo.sh`.
- [ ] **Create** `scripts/demo.test.ts` (the demo-script test — runs the script on LOCAL net, asserts exit 0 + "DEMO OK"):
  ```typescript
  import { describe, it, expect } from "vitest";
  import { execFileSync } from "node:child_process";

  // Demo-script test (user requirement). Runs the FULL local loop end to end and asserts it is green.
  // Requires the local network up + contracts deployed (just net-up && just deploy-local from M0).
  // JUSTIFICATION (charter rule 4): this drives REAL contracts on the local network; it is gated on
  // RUN_DEMO_TEST=1 because it requires the local quickstart container + a fresh deploy, which is not
  // available in a pure unit-test runner. CI's e2e stage sets RUN_DEMO_TEST=1 after `just net-up`.
  const run = process.env.RUN_DEMO_TEST === "1" ? describe : describe.skip;

  run("demo.sh full loop (local)", () => {
    it("runs green and prints DEMO OK", () => {
      const out = execFileSync("bash", ["scripts/demo.sh", "--network", "local"], {
        encoding: "utf8", timeout: 180_000,
      });
      expect(out).toMatch(/DEMO OK \(local\)/);
    });

    it("runs green a SECOND time (demo never dies)", () => {
      const out = execFileSync("bash", ["scripts/demo.sh", "--network", "local"], {
        encoding: "utf8", timeout: 180_000,
      });
      expect(out).toMatch(/DEMO OK \(local\)/);
    });
  });
  ```
- [ ] **Run (RED):** `RUN_DEMO_TEST=1 npx vitest run scripts/demo.test.ts` → FAIL initially (demo helpers `scripts/demo/*.ts` not yet created, or assertions fail). Paste the actual failure.
- [ ] **Commit:** `test(repo): failing full-loop demo-script test (local)`

### Task 10.3 — GREEN: implement the demo step helpers (one sub-task each)

Each helper below is its own create→run→commit cycle (foundation §0 / §14: each numbered sub-task is a single cycle). Implement them in order. **Before writing each, check `06-m5-timelock-reveal.md` for an equivalent e2e step script and REUSE it (cite the path) if present — only create the helper here if M5 has none.** All helpers load env via `scripts/demo/_env.ts` and take contract ids from `.env.{local,testnet}`.

#### Task 10.3a — `scripts/demo/_env.ts` (shared env loader)
- [ ] **Create** `scripts/demo/_env.ts`:
  ```typescript
  // Typed accessor for the demo env (loaded into process.env by demo.sh's `. .env.{local,testnet}`).
  function req(name: string): string {
    const v = process.env[name];
    if (!v) { console.error(`missing env ${name}`); process.exit(1); }
    return v;
  }
  export const env = {
    rpcUrl: () => req("RPC_URL"),
    networkPassphrase: () => req("NETWORK_PASSPHRASE"),
    govVaultId: () => req("GOV_VAULT_ID"),
    agentPolicyId: () => req("AGENT_POLICY_ID"),
    fallbackAmmId: () => req("FALLBACK_AMM_ID"),
    soroswapAdapterId: () => process.env.SOROSWAP_ADAPTER_ID ?? "",
    swapVenue: () => process.env.SWAP_VENUE ?? "fallback",
    usdcId: () => req("USDC_ID"),
    deployerSecret: () => req("DEPLOYER_SECRET"),
    premiumDataUrl: () => process.env.PREMIUM_DATA_URL ?? "http://127.0.0.1:4100",
    proposalId: () => Number(process.env.DEMO_PROPOSAL_ID ?? "0"),
    setProposalId: (id: number) => { process.env.DEMO_PROPOSAL_ID = String(id); },
  };
  ```
- [ ] **Commit:** `feat(repo): demo env loader (_env.ts)`

#### Task 10.3b — `scripts/demo/start-facilitator.ts`
- [ ] **Create** `scripts/demo/start-facilitator.ts` (stands up the local test facilitator the services + payer use):
  ```typescript
  import { startTestFacilitator } from "@shadowkit/x402-shared";
  const network = (process.env.X402_NETWORK as "stellar:testnet" | "stellar:pubnet") ?? "stellar:testnet";
  const fac = await startTestFacilitator({ network, signerSecret: process.env.FACILITATOR_SECRET!, port: 4023 });
  console.log(`facilitator up at ${fac.url}`);
  process.on("SIGTERM", () => { fac.stop(); });
  // keep the process alive
  await new Promise(() => {});
  ```
- [ ] **Commit:** `feat(repo): demo local-facilitator launcher`

#### Task 10.3c — `scripts/demo/create-proposal.ts`
- [ ] **Create** `scripts/demo/create-proposal.ts` (snapshot + create proposal; prints the new id for the loop):
  ```typescript
  import { Keypair } from "@stellar/stellar-sdk";
  import { buildSnapshot } from "@shadowkit/snapshot-tool";
  import { Client as GovVaultClient } from "@shadowkit/shared/bindings/gov-vault";
  import { env } from "./_env.js";
  // --deadline <unix>; build a 3-holder snapshot fixture and create a swap proposal capped at 1000 USDC.
  const deadline = Number(process.argv[process.argv.indexOf("--deadline") + 1]);
  const holders = [
    { secretCommit: "1", weight: "100" }, { secretCommit: "2", weight: "200" }, { secretCommit: "3", weight: "300" },
  ];
  const snap = buildSnapshot(holders); // root must equal GovVault's stored MerkleRoot (set at init/deploy)
  const gov = new GovVaultClient({ contractId: env.govVaultId(), rpcUrl: env.rpcUrl(), networkPassphrase: env.networkPassphrase() });
  const source = Keypair.fromSecret(env.deployerSecret());
  const tx = await gov.create_proposal({
    action_spec: { kind: "swap", asset_in: env.usdcId(), asset_out: env.usdcId(), amount: "1000", min_out: "1" },
    cap: "1000", deadline,
  });
  const { result: id } = await tx.signAndSend({ signTransaction: async (xdr) => source.sign as never }); // see NOTE
  console.log(`proposal id=${id} root=${snap.rootBe32Hex}`);
  process.stdout.write(String(id)); // demo.sh captures DEMO_PROPOSAL_ID
  ```
  > **NOTE (charter rule 5):** the binding's submit/sign call (`tx.signAndSend({...})`) follows the `stellar contract bindings typescript` ContractClient convention generated in M0/M1 — confirm the exact signer-callback shape against the generated client (and the M5 e2e step's usage) before relying on it; adjust to the real `signTransaction`/`signAndSend` signature. The snapshot root must match GovVault's stored root (set at deploy/init); if M1's e2e fixture already pins a matching root, reuse it.
- [ ] **Commit:** `feat(repo): demo create-proposal step`

#### Task 10.3d — `scripts/demo/cast-votes.ts`
- [ ] **Create** `scripts/demo/cast-votes.ts` (generate REAL proofs + timelock-seal + cast N sealed votes):
  ```typescript
  import { Keypair } from "@stellar/stellar-sdk";
  import { generateVoteProof } from "@shadowkit/zk-prover";
  import { buildSnapshot } from "@shadowkit/snapshot-tool";
  import { Client as GovVaultClient } from "@shadowkit/shared/bindings/gov-vault";
  import { env } from "./_env.js";
  const deadline = Number(process.env.DEMO_DEADLINE ?? "0");
  const proposalId = String(env.proposalId());
  const gov = new GovVaultClient({ contractId: env.govVaultId(), rpcUrl: env.rpcUrl(), networkPassphrase: env.networkPassphrase() });
  const source = Keypair.fromSecret(env.deployerSecret());
  const holders = [{ secretCommit: "1", weight: "100" }, { secretCommit: "2", weight: "200" }, { secretCommit: "3", weight: "300" }];
  const snap = buildSnapshot(holders);
  const dirs: (0 | 1)[] = [1, 1, 0]; // 2 yes (300w) vs 1 no (300w) — sealed, direction hidden on-chain
  for (let i = 0; i < holders.length; i++) {
    const { merklePath, pathIndices } = snap.getPath(i);
    const r = await generateVoteProof(
      { secret: String(i + 1), merklePath, pathIndices, weight: holders[i].weight, proposalId, direction: dirs[i], merkleRoot: snap.root },
      { wasmPath: "circuits/vote/fixtures/vote.wasm", zkeyPath: "circuits/vote/fixtures/vote_final.zkey" },
      deadline,
    );
    const tx = await gov.cast_vote({
      id: env.proposalId(), proof: r.proof as never, pub_signals: r.publicSignals as never, sealed_ciphertext: r.sealedCiphertext as never,
    });
    await tx.signAndSend({ signTransaction: async () => source.sign as never });
    console.log(`cast vote ${i + 1}/${holders.length}`);
  }
  ```
  > **NOTE:** proof/pub_signals/sealed_ciphertext must be marshalled to the binding's XDR shapes (foundation §3.1 `fieldToBe32Hex`/`toScSealedVote`); reuse M4/M5's exact marshalling helper (cite the path) rather than the `as never` placeholders, which only stand in for the verified conversion call.
- [ ] **Commit:** `feat(repo): demo cast-votes step (real proofs + tlock seal)`

#### Task 10.3e — `scripts/demo/assert-sealed.ts`
- [ ] **Create** `scripts/demo/assert-sealed.ts` (exit 1 if any tally leaks before close — the privacy invariant):
  ```typescript
  import { Client as GovVaultClient } from "@shadowkit/shared/bindings/gov-vault";
  import { env } from "./_env.js";
  const gov = new GovVaultClient({ contractId: env.govVaultId(), rpcUrl: env.rpcUrl(), networkPassphrase: env.networkPassphrase() });
  const view = (await gov.proposal({ id: env.proposalId() })).result;
  if (view.weightedYes !== null || view.weightedNo !== null) {
    console.error(`TALLY LEAKED before close: yes=${view.weightedYes} no=${view.weightedNo}`);
    process.exit(1);
  }
  console.log(`sealed OK: votesCast=${view.votesCast}, tally hidden`);
  ```
- [ ] **Commit:** `feat(repo): demo assert-sealed (no pre-close tally) step`

#### Task 10.3f — `scripts/demo/reveal.ts`
- [ ] **Create** `scripts/demo/reveal.ts` (tlock-decrypt + build reveal args + close_and_reveal):
  ```typescript
  import { Keypair } from "@stellar/stellar-sdk";
  import { buildRevealArgs } from "@shadowkit/tally-reveal";
  import { Client as GovVaultClient } from "@shadowkit/shared/bindings/gov-vault";
  import { env } from "./_env.js";
  const gov = new GovVaultClient({ contractId: env.govVaultId(), rpcUrl: env.rpcUrl(), networkPassphrase: env.networkPassphrase() });
  const source = Keypair.fromSecret(env.deployerSecret());
  // Read the stored sealed votes (binding view) to feed the tlock decryption, then re-aggregate on-chain.
  const sealed = (await gov.sealed_votes?.({ id: env.proposalId() }))?.result
    ?? (await gov.proposal({ id: env.proposalId() })).result.sealedVotes; // shape per generated binding (verify)
  const args = await buildRevealArgs(env.proposalId(), sealed as never);
  const tx = await gov.close_and_reveal({
    id: env.proposalId(), revealed_yes_w: args.revealedYesW, revealed_no_w: args.revealedNoW, decryptions: args.decryptions as never,
  });
  await tx.signAndSend({ signTransaction: async () => source.sign as never });
  console.log(`revealed yes=${args.revealedYesW} no=${args.revealedNoW}`);
  ```
  > **NOTE:** the way the demo reads stored `SealedVote`s for `buildRevealArgs` (a dedicated `sealed_votes(id)` view vs reading them from `proposal()`) depends on the M5 binding/contract surface — reuse M5's reveal step (cite the path) if it exists; otherwise confirm the read against the generated GovVault binding.
- [ ] **Commit:** `feat(repo): demo reveal step (real tlock decrypt + on-chain re-aggregate)`

#### Task 10.3g — `scripts/demo/run-agent.ts`
- [ ] **Create** `scripts/demo/run-agent.ts` (snapshots treasury balance, runs the agent x402→plan→sign→swap, writes the before/after balances for assert-final):
  ```typescript
  import { writeFileSync } from "node:fs";
  import { Horizon, Asset } from "@stellar/stellar-sdk";
  import { AgentRunner } from "@shadowkit/agent";
  import { selectSwapVenueId } from "../../agent/src/executor.js";
  import { env } from "./_env.js";
  const horizon = new Horizon.Server(process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org");
  async function usdcBalance(addr: string): Promise<string> {
    const a = await horizon.loadAccount(addr);
    const b = a.balances.find((x: any) => x.asset_code === "USDC");
    return b ? (b as any).balance : "0";
  }
  const treasury = process.env.AGENT_POLICY_ID!; // the smart-account treasury wallet (foundation §2.3)
  const before = await usdcBalance(treasury);
  const runner = new AgentRunner({
    rpcUrl: env.rpcUrl(), networkPassphrase: env.networkPassphrase(),
    govVaultId: env.govVaultId(), agentPolicyId: env.agentPolicyId(),
    swapVenueId: selectSwapVenueId(env.swapVenue(), { fallbackAmmId: env.fallbackAmmId(), soroswapAdapterId: env.soroswapAdapterId() }),
    sessionSecretKey: process.env.AGENT_SESSION_SECRET!,
    premiumDataUrl: env.premiumDataUrl(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    useDeterministicPlanner: (process.env.USE_DETERMINISTIC_PLANNER ?? "true") === "true",
  });
  const { txHash } = await runner.run(env.proposalId(), (l) => console.log(`[${l.phase}] ${l.message}`));
  const after = await usdcBalance(treasury);
  writeFileSync(".demo-balances.json", JSON.stringify({ before, after, txHash }));
  console.log(`agent done tx=${txHash} treasury USDC ${before} -> ${after}`);
  ```
  > **NOTE:** `usdcBalance` reads the classic USDC balance from Horizon; if the treasury holds USDC as a Soroban SAC balance instead, read it via the SAC `balance(addr)` binding (verify which the M2 treasury uses). `AGENT_SESSION_SECRET` is the session key the AgentPolicy authorizes (foundation §3.5).
- [ ] **Commit:** `feat(repo): demo run-agent step (x402 pay -> plan -> sign -> swap)`

#### Task 10.3h — `scripts/demo/assert-final.ts`
- [ ] **Create** `scripts/demo/assert-final.ts` (exit 1 unless treasury balance changed AND tally revealed):
  ```typescript
  import { readFileSync } from "node:fs";
  import { Client as GovVaultClient } from "@shadowkit/shared/bindings/gov-vault";
  import { env } from "./_env.js";
  const gov = new GovVaultClient({ contractId: env.govVaultId(), rpcUrl: env.rpcUrl(), networkPassphrase: env.networkPassphrase() });
  const view = (await gov.proposal({ id: env.proposalId() })).result;
  if (view.weightedYes === null || view.weightedNo === null) { console.error("tally NOT revealed"); process.exit(1); }
  const { before, after } = JSON.parse(readFileSync(".demo-balances.json", "utf8"));
  if (before === after) { console.error(`treasury did NOT move (USDC stayed ${before})`); process.exit(1); }
  console.log(`final assert OK: tally revealed (yes=${view.weightedYes} no=${view.weightedNo}); treasury ${before} -> ${after}`);
  ```
- [ ] **Commit:** `feat(repo): demo assert-final (treasury moved + tally revealed) step`

#### Task 10.3i — Run the full demo green (local, then testnet, ×2)
- [ ] **Run (GREEN, local net up + deployed):**
  ```bash
  just net-up && just deploy-local    # M0 recipes (writes .env.local incl. the 3 x402 accounts + DEPLOYER_SECRET)
  RUN_DEMO_TEST=1 npx vitest run scripts/demo.test.ts
  ```
  Expected PASS: 2 passing (`runs green and prints DEMO OK`, `runs green a SECOND time`).
- [ ] **Run on TESTNET (manual, the M6 primary deliverable):**
  ```bash
  bash scripts/deploy-testnet.sh
  bash scripts/demo.sh --network testnet
  ```
  Expected: ends with `DEMO OK (testnet)`. Run it a SECOND time to prove repeatability.
- [ ] **Commit:** `feat(repo): full e2e demo loop green on local + testnet`

---

## 11. Polish docs (README + threat model + presentation)

### Task 11.1 — README

- [ ] **Create** `docs/README.md` with: one-paragraph product pitch (spec §1); architecture diagram (spec §6 ASCII); the M0–M6 build order table (spec §11); **run instructions** (`just net-up`, `just deploy-local`, `just test`, `just demo`, `bash scripts/deploy-testnet.sh && bash scripts/demo.sh --network testnet`); the two x402 directions explained (who pays whom); passkey vs keypair; SWAP_VENUE config; and a "Fallbacks" subsection listing each config switch (`X402_DIRECTION`, `WALLET_MODE`, `SWAP_VENUE`, `REVEAL_MODE`, `offchain-verify`, `handrolled`) with the command to run its test suite. Include the hackathon-grade/unaudited disclosure (spec §12).
- [ ] **Verify** every command in the README actually runs (copy-paste each into a shell). Fix any that fail.
- [ ] **Commit:** `docs: project README with run instructions + fallbacks`

### Task 11.2 — Threat model

- [ ] **Create** `docs/threat-model.md` materializing spec §7 verbatim-structured: (1) what is hidden, from whom (incl. sealed-until-close tally); (2) privacy technology (Groth16/BLS12-381 on-chain verify, nullifier, Poseidon Merkle, tlock/drand); (3) adversaries + guarantees + assumptions + residual risk; and the Hack Agentic section (what the agent does autonomously, the 5-gate AgentPolicy lock, why Stellar). Add a "Trusted setup" note (spec §12) and the residual-risk table.
- [ ] **Commit:** `docs: threat model (Hack Privacy + Hack Agentic)`

### Task 11.3 — Presentation outline

- [ ] **Create** `docs/presentation-outline.md`: slide-by-slide (Problem → Solution → Live demo loop (the 7 steps from spec §6) → Privacy story (sealed-until-close) → Agentic story (the on-chain lock) → x402 both directions → Why Stellar → Tracks alignment (spec §3) → Ask). Each slide = title + 2-4 bullets + the demo command to run live.
- [ ] **Commit:** `docs: presentation outline`

---

## 12. Final verification (charter rule 1 + 2 + 3) — DO NOT SKIP

Run EVERYTHING and confirm green. The milestone is incomplete unless every command below passes (charter rules 1–4).

- [ ] **Primary, full test suite (3-account x402 env loaded):**
  ```bash
  node --experimental-strip-types scripts/x402-bootstrap.ts   # once, if .env.x402 not present (Task 3.1b)
  set -a; . ./.env.x402; set +a                                # CLIENT_SECRET/FACILITATOR_SECRET/RESOURCE_SERVER_ADDRESS
  just test
  ```
  Expected: all rust + ts + circuit + x402 + M6 fallback suites pass; 0 failures, 0 unjustified skips. (The REAL-x402 suites require the CLIENT to hold testnet USDC — Circle faucet or `X402_USDC_FUNDER_SECRET`; otherwise they SKIP with the documented justification.)
- [ ] **M6 primary x402 (both directions), explicit:**
  ```bash
  set -a; . ./.env.x402; set +a
  npx vitest run x402-services/shared-x402 x402-services/premium-data x402-services/shadowkit-api agent/test/dataClient.test.ts
  ```
  Expected: `roundtrip` (2), premium-data market (2) + server (2) + onedir (2), shadowkit-api gating (2) + server (4) + onedir (2), DataClient (2) — all PASS. (The `gating.integration.test.ts` runs only when `APPROVED_PROPOSAL_ID`/`REJECTED_PROPOSAL_ID` + a deployed GovVault are present — see Task 5.5; it is part of the e2e stage below.)
- [ ] **M6 fallbacks, explicit (each must pass):**
  ```bash
  just test-fallbacks-m6
  ```
  Expected: one-direction (premium-data still 402; shadowkit-api ungated 200 + still gates 403), keypair-login passkey test green under `WALLET_MODE=keypair`, Soroswap adapter rust tests green, SWAP_VENUE selector green.
- [ ] **Passkey path:** `npx vitest run web/test/passkey.test.ts web/test/connectbar.test.tsx` → all pass.
- [ ] **E2E local (twice = repeatable):**
  ```bash
  just net-up && just deploy-local && RUN_DEMO_TEST=1 npx vitest run scripts/demo.test.ts
  ```
  Expected: 2 passing (both runs print `DEMO OK (local)`).
- [ ] **Provider-gate integration (real GovVault, Task 5.5):**
  ```bash
  GOV_VAULT_ID=$GOV_VAULT_ID RPC_URL=$RPC_URL APPROVED_PROPOSAL_ID=1 REJECTED_PROPOSAL_ID=2 \
    npx vitest run x402-services/shadowkit-api/test/gating.integration.test.ts
  ```
  Expected: 2 passing (real Approved → 200; real not-approved → 403) — `defaultReadApproved` exercised end to end.
- [ ] **E2E testnet (the M6 hero deliverable, run twice):**
  ```bash
  bash scripts/deploy-testnet.sh && bash scripts/demo.sh --network testnet && bash scripts/demo.sh --network testnet
  ```
  Expected: two `DEMO OK (testnet)` lines. (deploy-testnet.sh provisions the 3 x402 accounts + USDC trustlines + payer USDC; the CLIENT must hold Circle-faucet USDC or `X402_USDC_FUNDER_SECRET` must be set, foundation §3.6a.)
- [ ] **No-cheating audit (charter rule 4 / foundation §7.2):**
  ```bash
  grep -rn -E "#\[ignore\]|\.skip\(|\.only\(|it\.todo|xfail|assert!\(true\)|expect\(true\)\.toBe\(true\)" \
    x402-services agent/src agent/test web/src web/test contracts/swap-venue scripts || echo "no unjustified cheats"
  ```
  Expected: every hit (the `describe.skip` env-gated suites — keyed on `loadX402Accounts()` for REAL-x402 and on `GOV_VAULT_ID`/`APPROVED_PROPOSAL_ID` for the gate integration — plus the `RUN_DEMO_TEST` gate) is on a line with a `// JUSTIFICATION (charter rule 4): ...` comment immediately above or referenced. No bare skips.
- [ ] **Commit:** `chore(repo): M6 final verification — all suites green`
- [ ] **Finish the branch** per `superpowers:finishing-a-development-branch` (offer merge/PR; do not push unless the user asks). PR body footer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## 13. Fallback ladder summary (config-selectable, each TESTED)

| Concern | PRIMARY (default, must pass alone) | FALLBACK (config switch) | Fallback test |
|---|---|---|---|
| x402 direction | both (`X402_DIRECTION=both`) — agent pays premium-data AND shadowkit-api charges callers | `X402_DIRECTION=agent-pays-only` — shadowkit-api UNGATED | `x402-services/shadowkit-api/test/onedir.test.ts`, `.../premium-data/test/onedir.test.ts` |
| Login | passkey/WebAuthn (`WALLET_MODE=passkey`) | `WALLET_MODE=keypair` — Ed25519 keypair | `web/test/passkey.test.ts` (keypair case) |
| Swap venue | Soroswap adapter (`SWAP_VENUE=soroswap`) | `SWAP_VENUE=fallback` — FallbackAMM (M1) | the embedded `#[cfg(test)] mod test` in `contracts/swap-venue/src/soroswap_adapter.rs` (live-router tests appended in Task 8.1) + `agent/test/swapVenueSelect.test.ts` |

These are M6-scoped. The M4/M5 fallbacks (off-chain verify `offchain-verify`, hand-rolled `handrolled`, coordinator commit-reveal `REVEAL_MODE=coordinator`, weight-unlinked, 1p1v) are owned by their plans and re-run by `just test`'s `test-fallbacks` target (M4/M5), not duplicated here (DRY).

---

## 14. Task index (for `subagent-driven-development`)

1. **2.1** API verification gate (install + verify x402 imports + facilitator router + smart-account-kit constructor)
2. **3.1, 3.1b, 3.2–3.3** `@shadowkit/x402-shared` scaffold + 3-account bootstrap/fixtures + REAL round-trip (facilitator via `createFacilitatorRouter`)
3. **4.1–4.4** premium-data service (agent pays) + market + 402/200 (3 accounts) + never-leak negative
4. **5.1–5.5** shadowkit-api service (sells) + gating + 402/200/403 + agent kick + one-direction ungating + REAL-GovVault integration
5. **6.1–6.2** agent DataClient = real x402 payer (3 accounts)
6. **7.1–7.3** passkey (null-return contract) + keypair `connect()` + ConnectBar
7. **8.0–8.3** Soroswap adapter (verify→test→impl) + SWAP_VENUE selector
8. **9.1–9.2** justfile recipes + `.env.example`
9. **10.1, 10.2, 10.3a–10.3i** testnet deploy script (+ x402 bootstrap, no `|| true` masks) + demo script + per-helper demo steps + green local/testnet ×2
10. **11.1–11.3** README + threat model + presentation outline
11. **12** final verification (everything green, twice on testnet, no-cheat audit)

Each numbered sub-task is a single red→green→commit cycle (or a single verify/scaffold/doc action). Do them in order; do not batch.

---

*End of M6 plan. Every signature used here is defined in `00-foundation-interfaces.md` (§ cited inline) or in a task above. Re-verify external APIs (charter rule 5) at execution time against the installed packages; if any differ, update the foundation first, then this plan.*
