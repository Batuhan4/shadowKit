export const meta = {
  name: 'shadowkit-site-build',
  description: 'Build the shadowkit.pages.dev site: landing + ShadowFund + AgentBoard + docs, then integrate green',
  phases: [
    { title: 'Build', detail: 'parallel opus agents: landing, fund, agent, docs' },
    { title: 'Integrate', detail: 'make astro build + vitest green across all pieces' },
  ],
}

// ---------------------------------------------------------------------------
// Shared context every build agent needs (subagents start with ZERO context).
// ---------------------------------------------------------------------------
const SHARED = `
You are building part of the PUBLIC demo site for **ShadowKit** — ZK + AI-agent governance infra on
Stellar/Soroban (Build On Stellar — IBW 2026). The site lives in /home/batuhan4/github/shadowKit/web
(Astro 6.4.2 + @astrojs/react 5, React 19, STATIC output + Cloudflare Pages Functions in web/functions/).

READ FIRST (authoritative): /home/batuhan4/github/shadowKit/docs/superpowers/specs/2026-06-03-shadowkit-demo-site-design.md

THE FOUNDATION ALREADY EXISTS — consume it, DO NOT modify these shared files:
- web/src/layouts/Layout.astro  → import Layout from "<rel>/layouts/Layout.astro"; props {title?, description?}. Renders Nav+Footer+<slot/>.
- web/src/styles/global.css      → brand tokens as CSS vars + utility classes. USE THESE, do not invent new colors.
    colors: --void #0b0b12, --panel, --line, --veil #8b7cff (privacy), --cyan #3de0e6 (agent),
            --gold #f6c453 (reveal), --green #56d98a (success), --ink, --mist (muted), --red.
    classes: .container .btn .btn-primary .btn-ghost .card .badge(.badge-veil/cyan/gold/green)
             .gradient-text .eyebrow .mono .sealed .reveal-up ; fonts: --font-display (Space Grotesk),
             --font-mono (JetBrains Mono), --font-body (Cantarell). Theme = dark "shadow → reveal".
- web/src/lib/config.ts          → import { CONFIG, explorerTx, explorerContract, explorerAccount, short } from "<rel>/lib/config.ts".
    CONFIG has LIVE testnet ids: govVaultId, verifierId, usdcId, wxlmId, ammId, agentPolicyId,
    treasuryAddr, deployerAddr, merkleRoot, rpcUrl, networkPassphrase ("Test SDF Network ; September 2015"),
    explorerBase (stellar.expert testnet). Use these — the contracts are DEPLOYED & LIVE on testnet.
- web/functions/api/config.ts    → example Pages Function (file-based routing: web/functions/api/X.ts → /api/X).
- ZK proving artifacts are served at /zk/vote.wasm, /zk/vote_final.zkey, /zk/verification_key.json.

CHARTER (hard rules — the user is strict): TDD (write failing test → implement → pass); test EVERYTHING
relevant to your piece (unit + component + negative); NO cheating (no .skip/.only, no always-true asserts,
no mocking-away the unit under test, real crypto where applicable); the demos are FULLY LIVE on testnet
with NO replay fallback. Distinctive, production-grade design (no generic AI-slop; honor the brand).

RULES TO AVOID CONFLICTS (other agents work in parallel):
- Create ONLY the files listed in YOUR task. Do NOT edit Layout/Nav/Footer/global.css/config.ts/package.json/astro.config.
- Do NOT run "npm install" (all deps present: @creit.tech/stellar-wallets-kit, snarkjs, tlock-js,
  drand-client, @google/genai, @stellar/stellar-sdk via @shadowkit/shared). If you truly need a new dep,
  DO NOT install it — list it in depsNeeded and code as if present.
- Do NOT run the full "astro build" or bare "vitest run" (you'd hit other agents' in-progress files).
  Run ONLY your own tests, scoped by path, e.g.  npx vitest run src/components/<your-dir>
- Commit nothing. The controller commits.
Return the structured result via the StructuredOutput tool.
`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['piece', 'filesCreated', 'depsNeeded', 'testStatus', 'integrationNotes'],
  properties: {
    piece: { type: 'string' },
    filesCreated: { type: 'array', items: { type: 'string' } },
    depsNeeded: { type: 'array', items: { type: 'string' }, description: 'npm packages you needed but did NOT install' },
    testStatus: { type: 'string', description: 'what tests you wrote + their pass/fail result' },
    integrationNotes: { type: 'string', description: 'anything the controller must do to wire/deploy this (routes, secrets, env, gotchas)' },
  },
}

// ---------------------------------------------------------------------------
phase('Build')

const landing = () => agent(`${SHARED}

YOUR PIECE: the LANDING PAGE ("/"). Make it unforgettable — this is the front door.
Files you OWN (create/overwrite only these):
- web/src/pages/index.astro  (currently a minimal placeholder hero — REPLACE with the full landing)
- web/src/components/landing/*.astro  (any section components you split out)
- web/src/components/landing/*.test.ts(x) if you add testable logic

Build a cinematic single page (Astro-first, minimal JS) with these sections, all on-brand
(dark shadow→reveal, violet→cyan, gold for the unseal moment, JetBrains Mono for hashes):
1. HERO: tagline "Vote in the shadows. Execute in the light.", subcopy, two CTAs
   (→ /demo/fund primary, → /demo/agent ghost), a live "GovVault {short id}" testnet badge.
   Staggered .reveal-up load animation. An "octagon Seal" motif.
2. THE STORY (signature visual): the shadow→reveal pipeline as 4 stages —
   Sealed vote (ZK) → Timelocked tally (drand) → Reveal (gold flash) → Agent executes on-chain.
   Make this a striking horizontal/diagonal flow with the brand colors.
3. THREE CARDS linking the demos + docs: "Private Voting" (veil), "AI AgentBoard" (cyan), "SDK & Docs".
4. HOW IT WORKS: 4 concise numbered steps (snapshot → sealed ZK vote → timelock reveal → policy-gated agent swap).
5. TRACKS: badges for "Hack Privacy" + "Hack Agentic" with one line each.
6. LIVE ON TESTNET strip: show 3-4 real CONFIG contract ids as explorerContract links (mono).
7. Final CTA + it inherits the Footer from Layout.
Use the .container width, generous spacing, real copy (no lorem). Respect prefers-reduced-motion.
Wrap the page in Layout with a good <title>/description. Quality bar: distinctive, not generic.
`, { label: 'build:landing', phase: 'Build', model: 'opus', schema: SCHEMA })

const fund = () => agent(`${SHARED}

YOUR PIECE: ShadowFund — the PRIVATE VOTING demo at "/demo/fund". This is the Hack-Privacy showcase
and the hardest piece. It must do REAL client-side zero-knowledge proving + REAL timelock sealing +
REAL on-chain submission to the LIVE testnet GovVault. NO mocks on the live path.

STUDY THESE REFERENCES THOROUGHLY before coding (they contain the exact, working logic to PORT to the browser):
- packages/zk-prover/src/index.ts   → generateVoteProof(): the snarkjs fullProve call, the circuit input
   shape, and the PUBLIC SIGNAL BINDING ORDER. CRITICAL: on-chain order is
   [merkleRoot, nullifier, proposalId, sealedCommitmentHash]; snarkjs NATIVE order is
   [nullifier, merkleRoot, proposalId, sealedCommitmentHash]. Match what cast_vote expects.
- packages/zk-prover/src/seal.ts + drandConfig.ts → timelockSealVote/Unseal, roundForDeadline, DEFAULT_DRAND (quicknet).
- packages/shared/src/ (types + the gov-vault binding) → cast_vote(proposalId, proof, public_signals, sealed_ciphertext)
   and close_and_reveal(...) signatures + how proof/public_signals are encoded for Soroban.
- scripts/demo/_holders.ts, compute-root.ts, gen-sealed-votes.ts, reveal-tally.ts → the demo snapshot
   members (secret/weight), the Merkle tree/paths, the sealed-vote generation, and the reveal aggregation.
   The site's MERKLE ROOT is CONFIG.merkleRoot (proofs MUST be for THIS snapshot).

Files you OWN:
- web/src/pages/demo/fund.astro
- web/src/components/fund/*.tsx   (React islands: e.g. WalletConnect, FundProjectGrid, SealedVoteFlow, RevealStage)
- web/src/lib/voteClient.ts       (browser port: build circuit input for a snapshot member → snarkjs.groth16.fullProve
                                    using fetched /zk/vote.wasm + /zk/vote_final.zkey → proof+publicSignals;
                                    tlock-seal the (weight,direction); compute sealedCommitmentHash; remap to the
                                    on-chain public-signal order; build+submit cast_vote via @stellar/stellar-sdk.)
- web/src/lib/snapshot.json       (GENERATE from scripts/demo/_holders.ts: the demo voter identities
                                    {secret, weight, merklePath, pathIndices} so the browser can prove membership.
                                    These are demo-only secrets — fine to ship.)
- web/src/components/fund/*.test.tsx + web/src/lib/voteClient.test.ts (TDD)

UX FLOW (SCF-styled, like communityfund.stellar.org but on-brand dark): a grid of 4-5 candidate
community-fund PROJECTS (name, ask in USDC, category, short blurb, "N votes sealed" counter — the counter
shows COUNT only, never the tally). User connects a Stellar wallet (Stellar Wallets Kit; testnet). User
picks a project + YES/NO weighted vote → "SealedVoteFlow" shows live steps: (1) building ZK proof
(real snarkjs), (2) timelock-sealing (real tlock/drand), (3) submitting cast_vote on-chain (real tx, show
explorer link). The running tally stays SEALED/blurred (.sealed) with copy "Tally hidden until close —
whales can't see which way it's going." A "Close & Reveal" action runs the tlock reveal → close_and_reveal
on-chain → animated unseal (gold flash) → winner project + the USDC pool result, with explorer links.

TESTING: real round-trip unit tests for voteClient (real snarkjs proof for a snapshot member using the
artifacts, real tlock seal/unseal, assert public-signal binding order + that verification passes) and
component tests (render states; proof step can be stubbed at the component layer ONLY, never in the
voteClient unit test). Run: npx vitest run src/lib/voteClient.test.ts src/components/fund
NOTE for controller in integrationNotes: which wallet pays fees (connected wallet vs a relayer), and any
RPC/CORS caveat for submitting from the browser to ${'`'}CONFIG.rpcUrl${'`'}.
`, { label: 'build:fund', phase: 'Build', model: 'opus', schema: SCHEMA })

const agentDemo = () => agent(`${SHARED}

YOUR PIECE: AgentBoard — the LIVE AI-AGENT demo at "/demo/agent". This is the Hack-Agentic showcase.
The agent loop runs server-side in a Cloudflare Pages Function (nodejs_compat) so the Gemini key + the
executor signing key never reach the browser. It must be GENUINELY LIVE on testnet.

STUDY THESE REFERENCES (port the loop to the Worker runtime; prefer fetch-based, avoid Node-only fs/temp):
- agent/src/ (planner.ts: GeminiPlanner using @google/genai model "gemini-3.1-flash-lite", responseSchema
   structured output, + DeterministicPlanner; executor.ts: builds+submits the swap; policy guard;
   dataClient.ts: x402 paid premium-data; agentRunner.ts: the orchestration + cap-guard).
- x402-services/ (premium-data + shadowkit-api + shared-x402: the x402 charge/pay flow).
- contracts/gov-vault (read whether a proposal is APPROVED/executed; mark_executed auth on the executor)
   and contracts/agent-policy (the policy that gates the swap). packages/shared bindings.
- The LIVE ids are in CONFIG (govVaultId, ammId, usdcId, wxlmId, agentPolicyId, treasuryAddr).

Files you OWN:
- web/src/pages/demo/agent.astro
- web/src/components/agent/*.tsx  (AgentRunPanel; you MAY reuse web/src/components/AgentBoardTerminal.tsx — read it, do NOT edit it)
- web/functions/api/agent/execute.ts   (POST → Server-Sent Events stream. Steps, each emitted as an SSE log line:
    1) read GovVault: is the demo proposal APPROVED? (if not → 403 + clear message)
    2) x402-pay the premium-data endpoint and fetch the market quote
    3) Gemini bounded PLAN (key from env GEMINI_API_KEY) → structured {action, venue, amountIn, minOut, reason}
    4) POLICY GATE the plan (reject hallucinated/over-cap plans → emit "BLOCKED by policy", NO tx)
    5) submit the swap on-chain signed by EXECUTOR_SECRET (env) → emit real tx hash + explorer link + before/after balances
    Emit a final {done:true} event.)
- web/functions/api/premium-data.ts   (x402-charged GET returning the quote — proves x402 INBOUND)
- web/functions/api/_lib/*.ts         (shared worker helpers: stellar client, gemini, policy, sse)
- tests: web/functions/**/*.test.ts (unit-test the handler logic with vitest: HAPPY path + NEGATIVES —
   proposal not approved → 403; Gemini plan violates policy → blocked, zero txs; payment missing → 402.
   Mock ONLY the network boundary (RPC/Gemini/x402) with recorded responses; never mock the policy/logic under test.)
Run: npx vitest run web/functions  (or your test paths)

UX: a terminal-style panel (brand colors; cyan = agent) that POSTs to /api/agent/execute and streams the
log live (reuse AgentBoardTerminal styling). Show the plan, the policy verdict (green = allowed / red =
blocked), the tx hash (explorer link), and before/after treasury balances. Include a "what is bounded
execution" explainer. Page wrapped in Layout.
integrationNotes MUST list: the exact env secrets needed (GEMINI_API_KEY, EXECUTOR_SECRET, any X402_*),
the demo proposal id used, and whether the proposal must be pre-approved on-chain for the demo to run
(and how the controller should approve it).
`, { label: 'build:agent', phase: 'Build', model: 'opus', schema: SCHEMA })

const docs = () => agent(`${SHARED}

YOUR PIECE: the SDK DOCS at "/docs" (and sub-pages). Brand-consistent, NOT Starlight — build a clean,
custom docs section so it matches the site exactly. This documents the REAL ShadowKit SDK.

STUDY: README.md, the spec, docs/superpowers/plans/00-foundation-interfaces.md, packages/* (shared,
zk-prover, snapshot-tool, tally-reveal), contracts/* (gov-vault, groth16-verifier, agent-policy,
fallback-amm, swap-venue), circuits/vote, agent/, x402-services/. Document what ACTUALLY exists.

Files you OWN:
- web/src/layouts/DocsLayout.astro     (docs shell: sticky sidebar nav + content column + on-brand; wraps Layout)
- web/src/pages/docs/index.astro       (overview / quickstart)
- web/src/pages/docs/*.astro           (pages: architecture, packages (the 4 npm pkgs + APIs), contracts
                                        (with the LIVE testnet ids from CONFIG as explorer links), circuits
                                        (the vote circuit + public-signal order), agent (planner/policy/executor),
                                        x402, sealed-voting-flow). Use MDX/astro + on-brand code blocks (JetBrains Mono).
- web/src/components/docs/*.astro       (e.g. CodeBlock, Callout, ApiTable)
- tests only if you add testable TS helpers.
Content quality: accurate, concise, developer-grade. Include real install snippets, real contract
addresses (from CONFIG), real function signatures (from the bindings/contracts). Cross-link pages in the sidebar.
Run only your own tests if any: npx vitest run src/components/docs
`, { label: 'build:docs', phase: 'Build', model: 'opus', schema: SCHEMA })

const results = await parallel([landing, fund, agentDemo, docs])
const built = results.filter(Boolean)
log(`Build phase done: ${built.length}/4 pieces. depsNeeded: ${JSON.stringify(built.flatMap(r => r.depsNeeded || []))}`)

// ---------------------------------------------------------------------------
phase('Integrate')

const integ = await agent(`You are the INTEGRATION engineer for the ShadowKit demo site at
/home/batuhan4/github/shadowKit/web. Four parallel agents just built: the landing page, ShadowFund
(/demo/fund), AgentBoard (/demo/agent + web/functions/api/agent/*), and /docs. Your job: make the WHOLE
thing build and test GREEN, fixing cross-cutting issues, WITHOUT weakening any test or removing real
functionality (charter: no cheating — no .skip/.only, no always-true asserts, no deleting tests to go green).

Here is what each agent reported (filesCreated, depsNeeded, integrationNotes):
${JSON.stringify(built, null, 2)}

DO:
1. If any depsNeeded are listed, run: cd /home/batuhan4/github/shadowKit/web && npm install --save <pkgs>
   (network IS allowed for you; use it only for genuine missing deps).
2. Run: cd /home/batuhan4/github/shadowKit/web && npm run build   → fix every Astro/TS/import error until it exits 0.
   Common fixes: wrong relative import depths (e.g. src/pages/demo/*.astro need ../../layouts/Layout.astro),
   client:load directives missing on interactive React islands, JSON import typing, duplicate component names.
3. Run: cd /home/batuhan4/github/shadowKit/web && npx vitest run   → fix failing tests (fix the CODE, not by gutting tests).
4. Ensure routes resolve: /, /demo/fund, /demo/agent, /docs (+ docs sub-pages). Nav already links these.
5. Verify web/functions/api/* are syntactically valid Worker code (do NOT need them to run here; just compile/typecheck-clean).
6. Keep the design coherent across pages (shared brand). Do NOT redesign; only fix breakage + obvious polish.

Return a concise report: final "npm run build" exit status, final vitest pass/fail counts, any files you
changed, and a CLEAR list of REMAINING items the controller must handle live (e.g. wallet/CORS, worker
secrets, on-chain proposal approval) — quoted from the agents' integrationNotes.`,
  { label: 'integrate', phase: 'Integrate', model: 'opus' })

return { pieces: built, integration: integ }
