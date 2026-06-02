import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ProposalView } from "@shadowkit/shared";
import { ProposalList } from "./ProposalList";

const sample: ProposalView[] = [
  {
    id: 0,
    actionSpec: { kind: "swap", assetIn: "USDC", assetOut: "XLM", amount: "15000", minOut: "14000" },
    cap: "15000", deadline: 2_000_000_000, votesCast: 2, status: "Open",
    weightedYes: null, weightedNo: null,
  },
  {
    id: 1,
    actionSpec: { kind: "swap", assetIn: "USDC", assetOut: "XLM", amount: "5000", minOut: "4800" },
    cap: "5000", deadline: 2_000_000_500, votesCast: 3, status: "Approved",
    weightedYes: "55", weightedNo: "40",
  },
];

describe("ProposalList", () => {
  it("renders one row per proposal with status and votes", () => {
    render(<ProposalList proposals={sample} onSelect={() => {}} />);
    expect(screen.getByText(/Proposal #0/)).toBeInTheDocument();
    expect(screen.getByText(/Proposal #1/)).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText(/2 votes/)).toBeInTheDocument();
  });

  it("fires onSelect with the proposal id when a row is clicked", () => {
    const onSelect = vi.fn();
    render(<ProposalList proposals={sample} onSelect={onSelect} />);
    fireEvent.click(screen.getByText(/Proposal #1/));
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});
