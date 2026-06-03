export const meta = {
  name: 'shadowkit-redesign',
  description: 'Restyle demo pages + docs to the "Anonymity Set" design system, preserving all logic',
  phases: [{ title: 'Redesign', detail: 'fund + agent restyle, docs → Starlight (parallel, opus)' }],
}

const SHARED = `
You are restyling part of the ShadowKit site (/home/batuhan4/github/shadowKit/web, Astro 6 + React) to
a NEW, already-approved design system called **"Anonymity Set"**. The colors/direction are LOCKED — do
NOT invent new ones.

READ FIRST (authoritative): /home/batuhan4/github/shadowKit/docs/DESIGN.md
REFERENCE for the look (already approved): /home/batuhan4/github/shadowKit/web/src/pages/index.astro
DESIGN TOKENS + utilities are in /home/batuhan4/github/shadowKit/web/src/styles/global.css:
  colors  --bg #0f0f12, --bg-2, --panel, --line, --line-2, --text #eceae3 (bone), --text-2, --muted,
          --lime #b6f03a (THE one accent — lit mark / signal / action), --on-lime (text on lime), --red.
  type    --font-display/--font-sans = Archivo (800 headlines), --font-mono = JetBrains Mono (labels/hashes).
  utils   .wrap .section .eyebrow .lede .muted .btn(.btn-primary/.btn-ghost) .card .tag(.tag-lime/.tag-ok/.tag-red)
          .ledger/.idx .redact ; the SIGNATURE motif .aset (grid of marks; .m dim, .m.lit lime, .m.you).
VIBE: charcoal + bone + one lime "lit mark"; mathematical, flat (NO gradients/glows/drop-shadow soup),
hairline rules, monospace metadata, BIG type, MINIMAL copy, lots of negative space. The anonymity-set
glyph field (.aset) is the signature — weave it in where it fits (votes as marks, sealed = dim, lit = revealed).

ABSOLUTE RULES:
- PRESERVE ALL LOGIC. Do not change behavior, hooks, state, handlers, effects, imports, data flow, function
  signatures, or the network/contract calls. You are changing PRESENTATION ONLY: JSX/markup structure,
  className usage, and scoped <style>. The demos must keep working exactly as before.
- Keep existing unit tests passing. If a test asserts on a className or visible text you changed, update
  THAT assertion minimally — never weaken a test, never touch logic tests, never add .skip/.only.
- Do NOT run "astro build" (the controller runs the integrated build to avoid dist races). Do NOT run any
  browser test, screenshot, or deploy. Verify ONLY by running your own vitest scope.
- Do NOT edit shared files outside your task (global.css, Layout.astro, Nav.astro, Footer.astro,
  astro.config.mjs unless your task says so, package.json). Do NOT npm install.
- Less text, but CLEAR. This is for a hackathon JURY demo: a viewer must INSTANTLY understand what's
  happening and why it's novel (private ZK voting · sealed tally until close · bounded AI agent that
  can't go off-policy). So cut filler, but DO annotate the key moments — concise labels / one-line
  explainers on each step, a short "what just happened" caption where it helps a non-expert follow along.
  Not a wall of text, not cryptic. Explanatory + elegant.
- Use mono for labels/metadata. Responsive (reflow to 1 column under ~720px; touch targets >= 42px; fluid
  clamp sizes; looks intentional phone → 4K).
Return a short structured summary (files changed, what you restyled, vitest result, any logic you had to
touch + why, anything the controller must wire).
`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['piece', 'filesChanged', 'vitest', 'notes'],
  properties: {
    piece: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    vitest: { type: 'string' },
    notes: { type: 'string' },
  },
}

phase('Redesign')

const fund = () => agent(`${SHARED}

YOUR PIECE: the **ShadowFund** demo at /demo/fund. Restyle it to Anonymity Set, preserving the REAL
client-side ZK voting logic.
Files you own (restyle these; create scoped CSS / small presentational helpers as needed):
- web/src/pages/demo/fund.astro
- web/src/components/fund/FundApp.tsx, FundProjectGrid.tsx, WalletConnect.tsx, SealedVoteFlow.tsx, RevealStage.tsx
- their *.test.tsx (only assertion updates if class/text changed)
DO NOT touch: web/src/lib/voteClient.ts, web/src/lib/snapshot.json, web/src/lib/config.ts (logic/config).
Read them to understand the flow, but the proof/seal/submit/reveal logic stays byte-identical in behavior.

Weave the motif (this demo is the literal anonymity set):
- candidate project cards: clean .card, lime tag, minimal copy, hover border→lime.
- "N votes sealed": render N dim .aset marks (a small glyph field) instead of plain text — the votes are
  indistinguishable marks; never show direction. A freshly cast vote lights one mark (.m.lit) + shows a
  short nullifier hash (mono).
- SealedVoteFlow steps (proof → seal → submit): a clean mono step list with lime ticks; sealed state dim.
- RevealStage: the dim marks resolve into a weighted YES/NO bar (lime) + winner + disbursement link (mono).
- WalletConnect: minimal, mono address, lime connect button.
Keep the live testnet flow intact (it builds a real Groth16 proof + tlock seal + on-chain cast_vote via
the connected wallet, then close_and_reveal). Verify: cd /home/batuhan4/github/shadowKit/web && npx vitest run src/lib/voteClient.test.ts src/components/fund
`, { label: 'fund', phase: 'Redesign', model: 'opus', schema: SCHEMA })

const agentDemo = () => agent(`${SHARED}

YOUR PIECE: the **AgentBoard** demo at /demo/agent. Restyle to Anonymity Set, preserving the LIVE agent
loop (server-side SSE).
Files you own:
- web/src/pages/demo/agent.astro
- web/src/components/agent/AgentRunPanel.tsx  (the run trigger + SSE stream binding — KEEP all fetch/SSE/state logic)
- web/src/components/AgentBoardTerminal.tsx    (the streaming terminal — KEEP its event/append logic; restyle only)
- their *.test.tsx (assertion updates only)
DO NOT touch: web/functions/** (the worker logic).
Design: a clean charcoal console. The terminal is the centerpiece — mono, generous, with lime for
ALLOWED/success/tx-hash, --red for BLOCKED, --muted for steps. Present the 5-stage flow (GOV → X402 →
PLAN → POLICY → CHAIN) as a crisp mono stepper that lights up as events stream. The structured result
panels (Gemini plan / policy verdict / on-chain swap) as clean .card blocks. Minimal explanatory copy
(cut the long paragraphs). Keep the "Run the agent" button (lime) wired to the exact same POST /api/agent/execute
SSE handler. Responsive (stack under 720px). Verify: cd /home/batuhan4/github/shadowKit/web && npx vitest run src/components/agent
`, { label: 'agent', phase: 'Redesign', model: 'opus', schema: SCHEMA })

const docs = () => agent(`${SHARED}

YOUR PIECE: the **/docs** section. Replace the bespoke docs with **Starlight** (@astrojs/starlight@^0.39.2
is ALREADY installed) themed to the Anonymity Set system. This is the one task allowed to edit
web/astro.config.mjs.
Steps:
1. Use ctx7 / find-docs to confirm the CURRENT @astrojs/starlight 0.39 API: the integration config,
   how it routes, content collection setup (src/content/docs/ + content config), customCss theming, and
   how to keep the rest of the Astro site (the landing + /demo/* React pages) working alongside it. Verify,
   do not guess the API.
2. Add starlight() to web/astro.config.mjs. Keep @astrojs/react. Mount the docs so they live under the
   /docs/* path (the site Nav links to /docs). Title "ShadowKit", GitHub social link
   https://github.com/Batuhan4/shadowKit, a sidebar covering: Overview, Architecture, Packages, Contracts,
   Circuits, Agent, x402, Sealed-voting flow.
3. Migrate the REAL content from the existing web/src/pages/docs/*.astro (overview/architecture/packages/
   contracts/circuits/agent/x402/sealed-voting-flow) into Starlight markdown/MDX under src/content/docs/.
   Preserve the substance: entrypoints, errors, the LIVE testnet contract addresses (from
   web/src/lib/contracts.json), function signatures, the public-signal order, the policy gates. Keep it
   accurate. Then REMOVE the old web/src/pages/docs/*.astro + web/src/components/docs/* (now superseded).
4. THEME Starlight to match: a dark-only theme with --bg #0f0f12, bone text #eceae3, --lime #b6f03a accent,
   Archivo (headings/ui) + JetBrains Mono (code), via a Starlight customCss file overriding the Starlight
   CSS variables (--sl-color-accent*, --sl-color-bg*, --sl-color-text*, --sl-font, --sl-font-mono, etc.).
   It should feel like the rest of the site (charcoal + lime), not default-purple Starlight.
Do NOT run astro build (controller integrates). You MAY run a scoped typecheck if helpful, but no browser
test/deploy. In notes, tell the controller exactly what changed in astro.config.mjs + any integration risk
(e.g., route collisions, the content config file) so the controller's integrated build can be fixed fast.
`, { label: 'docs', phase: 'Redesign', model: 'opus', schema: SCHEMA })

const results = (await parallel([fund, agentDemo, docs])).filter(Boolean)
return { pieces: results }
