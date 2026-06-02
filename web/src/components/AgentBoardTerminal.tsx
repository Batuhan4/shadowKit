import type { AgentLog } from "@shadowkit/shared";

export interface AgentBoardTerminalProps {
  logs: AgentLog[];
}

/** Streams AgentLog from the agent logBus (foundation §3.7). Renders one line per log with its
 *  phase, message, and (when present) the tx hash. */
export function AgentBoardTerminal({ logs }: AgentBoardTerminalProps) {
  return (
    <pre data-testid="agent-terminal" style={{ background: "#0b0b0b", color: "#0f0", padding: 12 }}>
      {logs.map((l, i) => (
        <div key={i} data-phase={l.phase}>
          <span>[{l.phase}]</span> <span>{l.message}</span>
          {l.txHash ? <span> ({l.txHash})</span> : null}
        </div>
      ))}
    </pre>
  );
}
