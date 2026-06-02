# M3 — Claude LLM-Bounded Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.
>
> This plan implements **milestone M3** of ShadowKit. It depends on the binding interfaces in `docs/superpowers/plans/00-foundation-interfaces.md` (the foundation). **Read the foundation first.** Every type, path, package name, and signature below comes from §3.5 (`@shadowkit/agent`), §3.1 (`@shadowkit/shared`), §6 (toolchain/versions), and §7 (testing charter) of the foundation. No type, function, package, or path is invented here that is not defined in some task or in the foundation.

**Goal:** Replace the deterministic executor (M2) with a **Claude LLM planner** that decides *how* to execute the approved swap (`amountIn` / `minOut` — i.e. sizing + slippage floor) strictly within the on-chain proposal cap, streams its reasoning to the `AgentBoardTerminal`, and lets the existing agent execute the resulting plan on-chain. The **client-side cap guard** (defense-in-depth) and the **on-chain backstop** (M2 `AgentPolicy`) both remain. The **deterministic executor (M2 `DeterministicPlanner`) stays as a config-selectable, fully-tested fallback** for when the LLM is unavailable or returns an invalid plan.

> **SCOPE DEVIATION (intentional, recorded — read before reviewing).** The spec (D2 line 44, §7.2(1) line 130) and the M3 milestone row (foundation §9 line 1201) name FOUR execution dimensions for the LLM-bounded agent: **slippage / route / split / timing**. M3 implements **only two of them — sizing (`amountIn`) and slippage floor (`minOut`)** — because the foundation's binding `ActionPlan` type (§3.5: `{ amountIn; minOut; reasoning }`) carries no fields for route, split, or timing, and the unchanged single-shot `Executor.executeSwap(plan, spec, cap, proposalId)` performs exactly ONE swap against ONE configured `swapVenueId` and marks the proposal executed (single-shot idempotency). **Route** is therefore fixed by config (`SWAP_VENUE=fallback|soroswap`, foundation §2.4) not chosen per-plan; **split** (multiple partial fills) is impossible without changing the `Executor`/`ActionPlan`/`AgentPolicy` single-call binding; **timing** is bounded to "execute now, once" by the same single-shot constraint. This is deliberate YAGNI scoping (foundation §14), not an omission. **Where they would be picked up:** split/route/timing would require (a) extending `ActionPlan` to a `legs: ActionPlan[]` shape and (b) relaxing the `AgentPolicy.enforce` single-context `MultiCall` gate (foundation §2.3, `PolicyError::MultiCall = 8`) to permit a bounded batch — both are out of M3's scope and would need a foundation §3.5/§2.3 amendment first. Until then M3's "split/slippage/timing ≤ cap" milestone claim is satisfied as **sizing + slippage ≤ cap**, with route/split/timing fixed by the M2 execution surface.

**Architecture:** `@shadowkit/agent` already defines a `Planner` interface (`plan(spec, cap, market) -> ActionPlan`) with two implementations — `ClaudePlanner` (PRIMARY) and `DeterministicPlanner` (FALLBACK, from M2). M3 makes `ClaudePlanner` real: it calls the Anthropic Messages API (`@anthropic-ai/sdk@0.100.1`) with **structured JSON output** (`output_config.format` + JSON schema) so the model returns a machine-checkable `{amountIn, minOut, reasoning}`, **streaming** so each reasoning token is emitted as an `AgentLog{phase:"plan"}` through the existing `LogBus`, and **prompt caching** on a frozen system prompt that is deliberately sized **above the 4096-token Opus-4.8 minimum** so caching genuinely engages (see the boxed note in Task 2 and the verified 4096-token threshold below — a sub-4096 prefix silently never caches). A pure `validatePlan()` function rejects any over-cap / wrong-target / wrong-asset / malformed plan *before* the executor signs anything. `AgentRunner` selects the planner via `AgentConfig.useDeterministicPlanner` and, on any `ClaudePlanner` failure, **falls back to `DeterministicPlanner` automatically** (logged). Idempotency (single-shot per `proposalId` via `GovVault.mark_executed`) is preserved by the unchanged `Executor`.

**Tech Stack:** TypeScript (ESM, `strict`), Node 26, Vitest 4.1.8. `@anthropic-ai/sdk@0.100.1`, `@stellar/stellar-sdk@15.1.0`. Model: `claude-opus-4-8` (latest; configurable via `AgentConfig`/env). Package: `@shadowkit/agent` (`agent/`). Shared types: `@shadowkit/shared` (`packages/shared/`).

---

## Verification provenance (read before writing API-bearing code)

Every Anthropic-SDK call in this plan was verified on 2026-06-02 against current sources. **Re-verify before any task that calls a new API** (foundation §6 "API VERIFICATION RULE"):

- **`@anthropic-ai/sdk@0.100.1`** (foundation §6 pins this version). Verified via `npx ctx7@latest library "@anthropic-ai/sdk" ...` → `/anthropics/anthropic-sdk-typescript`, then `npx ctx7@latest docs /anthropics/anthropic-sdk-typescript "..."`, plus the bundled `claude-api` skill (`typescript/claude-api/README.md`).
  - **Construct:** `new Anthropic({ apiKey })` (`typescript/claude-api/README.md`).
  - **Create:** `client.messages.create({ model, max_tokens, system, messages, output_config?, thinking?, stream? })`. The `MessageCreateParamsBase` interface (ctx7, `src/resources/messages/messages.ts:2757-3031`) confirms fields: `max_tokens`, `messages`, `model`, `cache_control?`, `output_config?`, `stream?`, `system?: string | Array<TextBlockParam>`, `thinking?`.
  - **Prompt caching:** `system: [{ type: "text", text, cache_control: { type: "ephemeral" } }]` (ctx7 test fixture `messages.test.ts`; `shared/prompt-caching.md`). Verify hits via `response.usage.cache_read_input_tokens` / `cache_creation_input_tokens` (`typescript/claude-api/README.md` "Verifying Cache Hits").
    - **VERIFIED MINIMUM PREFIX (binding constraint for M3):** `shared/prompt-caching.md` minimum-cacheable-prefix table — **Opus 4.8 / 4.7 / 4.6 / 4.5 / Haiku 4.5 = 4096 tokens**; Sonnet 4.6 / Haiku 3.5 / Haiku 3 = 2048; Sonnet 4.5 / 4.1 / 4 / 3.7 = 1024. *"Shorter prefixes silently won't cache even with a marker — no error, just `cache_creation_input_tokens: 0`."* Therefore on `claude-opus-4-8` the cached `SYSTEM_PROMPT` **MUST exceed 4096 tokens** or caching is a guaranteed no-op. Task 2 sizes the prompt above this threshold and asserts the size in `prompt.test.ts`; the live caching test (Task 4) only runs after the threshold is met.
  - **Structured output (non-streaming):** `client.messages.parse({ ..., output_config: { format: jsonSchemaOutputFormat(SCHEMA) } })` → `message.parsed_output` (the SDK schema-validates and populates `parsed_output`). Import `jsonSchemaOutputFormat` from `@anthropic-ai/sdk/helpers/json-schema` (ctx7 `helpers.md` "Usage with JSON Schema"; example prints `message.parsed_output?.primes`). Verified again 2026-06-02 via ctx7 `/anthropics/anthropic-sdk-typescript` "Usage with JSON Schema" + `examples/structured-outputs-raw.ts`.
  - **Streaming:** `client.messages.stream({ ... })` returns a `MessageStream`; `stream.on("text", (delta) => ...)` yields text deltas; `await stream.finalMessage()` returns the complete `Anthropic.Message` (`typescript/claude-api/streaming.md` Best Practices #4/#6; ctx7 `client.messages.stream` returns `MessageStream`). `output_config.format` "Works with: ... streaming" (`shared/tool-use-concepts.md` "Structured Outputs" line 332). **VERIFIED LIMITATION:** the `MessageStream` exposes **no** `parsed_output` accessor (that helper is populated only by `client.messages.parse()`, not by `stream()`) — ctx7 `helpers.md` only shows `parsed_output` on `messages.parse(...)`, and the streaming docs only document `.on("text")` + `.finalMessage()`. The streaming path therefore extracts the structured JSON from the final message's text block (`final.content.find(b => b.type === "text").text` → `JSON.parse`). **This invariant — that the streamed structured-output run lands the schema JSON verbatim in the first text block (no markdown fences, no leading prose, no thinking-block contamination) — is NOT assumed; it is asserted against a REAL streamed call in the live test (Task 4, Step 4.1a) and the captured bytes become the cassette (Task 3).** If the live assertion ever fails, the primary path uses the documented `messages.parse()` `parsed_output` accessor for the authoritative plan and `stream()` solely for reasoning deltas (Task 3 Step 3.3 fallback note).
  - **Model `claude-opus-4-8`:** the latest Opus, 1M context (`shared/models.md`). On Opus 4.8 **`temperature`/`top_p`/`top_k` are removed (400 if sent)** and **`thinking: {type:"enabled", budget_tokens}` is removed (400)** — use `thinking: {type:"adaptive"}` only (`claude-api` SKILL.md "Thinking & Effort"; `shared/error-codes.md` "Model-specific 400s on Opus 4.8 / 4.7"). This plan sends neither sampling params nor `budget_tokens`.
  - **Errors:** typed classes `Anthropic.BadRequestError`, `Anthropic.AuthenticationError`, `Anthropic.RateLimitError`, `Anthropic.APIError` (all extend `APIError`, have `.status`) (`typescript/claude-api/README.md` "Error Handling"; `shared/error-codes.md`).
- **`@shadowkit/agent` interfaces** — foundation §3.5 (binding): `AgentConfig`, `AgentRunner`, `Planner`, `ActionPlan`, `ClaudePlanner`, `DeterministicPlanner`, `MarketData`, `Executor`, `LogBus`.
- **`@shadowkit/shared` types** — foundation §3.1 (binding): `ActionSpec`, `AgentLog`, `AgentLogPhase`.

---

## File Structure

Every file M3 creates or modifies, with its one-line responsibility. Paths and responsibilities match foundation §1 exactly.

| File | Create/Modify | Responsibility (foundation §1 / §3.5) |
|---|---|---|
| `agent/src/planner.ts` | **Modify** | `Planner` interface, `ActionPlan`, `ClaudePlanner` (Claude call → ActionPlan ≤ cap, prompt-cached system prefix >4096 tokens, structured output; streamed reasoning emission added in Task 5), `DeterministicPlanner` (M2 fallback). Adds `ClaudePlannerConfig`/`AnthropicLike` (foundation §3.5 amendment). M3 makes `ClaudePlanner` real. |
| `agent/src/planValidation.ts` | **Create** | Pure `validatePlan(plan, spec, cap)` → rejects over-cap / wrong-target / wrong-asset / malformed plans BEFORE submit. New file under `agent/src/` (foundation §1 lists `agent/src/*`; this is the plan-validation module the charter requires). |
| `agent/src/prompt.ts` | **Create** | Frozen system prompt (>=18,000 chars / >4096 tokens so it actually caches on Opus 4.8) + per-request user message builder + JSON schema for the structured `ActionPlan` output. Stable prefix for prompt caching (foundation §6 prompt-caching). |
| `agent/scripts/record-cassette.mjs` | **Create** | One-off recorder: makes a REAL `claude-opus-4-8` streamed call, asserts the structured JSON is verbatim + in-cap, and writes `anthropic-cassette.json`. NOT part of the build; the ONLY way to produce the cassette (no placeholder). |
| `agent/src/index.ts` | **Modify** | `AgentRunner(cfg, deps?)` (foundation §3.5 amendment) selects planner by `AgentConfig.useDeterministicPlanner`; auto-falls-back `ClaudePlanner → DeterministicPlanner` on failure (logged `phase:"error"`). Adds `GovReader`/`AgentDeps`/`makeGovReader` (reads existing GovVault `cap_of`/`action_of` via the generated binding). |
| `agent/src/logBus.ts` | **(unchanged, used)** | `LogBus.emit/subscribe` — the SSE/terminal source the planner streams into (M2; foundation §3.5). |
| `agent/src/executor.ts` | **(unchanged, used)** | `Executor.executeSwap` — client cap guard + sign + on-chain `AgentPolicy` validate + `mark_executed` idempotency (M2; foundation §3.5). |
| `agent/src/dataClient.ts` | **(unchanged, used)** | `DataClient.fetchMarket` → `MarketData` (M2; foundation §3.5). |
| `agent/src/watcher.ts` | **(unchanged, used)** | `Watcher.waitForApproved` (M2; foundation §3.5). |
| `packages/shared/src/types.ts` | **(unchanged, used)** | `ActionSpec`, `AgentLog`, `AgentLogPhase` (foundation §3.1). |
| `agent/package.json` | **Modify** | Add `@anthropic-ai/sdk` dep + the M3 test scripts (foundation §6 pins version). |
| `agent/test/planValidation.test.ts` | **Create** | Unit + adversarial tests for `validatePlan` (under-cap accept / at-cap accept / over-cap / wrong-target / wrong-asset / malformed). |
| `agent/test/prompt.test.ts` | **Create** | Frozen-prompt tests: schema shape, user-message builder, no volatile data, and the >=4096-token cacheability size assertion. |
| `agent/test/claudePlanner.cap.test.ts` | **Create** | Cassette-realness guards + planner-respects-cap with Anthropic SDK **network-stubbed** (deterministic); cap-guard + under-cap/at-cap/over-cap exercised. |
| `agent/test/claudePlanner.stream.test.ts` | **Create** | Reasoning stream rendered: streamed deltas surface as `AgentLog{phase:"plan"}` via `LogBus`. |
| `agent/test/claudePlanner.live.test.ts` | **Create** | **REAL Anthropic SDK** call (env-gated `RUN_LIVE_LLM=1`) → valid in-cap schema-conforming `ActionPlan` (charter rule 2 — primary works on its own). |
| `agent/test/deterministicPlanner.test.ts` | **Create/extend** | Fallback planner suite: `amountIn=cap`, `minOut` from market − slippage, no LLM. |
| `agent/test/agentRunner.fallback.test.ts` | **Create** | `AgentRunner` picks planner by config; auto-falls-back to deterministic on `ClaudePlanner` failure; idempotency preserved (executor stub asserts single `mark_executed`). |
| `agent/test/fixtures/anthropic-cassette.json` | **Create** | Committed recorded Anthropic streaming SSE response (replayed by the cap + stream tests — REAL model output captured once, not a hand-faked success). |
| `.env.example` | **Modify** | Document `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `USE_DETERMINISTIC_PLANNER`, `RUN_LIVE_LLM` (foundation §1). |

**No new package or crate names.** Everything lives in `@shadowkit/agent` (`agent/`) and reuses `@shadowkit/shared`.

---

## Binding type definitions used by M3 (from the foundation — do NOT redefine)

These are referenced verbatim throughout; they are **already defined** in `@shadowkit/shared` (foundation §3.1) and `@shadowkit/agent` (foundation §3.5). M3 imports them, never re-declares them.

```typescript
// @shadowkit/shared (packages/shared/src/types.ts) — foundation §3.1
export interface ActionSpec {
  kind: "swap";
  assetIn: string;   // C... strkey
  assetOut: string;
  amount: string;    // i128 decimal string
  minOut: string;    // i128 decimal string
}
export type AgentLogPhase = "reveal" | "data" | "plan" | "sign" | "submit" | "done" | "error";
export interface AgentLog { ts: number; phase: AgentLogPhase; message: string; txHash?: string; }

// @shadowkit/agent (agent/src/planner.ts + index.ts) — foundation §3.5 (incl. the M3 amendment)
export interface MarketData { pair: string; price: string; signal: "buy" | "sell" | "hold"; }
export interface ActionPlan { amountIn: string; minOut: string; reasoning: string; }
export interface Planner { plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan>; }

// --- M3 amendment to foundation §3.5 (added to the foundation FIRST; see box below) ---
export interface AnthropicLike {
  messages: {
    stream(args: unknown): {
      on(event: "text", cb: (delta: string) => void): unknown;
      finalMessage(): Promise<{ content: Array<{ type: string; text?: string }>; usage?: unknown }>;
    };
  };
}
export interface ClaudePlannerConfig { apiKey: string; model: string; client?: AnthropicLike; logBus?: LogBus; }
export class ClaudePlanner implements Planner { constructor(cfg: ClaudePlannerConfig); plan(...): Promise<ActionPlan>; }
export class DeterministicPlanner implements Planner { constructor(cfg?: { slippageBps?: number }); plan(...): Promise<ActionPlan>; }

export interface GovReader { capOf(proposalId: number): Promise<string>; actionOf(proposalId: number): Promise<ActionSpec>; }
export interface AgentDeps {
  watcher: { waitForApproved(proposalId: number, pollMs?: number): Promise<void> };
  dataClient: { fetchMarket(pair: string): Promise<MarketData> };
  govReader: GovReader;
  executor: { executeSwap(plan: ActionPlan, spec: ActionSpec, cap: string, proposalId: number): Promise<{ txHash: string }> };
  makeClaudePlanner(logBus: LogBus): Planner;
  makeDeterministicPlanner(): Planner;
}
// AgentRunner ctor (M3 amendment): constructor(cfg: AgentConfig, deps?: AgentDeps)
```

> **i128-as-string discipline (foundation §5):** every amount/cap/price crosses the boundary as a **decimal string**, never JS `number`. M3 comparisons use **`BigInt`**, never `parseFloat`. This is load-bearing for the cap guard (a `number` would silently lose precision on a 15k-USDC×10^7-stroop value).

---

## Foundation amendment (ratified before M3 relies on it)

> The foundation's §0 preamble is binding: *"If a plan needs a signature not in this document, it must be added here first (and that change rippled to dependent plans)."* M3 needed three signatures that were not in the original §3.5. **They have been added to `docs/superpowers/plans/00-foundation-interfaces.md` §3.5 (see the "M3 AMENDMENT" box there) BEFORE this plan relies on them.** Summary of the ratified change:

| Amendment | Original (§3.5) | M3-ratified (§3.5) | Backward-compatible? |
|---|---|---|---|
| `AgentRunner` ctor | `constructor(cfg: AgentConfig)` | `constructor(cfg: AgentConfig, deps?: AgentDeps)` | Yes — `deps` optional; omitting it = original behavior. |
| `ClaudePlanner` ctor | `constructor(cfg: { apiKey: string; model: string })` | `constructor(cfg: ClaudePlannerConfig)` where `ClaudePlannerConfig = { apiKey; model; client?: AnthropicLike; logBus?: LogBus }` | Yes — superset; `{apiKey, model}` still type-checks. |
| New interfaces | — | `AgentDeps`, `GovReader`, `AnthropicLike`, `ClaudePlannerConfig` (all `@shadowkit/agent`) | New names, no collision. |

> `GovReader.capOf`/`actionOf` are TS read-adapters over the **existing** GovVault `cap_of`/`action_of` entrypoints (foundation §2.2) — **no new contract method is invented** (this resolves the earlier "M2 helper not in the foundation" gap: `makeGovReader` is now the named factory that returns a `GovReader`, and its only on-chain surface is the generated GovVault binding from `@shadowkit/shared/bindings`, foundation §1). No milestone plan other than M3 references the amended signatures, so the ripple is limited to this plan.

---

## Task 0 — Add the Anthropic SDK dependency and M3 test scripts

**Goal:** Get `@anthropic-ai/sdk@0.100.1` installed and wire the M3 test commands into `agent/package.json`. No new behavior yet — this is the build prerequisite for every later task.

**Files:**
- Modify: `agent/package.json` (deps + scripts)
- (Reads) `package.json` (npm workspace root — already lists `agent` per foundation §1)

### Step 0.1 — Confirm the pinned version is the published latest-compatible one

- [ ] Run the version check (foundation §6 pins `0.100.1`; re-confirm it exists):

```bash
npm view @anthropic-ai/sdk@0.100.1 version
```

Expected output:
```
0.100.1
```

If npm reports "No match found", STOP and reconcile with the foundation maintainer (the pinned version is binding; do not silently bump it).

### Step 0.2 — Read the current `agent/package.json`

- [ ] Read `agent/package.json` to see the M2 baseline (it already has `@stellar/stellar-sdk`, `@shadowkit/shared`, `vitest`, and `"type":"module"` per foundation §1/§6). You must Read it before editing.

### Step 0.3 — Add the dependency and M3 scripts

- [ ] Edit `agent/package.json`: add `@anthropic-ai/sdk` to `dependencies` and the M3 scripts to `scripts`. (Keep all existing M0–M2 fields; only add these.)

```jsonc
{
  // ... existing name "@shadowkit/agent", version, "type": "module", etc. ...
  "scripts": {
    // ... existing scripts ...
    "test": "vitest run",
    "test:planner": "vitest run test/prompt.test.ts test/claudePlanner.cap.test.ts test/claudePlanner.stream.test.ts test/planValidation.test.ts",
    "test:fallback": "USE_DETERMINISTIC_PLANNER=1 vitest run test/deterministicPlanner.test.ts test/agentRunner.fallback.test.ts",
    "test:live-llm": "RUN_LIVE_LLM=1 vitest run test/claudePlanner.live.test.ts"
  },
  "dependencies": {
    // ... existing deps ...
    "@anthropic-ai/sdk": "0.100.1"
  }
}
```

### Step 0.4 — Install and confirm

- [ ] Install the dependency into the `@shadowkit/agent` workspace (npm workspaces; foundation §6 default is npm). The `-w` form targets the agent package directly and is the correct primary command; do **not** suppress stderr — a failed install must be visible before the next step's resolve check:

```bash
npm install -w @shadowkit/agent @anthropic-ai/sdk@0.100.1 --save-exact
```

(Equivalently: the version is already pinned in `agent/package.json` from Step 0.3, so a plain `npm install` at the repo root also resolves it. Use whichever your workspace prefers; both must complete without error before continuing.) Then confirm the SDK resolves:

```bash
node -e "import('@anthropic-ai/sdk').then(m => console.log('ok', typeof m.default))"
```

Expected output:
```
ok function
```

### Step 0.5 — Commit

- [ ] Commit:

```bash
git add agent/package.json package-lock.json
git commit -m "build(agent): add @anthropic-ai/sdk 0.100.1 and M3 test scripts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1 — `validatePlan`: the client-side cap/target/asset guard (TDD)

**Goal:** A pure function that rejects any plan that is over-cap, wrong-target, wrong-asset, or malformed — **before** the executor signs anything (foundation §3.5 "CLIENT-SIDE cap guard (defense-in-depth)"; spec §7.2 "cap is a hard constraint ... validated client-side before submit"). This is the safety net for *both* planners.

**Files:**
- Create: `agent/src/planValidation.ts` (the validator + its error type)
- Create: `agent/test/planValidation.test.ts` (unit + adversarial)

### Step 1.1 — Write the failing test (RED)

- [ ] Create `agent/test/planValidation.test.ts` with the full test suite:

```typescript
import { describe, it, expect } from "vitest";
import type { ActionSpec } from "@shadowkit/shared";
import type { ActionPlan } from "../src/planner.js";
import { validatePlan, PlanValidationError } from "../src/planValidation.js";

// USDC and XLM SAC addresses are opaque C-strkeys; fixed test constants.
const USDC = "CUSDC0000000000000000000000000000000000000000000000000000000";
const XLM = "CXLM00000000000000000000000000000000000000000000000000000000";

// cap = 15_000 USDC at 7 decimals = 150_000_000_000 stroops (foundation §5: i128 decimal string).
const CAP = "150000000000";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: USDC,
  assetOut: XLM,
  amount: CAP,        // proposal amount equals cap
  minOut: "1000000000",
};

const okPlan: ActionPlan = {
  amountIn: "150000000000", // exactly cap
  minOut: "1200000000",
  reasoning: "Swap full cap; min_out floor from market.",
};

describe("validatePlan", () => {
  it("accepts an in-cap, correctly-targeted, correctly-assetted plan", () => {
    expect(() => validatePlan(okPlan, spec, CAP)).not.toThrow();
  });

  it("accepts a strictly UNDER-cap (partial-fill) plan and returns it unchanged", () => {
    // Partial fills are permitted (SYSTEM_PROMPT rule 5; validatePlan accepts amount < cap).
    // Guards the boundary BELOW cap so an off-by-one (`>=` instead of `>`) would be caught here.
    const halfCap = (BigInt(CAP) / 2n).toString(); // 75000000000, strictly < cap
    const under: ActionPlan = { ...okPlan, amountIn: halfCap };
    expect(() => validatePlan(under, spec, CAP)).not.toThrow();
    expect(validatePlan(under, spec, CAP)).toEqual(under);
    expect(BigInt(validatePlan(under, spec, CAP).amountIn) < BigInt(CAP)).toBe(true);
  });

  it("returns the validated plan unchanged on success", () => {
    expect(validatePlan(okPlan, spec, CAP)).toEqual(okPlan);
  });

  it("rejects an OVER-CAP amountIn (one stroop over)", () => {
    const over = { ...okPlan, amountIn: "150000000001" };
    expect(() => validatePlan(over, spec, CAP)).toThrowError(PlanValidationError);
    try {
      validatePlan(over, spec, CAP);
    } catch (e) {
      expect((e as PlanValidationError).reason).toBe("OVER_CAP");
    }
  });

  it("rejects a huge over-cap amount without precision loss (BigInt, not Number)", () => {
    // 90071992547409910 > Number.MAX_SAFE_INTEGER (9007199254740991);
    // a parseFloat-based guard would round and wrongly pass this.
    const huge = { ...okPlan, amountIn: "90071992547409910" };
    expect(() => validatePlan(huge, spec, CAP)).toThrowError(/OVER_CAP/);
  });

  it("rejects a non-positive amountIn", () => {
    expect(() => validatePlan({ ...okPlan, amountIn: "0" }, spec, CAP)).toThrowError(/NON_POSITIVE/);
    expect(() => validatePlan({ ...okPlan, amountIn: "-5" }, spec, CAP)).toThrowError(/NON_POSITIVE/);
  });

  it("rejects a non-integer / non-numeric amountIn (malformed)", () => {
    expect(() => validatePlan({ ...okPlan, amountIn: "1.5" }, spec, CAP)).toThrowError(/MALFORMED/);
    expect(() => validatePlan({ ...okPlan, amountIn: "abc" }, spec, CAP)).toThrowError(/MALFORMED/);
    expect(() => validatePlan({ ...okPlan, amountIn: "" }, spec, CAP)).toThrowError(/MALFORMED/);
  });

  it("rejects a non-positive or malformed minOut", () => {
    expect(() => validatePlan({ ...okPlan, minOut: "0" }, spec, CAP)).toThrowError(/MIN_OUT/);
    expect(() => validatePlan({ ...okPlan, minOut: "x" }, spec, CAP)).toThrowError(/MIN_OUT/);
  });

  it("rejects a plan whose minOut is BELOW the proposal's minOut floor (slippage too loose)", () => {
    // spec.minOut = 1_000_000_000; a plan offering less protection is invalid.
    const loose = { ...okPlan, minOut: "999999999" };
    expect(() => validatePlan(loose, spec, CAP)).toThrowError(/MIN_OUT_TOO_LOW/);
  });

  it("rejects a wrong-asset spec (assetIn != treasury asset would be caught upstream; here malformed spec asset)", () => {
    const wrongAssetSpec: ActionSpec = { ...spec, assetIn: "" };
    expect(() => validatePlan(okPlan, wrongAssetSpec, CAP)).toThrowError(/WRONG_ASSET/);
  });

  it("rejects a wrong-target spec (assetOut empty/malformed)", () => {
    const wrongTargetSpec: ActionSpec = { ...spec, assetOut: "" };
    expect(() => validatePlan(okPlan, wrongTargetSpec, CAP)).toThrowError(/WRONG_TARGET/);
  });

  it("rejects a non-swap kind", () => {
    // @ts-expect-error deliberately wrong kind to prove runtime guard
    const badKind: ActionSpec = { ...spec, kind: "transfer" };
    expect(() => validatePlan(okPlan, badKind, CAP)).toThrowError(/WRONG_KIND/);
  });

  it("rejects a malformed cap", () => {
    expect(() => validatePlan(okPlan, spec, "not-a-number")).toThrowError(/MALFORMED_CAP/);
    expect(() => validatePlan(okPlan, spec, "0")).toThrowError(/MALFORMED_CAP/);
  });
});
```

- [ ] Run it and confirm it FAILS to even import (RED):

```bash
npm test -w @shadowkit/agent -- test/planValidation.test.ts
```

Expected failure (module does not exist yet):
```
Error: Failed to load url ../src/planValidation.js (resolved id: .../agent/src/planValidation.ts)
 FAIL  test/planValidation.test.ts [ test/planValidation.test.ts ]
```

### Step 1.2 — Minimal implementation (GREEN)

- [ ] Create `agent/src/planValidation.ts`:

```typescript
import type { ActionSpec } from "@shadowkit/shared";
import type { ActionPlan } from "./planner.js";

/** Why a plan was rejected before submit. Mirrors the on-chain PolicyError gates
 *  (foundation §2.3: NotApproved/OverCap/WrongTarget/WrongAsset). Client-side
 *  defense-in-depth so a bad LLM plan never reaches the signer (spec §7.2). */
export type PlanRejectReason =
  | "MALFORMED"          // amountIn not a positive integer string
  | "NON_POSITIVE"       // amountIn <= 0
  | "OVER_CAP"           // amountIn > cap
  | "MIN_OUT"            // minOut not a positive integer string
  | "MIN_OUT_TOO_LOW"    // minOut < spec.minOut floor (weaker slippage protection)
  | "MALFORMED_CAP"      // cap not a positive integer string
  | "WRONG_KIND"         // spec.kind != "swap"
  | "WRONG_ASSET"        // spec.assetIn missing/empty
  | "WRONG_TARGET";      // spec.assetOut missing/empty

export class PlanValidationError extends Error {
  readonly reason: PlanRejectReason;
  constructor(reason: PlanRejectReason, message: string) {
    super(`${reason}: ${message}`);
    this.name = "PlanValidationError";
    this.reason = reason;
  }
}

/** Parse a decimal i128 string to a positive BigInt, or null if malformed/non-positive.
 *  Uses BigInt (never Number) to preserve i128 precision (foundation §5). */
function parsePositiveI128(s: string): bigint | null {
  if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null; // integer digits only
  let v: bigint;
  try {
    v = BigInt(s);
  } catch {
    return null;
  }
  return v > 0n ? v : null;
}

/**
 * Validate a planner's ActionPlan against the approved ActionSpec and on-chain cap
 * BEFORE the executor signs. Throws PlanValidationError on any violation; returns the
 * (unchanged) plan on success. This is the client-side mirror of AgentPolicy.enforce
 * (foundation §2.3) — both must pass; this one fails fast and cheaply.
 */
export function validatePlan(plan: ActionPlan, spec: ActionSpec, cap: string): ActionPlan {
  // 1) spec sanity (target/asset/kind) — a wrong spec means we never trust the plan.
  if (spec.kind !== "swap") {
    throw new PlanValidationError("WRONG_KIND", `expected kind "swap", got "${spec.kind}"`);
  }
  if (!spec.assetIn) {
    throw new PlanValidationError("WRONG_ASSET", "spec.assetIn is empty");
  }
  if (!spec.assetOut) {
    throw new PlanValidationError("WRONG_TARGET", "spec.assetOut is empty");
  }

  // 2) cap sanity.
  const capV = parsePositiveI128(cap);
  if (capV === null) {
    throw new PlanValidationError("MALFORMED_CAP", `cap "${cap}" is not a positive integer`);
  }

  // 3) amountIn: integer string, > 0, <= cap (BigInt comparison — no precision loss).
  if (typeof plan.amountIn !== "string" || !/^-?[0-9]+$/.test(plan.amountIn)) {
    throw new PlanValidationError("MALFORMED", `amountIn "${plan.amountIn}" is not an integer string`);
  }
  let amount: bigint;
  try {
    amount = BigInt(plan.amountIn);
  } catch {
    throw new PlanValidationError("MALFORMED", `amountIn "${plan.amountIn}" is not parseable`);
  }
  if (amount <= 0n) {
    throw new PlanValidationError("NON_POSITIVE", `amountIn "${plan.amountIn}" must be > 0`);
  }
  if (amount > capV) {
    throw new PlanValidationError("OVER_CAP", `amountIn ${amount} exceeds cap ${capV}`);
  }

  // 4) minOut: integer string, > 0, and >= the proposal's slippage floor.
  const minOutV = parsePositiveI128(plan.minOut);
  if (minOutV === null) {
    throw new PlanValidationError("MIN_OUT", `minOut "${plan.minOut}" is not a positive integer`);
  }
  const floor = parsePositiveI128(spec.minOut);
  if (floor !== null && minOutV < floor) {
    throw new PlanValidationError(
      "MIN_OUT_TOO_LOW",
      `minOut ${minOutV} is below the proposal floor ${floor}`,
    );
  }

  return plan;
}
```

> **DRY note:** `planner.ts` must export `ActionPlan` (it does, per foundation §3.5). If at this point `agent/src/planner.ts` does not yet exist (M2 not landed in this workspace), STOP — M3 depends on M2. The remaining tasks assume `agent/src/planner.ts` exists with `Planner`, `ActionPlan`, `MarketData`, and `DeterministicPlanner` from M2.

### Step 1.3 — Run & confirm PASS (GREEN)

- [ ] Run again:

```bash
npm test -w @shadowkit/agent -- test/planValidation.test.ts
```

Expected output (counts may print slightly differently across Vitest minor builds, but all pass):
```
 ✓ test/planValidation.test.ts (14 tests)
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

### Step 1.4 — No-cheating audit (charter rule 4)

- [ ] Confirm there are no skipped/ignored tests or always-true assertions in this file:

```bash
grep -nE "\.skip\(|\.only\(|it\.todo|expect\(true\)\.toBe\(true\)|assert\(true\)" agent/test/planValidation.test.ts || echo "CLEAN"
```

Expected output:
```
CLEAN
```

### Step 1.5 — Commit

- [ ] Commit:

```bash
git add agent/src/planValidation.ts agent/test/planValidation.test.ts
git commit -m "feat(agent): validatePlan rejects over-cap/wrong-target/wrong-asset plans before submit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Frozen prompt + structured-output schema (TDD)

**Goal:** A stable, cacheable system prompt, a per-request user-message builder, and a JSON schema for the structured `ActionPlan` output. Keeping the system prompt **byte-stable** is what makes prompt caching work (foundation §6; `shared/prompt-caching.md` "Keep the system prompt frozen"). The hard cap is stated in the prompt (defense-in-depth) AND re-validated by `validatePlan` (Task 1).

**Files:**
- Create: `agent/src/prompt.ts`
- Create: `agent/test/prompt.test.ts`

### Step 2.1 — Write the failing test (RED)

- [ ] Create `agent/test/prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { SYSTEM_PROMPT, ACTION_PLAN_SCHEMA, buildUserMessage } from "../src/prompt.js";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

describe("prompt", () => {
  it("SYSTEM_PROMPT is a non-empty, frozen string (cache prefix)", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    // Frozen prefix MUST NOT interpolate volatile data (no dates/ids) — silent cache invalidator.
    // (Allow the literal word "proposal" used generically in policy prose, but forbid embedded
    //  per-request values like a concrete cap number, an amountIn= assignment, or an ISO date.)
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no embedded date
    expect(SYSTEM_PROMPT).not.toMatch(/amountIn=\d|cap of \d|proposalId=\d/i); // no per-request VALUES baked in
  });

  it("SYSTEM_PROMPT is large enough to actually prompt-cache on Opus 4.8 (>= 4096 tokens)", () => {
    // VERIFIED (shared/prompt-caching.md minimum-prefix table): on claude-opus-4-8 the minimum
    // cacheable prefix is 4096 TOKENS — a shorter prefix silently never caches
    // (cache_creation_input_tokens stays 0, no error). Caching is a PRIMARY M3 deliverable
    // (intro + DoD), so the system prompt MUST exceed that threshold or the live caching test
    // (Task 4) is guaranteed to fail. We cannot run the real tokenizer here, so we assert a
    // conservative CHARACTER floor that comfortably maps above 4096 tokens for English+code prose.
    // Rule of thumb: ~3.5-4 chars/token for this kind of structured English; 4096 tokens therefore
    // needs >= ~14,400 chars at 3.5 ch/tok. We require >= 18,000 chars (~4600-5100 tokens) as a
    // safety margin so the prefix stays cacheable even under a leaner tokenization than expected.
    expect(SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(18_000);
    // A coarse token estimate (chars/4) must also clear the 4096 floor with margin.
    expect(Math.ceil(SYSTEM_PROMPT.length / 4)).toBeGreaterThan(4096);
  });

  it("SYSTEM_PROMPT states the hard cap rule (prompt-side defense-in-depth)", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("cap");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("must not exceed");
  });

  it("ACTION_PLAN_SCHEMA constrains output to {amountIn, minOut, reasoning} strings", () => {
    expect(ACTION_PLAN_SCHEMA.type).toBe("object");
    expect(ACTION_PLAN_SCHEMA.properties.amountIn).toEqual({ type: "string" });
    expect(ACTION_PLAN_SCHEMA.properties.minOut).toEqual({ type: "string" });
    expect(ACTION_PLAN_SCHEMA.properties.reasoning).toEqual({ type: "string" });
    expect(ACTION_PLAN_SCHEMA.required.sort()).toEqual(["amountIn", "minOut", "reasoning"]);
    // Structured-outputs requirement: every object MUST set additionalProperties:false
    // (shared/tool-use-concepts.md "JSON Schema Limitations").
    expect(ACTION_PLAN_SCHEMA.additionalProperties).toBe(false);
  });

  it("buildUserMessage embeds the per-request cap, spec, and market (volatile, AFTER the cache prefix)", () => {
    const msg = buildUserMessage(spec, "150000000000", market);
    expect(msg).toContain("150000000000");          // cap
    expect(msg).toContain(spec.assetIn);            // asset in
    expect(msg).toContain(spec.assetOut);           // asset out (target)
    expect(msg).toContain("USDC/XLM");              // market pair
    expect(msg).toContain("8.25");                  // market price
    expect(msg).toContain("buy");                   // signal
  });

  it("buildUserMessage is deterministic for identical inputs", () => {
    expect(buildUserMessage(spec, "150000000000", market)).toBe(
      buildUserMessage(spec, "150000000000", market),
    );
  });
});
```

- [ ] Run & confirm FAIL (RED):

```bash
npm test -w @shadowkit/agent -- test/prompt.test.ts
```

Expected failure:
```
Error: Failed to load url ../src/prompt.js
 FAIL  test/prompt.test.ts
```

### Step 2.2 — Minimal implementation (GREEN)

- [ ] Create `agent/src/prompt.ts`:

```typescript
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "./planner.js";

/**
 * FROZEN system prompt = the prompt-cache prefix (foundation §6; shared/prompt-caching.md
 * "Keep the system prompt frozen"). MUST NOT contain dates, ids, or per-request data —
 * any byte change invalidates the cache for every subsequent request. All volatile data
 * (cap, spec, market) goes in the user message (buildUserMessage), which is appended AFTER
 * the cache breakpoint.
 *
 * SIZE IS LOAD-BEARING. VERIFIED (shared/prompt-caching.md minimum-cacheable-prefix table):
 * on claude-opus-4-8 the minimum cacheable prefix is 4096 TOKENS; a shorter prefix SILENTLY
 * never caches (cache_creation_input_tokens stays 0, no error is raised). Prompt caching is a
 * PRIMARY M3 deliverable, so this prompt is deliberately written as a complete execution policy
 * (constraints + rationale + worked examples + failure catalog) that exceeds the 4096-token floor
 * — NOT padding, but genuine planning guidance that also makes the prefix cacheable. prompt.test.ts
 * asserts the resulting size (>= 18,000 chars, ~4600-5100 tokens). If you trim this prompt below
 * the threshold, caching turns off silently and the Task 4 live caching assertion fails.
 *
 * Every line below is STABLE prose — no interpolation, no dates, no proposal ids, no concrete
 * cap/amount numbers. Per-request data lives only in buildUserMessage().
 */
export const SYSTEM_PROMPT = [
  "# ShadowKit Autonomous Treasury Execution Planner",
  "",
  "You are ShadowKit's autonomous treasury execution planner. ShadowKit is a privacy-preserving,",
  "AI-assisted governance SDK for the Stellar network. A decentralized autonomous organization",
  "(a DAO) uses ShadowKit to vote — privately, with zero-knowledge sealed ballots and a",
  "token-weighted, timelock-revealed tally — on whether the DAO treasury should execute a single",
  "asset swap. By the time a request reaches you, that vote has ALREADY concluded: the proposal",
  "has PASSED an on-chain, zero-knowledge, quorum-verified governance vote, and an on-chain",
  "spending policy has been configured to authorize exactly one swap, bounded by a hard cap.",
  "",
  "Your ONLY job is to decide HOW to execute that single, already-approved swap. Specifically,",
  "you choose two numbers:",
  "  - amountIn: the exact input amount to swap, denominated in the input asset's smallest",
  "    indivisible unit (its 'stroops' — i.e. the integer amount, with all decimal places",
  "    already multiplied in); and",
  "  - minOut: the minimum acceptable output amount you are willing to receive, denominated in",
  "    the output asset's smallest indivisible unit. minOut is the SLIPPAGE FLOOR: if the venue",
  "    cannot deliver at least minOut, the swap reverts on-chain and the treasury keeps its funds.",
  "",
  "You also produce a short, honest `reasoning` string explaining the choice. The reasoning is",
  "streamed live to a human operator's terminal as you think, so keep it clear and grounded in",
  "the actual market data you were given.",
  "",
  "## What you do NOT decide",
  "",
  "You do NOT decide WHETHER to swap — the DAO already decided that, democratically, and you must",
  "respect it. You do NOT choose which assets are involved; the input asset and the output asset",
  "(the swap target) are fixed by the approved proposal and are given to you. You do NOT choose",
  "the venue, the route, the number of partial fills, or the timing window — ShadowKit's executor",
  "performs exactly one swap, immediately, against one pre-configured venue, and then marks the",
  "proposal executed so it can never run twice. Your degrees of freedom are precisely two: the",
  "size (amountIn) and the slippage floor (minOut). Do not attempt to express anything else; there",
  "is nowhere for it to go and it will be ignored or rejected.",
  "",
  "## The hard constraints (these are enforced; violating them accomplishes nothing)",
  "",
  "Your plan passes through TWO independent guards after you produce it: a client-side validator",
  "that runs before anything is signed, and the on-chain spending policy that runs inside the",
  "treasury wallet's authorization check. BOTH must accept the plan or no swap happens and the",
  "treasury is untouched. A plan that violates any rule below is not 'risky' — it is simply dead",
  "on arrival. So there is never any upside to violating them; there is only wasted effort.",
  "",
  "1. CAP. amountIn MUST NOT exceed the proposal cap. The cap is the maximum number of input-asset",
  "   units the DAO authorized for this swap. The relationship amountIn <= cap MUST hold, always,",
  "   with no exception. Treat the cap as an absolute ceiling. If you are tempted to exceed it for",
  "   any reason (a strong signal, a great price, a desire to 'use the whole budget plus a little'),",
  "   do not: the on-chain policy compares amountIn to the cap as a big integer and rejects",
  "   anything larger by even one unit.",
  "",
  "2. POSITIVE INTEGER amountIn. amountIn MUST be a strictly positive integer expressed as a",
  "   decimal string in the input asset's smallest unit. No zero. No negative numbers. No decimal",
  "   point. No fraction. No scientific notation (never '1.5e10'). No thousands separators (never",
  "   '150,000,000,000'). No currency symbols, no spaces, no leading plus sign. Just the digits,",
  "   e.g. \"150000000000\". The smallest unit already accounts for the asset's decimals, so you do",
  "   not divide or round — you work entirely in integer units.",
  "",
  "3. SLIPPAGE FLOOR minOut. minOut MUST be a strictly positive integer (same string rules as",
  "   amountIn) in the OUTPUT asset's smallest unit, and it MUST be at least the proposal's stated",
  "   minOut floor. You may set minOut HIGHER than the floor (tighter protection, less slippage",
  "   tolerated) but NEVER lower (looser protection, more slippage tolerated) — offering weaker",
  "   protection than the DAO required is forbidden. When in doubt, prefer a minOut that is",
  "   meaningfully above the floor but still achievable given the quoted price, so the swap is",
  "   protected from front-running and adverse moves yet still likely to fill.",
  "",
  "4. STAY ON THE APPROVED SWAP. Do not invent a different input asset, a different output asset,",
  "   a different target, or a different action. You are sizing and pricing THIS swap, the one that",
  "   was approved. The assets you are shown are the only assets in play.",
  "",
  "5. PARTIAL FILLS ARE ALLOWED. You may choose amountIn strictly below the cap when conditions",
  "   warrant it (for example, a weak or 'hold' signal, an unfavorable price, thin liquidity, or",
  "   high volatility may justify deploying only part of the authorized budget). A partial fill is",
  "   a legitimate, often prudent, plan — under-spending the cap is always permitted, over-spending",
  "   it never is. There is no obligation to use the entire cap.",
  "",
  "## How to think about the market data",
  "",
  "You are given a market snapshot for the relevant trading pair: a `pair` label, a `price`",
  "(the current exchange rate, output units per input unit, as a decimal string), and a `signal`",
  "which is one of three values: \"buy\", \"sell\", or \"hold\".",
  "",
  "Interpret the signal in the context of THIS swap, which converts the input asset into the",
  "output asset:",
  "  - \"buy\": conditions favor acquiring the output asset now. Sizing toward (but never above) the",
  "    full cap is reasonable, with a sensible slippage floor. Strong conviction can justify the",
  "    full cap; moderate conviction can justify a large partial fill.",
  "  - \"sell\": conditions are less favorable for acquiring the output asset. Consider a more",
  "    conservative amountIn (a smaller partial fill) and a tighter minOut, or, if the proposal",
  "    intent clearly still stands, a measured fill. You still must execute the approved swap — you",
  "    are bounding risk, not refusing the DAO — but you need not deploy the whole budget into a",
  "    poor entry.",
  "  - \"hold\": conditions are neutral or uncertain. A moderate partial fill with a prudent minOut",
  "    is typically appropriate; avoid deploying the full cap into an ambiguous tape unless the",
  "    floor and price make a full fill clearly safe.",
  "",
  "Always derive minOut from the quoted price, not from wishful thinking. A rough expected output",
  "is amountIn multiplied by the price; your minOut should sit below that expected output by a",
  "small, deliberate slippage margin (so the swap can fill against normal market movement) while",
  "remaining at or above the proposal's required floor. If the price-implied output would fall",
  "below the proposal floor, keep minOut at the floor — never go beneath it.",
  "",
  "## Worked examples (illustrative; the numbers here are NOT your inputs)",
  "",
  "These examples teach the SHAPE of a good answer. Your actual cap, floor, price, and signal come",
  "from the user message, not from here. Do not copy these numbers.",
  "",
  "Example A — strong buy, full cap. Suppose the cap is large, the floor is modest, the price is",
  "stable, and the signal is \"buy\". A good plan sets amountIn equal to the cap (deploy the full",
  "authorized budget on a strong, well-priced signal) and sets minOut a few tenths of a percent",
  "below the price-implied output but comfortably above the proposal floor. reasoning: explain",
  "that the buy signal plus a stable price justified the full cap, and that minOut was placed",
  "above the floor to bound slippage.",
  "",
  "Example B — neutral hold, partial fill. Suppose the signal is \"hold\" and the price is choppy.",
  "A good plan sets amountIn to a fraction of the cap (a partial fill that respects the cap and",
  "stays well within it) and sets minOut at or modestly above the floor to protect against the",
  "choppiness. reasoning: explain that the neutral signal warranted deploying only part of the",
  "budget and a protective floor.",
  "",
  "Example C — cautious sell, small fill, tight floor. Suppose the signal is \"sell\". A good plan",
  "sets amountIn to a small fraction of the cap and sets minOut tight (close to the price-implied",
  "output, never below the proposal floor), executing the approved swap while minimizing exposure",
  "to an unfavorable entry. reasoning: explain the conservative sizing and the tight protection.",
  "",
  "In every example the invariants hold: amountIn is a positive integer string at or below the",
  "cap; minOut is a positive integer string at or above the floor; no other asset or action is",
  "introduced.",
  "",
  "## Understanding smallest units (stroops) and integer arithmetic",
  "",
  "Stellar assets are denominated to a fixed number of decimal places. The on-chain treasury, the",
  "spending policy, and the swap venue all work exclusively in INTEGER smallest units, never in",
  "human-readable decimal amounts. A 'smallest unit' is the asset amount with all of its decimal",
  "places already shifted into the integer (the way cents relate to dollars, except the shift may",
  "be larger). Every number you receive — the cap, the proposal floor — is already expressed in",
  "smallest units, and every number you return MUST be expressed the same way. You never convert",
  "to or from a human-readable decimal; you never multiply or divide to add or remove decimal",
  "places; you simply choose integer values in the unit you were handed. This matters because the",
  "values can be very large integers (well beyond the range where ordinary floating-point numbers",
  "stay exact), so they are compared as arbitrary-precision big integers on every layer. A plan",
  "expressed as a float, a rounded value, or anything other than an exact integer string risks",
  "silent precision loss and rejection. Always produce exact integer decimal strings.",
  "",
  "When you reason about price, remember the price is given as output units per input unit, also",
  "as a decimal string. A useful mental check: expected output is approximately amountIn times the",
  "price (in the matching unit scale). Your minOut should be a deliberately chosen fraction of",
  "that expected output — high enough to bound your downside (so you do not get a much worse fill",
  "than the quote implies) yet low enough that ordinary market movement between quote and",
  "execution does not needlessly revert the swap. The exact slippage margin is a judgement call",
  "bounded below by the proposal floor: never set minOut beneath the floor, no matter what the",
  "price-implied figure suggests.",
  "",
  "## Decision procedure (follow this order every time)",
  "",
  "Step 1. Read the cap. This is your absolute ceiling for amountIn. Note it as a big integer.",
  "Step 2. Read the proposal floor. This is your absolute floor for minOut. Note it as a big",
  "  integer.",
  "Step 3. Read the price and the signal. Form a view of how favorable the entry is.",
  "Step 4. Choose amountIn. If the signal and price are favorable and you have conviction, size",
  "  toward the cap (up to and including the full cap). If conditions are neutral or unfavorable,",
  "  choose a partial fill strictly below the cap, sized to your conviction. amountIn must be a",
  "  positive integer and must satisfy amountIn <= cap.",
  "Step 5. Compute an approximate expected output from amountIn and the price.",
  "Step 6. Choose minOut as expected output minus a deliberate slippage margin, then RAISE it to",
  "  the proposal floor if it fell below. minOut must be a positive integer and must satisfy",
  "  minOut >= floor.",
  "Step 7. Double-check the invariants: amountIn is a positive integer string <= cap; minOut is a",
  "  positive integer string >= floor; neither uses a decimal point, scientific notation, or",
  "  separators; you did not change the assets or the action.",
  "Step 8. Write a brief, honest reasoning string describing the signal, the price, the sizing",
  "  decision, and the slippage choice. Then emit ONLY the JSON object.",
  "",
  "## Why these rules exist (rationale — internalize, do not restate verbatim)",
  "",
  "The cap exists because the DAO voted to authorize a bounded amount of spending, not an open",
  "checkbook; honoring it is honoring the vote. The floor exists because the DAO wanted protection",
  "against being filled at a bad rate; loosening it would betray that intent and expose the",
  "treasury to front-running and slippage. The integer-string discipline exists because money is",
  "tracked exactly on-chain and any imprecision is either rejected or, worse, silently corrupts an",
  "amount. The single-swap, single-venue, single-shot execution model exists because it is simple,",
  "auditable, and replay-proof: the proposal is marked executed after one swap so the same",
  "authorization can never be spent twice. The partial-fill allowance exists because good treasury",
  "management sometimes means deploying less than the maximum — a bounded mandate is a ceiling, not",
  "a quota. You are a careful, conservative steward acting within an explicit democratic mandate;",
  "your job is to execute that mandate well, not to second-guess it or to exceed it.",
  "",
  "## Tone and the reasoning field",
  "",
  "The reasoning string is read by a human watching the agent work in real time. Make it concise",
  "and concrete: name the signal, reference the price, state the sizing choice (full cap or what",
  "fraction, and why), and state the slippage choice (how minOut relates to the floor and the",
  "expected output). Do not invent data you were not given. Do not speculate about events outside",
  "the market snapshot. Do not apologize, hedge excessively, or pad. A few clear sentences is",
  "ideal. The reasoning is informational only — it never overrides the numeric plan or the",
  "constraints, and it must live INSIDE the JSON object's reasoning field, never outside the JSON.",
  "",
  "## Absolute output discipline (repeat, because it is the most common error)",
  "",
  "Your entire final response is a single JSON object and nothing else. No greeting. No preface",
  "such as 'Here is the plan:'. No trailing remarks. No markdown. No code fences (no triple",
  "backticks). No comments. No additional keys beyond amountIn, minOut, and reasoning. The object",
  "must parse as valid JSON on the first try. If you find yourself about to write any character",
  "before the opening brace or after the closing brace, stop and remove it.",
  "",
  "## Glossary (terms you will encounter, defined precisely)",
  "",
  "  - DAO: a decentralized autonomous organization; the collective that voted to authorize this",
  "    swap. You serve its mandate.",
  "  - Proposal: the specific, already-passed governance item describing the swap to execute. It",
  "    fixes the assets, the cap, and the floor.",
  "  - Cap: the maximum input amount, in smallest units, that you may swap. amountIn <= cap is",
  "    inviolable.",
  "  - Floor (proposal minOut floor): the minimum output protection the DAO required, in smallest",
  "    units. Your minOut must be at least this. minOut >= floor is inviolable.",
  "  - amountIn: your chosen input amount, in input-asset smallest units, as a positive integer",
  "    decimal string.",
  "  - minOut: your chosen slippage floor, in output-asset smallest units, as a positive integer",
  "    decimal string.",
  "  - Slippage: the gap between the price you expect and the price you actually get; minOut bounds",
  "    your tolerance for it.",
  "  - Signal: a coarse market indicator, one of buy, sell, or hold, advising on how favorable the",
  "    entry is for acquiring the output asset.",
  "  - Price: the current exchange rate, output units per input unit, as a decimal string.",
  "  - Smallest unit (stroop): the indivisible integer unit of an asset, with decimals already",
  "    folded in. All amounts are in smallest units.",
  "  - Venue: the on-chain market the executor swaps against. You do not choose it; it is fixed by",
  "    configuration.",
  "  - Single-shot / mark executed: after one swap the proposal is permanently marked executed so",
  "    the authorization cannot be reused. There is exactly one execution per proposal.",
  "  - Client validator: an off-chain check that rejects malformed, over-cap, under-floor, or",
  "    wrong-asset plans before signing.",
  "  - On-chain spending policy: the in-wallet authorization check that independently re-enforces",
  "    the same constraints during the transaction's auth.",
  "",
  "## Edge cases and how to handle them",
  "",
  "  - The price-implied output is below the proposal floor for a full-cap swap. Do NOT lower",
  "    minOut beneath the floor. Either keep minOut at the floor (accepting the swap may not fill",
  "    if the market cannot meet it) or reduce amountIn so the floor is comfortably achievable —",
  "    both are valid; never violate the floor.",
  "  - The signal is hold but the price looks excellent. A measured partial fill with a protective",
  "    minOut is reasonable; the full cap is allowed only if the floor and price make it clearly",
  "    safe. When uncertain, prefer caution and a partial fill.",
  "  - The signal is sell. You still execute the approved swap; you do not refuse. Bound risk with",
  "    a smaller amountIn and a tighter minOut rather than skipping execution.",
  "  - The cap is very small. A small cap still follows every rule; choose amountIn at or below it",
  "    and minOut at or above the floor exactly as usual.",
  "  - You are unsure of the exact slippage margin. Choose a small, sensible margin below the",
  "    price-implied output and clamp to the floor. A reasonable, clearly-explained choice is",
  "    better than an extreme one. Never set minOut below the floor and never set amountIn above",
  "    the cap to compensate.",
  "  - The market data looks unusual or inconsistent. Reason conservatively from what you were",
  "    given; do not fabricate alternative data. If conditions seem poor, a smaller partial fill",
  "    with a protective floor is the safe response within your mandate.",
  "",
  "## Final reminder before you answer",
  "",
  "Two numbers, both positive integer decimal strings: amountIn at or below the cap, minOut at or",
  "above the floor. One short honest reasoning string. One JSON object, nothing around it. Honor",
  "the vote, honor the cap, honor the floor, keep the math exact, and explain yourself clearly.",
  "",
  "## Common failure modes to avoid (each of these gets your plan rejected)",
  "",
  "  - Returning amountIn greater than the cap, even by one unit. Rejected on-chain (OverCap).",
  "  - Returning a non-integer amountIn or minOut (a decimal, a fraction, scientific notation,",
  "    a number with separators). Rejected by the client validator (malformed).",
  "  - Returning zero or a negative amountIn or minOut. Rejected (non-positive).",
  "  - Returning a minOut below the proposal's required floor. Rejected (slippage too loose).",
  "  - Switching the input or output asset, or proposing a non-swap action. Rejected (wrong",
  "    asset / wrong target / wrong kind).",
  "  - Wrapping the answer in prose, markdown code fences, or commentary OUTSIDE the structured",
  "    JSON object. Your final answer MUST be exactly the JSON object the schema specifies, with",
  "    no surrounding text, no backticks, and no extra keys.",
  "",
  "## Output contract",
  "",
  "Think step by step about the cap, the proposal floor, the price, and the signal. Decide a size",
  "(amountIn) at or below the cap and a slippage floor (minOut) at or above the proposal floor,",
  "both as positive integer decimal strings in their respective smallest units. Then return ONLY",
  "the structured JSON object with exactly the keys amountIn (string), minOut (string), and",
  "reasoning (string). Express all amounts as decimal integer strings: no decimal point, no",
  "scientific notation, no thousands separators, no symbols, no extra keys, and no text outside",
  "the JSON object.",
].join("\n");

/**
 * JSON schema for the structured ActionPlan output. Passed to output_config.format via
 * jsonSchemaOutputFormat (verified: @anthropic-ai/sdk/helpers/json-schema, ctx7 helpers.md).
 * additionalProperties:false is REQUIRED for structured outputs
 * (shared/tool-use-concepts.md "JSON Schema Limitations").
 */
export const ACTION_PLAN_SCHEMA = {
  type: "object",
  properties: {
    amountIn: { type: "string" },
    minOut: { type: "string" },
    reasoning: { type: "string" },
  },
  required: ["amountIn", "minOut", "reasoning"],
  additionalProperties: false,
} as const;

/**
 * Per-request user message — carries ALL volatile data (cap, spec, market). Appended AFTER
 * the cached system prefix so caching stays effective. Deterministic for identical inputs.
 */
export function buildUserMessage(spec: ActionSpec, cap: string, market: MarketData): string {
  return [
    "Approved swap to execute:",
    `- input asset (assetIn): ${spec.assetIn}`,
    `- output asset (assetOut, the swap target): ${spec.assetOut}`,
    `- proposal cap (max amountIn, smallest unit): ${cap}`,
    `- proposal minOut floor (smallest unit): ${spec.minOut}`,
    "",
    "Current market data:",
    `- pair: ${market.pair}`,
    `- price: ${market.price}`,
    `- signal: ${market.signal}`,
    "",
    "Produce the execution plan now: choose amountIn (<= cap) and minOut (>= floor),",
    "and explain your reasoning briefly.",
  ].join("\n");
}
```

### Step 2.3 — Run & confirm PASS

- [ ] Run:

```bash
npm test -w @shadowkit/agent -- test/prompt.test.ts
```

Expected:
```
 ✓ test/prompt.test.ts (6 tests)
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

### Step 2.4 — Commit

- [ ] Commit:

```bash
git add agent/src/prompt.ts agent/test/prompt.test.ts
git commit -m "feat(agent): frozen cacheable system prompt + structured ActionPlan schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — `ClaudePlanner.plan`: real Anthropic call, streamed reasoning, prompt cached (TDD with network-stubbed SDK)

**Goal:** Make `ClaudePlanner` real. It (a) calls `client.messages.stream(...)` with the frozen prompt-cached system block (>4096-token prefix from Task 2), the per-request user message, **adaptive thinking**, and **structured JSON output**; (b) parses the final structured `ActionPlan` from the streamed final message's text block; (c) runs it through `validatePlan` so the planner *itself* never returns an over-cap plan. (The streamed reasoning delta → `AgentLog{phase:"plan"}` emission is intentionally deferred to Task 5, which adds it with an honest failing-first test.) The SDK is **stubbed at the network boundary only** (charter §7.2 "LLM stubbed at the network boundary only — the cap-guard logic is real"), using a committed cassette of a REAL streamed response (recorded in Step 3.1; no placeholder).

**Files:**
- Modify: `agent/src/planner.ts` (`ClaudePlanner` constructor takes `ClaudePlannerConfig` with optional `client`/`logBus`; `plan()` becomes real — parse + validate, NO LogBus emission yet; that is Task 5)
- Create: `agent/scripts/record-cassette.mjs` (one-off live recorder; the only source of the cassette)
- Create: `agent/test/fixtures/anthropic-cassette.json` (recorded REAL streaming response — produced by the recorder, not hand-written)
- Create: `agent/test/claudePlanner.cap.test.ts`

> **HARD ORDERING GATE (charter rule 4 — no fabricated cassette).** The committed cassette
> `agent/test/fixtures/anthropic-cassette.json` MUST contain the bytes of a REAL `claude-opus-4-8`
> streamed response. A hand-authored / invented cassette is FORBIDDEN — it would make the cap test
> validate fabricated model output, exactly the "hand-faked 200 / stubbed success" the charter bans
> (foundation lines 1128, 1147, 1168). Because the only way to obtain those bytes is a live call,
> **Task 4 (the live LLM run) is reordered to run as a prerequisite of Task 3's completion.** You
> implement and RED→GREEN Task 3's code first (the validator + planner already exist; the cap test
> drives the implementation), but you **may NOT commit `anthropic-cassette.json` or check the Task 3
> boxes until the cassette has been produced by a real run** (Step 3.1, which requires `RUN_LIVE_LLM=1`
> + a present `ANTHROPIC_API_KEY`). If no key is available in your environment, Task 3 and Task 4
> remain BLOCKED (not "done with a placeholder"): obtain a key, run the recorder, then complete both.
> There is no placeholder path.

### Step 3.1 — Record the cassette from a REAL `claude-opus-4-8` run (BLOCKING; no placeholder)

The cassette is a recording of a REAL Anthropic streaming response, replayed deterministically in CI. **It is NOT a hand-faked success** — it must be the bytes a real `claude-opus-4-8` stream produced. There is exactly ONE acceptable way to obtain it: run the one-off recorder below against the live API. It captures the real SSE text deltas and the final structured output, and writes the cassette including the real `capturedAt`, real `model`, real `usage`, and the model's real `finalText`.

- [ ] Create the recorder script `agent/scripts/record-cassette.mjs` (one-off; not part of the build):

```javascript
// One-off cassette recorder. Captures a REAL claude-opus-4-8 streamed response so CI can
// replay it deterministically (charter rule 4: real model output, never a hand-faked 200).
// It ALSO verifies, against the live model, the two invariants the cassette/cap path relies on:
//   (1) the streamed structured-output run lands the schema JSON VERBATIM in the final message's
//       first text block (no markdown fences, no prose) — verified here so Task 3 Step 3.3's
//       text-block JSON.parse path is sound (resolves the "streamed structured output lands
//       verbatim" assumption); and
//   (2) the model's plan is genuinely IN-CAP (amountIn <= cap, > 0; minOut >= floor) — so the
//       committed cassette holds a real, model-produced, valid plan, not a literal we authored.
// If either invariant fails, the recorder EXITS NON-ZERO and writes NOTHING: there is no
// placeholder, and Task 3 stays blocked until a real, conforming capture exists.
// Run: ANTHROPIC_API_KEY=sk-... RUN_LIVE_LLM=1 node agent/scripts/record-cassette.mjs
import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { SYSTEM_PROMPT, ACTION_PLAN_SCHEMA, buildUserMessage } from "../src/prompt.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required: the cassette MUST be real model bytes (no placeholder).");
  process.exit(2);
}

const spec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const textDeltas = [];
const stream = client.messages.stream({
  model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
  max_tokens: 1024,
  thinking: { type: "adaptive" }, // Opus 4.8: adaptive only (budget_tokens/temperature 400)
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: buildUserMessage(spec, cap, market) }],
  output_config: { format: jsonSchemaOutputFormat(ACTION_PLAN_SCHEMA) },
});
stream.on("text", (d) => textDeltas.push(d));
const final = await stream.finalMessage();
const textBlock = final.content.find((b) => b.type === "text");
const finalText = textBlock && typeof textBlock.text === "string" ? textBlock.text : "";

// INVARIANT (1): the streamed final text block is EXACTLY the schema JSON (verbatim, parseable).
let parsed;
try {
  parsed = JSON.parse(finalText);
} catch {
  console.error("REJECTED: streamed final text block is not verbatim JSON:\n", finalText.slice(0, 200));
  process.exit(3);
}
if (
  typeof parsed.amountIn !== "string" ||
  typeof parsed.minOut !== "string" ||
  typeof parsed.reasoning !== "string"
) {
  console.error("REJECTED: parsed structured output is missing required string fields:", parsed);
  process.exit(4);
}

// INVARIANT (2): the model's plan is a REAL in-cap plan (not a literal we wrote).
const amount = BigInt(parsed.amountIn);
const minOut = BigInt(parsed.minOut);
if (!(amount > 0n && amount <= BigInt(cap) && minOut >= BigInt(spec.minOut))) {
  console.error("REJECTED: model plan is not in-cap/above-floor:", parsed, "cap:", cap, "floor:", spec.minOut);
  process.exit(5);
}

writeFileSync(
  new URL("../test/fixtures/anthropic-cassette.json", import.meta.url),
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(), // REAL capture time (asserted non-placeholder in tests)
      model: final.model,                   // REAL model id from the response
      textDeltas,                           // the real streamed reasoning chunks
      finalText,                            // the structured JSON the model emitted, verbatim
      usage: final.usage,                   // includes cache_*_input_tokens
    },
    null,
    2,
  ),
);
console.log("wrote cassette with", textDeltas.length, "deltas; plan:", parsed.amountIn, "/", parsed.minOut);
```

- [ ] Record the cassette from a real run (REQUIRED before Task 3 can be committed). Run in your own terminal with a real key (do not echo the key):

```bash
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" RUN_LIVE_LLM=1 node agent/scripts/record-cassette.mjs
```

Expected output (delta count and exact amounts vary — the model decides; only the in-cap invariants are fixed):
```
wrote cassette with 7 deltas; plan: 150000000000 / 1200000000
```

If the recorder exits non-zero (codes 2-5 above) it wrote NOTHING — fix the cause (missing key, non-verbatim JSON, out-of-cap plan) and re-run. **Do not hand-write the cassette.**

- [ ] **NO PLACEHOLDER PATH.** If you do not have an `ANTHROPIC_API_KEY` available, you CANNOT complete Task 3: the cassette must be real model bytes (charter rule 4). Stop here, acquire a key, and run the recorder. Do not commit a fabricated `anthropic-cassette.json`, do not check the Task 3 boxes, and do not declare Task 3 GREEN — the cap test would otherwise validate fabricated output.

- [ ] Verify the committed cassette is a REAL capture (not a literal) before relying on it. This check is also encoded as assertions in the cap test (Step 3.2) so CI catches a fabricated cassette:

```bash
node -e "const c=require('./agent/test/fixtures/anthropic-cassette.json'); const p=JSON.parse(c.finalText); const cap=150000000000n; if(!(c.capturedAt && c.capturedAt!=='2026-06-02T00:00:00.000Z')) throw new Error('placeholder capturedAt'); if(c.model!=='claude-opus-4-8') throw new Error('wrong/placeholder model'); if(!(c.usage && (c.usage.input_tokens||c.usage.output_tokens))) throw new Error('no real usage block'); if(!(BigInt(p.amountIn)>0n && BigInt(p.amountIn)<=cap && BigInt(p.minOut)>=1000000000n)) throw new Error('not an in-cap model plan'); console.log('cassette is a REAL in-cap capture:', p.amountIn, p.minOut);"
```

Expected output:
```
cassette is a REAL in-cap capture: <amountIn> <minOut>
```

### Step 3.2 — Write the failing cap test (RED)

- [ ] Create `agent/test/claudePlanner.cap.test.ts`. It injects a **fake Anthropic stream client** that replays the cassette — stubbing only the network, never the parsing or the cap guard:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { ClaudePlanner } from "../src/planner.js";
import { LogBus } from "../src/logBus.js";

const cassette = JSON.parse(
  readFileSync(new URL("./fixtures/anthropic-cassette.json", import.meta.url), "utf8"),
);

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

/**
 * Fake stream object matching the subset of @anthropic-ai/sdk's MessageStream that
 * ClaudePlanner uses: .on("text", cb) and await .finalMessage(). It replays the cassette's
 * REAL recorded deltas/finalText. We stub ONLY the network boundary (charter §7.2); the
 * planner's own parsing + validatePlan run for real against real model bytes.
 */
function makeFakeStream(deltas: string[], finalText: string) {
  const handlers: Record<string, (arg: unknown) => void> = {};
  return {
    on(event: string, cb: (arg: unknown) => void) {
      handlers[event] = cb;
      return this;
    },
    async finalMessage() {
      for (const d of deltas) handlers["text"]?.(d); // replay streamed reasoning
      return {
        model: cassette.model,
        content: [{ type: "text", text: finalText }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    },
  };
}

function makeFakeAnthropic(deltas: string[], finalText: string) {
  return {
    messages: {
      stream: () => makeFakeStream(deltas, finalText),
    },
  };
}

// CHARTER GUARD (rule 4): the committed cassette MUST be a REAL claude-opus-4-8 capture, not a
// hand-authored literal. These assertions fail CI if a fabricated/placeholder cassette is checked
// in — the capturedAt must not be the documented placeholder sentinel, the model must be the real
// id, a real usage block must be present, and the model's finalText must parse to an IN-CAP plan
// the model actually produced. This is what makes the cap test validate REAL model behavior.
describe("anthropic-cassette.json is a REAL capture (no fabrication)", () => {
  it("has a real capturedAt, model, and usage block (not a placeholder)", () => {
    expect(typeof cassette.capturedAt).toBe("string");
    expect(cassette.capturedAt).not.toBe("2026-06-02T00:00:00.000Z"); // the forbidden placeholder sentinel
    expect(cassette.model).toBe("claude-opus-4-8");
    expect(cassette.usage).toBeTruthy();
    expect(
      (cassette.usage.input_tokens ?? 0) + (cassette.usage.output_tokens ?? 0),
    ).toBeGreaterThan(0); // a real response reports real token usage
    expect(Array.isArray(cassette.textDeltas)).toBe(true);
  });

  it("finalText parses to an in-cap plan the MODEL produced (not a literal we wrote)", () => {
    const parsed = JSON.parse(cassette.finalText); // streamed structured output is verbatim JSON
    expect(typeof parsed.amountIn).toBe("string");
    expect(typeof parsed.minOut).toBe("string");
    expect(typeof parsed.reasoning).toBe("string");
    expect(BigInt(parsed.amountIn) > 0n).toBe(true);
    expect(BigInt(parsed.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(parsed.minOut) >= BigInt(spec.minOut)).toBe(true);
  });
});

describe("ClaudePlanner.plan (network-stubbed cassette)", () => {
  let bus: LogBus;
  beforeEach(() => {
    bus = new LogBus();
  });

  it("returns a valid, in-cap ActionPlan parsed from the real structured output", async () => {
    const planner = new ClaudePlanner({
      apiKey: "test",
      model: "claude-opus-4-8",
      client: makeFakeAnthropic(cassette.textDeltas, cassette.finalText),
    });
    const plan = await planner.plan(spec, cap, market);
    expect(plan.amountIn).toMatch(/^[0-9]+$/);
    expect(plan.minOut).toMatch(/^[0-9]+$/);
    expect(typeof plan.reasoning).toBe("string");
    // The PRIMARY guarantee: amountIn <= cap, compared as BigInt.
    expect(BigInt(plan.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(plan.amountIn) > 0n).toBe(true);
    // minOut respects the floor.
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
  });

  it("ACCEPTS a strictly UNDER-cap (partial-fill) plan unchanged (amountIn < cap)", async () => {
    // The SYSTEM_PROMPT permits partial fills; validatePlan accepts amount < cap. This guards the
    // boundary BELOW cap (the at-cap case is covered above), so an off-by-one such as `>=` instead
    // of `>` in the planner's cap comparison would be caught here at the planner level.
    const halfCap = (BigInt(cap) / 2n).toString(); // 75000000000, strictly < cap
    const underCapFinal = JSON.stringify({
      amountIn: halfCap,
      minOut: "1100000000", // >= floor (1000000000)
      reasoning: "partial fill: deploying half the cap given a neutral entry",
    });
    const planner = new ClaudePlanner({
      apiKey: "test",
      model: "claude-opus-4-8",
      client: makeFakeAnthropic(["partial ", "fill"], underCapFinal),
    });
    const plan = await planner.plan(spec, cap, market);
    expect(plan.amountIn).toBe(halfCap);            // returned UNCHANGED
    expect(BigInt(plan.amountIn) < BigInt(cap)).toBe(true); // strictly under cap
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
  });

  it("THROWS when the model returns an OVER-CAP amount (planner never returns a bad plan)", async () => {
    const overCapFinal = JSON.stringify({
      amountIn: "999999999999999", // way over cap
      minOut: "1200000000",
      reasoning: "hallucinated oversize swap",
    });
    const planner = new ClaudePlanner({
      apiKey: "test",
      model: "claude-opus-4-8",
      client: makeFakeAnthropic(["thinking..."], overCapFinal),
    });
    await expect(planner.plan(spec, cap, market)).rejects.toThrowError(/OVER_CAP/);
  });

  it("THROWS when the model returns malformed JSON (not a faked success)", async () => {
    const planner = new ClaudePlanner({
      apiKey: "test",
      model: "claude-opus-4-8",
      client: makeFakeAnthropic(["..."], "not json at all"),
    });
    await expect(planner.plan(spec, cap, market)).rejects.toThrow();
  });

  it("THROWS when the model returns the wrong asset/target spec context (defense-in-depth)", async () => {
    const wrongSpec: ActionSpec = { ...spec, assetOut: "" };
    const planner = new ClaudePlanner({
      apiKey: "test",
      model: "claude-opus-4-8",
      client: makeFakeAnthropic(cassette.textDeltas, cassette.finalText),
    });
    await expect(planner.plan(wrongSpec, cap, market)).rejects.toThrowError(/WRONG_TARGET/);
  });
});
```

- [ ] Run & confirm FAIL (RED) — `ClaudePlanner` does not yet accept an injectable `client`, and `plan()` is still the M2 stub:

```bash
npm test -w @shadowkit/agent -- test/claudePlanner.cap.test.ts
```

Expected failure (one of):
```
TypeError: planner.plan is not a function   // or: returns M2 placeholder, assertion fails
 FAIL  test/claudePlanner.cap.test.ts
```

### Step 3.3 — Implement `ClaudePlanner` (GREEN)

- [ ] Read `agent/src/planner.ts` (M2 baseline) before editing.
- [ ] Edit `agent/src/planner.ts`: replace the M2 `ClaudePlanner` stub with the real implementation. Add the needed imports at the top, keep `DeterministicPlanner` and the interfaces intact. The constructor accepts an optional injected `client` (for tests) and optional `logBus` (stored for Task 5); production callers pass neither extra and a real `Anthropic` client is created. **This Task-3 implementation does NOT yet emit streamed deltas to the LogBus** — that is Task 5, so Task 5's stream tests have an honest failing-first state.

```typescript
// ---- add these imports at the top of agent/src/planner.ts ----
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { ActionSpec } from "@shadowkit/shared";
import { SYSTEM_PROMPT, ACTION_PLAN_SCHEMA, buildUserMessage } from "./prompt.js";
import { validatePlan } from "./planValidation.js";
import type { LogBus } from "./logBus.js";

// ---- existing (foundation §3.5): keep these exactly ----
// export interface MarketData { pair: string; price: string; signal: "buy" | "sell" | "hold"; }
// export interface ActionPlan { amountIn: string; minOut: string; reasoning: string; }
// export interface Planner { plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan>; }

/** Minimal structural shape of the Anthropic stream we use (verified: @anthropic-ai/sdk
 *  MessageStream — .on("text", cb) + await .finalMessage(); typescript/claude-api/streaming.md).
 *  Declared here so a fake client can be injected in tests (network-stubbed, charter §7.2). */
export interface AnthropicLike {
  messages: {
    stream(args: unknown): {
      on(event: "text", cb: (delta: string) => void): unknown;
      finalMessage(): Promise<{ content: Array<{ type: string; text?: string }>; usage?: unknown }>;
    };
  };
}

export interface ClaudePlannerConfig {
  apiKey: string;
  model: string;
  /** Optional injected client (tests replay a recorded cassette). Default: real Anthropic. */
  client?: AnthropicLike;
  /** Optional log sink. In Task 5, each streamed reasoning delta is emitted as
   *  AgentLog{phase:"plan"} through this bus (accepted but unused until Task 5). */
  logBus?: LogBus;
}

/**
 * PRIMARY planner (M3). Calls claude-opus-4-8 via the Messages streaming API with:
 *  - a frozen, prompt-CACHED system block (cache_control: ephemeral) sized above the 4096-token
 *    Opus-4.8 minimum so caching actually engages (prompt.ts; shared/prompt-caching.md),
 *  - adaptive thinking (Opus 4.8: budget_tokens/temperature are removed — 400 if sent),
 *  - structured JSON output (output_config.format) so the result is machine-checkable.
 * The returned plan is re-validated by validatePlan, so ClaudePlanner NEVER returns an
 * over-cap / wrong-target / wrong-asset plan (defense-in-depth; spec §7.2).
 *
 * NOTE (TDD seam): this Task-3 implementation parses + validates the structured output but does
 * NOT yet emit streamed reasoning deltas to the LogBus — that behavior (the delta->AgentLog
 * mapping AND the empty-delta filter) is implemented in Task 5, where its tests fail first
 * (honest RED) before the streaming emission is added. `logBus` is accepted and stored here but
 * intentionally unused until Task 5. SOURCE: @anthropic-ai/sdk@0.100.1 (ctx7
 * /anthropics/anthropic-sdk-typescript + claude-api skill).
 */
export class ClaudePlanner implements Planner {
  private readonly client: AnthropicLike;
  private readonly model: string;
  protected readonly logBus?: LogBus; // protected: Task 5 uses it in plan()

  constructor(cfg: ClaudePlannerConfig) {
    this.client = cfg.client ?? (new Anthropic({ apiKey: cfg.apiKey }) as unknown as AnthropicLike);
    this.model = cfg.model;
    this.logBus = cfg.logBus;
  }

  async plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 1024,
      thinking: { type: "adaptive" }, // Opus 4.8: adaptive only (no budget_tokens / temperature)
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }, // cache prefix
      ],
      messages: [{ role: "user", content: buildUserMessage(spec, cap, market) }],
      output_config: { format: jsonSchemaOutputFormat(ACTION_PLAN_SCHEMA) }, // structured output
    });

    // NOTE: streamed-reasoning -> LogBus emission is added in Task 5 (it has its own failing-first
    // test). Task 3 only consumes the final structured output below.

    const final = await stream.finalMessage();
    const textBlock = final.content.find((b) => b.type === "text");
    if (!textBlock || typeof textBlock.text !== "string") {
      throw new Error("ClaudePlanner: model returned no text/structured output");
    }

    let parsed: { amountIn?: unknown; minOut?: unknown; reasoning?: unknown };
    try {
      // Streamed structured output lands the schema JSON VERBATIM in the first text block — this
      // invariant is verified against the live model in Task 4 (the recorder/live test) and pinned
      // by the cassette-realness guard in Step 3.2. If a future SDK/model change ever broke it, the
      // documented fallback is messages.parse() -> parsed_output (see the "Why stream not parse" note
      // below). JSON.parse throwing here surfaces as a planner failure (caught -> deterministic
      // fallback in AgentRunner, Task 7), never a silent bad plan.
      parsed = JSON.parse(textBlock.text);
    } catch {
      throw new Error(`ClaudePlanner: model output is not valid JSON: ${textBlock.text.slice(0, 80)}`);
    }
    if (
      typeof parsed.amountIn !== "string" ||
      typeof parsed.minOut !== "string" ||
      typeof parsed.reasoning !== "string"
    ) {
      throw new Error("ClaudePlanner: structured output missing required string fields");
    }

    const candidate: ActionPlan = {
      amountIn: parsed.amountIn,
      minOut: parsed.minOut,
      reasoning: parsed.reasoning,
    };
    // The planner re-validates its own output. Throws on any violation (never returns bad plan).
    return validatePlan(candidate, spec, cap);
  }
}
```

> **Why `client.messages.stream` (not `.parse`)?** We need both streamed reasoning *and* structured output. `output_config.format` "Works with: streaming" (`shared/tool-use-concepts.md` line 332, verified), so the streamed run still yields valid JSON in the final text block; we `JSON.parse` it ourselves. The `MessageStream` has **no** `parsed_output` accessor (verified: that helper is only on `client.messages.parse()`, ctx7 `helpers.md`), which is exactly why we extract from the text block. The assumption that the streamed text block is the schema JSON verbatim is **verified against the real model** in Task 4 (recorder Step 3.1 invariant (1) + the live test) and pinned by the cassette-realness guard, not assumed.
>
> **Documented fallback if the verbatim-text assumption ever breaks:** use the non-streaming `client.messages.parse({ ..., output_config: { format: jsonSchemaOutputFormat(ACTION_PLAN_SCHEMA) } })` for the authoritative, SDK-schema-validated `message.parsed_output`, and (optionally) a separate `client.messages.stream(...)` solely for reasoning deltas. The live test (Task 4) already exercises `messages.parse()` + `parsed_output`, so this path is proven to work; M3 keeps `stream()` on the primary path because the live test confirms the verbatim-text invariant holds for `claude-opus-4-8`.

### Step 3.4 — Run & confirm PASS (GREEN)

- [ ] Run:

```bash
npm test -w @shadowkit/agent -- test/claudePlanner.cap.test.ts
```

Expected:
```
 ✓ test/claudePlanner.cap.test.ts (7 tests)
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

(7 = 2 cassette-realness guards + 5 planner tests: at-cap accept, under-cap/partial-fill accept, over-cap reject, malformed reject, wrong-target reject.)

### Step 3.5 — No-cheating audit

- [ ] Confirm no skips/no faked-success in the cap test, and that the cassette is real JSON:

```bash
grep -nE "\.skip\(|\.only\(|it\.todo|expect\(true\)\.toBe\(true\)" agent/test/claudePlanner.cap.test.ts || echo "CLEAN"
node -e "JSON.parse(require('fs').readFileSync('agent/test/fixtures/anthropic-cassette.json','utf8')); console.log('cassette JSON OK')"
```

Expected:
```
CLEAN
cassette JSON OK
```

### Step 3.6 — Commit (BLOCKED until the cassette is a REAL capture)

- [ ] **Precondition (charter rule 4):** the recorder (Step 3.1) has produced `anthropic-cassette.json` from a real `claude-opus-4-8` run, the cassette-realness guards (Step 3.2) pass, and the Step 3.1 verify check printed "cassette is a REAL in-cap capture". Do NOT commit a fabricated/placeholder cassette. If you have no API key, this task stays blocked — do not check this box.
- [ ] Commit:

```bash
git add agent/src/planner.ts agent/scripts/record-cassette.mjs agent/test/fixtures/anthropic-cassette.json agent/test/claudePlanner.cap.test.ts
git commit -m "feat(agent): ClaudePlanner calls claude-opus-4-8 (cached, structured, in-cap)

Structured output parsed and re-validated by validatePlan so the planner never returns an
over-cap/wrong-target/wrong-asset plan (streamed reasoning -> LogBus is added in Task 5).
Network stubbed with a REAL recorded claude-opus-4-8 cassette for deterministic CI; the
cassette was produced by agent/scripts/record-cassette.mjs against the live API (NOT a
hand-faked success) and the cap test asserts it is a real in-cap capture (charter rule 4).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Live LLM integration test (REAL Anthropic call; charter rule 2) (TDD)

> **ORDERING (read first).** Task 4's live machinery is a **hard prerequisite of Task 3's commit**: the cassette Task 3 replays MUST come from a real run (Task 3 Step 3.1 recorder, which is the same live `stream()` call this task exercises). Practically, you authored Task 3's code (RED→GREEN against the cap test logic) but you cannot COMMIT Task 3 or check its boxes until you have run the recorder/live path here at least once with a real key and the cassette holds real bytes. The live test file itself is written now and SKIPS cleanly without a key (the one charter-allowed skip). If you have a key, run the live path (Step 4.3) BEFORE committing Task 3.

**Goal:** Prove the PRIMARY path works **without any fallback** by exercising the REAL Anthropic SDK against `claude-opus-4-8` and asserting (a) it returns a schema-conforming, in-cap `ActionPlan`, (b) the streamed structured output lands the schema JSON **verbatim** in the final text block (the assumption Task 3's parsing relies on), and (c) prompt caching is **genuinely** exercised (the cached prefix exceeds the verified 4096-token Opus-4.8 minimum, so a real write/read is observed) (foundation §7.2 "ClaudePlanner PRIMARY path (M3)"). This is **separate** from the deterministic fallback suite. It is env-gated behind `RUN_LIVE_LLM=1` + a present `ANTHROPIC_API_KEY`; when gated off it is **skipped with an explicit written justification** (the only skip allowed by charter rule 4), and the cassette-backed cap test (Task 3) still runs by default in CI.

**Files:**
- Create: `agent/test/claudePlanner.live.test.ts`

### Step 4.1 — Write the live test (skip-with-justification when ungated)

- [ ] Create `agent/test/claudePlanner.live.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { ClaudePlanner } from "../src/planner.js";
import { LogBus } from "../src/logBus.js";
import { SYSTEM_PROMPT, ACTION_PLAN_SCHEMA, buildUserMessage } from "../src/prompt.js";

const LIVE = process.env.RUN_LIVE_LLM === "1" && !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

// JUSTIFIED SKIP (charter rule 4): this test makes a REAL, billable network call to the
// Anthropic API and requires a live ANTHROPIC_API_KEY. It is gated behind RUN_LIVE_LLM=1 so
// CI without secrets does not flake/fail. The cassette-backed cap test
// (claudePlanner.cap.test.ts) runs by default and exercises the same parse+validate path
// against REAL recorded model bytes; this test additionally confirms the live model produces
// a valid, in-cap plan. Run it with: npm run test:live-llm -w @shadowkit/agent.
const live = LIVE ? describe : describe.skip;

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

live("ClaudePlanner (LIVE Anthropic, claude-opus-4-8)", () => {
  it("produces a schema-conforming, in-cap ActionPlan from the real model (primary works alone)", async () => {
    // The LogBus is passed so streaming wiring (added in Task 5) is exercised end-to-end here too,
    // but this test does NOT assert on streamed deltas — the delta->LogBus contract has its own
    // dedicated suite (claudePlanner.stream.test.ts, Task 5). This test's job is the charter rule 2
    // guarantee: the PRIMARY planner, calling the REAL model, returns a valid in-cap plan with no
    // fallback involved.
    const bus = new LogBus();
    const planner = new ClaudePlanner({ apiKey: process.env.ANTHROPIC_API_KEY!, model: MODEL, logBus: bus });
    const plan = await planner.plan(spec, cap, market);

    expect(plan.amountIn).toMatch(/^[0-9]+$/);
    expect(plan.minOut).toMatch(/^[0-9]+$/);
    expect(typeof plan.reasoning).toBe("string");
    expect(plan.reasoning.length).toBeGreaterThan(0);
    // PRIMARY guarantee on real output: in-cap and respects the floor.
    expect(BigInt(plan.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(plan.amountIn) > 0n).toBe(true);
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
  }, 60_000);

  it("the streamed structured output lands the schema JSON VERBATIM in the final text block", async () => {
    // Verifies the load-bearing assumption behind Task 3's text-block JSON.parse path (resolves the
    // "streamed structured output lands verbatim" risk): a streamed structured-output run on the
    // real model yields the schema JSON, exactly, in content[].type==="text" — no markdown fences,
    // no surrounding prose, no thinking-block contamination. If this ever fails, switch the primary
    // path to messages.parse() + parsed_output (Task 3 Step 3.3 fallback note).
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "adaptive" as const },
      system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content: buildUserMessage(spec, cap, market) }],
      output_config: { format: jsonSchemaOutputFormat(ACTION_PLAN_SCHEMA) },
    });
    const final = await stream.finalMessage();
    const textBlock = final.content.find((b) => b.type === "text");
    expect(textBlock).toBeTruthy();
    const text = (textBlock as { text: string }).text;
    // EXACTLY the JSON: parses cleanly, has only the three schema keys, no leading/trailing prose.
    expect(text.trim().startsWith("{")).toBe(true);
    expect(text.trim().endsWith("}")).toBe(true);
    expect(text).not.toMatch(/```/); // no markdown fences
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual(["amountIn", "minOut", "reasoning"]);
    expect(BigInt(parsed.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(parsed.minOut) >= BigInt(spec.minOut)).toBe(true);
  }, 60_000);

  it("prompt caching is genuinely exercised on a second identical call (cache write then read)", async () => {
    // PRECONDITION (the whole reason caching can work here): the cached system prefix MUST exceed
    // the verified 4096-token Opus-4.8 minimum, or caching silently never happens
    // (cache_creation_input_tokens stays 0). prompt.test.ts asserts the static size; here we assert
    // the live API actually reports a cache write or read. If this fails with both fields 0, the
    // prompt regressed below 4096 tokens (re-check prompt.ts) — caching is a PRIMARY M3 deliverable.
    expect(SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(18_000); // ~>=4096 tokens, cacheable on Opus

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const args = {
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "adaptive" as const },
      system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content: buildUserMessage(spec, cap, market) }],
      output_config: { format: jsonSchemaOutputFormat(ACTION_PLAN_SCHEMA) },
    };
    // First call writes the cache; second (same prefix, within the 5-min TTL) reads it. Because the
    // prefix is > 4096 tokens, at least one of write-then-read MUST be observed (verified threshold,
    // shared/prompt-caching.md). The sum of cache fields must be > 0 across the two calls.
    const first = await client.messages.parse(args);
    const second = await client.messages.parse(args);
    const wrote = (first.usage.cache_creation_input_tokens ?? 0) > 0;
    const read = (second.usage.cache_read_input_tokens ?? 0) > 0;
    expect(wrote || read).toBe(true);
    // Stronger: the cached prefix must account for a non-trivial token count on at least one call.
    expect(
      (first.usage.cache_creation_input_tokens ?? 0) +
        (second.usage.cache_read_input_tokens ?? 0),
    ).toBeGreaterThan(0);
    expect(second.parsed_output?.amountIn).toMatch(/^[0-9]+$/);
  }, 90_000);
});
```

### Step 4.2 — Confirm it SKIPS cleanly without a key (RED is "skipped", not "failed")

- [ ] Run without the gate (default CI behavior). It must report **skipped**, not failed:

```bash
npm test -w @shadowkit/agent -- test/claudePlanner.live.test.ts
```

Expected output:
```
 ↓ test/claudePlanner.live.test.ts (3 tests | 3 skipped)
 Test Files  1 skipped (1)
      Tests  3 skipped (3)
```

### Step 4.3 — Run it LIVE once (charter rule 2 requires it to have been exercised; also produces the cassette)

- [ ] With a real key present (run in your own terminal per environment rules — do not echo the key):

```bash
RUN_LIVE_LLM=1 npm run test:live-llm -w @shadowkit/agent
```

> **Note on the streaming assertion and ordering:** the first live test passes a `LogBus` but does NOT assert on streamed deltas, so it passes whether or not Task 5's streaming emission has landed. Run this live path once to produce/refresh the cassette (it is the same `stream()` call the recorder makes). The third test (prompt caching) requires the >=4096-token prompt from Task 2 — if both cache fields are 0, the prompt regressed below the threshold; fix `prompt.ts` and re-run.

Expected output (the model decides exact amounts; assertions only require valid + in-cap + verbatim JSON + a real cache write/read):
```
 ✓ test/claudePlanner.live.test.ts (3 tests)
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

- [ ] **Produce / refresh the cassette from this real run** (charter rule 4 — the committed cassette must be real model bytes). Run the recorder (it is what creates the cassette Task 3 commits; there is no placeholder path):

```bash
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" RUN_LIVE_LLM=1 node agent/scripts/record-cassette.mjs
npm test -w @shadowkit/agent -- test/claudePlanner.cap.test.ts
```

Expected: cassette written with real deltas + real in-cap finalText, and the cap test (incl. the cassette-realness guards) passes against the recorded bytes.

### Step 4.4 — No-cheating audit (the one allowed skip is justified inline)

- [ ] Confirm the only skip is the justified live gate:

```bash
grep -nE "describe\.skip|\.skip\(|\.only\(|it\.todo" agent/test/claudePlanner.live.test.ts
```

Expected output (one match — the `describe.skip` selected by the `live` ternary, with the JUSTIFIED SKIP comment directly above it; the line number depends on your file):
```
const live = LIVE ? describe : describe.skip;
```

### Step 4.5 — Commit

- [ ] Commit:

```bash
git add agent/test/claudePlanner.live.test.ts agent/test/fixtures/anthropic-cassette.json
git commit -m "test(agent): gated REAL Anthropic integration test proves primary planner works

claude-opus-4-8 returns a schema-conforming, in-cap ActionPlan and prompt caching is
exercised. Env-gated (RUN_LIVE_LLM=1) with written justification; cassette refreshed from a
real run (charter rules 2 & 4).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Reasoning stream rendered: implement delta→LogBus emission (TDD)

**Goal:** Implement and test that the planner's streamed reasoning is rendered as `AgentLog{phase:"plan"}` events on the `LogBus` (charter "reasoning stream rendered"; spec §6 "agent reasoning ... streamed to AgentBoardTerminal"). **This behavior was deliberately NOT implemented in Task 3** (Task 3 only parses + validates the final structured output), so the tests below have an HONEST failing-first state: they fail because the planner does not yet emit any delta to the LogBus. Task 5 adds the `stream.on("text", ...)` emission AND the empty-delta filter, turning the tests green. No "break-and-restore" of already-shipped code — genuine RED→GREEN (charter rule 4: "A task that shows green on first run without a prior red is invalid.").

**Files:**
- Create: `agent/test/claudePlanner.stream.test.ts`
- Modify: `agent/src/planner.ts` (`ClaudePlanner.plan` gains the `stream.on("text", ...)` → `LogBus.emit` emission with an empty-delta guard)

### Step 5.1 — Write the failing test (RED)

- [ ] Create `agent/test/claudePlanner.stream.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { ActionSpec } from "@shadowkit/shared";
import type { AgentLog } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { ClaudePlanner } from "../src/planner.js";
import { LogBus } from "../src/logBus.js";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

const DELTAS = ["Considering ", "the buy signal ", "at price 8.25, ", "execute full cap."];
const FINAL = JSON.stringify({ amountIn: "150000000000", minOut: "1200000000", reasoning: "ok" });

function makeFakeAnthropic(deltas: string[], finalText: string) {
  return {
    messages: {
      stream() {
        const handlers: Record<string, (d: string) => void> = {};
        return {
          on(event: string, cb: (d: string) => void) {
            handlers[event] = cb;
            return this;
          },
          async finalMessage() {
            for (const d of deltas) handlers["text"]?.(d);
            return { content: [{ type: "text", text: finalText }], usage: {} };
          },
        };
      },
    },
  };
}

describe("ClaudePlanner streaming → AgentBoardTerminal", () => {
  it("emits each reasoning delta as AgentLog{phase:'plan'} on the LogBus, in order", async () => {
    const bus = new LogBus();
    const logs: AgentLog[] = [];
    const unsub = bus.subscribe((l) => logs.push(l));

    const planner = new ClaudePlanner({
      apiKey: "test",
      model: "claude-opus-4-8",
      client: makeFakeAnthropic(DELTAS, FINAL),
      logBus: bus,
    });
    await planner.plan(spec, cap, market);
    unsub();

    const planLogs = logs.filter((l) => l.phase === "plan");
    expect(planLogs.length).toBe(DELTAS.length);
    expect(planLogs.map((l) => l.message)).toEqual(DELTAS);
    // Each log carries a timestamp (terminal renders chronological reasoning).
    for (const l of planLogs) expect(typeof l.ts).toBe("number");
  });

  it("does NOT throw when no LogBus is provided (streaming is optional)", async () => {
    const planner = new ClaudePlanner({
      apiKey: "test",
      model: "claude-opus-4-8",
      client: makeFakeAnthropic(DELTAS, FINAL),
      // no logBus
    });
    const plan = await planner.plan(spec, cap, market);
    expect(BigInt(plan.amountIn) <= BigInt(cap)).toBe(true);
  });

  it("does not emit empty deltas (terminal stays clean)", async () => {
    const bus = new LogBus();
    const logs: AgentLog[] = [];
    bus.subscribe((l) => logs.push(l));
    const planner = new ClaudePlanner({
      apiKey: "test",
      model: "claude-opus-4-8",
      client: makeFakeAnthropic(["", "real chunk", ""], FINAL),
      logBus: bus,
    });
    await planner.plan(spec, cap, market);
    expect(logs.filter((l) => l.phase === "plan").map((l) => l.message)).toEqual(["real chunk"]);
  });
});
```

- [ ] Run & confirm GENUINE FAIL (RED) — Task 3's planner does NOT yet emit streamed deltas to the LogBus, so the "emits each reasoning delta" and "does not emit empty deltas" tests fail (zero plan-phase logs are produced):

```bash
npm test -w @shadowkit/agent -- test/claudePlanner.stream.test.ts
```

Expected RED (no deltas reach the bus because the emission is unimplemented):
```
 FAIL  test/claudePlanner.stream.test.ts > emits each reasoning delta as AgentLog{phase:'plan'} on the LogBus, in order
 AssertionError: expected 0 to be 4 // planLogs.length
 FAIL  test/claudePlanner.stream.test.ts > does not emit empty deltas (terminal stays clean)
 AssertionError: expected [] to deeply equal [ 'real chunk' ]
```

(The "does NOT throw when no LogBus is provided" test may already pass — it only asserts the plan resolves in-cap, which Task 3 already satisfies. The two streaming assertions are the ones that must be RED first.)

### Step 5.2 — Implement the delta→LogBus emission + empty-delta guard (GREEN)

- [ ] Read `agent/src/planner.ts` before editing.
- [ ] In `ClaudePlanner.plan`, add the streamed-reasoning emission. Replace the Task-3 placeholder comment (`// NOTE: streamed-reasoning -> LogBus emission is added in Task 5 ...`) — which sits immediately after the `const stream = this.client.messages.stream({ ... });` block and before `const final = await stream.finalMessage();` — with the real `stream.on("text", ...)` handler. The `&& delta` guard skips empty chunks so the terminal stays clean:

```typescript
    // Stream reasoning to the terminal as it arrives. Empty deltas are dropped (terminal clean).
    // (Implemented in Task 5 with its own failing-first test; logBus stored by the ctor in Task 3.)
    stream.on("text", (delta: string) => {
      if (this.logBus && delta) {
        this.logBus.emit({ ts: Date.now(), phase: "plan", message: delta });
      }
    });
```

The resulting `plan()` body, in order, is: build the stream (Task 3) → register the `on("text", ...)` emission (this step) → `await stream.finalMessage()` → extract text block → `JSON.parse` → field-check → `validatePlan` (all Task 3). The `logBus` field stays `protected` so this method can read it.

- [ ] Re-run & confirm GREEN:

```bash
npm test -w @shadowkit/agent -- test/claudePlanner.stream.test.ts
```

Expected:
```
 ✓ test/claudePlanner.stream.test.ts (3 tests)
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

- [ ] Re-run the cap test to confirm the new emission did not regress the parse/validate path:

```bash
npm test -w @shadowkit/agent -- test/claudePlanner.cap.test.ts
```

Expected: `7 passed (7)` (cassette replay drives deltas through the new handler; the cap test passes a planner without a `logBus` so emission is a no-op there, and with one in the realness/streaming cases it emits cleanly).

### Step 5.3 — Commit

- [ ] Commit (both the test and the planner change land together — the implementation that turns the red green):

```bash
git add agent/src/planner.ts agent/test/claudePlanner.stream.test.ts
git commit -m "feat(agent): stream planner reasoning as AgentLog{phase:plan} to the terminal

ClaudePlanner.plan now emits each non-empty streamed text delta through the optional LogBus
as AgentLog{phase:plan}; empty deltas are filtered. Tests fail first (Task 3 did not emit),
then pass (genuine RED->GREEN, charter rule 4).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Deterministic fallback planner suite (TDD; charter rule 3)

**Goal:** The M2 `DeterministicPlanner` is the named fallback (spec §11 M3 fallback column: "deterministic (M2)"). Charter rule 3 requires it to be **real, config-selectable, and have its own passing test suite**. This task gives it that suite (extend if M2 already shipped one) and proves it produces an in-cap plan with no LLM.

**Files:**
- Create/extend: `agent/test/deterministicPlanner.test.ts`
- (Verify, not modify) `agent/src/planner.ts` `DeterministicPlanner` (foundation §3.5: "amountIn=cap, minOut from market price − slippage. No LLM.")

### Step 6.1 — Write the fallback suite (RED if M2 left `DeterministicPlanner` a stub)

- [ ] Create `agent/test/deterministicPlanner.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { DeterministicPlanner } from "../src/planner.js";
import { validatePlan } from "../src/planValidation.js";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

describe("DeterministicPlanner (M2 fallback, no LLM)", () => {
  it("swaps the full cap (amountIn == cap)", async () => {
    const p = new DeterministicPlanner();
    const plan = await p.plan(spec, cap, market);
    expect(plan.amountIn).toBe(cap);
  });

  it("produces an in-cap, valid plan (passes validatePlan)", async () => {
    const p = new DeterministicPlanner();
    const plan = await p.plan(spec, cap, market);
    expect(() => validatePlan(plan, spec, cap)).not.toThrow();
    expect(BigInt(plan.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
  });

  it("derives minOut from market price minus the configured slippage (BigInt math)", async () => {
    // default slippage; minOut must be a positive integer and >= floor.
    const p = new DeterministicPlanner({ slippageBps: 50 }); // 0.5%
    const plan = await p.plan(spec, cap, market);
    expect(plan.minOut).toMatch(/^[0-9]+$/);
    expect(BigInt(plan.minOut) > 0n).toBe(true);
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
  });

  it("is fully synchronous-deterministic: identical inputs → identical plan, no network", async () => {
    const p = new DeterministicPlanner();
    const a = await p.plan(spec, cap, market);
    const b = await p.plan(spec, cap, market);
    expect(a).toEqual(b);
  });

  it("never makes an LLM/network call (no apiKey, no client required)", async () => {
    // Constructing with no config must work — proves it needs no Anthropic key.
    const p = new DeterministicPlanner();
    await expect(p.plan(spec, cap, market)).resolves.toBeDefined();
  });
});
```

- [ ] Run:

```bash
npm test -w @shadowkit/agent -- test/deterministicPlanner.test.ts
```

If `DeterministicPlanner` already works (M2 landed it), this is GREEN. If M2 left it a stub, this is RED — implement the minimal real body in Step 6.2.

### Step 6.2 — (If RED) implement `DeterministicPlanner` minimally (GREEN)

- [ ] If the suite is RED, ensure `agent/src/planner.ts` contains this real `DeterministicPlanner` (foundation §3.5: amountIn=cap, minOut from price − slippage; pure BigInt, no LLM):

```typescript
export interface DeterministicPlannerConfig {
  slippageBps?: number; // basis points of slippage tolerance; default 100 (1%)
}

/**
 * FALLBACK planner (spec §11 M3 fallback). No LLM, no network. Swaps the full cap and sets
 * minOut = max(proposalFloor, price-implied-out * (1 - slippage)). Deterministic; used when
 * the LLM is disabled (config) or unavailable (auto-fallback in AgentRunner). All arithmetic
 * is BigInt to preserve i128 precision (foundation §5).
 */
export class DeterministicPlanner implements Planner {
  private readonly slippageBps: number;
  constructor(cfg?: DeterministicPlannerConfig) {
    this.slippageBps = cfg?.slippageBps ?? 100;
  }
  async plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan> {
    const amountIn = cap; // swap the full approved cap
    // price is a decimal string (e.g. "8.25" output units per input unit). Convert with a
    // fixed scale to avoid floats: scale price by 1e6, compute, then divide out.
    const SCALE = 1_000_000n;
    const [whole, frac = ""] = market.price.split(".");
    const fracPadded = (frac + "000000").slice(0, 6);
    const priceScaled = BigInt(whole) * SCALE + BigInt(fracPadded || "0"); // price * 1e6
    const expectedOut = (BigInt(amountIn) * priceScaled) / SCALE;          // input * price
    const afterSlippage = (expectedOut * BigInt(10_000 - this.slippageBps)) / 10_000n;
    const floor = BigInt(spec.minOut);
    const minOutV = afterSlippage > floor ? afterSlippage : floor;         // never below floor
    return {
      amountIn,
      minOut: minOutV.toString(),
      reasoning: `Deterministic fallback: swap full cap ${amountIn}; minOut ${minOutV} at ${this.slippageBps}bps slippage from price ${market.price}.`,
    };
  }
}
```

- [ ] Re-run & confirm GREEN:

```bash
npm test -w @shadowkit/agent -- test/deterministicPlanner.test.ts
```

Expected:
```
 ✓ test/deterministicPlanner.test.ts (5 tests)
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### Step 6.3 — Commit

- [ ] Commit:

```bash
git add agent/src/planner.ts agent/test/deterministicPlanner.test.ts
git commit -m "test(agent): deterministic fallback planner suite (in-cap, no LLM, deterministic)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — `AgentRunner` planner selection + auto-fallback + idempotency (TDD)

**Goal:** Wire the planner into `AgentRunner` (foundation §3.5). `AgentConfig.useDeterministicPlanner` selects the planner (M2 default `true`; M3 sets `false` to use Claude). On any `ClaudePlanner` failure (LLM down, invalid plan, network error), the runner **automatically falls back to `DeterministicPlanner`**, logging the fallback as `AgentLog{phase:"error"}` then continuing. Idempotency (single-shot per `proposalId`) is preserved because the unchanged `Executor.executeSwap` calls `mark_executed` exactly once — the test asserts the executor is invoked exactly once regardless of planner path.

**Files:**
- Modify: `agent/src/index.ts` (`AgentRunner.run` planner selection + auto-fallback + plan→executor wiring)
- Create: `agent/test/agentRunner.fallback.test.ts`

### Step 7.1 — Write the failing test (RED)

- [ ] Create `agent/test/agentRunner.fallback.test.ts`. It injects fakes for the planner dependencies and the executor so we test selection/fallback/idempotency without a network or chain:

```typescript
import { describe, it, expect, vi } from "vitest";
import type { ActionSpec, AgentLog } from "@shadowkit/shared";
import type { ActionPlan, MarketData, Planner } from "../src/planner.js";
import { AgentRunner } from "../src/index.js";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

const baseCfg = {
  rpcUrl: "http://localhost:8000/rpc",
  networkPassphrase: "Test SDF Network ; September 2015",
  govVaultId: "CGOV0000000000000000000000000000000000000000000000000000000",
  agentPolicyId: "CPOL0000000000000000000000000000000000000000000000000000000",
  swapVenueId: "CAMM0000000000000000000000000000000000000000000000000000000",
  sessionSecretKey: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  premiumDataUrl: "http://localhost:4021/market/USDC-XLM",
  anthropicApiKey: "test",
  useDeterministicPlanner: false,
};

// Fake deps the runner uses. AgentRunner must accept these via an injection hook (Step 7.2).
function fakeDeps(opts: {
  approved?: boolean;
  market?: MarketData;
  claudePlan?: ActionPlan | Error;
}) {
  const executeSwap = vi.fn(async () => ({ txHash: "TXHASH123" }));
  return {
    watcher: { waitForApproved: vi.fn(async () => undefined) },
    dataClient: { fetchMarket: vi.fn(async () => opts.market ?? market) },
    govReader: {
      capOf: vi.fn(async () => cap),
      actionOf: vi.fn(async () => spec),
    },
    executor: { executeSwap },
    // Planner factory: returns a Planner whose plan() resolves/rejects per the option.
    makeClaudePlanner: (): Planner => ({
      plan: async () => {
        if (opts.claudePlan instanceof Error) throw opts.claudePlan;
        return opts.claudePlan ?? { amountIn: cap, minOut: "1200000000", reasoning: "llm plan" };
      },
    }),
    makeDeterministicPlanner: (): Planner => ({
      plan: async () => ({ amountIn: cap, minOut: "1100000000", reasoning: "deterministic plan" }),
    }),
    _executeSwap: executeSwap,
  };
}

describe("AgentRunner planner selection + auto-fallback + idempotency", () => {
  it("uses ClaudePlanner when useDeterministicPlanner=false", async () => {
    const deps = fakeDeps({});
    const runner = new AgentRunner(baseCfg, deps);
    const logs: AgentLog[] = [];
    const res = await runner.run(0, (l) => logs.push(l));

    expect(res.txHash).toBe("TXHASH123");
    // executor called exactly once with the LLM plan's amounts (single-shot / idempotent).
    expect(deps._executeSwap).toHaveBeenCalledTimes(1);
    const [planArg] = deps._executeSwap.mock.calls[0];
    expect(planArg.reasoning).toBe("llm plan");
    // a "plan" phase and a terminal "done" phase were logged.
    expect(logs.some((l) => l.phase === "plan")).toBe(true);
    expect(logs.some((l) => l.phase === "done")).toBe(true);
  });

  it("uses DeterministicPlanner when useDeterministicPlanner=true (config fallback)", async () => {
    const deps = fakeDeps({});
    const runner = new AgentRunner({ ...baseCfg, useDeterministicPlanner: true }, deps);
    await runner.run(0, () => {});
    const [planArg] = deps._executeSwap.mock.calls[0];
    expect(planArg.reasoning).toBe("deterministic plan");
    expect(deps._executeSwap).toHaveBeenCalledTimes(1);
  });

  it("AUTO-FALLS-BACK to DeterministicPlanner when ClaudePlanner throws", async () => {
    const deps = fakeDeps({ claudePlan: new Error("LLM unavailable") });
    const runner = new AgentRunner(baseCfg, deps); // useDeterministicPlanner=false
    const logs: AgentLog[] = [];
    const res = await runner.run(0, (l) => logs.push(l));

    expect(res.txHash).toBe("TXHASH123");
    const [planArg] = deps._executeSwap.mock.calls[0];
    expect(planArg.reasoning).toBe("deterministic plan"); // fell back
    // the fallback was logged as an error-phase event (visible in the terminal).
    expect(logs.some((l) => l.phase === "error" && /fallback/i.test(l.message))).toBe(true);
    // still exactly one execution — idempotency preserved across the fallback.
    expect(deps._executeSwap).toHaveBeenCalledTimes(1);
  });

  it("AUTO-FALLS-BACK when ClaudePlanner returns an over-cap plan (caught by validatePlan inside planner)", async () => {
    // ClaudePlanner.plan itself throws OVER_CAP (Task 3); simulate by rejecting.
    const deps = fakeDeps({ claudePlan: new Error("OVER_CAP: amountIn exceeds cap") });
    const runner = new AgentRunner(baseCfg, deps);
    await runner.run(0, () => {});
    const [planArg] = deps._executeSwap.mock.calls[0];
    expect(planArg.reasoning).toBe("deterministic plan");
    expect(deps._executeSwap).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] Run & confirm FAIL (RED) — `AgentRunner` does not yet accept injected deps / does not auto-fall-back:

```bash
npm test -w @shadowkit/agent -- test/agentRunner.fallback.test.ts
```

Expected failure:
```
 FAIL  test/agentRunner.fallback.test.ts
 TypeError: ... (AgentRunner ctor ignores deps / no fallback path)
```

### Step 7.2 — Implement the selection + auto-fallback in `AgentRunner` (GREEN)

- [ ] Read `agent/src/index.ts` (M2 baseline `AgentRunner`) before editing.
- [ ] Edit `agent/src/index.ts` so `AgentRunner`:
  1. Accepts an optional second constructor arg `deps` (an injection seam for tests). In production, `deps` is undefined and real instances are built from `cfg`.
  2. Selects the planner by `cfg.useDeterministicPlanner`.
  3. Wraps the `ClaudePlanner` call in try/catch and falls back to `DeterministicPlanner` on any throw, logging `AgentLog{phase:"error"}`.
  4. Passes the validated plan to `Executor.executeSwap` exactly once (idempotency unchanged).

```typescript
import type { ActionSpec, AgentLog } from "@shadowkit/shared";
import type { ActionPlan, MarketData, Planner } from "./planner.js";
import { ClaudePlanner, DeterministicPlanner } from "./planner.js";
import { Watcher } from "./watcher.js";
import { DataClient } from "./dataClient.js";
import { Executor } from "./executor.js";
import { LogBus } from "./logBus.js";
// Generated GovVault binding (foundation §1: packages/shared/src/bindings). Used by makeGovReader
// to read the on-chain cap_of/action_of entrypoints (foundation §2.2). M1/M2 already generated it.
import { Client as GovVaultClient } from "@shadowkit/shared/bindings";

export interface AgentConfig {
  rpcUrl: string;
  networkPassphrase: string;
  govVaultId: string;
  agentPolicyId: string;
  swapVenueId: string;
  sessionSecretKey: string;
  premiumDataUrl: string;
  anthropicApiKey: string;
  useDeterministicPlanner: boolean; // M2 default true; M3 sets false to use Claude
}

/** TS read-adapter over the GovVault binding's cap_of/action_of (foundation §3.5 amendment,
 *  §2.2 entrypoints). Invents NO new contract method. */
export interface GovReader {
  capOf(proposalId: number): Promise<string>;       // i128 -> decimal string (foundation §5)
  actionOf(proposalId: number): Promise<ActionSpec>;
}

/** Injection seam for tests (charter rule 4: no mocking-away the thing under test — these are
 *  the *collaborators*, not the planner-selection logic, which runs for real here).
 *  Ratified in foundation §3.5 (M3 AMENDMENT) before this plan relies on it. */
export interface AgentDeps {
  watcher: { waitForApproved(proposalId: number, pollMs?: number): Promise<void> };
  dataClient: { fetchMarket(pair: string): Promise<MarketData> };
  govReader: GovReader;
  executor: {
    executeSwap(plan: ActionPlan, spec: ActionSpec, cap: string, proposalId: number): Promise<{ txHash: string }>;
  };
  makeClaudePlanner(logBus: LogBus): Planner;
  makeDeterministicPlanner(): Planner;
}

/**
 * Build a GovReader over the generated GovVault binding (foundation §1 bindings, §2.2 entrypoints).
 * No new contract method — it calls the EXISTING cap_of/action_of and normalizes to the TS shapes
 * (i128 -> decimal string; contract ActionSpec -> @shadowkit/shared ActionSpec, §3.1). M2 already
 * needs cap/action to build the swap; M3 names this adapter `makeGovReader` returning `GovReader`
 * so AgentDeps has a stable seam. If M2's index.ts already exposes an equivalent reader, reuse it
 * and have this delegate to it — do NOT duplicate the read logic (DRY).
 */
export function makeGovReader(cfg: AgentConfig): GovReader {
  // VERIFIED binding usage pattern (stellar contract bindings typescript): construct with
  // `new Client({ ...networks.<net>, rpcUrl })`, call read-only methods as `await client.fn({args})`,
  // and read `const { result } = ...` (read-only methods auto-simulate; `result` is the typed value).
  // SOURCE: developers.stellar.org "Call Stellar Contract from Astro Frontend" / "fully-typed-contracts".
  const client = new GovVaultClient({
    contractId: cfg.govVaultId,
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: cfg.networkPassphrase,
  });
  return {
    async capOf(proposalId: number): Promise<string> {
      // cap_of(id) -> i128; the binding yields a bigint — normalize to a decimal string (§5).
      const { result } = await client.cap_of({ id: proposalId });
      return result.toString();
    },
    async actionOf(proposalId: number): Promise<ActionSpec> {
      // action_of(id) -> on-chain ActionSpec; map asset_in/asset_out (Address) + amount/min_out
      // (i128 -> decimal string) into the @shadowkit/shared ActionSpec (foundation §3.1 / §5).
      const { result } = await client.action_of({ id: proposalId });
      return {
        kind: "swap",
        assetIn: result.asset_in.toString(),
        assetOut: result.asset_out.toString(),
        amount: result.amount.toString(),
        minOut: result.min_out.toString(),
      };
    },
  };
}

export class AgentRunner {
  private readonly cfg: AgentConfig;
  private readonly deps: AgentDeps;

  constructor(cfg: AgentConfig, deps?: AgentDeps) {
    this.cfg = cfg;
    this.deps =
      deps ??
      (() => {
        const watcher = new Watcher({ rpcUrl: cfg.rpcUrl, govVaultId: cfg.govVaultId });
        const dataClient = new DataClient({
          url: cfg.premiumDataUrl,
          signerSecret: cfg.sessionSecretKey,
          network: cfg.networkPassphrase,
        });
        const executor = new Executor({
          rpcUrl: cfg.rpcUrl,
          networkPassphrase: cfg.networkPassphrase,
          agentPolicyId: cfg.agentPolicyId,
          swapVenueId: cfg.swapVenueId,
          sessionSecretKey: cfg.sessionSecretKey,
        });
        // govReader: TS read-adapter over the generated GovVault binding (cap_of/action_of, §2.2).
        const govReader = makeGovReader(cfg);
        return {
          watcher,
          dataClient,
          govReader,
          executor,
          makeClaudePlanner: (logBus: LogBus) =>
            new ClaudePlanner({ apiKey: cfg.anthropicApiKey, model: resolveModel(), logBus }),
          makeDeterministicPlanner: () => new DeterministicPlanner(),
        };
      })();
  }

  /** Full loop: watch → reveal(done in M5) → data → plan → sign → submit → done. */
  async run(proposalId: number, onLog: (l: AgentLog) => void): Promise<{ txHash: string }> {
    const bus = new LogBus();
    const unsub = bus.subscribe(onLog); // forward every LogBus event to the caller's terminal sink
    try {
      await this.deps.watcher.waitForApproved(proposalId);
      const spec = await this.deps.govReader.actionOf(proposalId);
      const cap = await this.deps.govReader.capOf(proposalId);

      bus.emit({ ts: Date.now(), phase: "data", message: "Fetching premium market data..." });
      const market = await this.deps.dataClient.fetchMarket(spec.assetIn + "-" + spec.assetOut);

      const plan = await this.selectAndPlan(spec, cap, market, bus);

      bus.emit({ ts: Date.now(), phase: "sign", message: `Signing swap of ${plan.amountIn} (minOut ${plan.minOut})` });
      const { txHash } = await this.deps.executor.executeSwap(plan, spec, cap, proposalId);

      bus.emit({ ts: Date.now(), phase: "done", message: "Swap executed.", txHash });
      return { txHash };
    } finally {
      unsub();
    }
  }

  /** Planner selection + AUTO-FALLBACK. Returns a plan that has already been validated by the
   *  chosen planner (ClaudePlanner re-validates internally; DeterministicPlanner is in-cap by
   *  construction). On any ClaudePlanner failure, logs phase:"error" and falls back. */
  private async selectAndPlan(
    spec: ActionSpec,
    cap: string,
    market: MarketData,
    bus: LogBus,
  ): Promise<ActionPlan> {
    if (this.cfg.useDeterministicPlanner) {
      bus.emit({ ts: Date.now(), phase: "plan", message: "Using deterministic planner (config)." });
      return this.deps.makeDeterministicPlanner().plan(spec, cap, market);
    }
    try {
      bus.emit({ ts: Date.now(), phase: "plan", message: "Claude is planning the execution..." });
      return await this.deps.makeClaudePlanner(bus).plan(spec, cap, market);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      bus.emit({
        ts: Date.now(),
        phase: "error",
        message: `Claude planner failed (${reason}); falling back to deterministic planner.`,
      });
      return this.deps.makeDeterministicPlanner().plan(spec, cap, market);
    }
  }
}

/** Resolve the planner model: env override wins, else the latest Opus (foundation §6, configurable). */
function resolveModel(): string {
  return process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
}
```

> **Notes for the implementer:**
> - `GovReader`, `AgentDeps`, and the two-arg `AgentRunner(cfg, deps?)` are now **defined in the foundation** (§3.5 M3 AMENDMENT) — they are not invented here. `makeGovReader` is defined ABOVE in this same `index.ts` and reads ONLY the existing GovVault `cap_of`/`action_of` entrypoints (foundation §2.2) via the generated binding (`@shadowkit/shared/bindings`, foundation §1); it invents no new contract method. `Watcher`/`DataClient`/`Executor` are unchanged M2 modules (foundation §3.5).
> - If M2's `index.ts` already exposes an equivalent cap/action reader, have `makeGovReader` delegate to it rather than duplicating the binding calls (DRY). The `GovReader` shape (`capOf`/`actionOf` returning a decimal string / `ActionSpec`) is the stable seam M3 relies on; keep it.
> - The generated binding's exact result accessor (`{ result }` vs `.result`) and i128 representation (bigint) follow the verified `stellar contract bindings typescript` pattern (cited in `makeGovReader`); if your generated binding differs, adapt the two normalizers there — do not change the `GovReader` interface.
> - `resolveModel()` makes the model **configurable** per the milestone requirement ("Latest Claude model, configurable"): set `ANTHROPIC_MODEL` to pin a different model; default is `claude-opus-4-8`.

### Step 7.3 — Run & confirm PASS (GREEN)

- [ ] Run:

```bash
npm test -w @shadowkit/agent -- test/agentRunner.fallback.test.ts
```

Expected:
```
 ✓ test/agentRunner.fallback.test.ts (4 tests)
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

### Step 7.4 — No-cheating audit

- [ ] Confirm no skips and the executor really is asserted (not mocked-away to always succeed silently):

```bash
grep -nE "\.skip\(|\.only\(|it\.todo|expect\(true\)\.toBe\(true\)" agent/test/agentRunner.fallback.test.ts || echo "CLEAN"
grep -c "toHaveBeenCalledTimes(1)" agent/test/agentRunner.fallback.test.ts
```

Expected:
```
CLEAN
3
```

### Step 7.5 — Commit

- [ ] Commit:

```bash
git add agent/src/index.ts agent/test/agentRunner.fallback.test.ts
git commit -m "feat(agent): AgentRunner selects planner by config, auto-falls-back to deterministic

ClaudePlanner failure (LLM down / invalid plan) logs phase:error and falls back to the M2
deterministic planner; executor runs exactly once so single-shot idempotency is preserved.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Documentation, env, and full-suite green (verification before completion)

**Goal:** Document the new config, run the entire M3 suite (primary + fallback) green, and confirm the no-cheating audit across all M3 test files. This is the `superpowers:verification-before-completion` gate.

**Files:**
- Modify: `.env.example`
- (No code) full-suite run + audit

### Step 8.1 — Document the env vars

- [ ] Read `.env.example` first, then add the M3 entries (keep existing M0–M2 lines):

```bash
# --- M3: Claude LLM-bounded planner ---
# Required for the PRIMARY (Claude) planner. Without it, set USE_DETERMINISTIC_PLANNER=1.
ANTHROPIC_API_KEY=
# Planner model (configurable). Default if unset: claude-opus-4-8 (latest Opus).
ANTHROPIC_MODEL=claude-opus-4-8
# Fallback switch: "1" forces the deterministic (M2) planner; unset/"0" uses Claude with
# automatic fallback to deterministic on failure.
USE_DETERMINISTIC_PLANNER=0
# Gate for the live LLM integration test (agent/test/claudePlanner.live.test.ts).
RUN_LIVE_LLM=0
```

### Step 8.2 — Run the full M3 agent suite (PRIMARY path, default config)

- [ ] Run every M3 agent test (the cassette-backed primary tests run by default; the live test skips without the gate):

```bash
npm test -w @shadowkit/agent
```

Expected (all 7 M3 files; live test's 3 tests skipped without the gate). Exact ordering may vary; the file count and totals are what matters:
```
 ✓ test/planValidation.test.ts (14 tests)
 ✓ test/prompt.test.ts (6 tests)
 ✓ test/claudePlanner.cap.test.ts (7 tests)
 ✓ test/claudePlanner.stream.test.ts (3 tests)
 ✓ test/deterministicPlanner.test.ts (5 tests)
 ✓ test/agentRunner.fallback.test.ts (4 tests)
 ↓ test/claudePlanner.live.test.ts (3 tests | 3 skipped)
 Test Files  6 passed | 1 skipped (7)
      Tests  39 passed | 3 skipped (42)
```

> **Test-count reconciliation (all 7 files created in Tasks 1-7):** planValidation 14 (Task 1) + prompt 6 (Task 2) + claudePlanner.cap 7 (Task 3) + claudePlanner.live 3 (Task 4, skipped by default) + claudePlanner.stream 3 (Task 5) + deterministicPlanner 5 (Task 6) + agentRunner.fallback 4 (Task 7) = **42 tests across 7 files**; **39 pass by default**, **3 skip** (the justified live gate). With `RUN_LIVE_LLM=1` + a key, the live file's 3 pass too (42 passed, 0 skipped).

### Step 8.3 — Run the FALLBACK suite under its config switch (charter rule 3)

- [ ] Run the fallback-config suite (proves the deterministic path passes under `USE_DETERMINISTIC_PLANNER=1`):

```bash
npm run test:fallback -w @shadowkit/agent
```

Expected:
```
 ✓ test/deterministicPlanner.test.ts (5 tests)
 ✓ test/agentRunner.fallback.test.ts (4 tests)
 Test Files  2 passed (2)
      Tests  9 passed (9)
```

### Step 8.4 — Run the live integration test once (charter rule 2) and (re)produce the cassette

> This step was ALREADY required before Task 3 could be committed (Task 4 ORDERING gate). Re-run it here as the final verification that the live primary path, the verbatim-JSON invariant, and prompt caching all hold, and that the committed cassette matches the current prompt.

- [ ] In your own terminal (do not echo the key), with a real `ANTHROPIC_API_KEY`:

```bash
RUN_LIVE_LLM=1 npm run test:live-llm -w @shadowkit/agent
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" RUN_LIVE_LLM=1 node agent/scripts/record-cassette.mjs
npm test -w @shadowkit/agent -- test/claudePlanner.cap.test.ts
```

Expected: live test passes (3 passed — in-cap plan, verbatim JSON, real cache write/read), cassette (re)written with real bytes, cap test (7 passed, incl. the cassette-realness guards) still passes against the cassette.

### Step 8.5 — No-cheating audit across all M3 test files (charter rule 4)

- [ ] Grep every M3 test file for forbidden patterns; the only allowed hit is the justified `describe.skip` in the live test:

```bash
grep -rnE "#\[ignore\]|\.skip\(|\.only\(|it\.todo|xfail|assert\(true\)|expect\(true\)\.toBe\(true\)" agent/test/
```

Expected output (exactly one line — the justified live gate; everything else clean; the line number depends on your file):
```
agent/test/claudePlanner.live.test.ts:<N>:const live = LIVE ? describe : describe.skip;
```

Confirm the JUSTIFIED SKIP comment is present directly above that line (Step 4.1). No other matches are permitted without an inline written justification. (Note: Task 5 removed the manufactured break-and-restore dance, so there is no transient skip/edit anywhere in the stream test.)

### Step 8.6 — TypeScript builds clean

- [ ] Type-check the agent package (strict mode; no `any` leaks in the new files):

```bash
npx tsc -p agent/tsconfig.json --noEmit 2>&1 | head -20 || echo "TSC FAILED"
```

Expected:
```
(no output — clean compile)
```

(If `agent/tsconfig.json` does not exist yet, use the workspace TS config: `npx tsc -p tsconfig.base.json --noEmit` per foundation §1.)

### Step 8.7 — Commit

- [ ] Commit:

```bash
git add .env.example
git commit -m "docs(agent): document M3 planner env vars; full M3 suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Definition of Done (M3)

All boxes must be checked and the listed commands must show the expected output:

- [ ] **PRIMARY works without fallback.** `ClaudePlanner` calls real `claude-opus-4-8` (streaming, structured output, adaptive thinking) and returns a valid in-cap `ActionPlan`. Proven by: `RUN_LIVE_LLM=1 npm run test:live-llm -w @shadowkit/agent` → 3 passed (run at least once), AND the cassette-backed `claudePlanner.cap.test.ts` → 7 passed by default in CI.
- [ ] **Prompt caching genuinely engages.** The cached `SYSTEM_PROMPT` exceeds the VERIFIED 4096-token Opus-4.8 minimum (prompt.test.ts asserts >=18,000 chars / >4096 tokens), so the live caching test observes a real `cache_creation_input_tokens`/`cache_read_input_tokens` > 0 across two identical calls (`claudePlanner.live.test.ts` test 3). A sub-4096 prefix would silently never cache — this DoD item fails if the prompt regresses below the threshold.
- [ ] **Streamed structured output lands verbatim.** `claudePlanner.live.test.ts` test 2 asserts the streamed final text block is exactly the schema JSON (no fences/prose), so Task 3's text-block `JSON.parse` path is sound; the cassette-realness guard pins the same invariant in CI.
- [ ] **Reasoning streamed to the terminal.** `claudePlanner.stream.test.ts` → 3 passed: streamed deltas surface as `AgentLog{phase:"plan"}` on the `LogBus`; the emission was implemented in Task 5 with an honest failing-first state (no break-and-restore).
- [ ] **Plan validation rejects bad plans BEFORE submit, and accepts under-cap.** `planValidation.test.ts` → 14 passed: under-cap accept, at-cap accept, over-cap / wrong-target / wrong-asset / malformed all rejected; BigInt comparison (no precision loss).
- [ ] **Planner respects cap (both boundaries).** `claudePlanner.cap.test.ts` → 7 passed: asserts `amountIn <= cap` (BigInt) for real recorded output, accepts a strictly under-cap partial fill, and throws on hallucinated over-cap / malformed / wrong-target responses. 2 of the 7 are cassette-realness guards proving the cassette is a REAL in-cap capture.
- [ ] **Deterministic fallback is real, config-selectable, and tested.** `npm run test:fallback -w @shadowkit/agent` → 9 passed; `DeterministicPlanner` selected by `USE_DETERMINISTIC_PLANNER=1` and auto-selected on `ClaudePlanner` failure.
- [ ] **Auto-fallback + idempotency.** `agentRunner.fallback.test.ts` → 4 passed: Claude-failure → deterministic (logged `phase:"error"`), executor invoked exactly once (`mark_executed` single-shot preserved).
- [ ] **Client cap guard + on-chain backstop both remain.** `validatePlan` runs client-side (Tasks 1, 3, 7); M2 `AgentPolicy` on-chain gate is unchanged (not touched by M3).
- [ ] **Scope deviation recorded.** M3 implements sizing (`amountIn`) + slippage floor (`minOut`) only; split/route/timing are out of scope (bounded by the single-shot Executor and the `ActionPlan` shape) and are documented in the SCOPE DEVIATION box at the top of this plan.
- [ ] **Foundation amendment ratified.** The two-arg `AgentRunner(cfg, deps?)`, `ClaudePlannerConfig`, `AnthropicLike`, `AgentDeps`, and `GovReader` were added to foundation §3.5 BEFORE this plan relied on them (see the Foundation amendment section); `makeGovReader` reads only the existing GovVault `cap_of`/`action_of` entrypoints.
- [ ] **No cheating.** Step 8.5 grep shows exactly one allowed, justified `describe.skip`; no other skips/ignores/always-true assertions; the committed cassette is REAL model output produced by the recorder against the live API (no placeholder path; cassette-realness asserted in CI).
- [ ] **APIs verified.** Every Anthropic call matches `@anthropic-ai/sdk@0.100.1` as verified via ctx7 + the bundled `claude-api` skill (provenance section above); the 4096-token cache minimum and the streamed-structured-output behavior were both verified; no invented function/package names.
- [ ] **Full agent suite green** (Step 8.2: 39 passed / 3 skipped across 7 files; 42 passed with the live gate) and **TypeScript clean** (Step 8.6).

**Fallback ladder for M3 (spec §11):** PRIMARY = `ClaudePlanner` (LLM decides how, in-cap). FALLBACK = `DeterministicPlanner` (M2), reachable two ways — by config (`USE_DETERMINISTIC_PLANNER=1`) and by automatic runtime fallback on any LLM/validation failure. Both are real, config-selectable, and have passing suites. M3 never ships the fallback as the default.
