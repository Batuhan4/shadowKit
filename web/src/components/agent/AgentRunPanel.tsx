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

const PHASE_COLOR: Record<AgentEventPhase, string> = {
  watch: "var(--veil)",
  data: "var(--gold)",
  plan: "var(--cyan)",
  policy: "var(--cyan)",
  submit: "var(--green)",
  balances: "var(--mist)",
  done: "var(--green)",
  error: "var(--red)",
};

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

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <div className="agent-dots" aria-hidden="true">
          <span /> <span /> <span />
        </div>
        <span className="agent-title mono">shadowkit-agent · bounded execution</span>
        <button
          className="btn btn-primary agent-run"
          onClick={start}
          disabled={running}
          aria-busy={running}
        >
          {running ? "Running…" : "Run the agent →"}
        </button>
      </div>

      <div className="agent-log" ref={logRef} data-testid="agent-terminal" role="log" aria-live="polite">
        {events.length === 0 && !running ? (
          <div className="agent-empty mono">
            $ awaiting run — the agent will read GovVault, pay x402, plan with Gemini, gate by policy,
            then submit the swap on testnet.
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
.agent-panel { display: flex; flex-direction: column; gap: 1rem; }
.agent-head {
  display: flex; align-items: center; gap: 0.8rem;
  background: linear-gradient(180deg, var(--panel), var(--panel-2));
  border: 1px solid var(--line); border-bottom: 0;
  border-radius: var(--radius) var(--radius) 0 0; padding: 0.7rem 1rem;
}
.agent-dots { display: inline-flex; gap: 6px; }
.agent-dots span { width: 11px; height: 11px; border-radius: 50%; background: var(--line); }
.agent-dots span:nth-child(1) { background: rgba(255,107,129,0.55); }
.agent-dots span:nth-child(2) { background: rgba(246,196,83,0.55); }
.agent-dots span:nth-child(3) { background: rgba(86,217,138,0.55); }
.agent-title { color: var(--mist); font-size: 0.78rem; }
.agent-run { margin-left: auto; padding: 0.5em 1em; font-size: 0.85rem; }
.agent-run[disabled] { opacity: 0.65; cursor: progress; }
.agent-log {
  background: #07070d; border: 1px solid var(--line); border-radius: 0 0 var(--radius) var(--radius);
  margin-top: -1rem; padding: 1rem 1.1rem; min-height: 240px; max-height: 420px; overflow-y: auto;
  font-family: var(--font-mono); font-size: 0.82rem; line-height: 1.7;
  box-shadow: inset 0 12px 30px -22px rgba(0,0,0,0.9);
}
.agent-empty { color: var(--mist-2); }
.agent-line { display: flex; gap: 0.7rem; align-items: baseline; animation: fadeUp 0.35s ease both; }
.agent-tag { flex: 0 0 52px; font-size: 0.66rem; letter-spacing: 0.12em; font-weight: 700; padding-top: 1px; }
.agent-msg { color: var(--ink); word-break: break-word; }
.agent-line[data-phase="error"] .agent-msg { color: var(--red); }
.agent-line[data-phase="done"] .agent-msg { color: var(--green); }
.agent-caret { color: var(--cyan); animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.agent-artifacts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.9rem; }
.art { padding: 1rem 1.1rem; }
.art-label { display: block; margin-bottom: 0.6rem; }
.art-grid { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.8rem; font-size: 0.82rem; }
.art-grid dt { color: var(--mist); }
.art-grid dd { margin: 0; color: var(--ink); text-align: right; }
.art-reason { font-size: 0.82rem; color: var(--mist); margin: 0.7rem 0 0; }
.verdict { font-family: var(--font-display); font-weight: 700; font-size: 1.05rem; letter-spacing: 0.02em; }
.verdict.is-allowed { color: var(--green); }
.verdict.is-blocked { color: var(--red); }
.verdict-card[data-allowed="false"] { border-color: rgba(255,107,129,0.5); box-shadow: 0 0 0 1px rgba(255,107,129,0.25); }
.verdict-card[data-allowed="true"] { border-color: rgba(86,217,138,0.5); box-shadow: 0 0 0 1px rgba(86,217,138,0.2); }
.tx { font-size: 0.78rem; color: var(--green); word-break: break-all; margin-bottom: 0.7rem; }
.art-link { padding: 0.45em 0.9em; font-size: 0.8rem; }
.bal-grid { display: flex; align-items: center; gap: 0.9rem; font-size: 0.8rem; }
.bal-col { display: flex; flex-direction: column; gap: 0.15rem; }
.bal-h { color: var(--mist-2); font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase; }
.bal-arrow { color: var(--cyan); font-size: 1.2rem; }
`;
