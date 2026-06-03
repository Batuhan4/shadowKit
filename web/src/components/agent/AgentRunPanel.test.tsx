import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentRunPanel } from "./AgentRunPanel";
import type { AgentEvent } from "./AgentRunPanel";

// Build a fake streamRun that pushes a recorded sequence of AgentEvents (the network boundary =
// /api/agent/execute SSE). The component's parsing/state/rendering is the unit under test.
function fakeStream(events: AgentEvent[]) {
  return vi.fn(async function* () {
    for (const e of events) yield e;
  });
}

const happy: AgentEvent[] = [
  { phase: "watch", message: "proposal #0 is APPROVED · cap=10000" },
  { phase: "data", message: "x402 paid · quote USDC-XLM price=0.1123 signal=buy" },
  {
    phase: "plan",
    message: "PLAN · amountIn=8000 minOut=7500",
    plan: { action: "swap", venue: "CAMM", amountIn: "8000", minOut: "7500", reason: "buy" },
  },
  { phase: "policy", message: "policy ALLOWED — plan is within bounds", allowed: true },
  {
    phase: "submit",
    message: "swap submitted · tx ABCTX",
    txHash: "ABCTX",
    explorer: "https://stellar.expert/explorer/testnet/tx/ABCTX",
  },
  { phase: "done", message: "execution complete", done: true, txHash: "ABCTX" },
];

const blocked: AgentEvent[] = [
  { phase: "watch", message: "proposal #0 is APPROVED" },
  { phase: "data", message: "x402 paid" },
  {
    phase: "plan",
    message: "PLAN · amountIn=999999999 minOut=7500",
    plan: { action: "swap", venue: "CAMM", amountIn: "999999999", minOut: "7500", reason: "all in" },
  },
  { phase: "policy", message: "BLOCKED by policy: OVER_CAP — amountIn 999999999 exceeds cap 10000", allowed: false },
];

describe("AgentRunPanel", () => {
  it("renders an idle state with a run button before anything streams", () => {
    render(<AgentRunPanel streamRun={fakeStream([])} />);
    expect(screen.getByRole("button", { name: /run the agent/i })).toBeInTheDocument();
  });

  it("streams the live log and shows the plan, ALLOWED verdict, tx hash + explorer link", async () => {
    const user = userEvent.setup();
    render(<AgentRunPanel streamRun={fakeStream(happy)} />);
    await user.click(screen.getByRole("button", { name: /run the agent/i }));

    await waitFor(() => expect(screen.getByText(/execution complete/i)).toBeInTheDocument());
    // plan surfaced
    expect(screen.getByText(/amountIn=8000/)).toBeInTheDocument();
    // ALLOWED verdict rendered as the allowed state
    const verdict = screen.getByTestId("policy-verdict");
    expect(verdict).toHaveTextContent(/ALLOWED/i);
    expect(verdict.getAttribute("data-allowed")).toBe("true");
    // explorer link to the real tx
    const link = screen.getByRole("link", { name: /explorer|view tx|ABCTX/i });
    expect(link).toHaveAttribute("href", "https://stellar.expert/explorer/testnet/tx/ABCTX");
  });

  it("shows a RED BLOCKED verdict and NO tx when the plan violates policy", async () => {
    const user = userEvent.setup();
    render(<AgentRunPanel streamRun={fakeStream(blocked)} />);
    await user.click(screen.getByRole("button", { name: /run the agent/i }));

    await waitFor(() => expect(screen.getByTestId("policy-verdict")).toBeInTheDocument());
    const verdict = screen.getByTestId("policy-verdict");
    expect(verdict).toHaveTextContent(/BLOCKED/i);
    expect(verdict.getAttribute("data-allowed")).toBe("false");
    // no explorer/tx link rendered when blocked
    expect(screen.queryByRole("link", { name: /explorer|view tx/i })).not.toBeInTheDocument();
  });

  it("disables the run button while a run is in progress", async () => {
    const user = userEvent.setup();
    // a stream that never completes until we resolve it keeps the running state observable
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slowStream = vi.fn(async function* () {
      yield { phase: "watch", message: "reading…" } as AgentEvent;
      await gate;
    });
    render(<AgentRunPanel streamRun={slowStream} />);
    await user.click(screen.getByRole("button", { name: /run the agent/i }));
    await waitFor(() => expect(screen.getByText(/reading…/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /running/i })).toBeDisabled();
    release();
  });
});
