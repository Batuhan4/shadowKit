import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FundProjectGrid, type FundProject } from "./FundProjectGrid";

const projects: FundProject[] = [
  {
    id: "shadowpay",
    name: "ShadowPay Wallet",
    category: "Payments",
    askUsdc: "10000",
    blurb: "Privacy-first mobile wallet for Stellar.",
    live: true,
  },
  {
    id: "merkle-id",
    name: "MerkleID",
    category: "Identity",
    askUsdc: "7500",
    blurb: "Self-sovereign identity anchored on-chain.",
    live: false,
  },
];

describe("FundProjectGrid", () => {
  it("renders one card per project with name, category and ask in USDC", () => {
    render(<FundProjectGrid projects={projects} votesSealed={0} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("ShadowPay Wallet")).toBeInTheDocument();
    expect(screen.getByText("MerkleID")).toBeInTheDocument();
    expect(screen.getByText(/Payments/)).toBeInTheDocument();
    // ask is formatted with the USDC unit
    expect(screen.getByText(/10,?000\s*USDC/i)).toBeInTheDocument();
  });

  it("shows the votes-sealed COUNT but NEVER a yes/no tally", () => {
    render(<FundProjectGrid projects={projects} votesSealed={3} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText(/3 votes sealed/i)).toBeInTheDocument();
    // privacy: no yes/no numbers leak
    expect(screen.queryByText(/\byes\b\s*\d/i)).not.toBeInTheDocument();
  });

  it("calls onSelect with the project id when a live project's card is chosen", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<FundProjectGrid projects={projects} votesSealed={0} selectedId={null} onSelect={onSelect} />);
    const card = screen.getByRole("button", { name: /ShadowPay Wallet/i });
    await user.click(card);
    expect(onSelect).toHaveBeenCalledWith("shadowpay");
  });

  it("marks a non-live project as not selectable (coming soon)", () => {
    render(<FundProjectGrid projects={projects} votesSealed={0} selectedId={null} onSelect={() => {}} />);
    const merkleCard = screen.getByText("MerkleID").closest("[data-project]") as HTMLElement;
    expect(within(merkleCard).getByText(/coming soon/i)).toBeInTheDocument();
  });

  it("highlights the selected project", () => {
    render(<FundProjectGrid projects={projects} votesSealed={0} selectedId="shadowpay" onSelect={() => {}} />);
    const card = screen.getByText("ShadowPay Wallet").closest("[data-project]") as HTMLElement;
    expect(card.getAttribute("data-selected")).toBe("true");
  });
});
