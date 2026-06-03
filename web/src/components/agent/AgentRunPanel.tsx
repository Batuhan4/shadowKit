import { useCallback, useMemo, useRef, useState } from "react";

// ---- The event shape streamed from POST /api/agent/execute (mirrors functions/api/agent/execute.ts) ----
export interface AgentPlanShape {
  action: string;
  venue: string;
  amountIn: string;
  minOut: string;
  reason: string;
}
export interface TreasuryBalancesShape {
  assetIn: string;
  assetOut: string;
}
export type AgentEventPhase =
  | "watch"
  | "data"
  | "plan"
  | "policy"
  | "submit"
  | "balances"
  | "done"
  | "error";
export interface AgentEvent {
  phase: AgentEventPhase;
  message: string;
  txHash?: string;
  explorer?: string;
  allowed?: boolean;
  plan?: AgentPlanShape;
  quote?: { pair: string; price: string; signal: string };
  balancesBefore?: TreasuryBalancesShape;
  balancesAfter?: TreasuryBalancesShape;
  done?: boolean;
}

/** Inject-able SSE source (default: live POST to /api/agent/execute). Yields one AgentEvent per
 *  step. Tests pass a recorded async generator (the network boundary). */
export type StreamRun = (signal?: AbortSignal) => AsyncIterable<AgentEvent>;

export interface AgentRunPanelProps {
  endpoint?: string;
  streamRun?: StreamRun;
}

/** Default live stream: POST to the SSE endpoint and parse `data:` frames with the Streams API
 *  (EventSource cannot POST, so we read the body stream ourselves). */
function makeLiveStream(endpoint: string): StreamRun {
  return async function* (signal?: AbortSignal) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: "{}",
      signal,
    });
    if (!res.ok && res.status !== 200) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) detail = j.error;
      } catch {
        /* non-json error */
      }
      yield { phase: "error", message: detail };
      return;
    }
    if (!res.body) {
      yield { phase: "error", message: "no response body (streaming unsupported)" };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          yield JSON.parse(json) as AgentEvent;
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  };
}

const PHASE_LABEL: Record<AgentEventPhase, string> = {
  watch: "GOV",
  data: "X402",
  plan: "PLAN",
  policy: "POLICY",
  submit: "CHAIN",
  balances: "BAL",
  done: "DONE",
  error: "ERR",
};

// One accent. Steps are muted; the lit moments (success, on-chain, done) are lime; failure is red.
const PHASE_COLOR: Record<AgentEventPhase, string> = {
  watch: "var(--muted)",
  data: "var(--muted)",
  plan: "var(--muted)",
  policy: "var(--text-2)",
  submit: "var(--lime)",
  balances: "var(--muted)",
  done: "var(--lime)",
  error: "var(--red)",
};

// The 5-stage flow shown as a mono stepper. Each maps to the event phase that "lights" it.
const STAGES: { tag: string; phase: AgentEventPhase; hint: string }[] = [
  { tag: "GOV", phase: "watch", hint: "read approved vote" },
  { tag: "X402", phase: "data", hint: "pay for data" },
  { tag: "PLAN", phase: "plan", hint: "bounded plan" },
  { tag: "POLICY", phase: "policy", hint: "gate the plan" },
  { tag: "CHAIN", phase: "submit", hint: "execute on-chain" },
];

type RunState = "idle" | "running" | "ok" | "blocked" | "error";

export function AgentRunPanel({ endpoint = "/api/agent/execute", streamRun }: AgentRunPanelProps) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [state, setState] = useState<RunState>("idle");
  const logRef = useRef<HTMLDivElement>(null);

  const run = useMemo<StreamRun>(() => streamRun ?? makeLiveStream(endpoint), [streamRun, endpoint]);

  const start = useCallback(async () => {
    setEvents([]);
    setState("running");
    let finalState: RunState = "ok";
    try {
      for await (const e of run()) {
        setEvents((prev) => [...prev, e]);
        if (e.phase === "policy" && e.allowed === false) finalState = "blocked";
        if (e.phase === "error") finalState = "error";
        // autoscroll
        requestAnimationFrame(() => {
          if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
        });
      }
    } catch (err) {
      setEvents((prev) => [...prev, { phase: "error", message: (err as Error).message }]);
      finalState = "error";
    }
    setState(finalState);
  }, [run]);

  // Derive the highlighted artifacts from the event stream.
  const plan = events.find((e) => e.plan)?.plan;
  const verdict = events.find((e) => e.phase === "policy");
  const submit = events.find((e) => e.phase === "submit" && e.txHash);
  const doneEvt = events.find((e) => e.phase === "done");
  const before = events.find((e) => e.balancesBefore)?.balancesBefore;
  const after = events.find((e) => e.balancesAfter)?.balancesAfter ?? doneEvt?.balancesAfter;
  const running = state === "running";

  // Stepper status: a stage is "lit" once its phase has streamed; "blocked" if POLICY denied; the
  // last lit stage is "active" while running.
  const seen = new Set(events.map((e) => e.phase));
  const policyBlocked = verdict?.allowed === false;
  const lastLitIdx = STAGES.reduce((acc, s, i) => (seen.has(s.phase) ? i : acc), -1);
  const stageStatus = (
    s: (typeof STAGES)[number],
    i: number,
  ): "done" | "active" | "blocked" | "idle" => {
    if (s.phase === "policy" && policyBlocked) return "blocked";
    if (s.phase === "submit" && policyBlocked) return "idle"; // never reached when blocked
    if (!seen.has(s.phase)) return "idle";
    if (running && i === lastLitIdx) return "active";
    return "done";
  };

  return (
    <div className="agent-panel" data-state={state}>
      <div className="agent-head">
        <span className="agent-title mono">
          <span className={`agent-dot${running ? " live" : ""}`} aria-hidden="true" />
          shadowkit-agent · bounded execution
        </span>
        <button
          className="btn btn-primary agent-run"
          onClick={start}
          disabled={running}
          aria-busy={running}
        >
          {running ? "Running…" : "Run the agent →"}
        </button>
      </div>

      <ol className="agent-stepper mono" aria-label="agent stages">
        {STAGES.map((s, i) => {
          const st = stageStatus(s, i);
          return (
            <li key={s.tag} className="agent-stage" data-status={st}>
              <span className="stage-mark" aria-hidden="true" />
              <span className="stage-tag">{s.tag}</span>
              <span className="stage-hint">{s.hint}</span>
            </li>
          );
        })}
      </ol>

      <div className="agent-log" ref={logRef} data-testid="agent-terminal" role="log" aria-live="polite">
        {events.length === 0 && !running ? (
          <div className="agent-empty mono">
            $ idle — press Run. The agent reads the approved vote, pays x402, plans with Gemini, is
            gated by policy, then submits the swap on testnet. Every run, live.
          </div>
        ) : null}
        {events.map((e, i) => (
          <div className="agent-line" key={i} data-phase={e.phase}>
            <span className="agent-tag mono" style={{ color: PHASE_COLOR[e.phase] }}>
              {PHASE_LABEL[e.phase]}
            </span>
            <span className="agent-msg mono">{e.message}</span>
          </div>
        ))}
        {running ? <div className="agent-caret mono" aria-hidden="true">▍</div> : null}
      </div>

      {(plan || verdict || submit || before) && (
        <div className="agent-artifacts">
          {plan ? (
            <div className="art card">
              <div className="art-label eyebrow">Gemini plan (bounded)</div>
              <dl className="art-grid mono">
                <dt>action</dt>
                <dd>{plan.action}</dd>
                <dt>amountIn</dt>
                <dd>{plan.amountIn}</dd>
                <dt>minOut</dt>
                <dd>{plan.minOut}</dd>
              </dl>
              <p className="art-reason">{plan.reason}</p>
            </div>
          ) : null}

          {verdict ? (
            <div
              className="art card verdict-card"
              data-testid="policy-verdict"
              data-allowed={verdict.allowed ? "true" : "false"}
              data-state={verdict.allowed ? "allowed" : "blocked"}
            >
              <div className="art-label eyebrow">Policy verdict</div>
              <div className={`verdict ${verdict.allowed ? "is-allowed" : "is-blocked"}`}>
                {verdict.allowed ? "● ALLOWED" : "● BLOCKED"}
              </div>
              <p className="art-reason mono">{verdict.message}</p>
              <p className="art-caption mono">
                {verdict.allowed
                  ? "Plan is within the on-chain cap — execution may proceed."
                  : "Plan violates the on-chain policy — no transaction is signed."}
              </p>
            </div>
          ) : null}

          {submit ? (
            <div className="art card">
              <div className="art-label eyebrow">On-chain swap</div>
              <div className="tx mono">tx {submit.txHash}</div>
              {submit.explorer ? (
                <a className="btn btn-ghost art-link" href={submit.explorer} target="_blank" rel="noopener">
                  View on Stellar Explorer →
                </a>
              ) : null}
            </div>
          ) : null}

          {(before || after) && (
            <div className="art card">
              <div className="art-label eyebrow">Treasury balances</div>
              <div className="bal-grid mono">
                <div className="bal-col">
                  <span className="bal-h">before</span>
                  <span>in {before?.assetIn ?? "—"}</span>
                  <span>out {before?.assetOut ?? "—"}</span>
                </div>
                <div className="bal-arrow" aria-hidden="true">→</div>
                <div className="bal-col">
                  <span className="bal-h">after</span>
                  <span>in {after?.assetIn ?? "—"}</span>
                  <span>out {after?.assetOut ?? "—"}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <style>{PANEL_CSS}</style>
    </div>
  );
}

const PANEL_CSS = `
/* Anonymity Set — a clean charcoal console. Flat, hairline rules, mono metadata, one lime accent. */
.agent-panel { display: flex; flex-direction: column; gap: clamp(0.9rem, 1.6vw, 1.2rem); }

/* console header */
.agent-head {
  display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap;
  background: var(--panel); border: 1px solid var(--line); border-bottom: 0;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0; padding: 0.75rem 1.05rem;
}
.agent-title { color: var(--text-2); font-size: 0.76rem; letter-spacing: 0.04em; display: inline-flex; align-items: center; gap: 0.6rem; }
.agent-dot { width: 7px; height: 7px; border-radius: 1px; background: var(--line-2); flex: 0 0 auto; }
.agent-dot.live { background: var(--lime); animation: flick 1.1s steps(2, jump-none) infinite; }
.agent-run { margin-left: auto; padding: 0.6em 1.1em; font-size: 0.85rem; min-height: 42px; }
.agent-run[disabled] { opacity: 0.6; cursor: progress; }

/* the 5-stage stepper — lights up as events stream */
.agent-stepper {
  list-style: none; margin: -1px 0 0; padding: 0.55rem 0.6rem; display: grid;
  grid-template-columns: repeat(5, 1fr); gap: 0.4rem;
  background: var(--bg-2); border: 1px solid var(--line); border-bottom: 0;
}
.agent-stage {
  display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto;
  column-gap: 0.5rem; align-items: center; padding: 0.45rem 0.55rem;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel);
  transition: border-color 0.18s, background 0.18s;
}
.stage-mark { grid-row: 1 / span 2; width: 9px; height: 9px; border-radius: 1px; background: var(--line-2); transition: background 0.18s, box-shadow 0.18s; }
.stage-tag { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.1em; color: var(--muted); }
.stage-hint { grid-column: 2; font-size: 0.6rem; letter-spacing: 0.02em; color: var(--muted); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-stage[data-status="done"] .stage-mark { background: var(--lime); }
.agent-stage[data-status="done"] .stage-tag { color: var(--text); }
.agent-stage[data-status="active"] { border-color: var(--lime); }
.agent-stage[data-status="active"] .stage-mark { background: var(--lime); box-shadow: 0 0 0 3px color-mix(in oklab, var(--lime) 24%, transparent); animation: flick 1.1s steps(2, jump-none) infinite; }
.agent-stage[data-status="active"] .stage-tag { color: var(--text); }
.agent-stage[data-status="blocked"] { border-color: color-mix(in oklab, var(--red) 55%, var(--line-2)); }
.agent-stage[data-status="blocked"] .stage-mark { background: var(--red); }
.agent-stage[data-status="blocked"] .stage-tag { color: var(--red); }

/* the terminal — the centerpiece */
.agent-log {
  background: var(--bg); border: 1px solid var(--line); border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  padding: clamp(0.9rem, 1.6vw, 1.25rem) clamp(1rem, 1.8vw, 1.3rem);
  min-height: 260px; max-height: 440px; overflow-y: auto;
  font-family: var(--font-mono); font-size: 0.82rem; line-height: 1.75;
}
.agent-empty { color: var(--muted); max-width: 60ch; }
.agent-line { display: flex; gap: 0.85rem; align-items: baseline; animation: rise 0.32s cubic-bezier(0.2,0.7,0.2,1) both; }
.agent-tag { flex: 0 0 56px; font-size: 0.66rem; letter-spacing: 0.12em; font-weight: 700; padding-top: 1px; }
.agent-msg { color: var(--text-2); word-break: break-word; }
.agent-line[data-phase="submit"] .agent-msg,
.agent-line[data-phase="done"] .agent-msg { color: var(--lime); }
.agent-line[data-phase="error"] .agent-msg { color: var(--red); }
.agent-caret { color: var(--lime); animation: flick 1s steps(2, jump-none) infinite; }

/* structured result cards */
.agent-artifacts { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: clamp(0.8rem, 1.5vw, 1.1rem); }
.art { padding: clamp(1rem, 1.8vw, 1.3rem); }
.art-label { display: block; margin-bottom: 0.7rem; }
.art-grid { display: grid; grid-template-columns: auto 1fr; gap: 0.2rem 0.9rem; font-size: 0.82rem; }
.art-grid dt { color: var(--muted); }
.art-grid dd { margin: 0; color: var(--text); text-align: right; }
.art-reason { font-size: 0.8rem; color: var(--text-2); margin: 0.8rem 0 0; line-height: 1.5; }
.art-caption { font-size: 0.68rem; color: var(--muted); margin: 0.6rem 0 0; line-height: 1.5; letter-spacing: 0.02em; }

/* verdict — the BLOCKED/ALLOWED moment */
.verdict { font-family: var(--font-mono); font-weight: 700; font-size: 1.02rem; letter-spacing: 0.06em; }
.verdict.is-allowed { color: var(--lime); }
.verdict.is-blocked { color: var(--red); }
.verdict-card[data-allowed="true"] { border-color: color-mix(in oklab, var(--lime) 55%, var(--line-2)); }
.verdict-card[data-allowed="false"] { border-color: color-mix(in oklab, var(--red) 55%, var(--line-2)); }

/* on-chain swap */
.tx { font-size: 0.78rem; color: var(--lime); word-break: break-all; margin-bottom: 0.85rem; }
.art-link { padding: 0.55em 1em; font-size: 0.8rem; min-height: 42px; }

/* treasury balances */
.bal-grid { display: flex; align-items: center; gap: 1rem; font-size: 0.8rem; }
.bal-col { display: flex; flex-direction: column; gap: 0.18rem; color: var(--text-2); }
.bal-h { color: var(--muted); font-size: 0.66rem; letter-spacing: 0.12em; text-transform: uppercase; }
.bal-arrow { color: var(--lime); font-size: 1.2rem; }

@media (max-width: 720px) {
  .agent-stepper { grid-template-columns: 1fr 1fr; }
  .agent-run { flex: 1 1 100%; justify-content: center; }
}
`;
