import type { AgentLog } from "@shadowkit/shared";

export interface AgentBoardTerminalProps {
  logs: AgentLog[];
}

// Anonymity Set console: charcoal bg, mono, muted steps, lime for on-chain/tx, red for errors.
const PHASE_COLOR: Record<string, string> = {
  submit: "var(--lime)",
  done: "var(--lime)",
  error: "var(--red)",
};

/** Streams AgentLog from the agent logBus (foundation §3.7). Renders one line per log with its
 *  phase, message, and (when present) the tx hash. */
export function AgentBoardTerminal({ logs }: AgentBoardTerminalProps) {
  return (
    <pre
      data-testid="agent-terminal"
      style={{
        background: "var(--bg)",
        color: "var(--text-2)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        padding: "clamp(0.9rem, 1.6vw, 1.25rem)",
        margin: 0,
        fontFamily: "var(--font-mono)",
        fontSize: "0.82rem",
        lineHeight: 1.75,
        overflowX: "auto",
      }}
    >
      {logs.map((l, i) => (
        <div
          key={i}
          data-phase={l.phase}
          style={{ display: "flex", gap: "0.85rem", alignItems: "baseline" }}
        >
          <span
            style={{
              flex: "0 0 56px",
              fontWeight: 700,
              fontSize: "0.66rem",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: PHASE_COLOR[l.phase] ?? "var(--muted)",
            }}
          >
            [{l.phase}]
          </span>
          <span style={{ color: PHASE_COLOR[l.phase] ?? "var(--text-2)", wordBreak: "break-word" }}>
            {l.message}
          </span>
          {l.txHash ? <span style={{ color: "var(--lime)" }}> ({l.txHash})</span> : null}
        </div>
      ))}
    </pre>
  );
}
