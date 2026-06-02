import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentBoardTerminal } from "./AgentBoardTerminal";
import type { AgentLog } from "@shadowkit/shared";

describe("AgentBoardTerminal", () => {
  it("renders each AgentLog message with its phase and tx hash", () => {
    const logs: AgentLog[] = [
      { ts: 1, phase: "plan", message: "planning swap" },
      { ts: 2, phase: "submit", message: "swap submitted", txHash: "abc123" },
    ];
    render(<AgentBoardTerminal logs={logs} />);
    expect(screen.getByText(/planning swap/)).toBeInTheDocument();
    expect(screen.getByText(/swap submitted/)).toBeInTheDocument();
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
    // Phase labels are rendered as bracketed tags; assert exactly so "plan" does not also
    // match the "planning swap" message word.
    expect(screen.getByText(/\[plan\]/)).toBeInTheDocument();
    expect(screen.getByText(/\[submit\]/)).toBeInTheDocument();
  });
});
