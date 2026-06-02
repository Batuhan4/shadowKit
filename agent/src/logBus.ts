import type { AgentLog } from "@shadowkit/shared";

/** Typed AgentLog event emitter (foundation §3.5). SSE/WebSocket source for the AgentBoard terminal. */
export class LogBus {
  private subs = new Set<(l: AgentLog) => void>();
  emit(log: AgentLog): void {
    for (const fn of this.subs) fn(log);
  }
  subscribe(fn: (l: AgentLog) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }
}
