import { describe, it, expect } from "vitest";
import { LogBus } from "../src/logBus";
import type { AgentLog } from "@shadowkit/shared";

describe("LogBus", () => {
  it("delivers emitted logs to subscribers and supports unsubscribe", () => {
    const bus = new LogBus();
    const seen: AgentLog[] = [];
    const off = bus.subscribe((l) => seen.push(l));
    const log: AgentLog = { ts: 1, phase: "data", message: "hello" };
    bus.emit(log);
    expect(seen).toEqual([log]);
    off();
    bus.emit({ ts: 2, phase: "done", message: "bye" });
    expect(seen).toHaveLength(1);
  });
});
