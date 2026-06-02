import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import type { ProposalView } from "@shadowkit/shared";
import { TallyView } from "./TallyView";

const closed: ProposalView = {
  id: 0,
  actionSpec: { kind: "swap", assetIn: "USDC", assetOut: "XLM", amount: "15000", minOut: "14000" },
  cap: "15000", deadline: 1, votesCast: 3, status: "Approved",
  weightedYes: "55", weightedNo: "40",
};

const open: ProposalView = { ...closed, status: "Open", weightedYes: null, weightedNo: null };

describe("TallyView", () => {
  it("shows weighted yes/no and the approved outcome after close", () => {
    render(<TallyView proposal={closed} />);
    expect(screen.getByText(/Yes:\s*55/)).toBeInTheDocument();
    expect(screen.getByText(/No:\s*40/)).toBeInTheDocument();
    expect(screen.getByText(/Approved/)).toBeInTheDocument();
  });

  it("shows 'results hidden' before close (no tally)", () => {
    render(<TallyView proposal={open} />);
    expect(screen.getByText(/results hidden/i)).toBeInTheDocument();
    // no numeric tally rendered while open
    expect(screen.queryByText(/Yes:\s*\d/)).not.toBeInTheDocument();
  });
});
