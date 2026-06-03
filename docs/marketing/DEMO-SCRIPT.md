# ShadowKit — Demo Script & Judge Talking Points

**Live:** https://shadowkit.pages.dev · **Network:** Stellar testnet · **Tracks:** Main · Hack Privacy · Hack Agentic

---

## The one-liner

> **ShadowKit lets a DAO vote in the shadows and execute in the light** — members vote with zero-knowledge proofs, the tally stays timelock-sealed until close so whales can't manipulate it, then an LLM-bounded AI agent executes the approved action on-chain inside a policy it mathematically cannot break.

## The 60-second demo

**[0:00 — The problem]**
"DAOs have two problems. Voting is public, so whales watch the tally and vote last — and members self-censor. And 'let an AI run the treasury' is terrifying, because a hallucinating agent can move real funds. ShadowKit fixes both."

**[0:10 — ShadowFund (Privacy), `/demo/fund`]**
"This is a community-fund round. I click **Start voting session** — that mints a fresh proposal on testnet. I connect my wallet and vote. Watch the steps: snarkjs builds a **real Groth16 proof in my browser** — it proves I'm an eligible member without revealing who I am, my weight, or my direction. Then the vote is **timelock-encrypted to a future drand round**. On-chain, the tally reads back as *null* — nobody, not even the contract, can see which way it's going. No whale manipulation."

**[0:30 — Reveal]**
"When the deadline passes, the drand beacon drops, every sealed vote decrypts at once, and `close_and_reveal` aggregates the weighted tally on-chain → **Approved**. Shadow becomes light."

**[0:38 — AgentBoard (Agentic), `/demo/agent`]**
"Now the agent. I click **Run the agent**. Server-side: it reads the approved proposal, pays for market data over **x402**, asks **Gemini** for a bounded plan, and — critically — that plan must pass an **on-chain policy** that runs inside the treasury wallet's own authorization check. The policy only ever authorizes *swap, on the approved venue, with the approved asset, under the approved cap*. A hallucinated or over-cap plan is **BLOCKED** — no transaction. This one's allowed, so it submits the swap on-chain: **real tx, real balance movement**, and the proposal flips to Executed. Single-shot."

**[0:58 — Close]**
"Vote in the shadows. Execute in the light. Every contract is live on Stellar testnet — links in the footer."

## Why it's novel (judge talking points)

- **On-chain ZK on Stellar.** Groth16 over BLS12-381 (CAP-0059) verified *on-chain* in a Soroban contract — not an off-chain check. Public signals `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]`; nullifier prevents double-voting while keeping the voter anonymous.
- **Timelock-sealed tally.** Each vote's (weight, direction) is tlock-encrypted to a future drand round. The chain stores only ciphertext + a commitment; `weighted_yes/no` is literally unreadable until the deadline. This kills last-mover/whale manipulation — a real governance problem.
- **Bounded autonomy, enforced on-chain.** The agent has exactly two degrees of freedom (amount, slippage floor) and both are bounded. The OZ smart-account `AgentPolicy` cross-reads GovVault during the treasury's `__check_auth` — so the *only* call it will ever sign is the approved swap. Defense in depth: a fail-fast policy mirror + the on-chain policy + single-shot `mark_executed`.
- **It's infrastructure, not a one-off.** Four SDK packages + five contracts + a circuit. The two demos are the showroom; any Stellar project can drop in private voting + bounded agent execution.
- **Genuinely live.** No mocks, no replay. Real proofs, real drand beacons, real Gemini calls, real on-chain swaps — all verifiable on Stellar Explorer.

## Proof points (have these tabs open)

- Live site: https://shadowkit.pages.dev
- GovVault on Explorer: https://stellar.expert/explorer/testnet/contract/CDYNOYGSY3JKLKDC5OWUNVKB3W4YAB7DIKELI7GCSJBFE7TYH3WDWTX5
- A real agent swap tx: `b73cfa65ac1b708fb2b3ff65bf51cb41191dd67cdc88b53fefe0ad95aa7071c2`
- mark_executed tx: `206d6e2e892c6bc264c089a6e993b76f12dbd267b6fa25e772a3ba89c63b065b`
- Repo: https://github.com/Batuhan4/shadowKit

## Likely questions & crisp answers

- **"Is the ZK real or simulated?"** Real. snarkjs generates a Groth16 proof in the browser; the Soroban `groth16-verifier` checks the pairing on-chain. Tampered proofs fail (`InvalidProof`); the public-signal order is binding.
- **"How is the tally actually hidden?"** tlock/drand timelock encryption to a future round. We read `proposal(id)` before close on the demo and `weighted_yes/no` is `null` — provably sealed.
- **"What stops the agent going rogue?"** The on-chain `AgentPolicy` inside the treasury's auth check. It rejects wrong target, wrong asset, over-cap, unapproved output, multi-call, and not-approved. We can demo the BLOCKED path live (over-cap plan → no tx).
- **"x402?"** Both directions: the agent pays the site's premium-data endpoint over x402 to fetch its market quote. (Note: settlement uses the OZ Channels facilitator, which on testnet settles Circle USDC; our demo uses a self-issued test USDC, so the live demo shows the real x402 round-trip and proceeds with a public quote — funding Circle USDC enables full settlement.)
- **"Pre-run setup?"** Each agent run consumes its proposal (single-shot). Re-provision before a run: `SKIP_DEPLOY=1 STOP_AFTER=fund bash scripts/demo.sh --network testnet`.

## Re-provision a fresh demo proposal (before each AgentBoard run)

```bash
SKIP_DEPLOY=1 STOP_AFTER=fund DEMO_DEADLINE_OFFSET=110 bash scripts/demo.sh --network testnet
# prints DEMO_PROPOSAL_ID=<n> ; then:
printf "<n>" | wrangler pages secret put DEMO_PROPOSAL_ID --project-name shadowkit
```
ShadowFund creates its own per-session proposal automatically (the "Start voting session" button), so it needs no manual setup.
