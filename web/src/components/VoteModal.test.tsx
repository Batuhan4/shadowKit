import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import type { ProposalView } from "@shadowkit/shared";
import { VoteModal } from "./VoteModal";

const proposal: ProposalView = {
  id: 0,
  actionSpec: { kind: "swap", assetIn: "USDC", assetOut: "XLM", amount: "15000", minOut: "14000" },
  cap: "15000", deadline: 2_000_000_000, votesCast: 1, status: "Open",
  // even if upstream leaked tally, the modal must NOT show it
  weightedYes: "999", weightedNo: "1",
};

describe("VoteModal (plaintext)", () => {
  it("submits direction=1 (yes) via onCast", async () => {
    const onCast = vi.fn();
    const user = userEvent.setup();
    render(<VoteModal proposal={proposal} voter="GVOTER" onCast={onCast} />);
    await user.click(screen.getByRole("button", { name: /vote yes/i }));
    expect(onCast).toHaveBeenCalledWith(1);
  });

  it("submits direction=0 (no) via onCast", async () => {
    const onCast = vi.fn();
    const user = userEvent.setup();
    render(<VoteModal proposal={proposal} voter="GVOTER" onCast={onCast} />);
    await user.click(screen.getByRole("button", { name: /vote no/i }));
    expect(onCast).toHaveBeenCalledWith(0);
  });

  it("NEVER displays the running tally (privacy invariant)", () => {
    render(<VoteModal proposal={proposal} voter="GVOTER" onCast={() => {}} />);
    // weightedYes is "999"; it must not appear anywhere in the modal
    expect(screen.queryByText(/999/)).not.toBeInTheDocument();
  });
});
