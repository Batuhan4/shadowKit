# ShadowKit

ZK- + AI-powered autonomous governance infrastructure for Stellar. See
`docs/superpowers/specs/2026-06-02-shadowkit-design.md` (design) and
`docs/superpowers/plans/00-foundation-interfaces.md` (binding interfaces).

## Prerequisites
- Rust 1.94.1 (pinned via `rust-toolchain.toml`) + `wasm32v1-none` target
  (`rustup target add wasm32v1-none`).
- `stellar` CLI: `cargo install --locked stellar-cli`.
- `just`: `cargo install --locked just`.
- Node 26 + npm (workspaces). `npm install` at the repo root.
- Docker (for the local Stellar network).

## One-time setup
```bash
rustup target add wasm32v1-none
cargo install --locked stellar-cli just
npm install
cp .env.example .env   # then fill in keys as needed
```

## Build & test everything
```bash
just build    # contracts -> wasm, typecheck every TS package, build web -> dist/index.html
just test     # cargo test --workspace + vitest (TS shared + web under jsdom) + circuit (no-op until M4)
```
> Vitest aggregates packages via the root `vitest.config.ts` `test.projects` (Vitest 4;
> there is no `vitest.workspace.ts`). `just build` does NOT use `tsc -b` — it typechecks
> each package with `tsc --noEmit -p <pkg>` (no root project references needed).

## Local network (Docker)
```bash
just net-up        # start quickstart container + register 'local' network + wait for healthy RPC
just deploy        # build wasm, deploy hello-world, deploy XLM + USDC SACs on local
just e2e           # net-up + deploy + invoke hello (full local loop)
just net-down      # stop the container
```

## Testnet
Both local and testnet use the SAME deploy script, switched by `STELLAR_NETWORK`
(no code fork). Network config lives in `.env.example` (passphrases verified
against stellar-docs 2026-06-02).
```bash
stellar network add testnet \
  --rpc-url "https://soroban-testnet.stellar.org" \
  --network-passphrase "Test SDF Network ; September 2015"
just deploy-testnet   # funds deployer via friendbot, deploys hello-world to testnet
```

## Workspace layout
See `docs/superpowers/plans/00-foundation-interfaces.md` §1. Rust contracts in
`contracts/`, TS libs in `packages/`, agent in `agent/`, x402 in
`x402-services/`, frontend in `web/`, circuit in `circuits/`.

## Milestones
M0 (this) = scaffold + pipeline. M1–M6 build the product (foundation §9). The
`hello-world` contract is a throwaway pipeline proof and is removed at M1.
