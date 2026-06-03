import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the heavy real modules at the COMPONENT boundary (allowed by charter — the REAL voteClient /
// wallet paths are exercised in voteClient.test.ts with real crypto + a live simulation). Here we only
// verify FundApp's render/wiring states without pulling snarkjs/tlock/the wallet kit into jsdom.
vi.mock("../../lib/voteClient", () => ({
  loadArtifacts: vi.fn(async () => ({})),
  buildVoteProof: vi.fn(),
  buildCastVoteXdr: vi.fn(),
  buildCloseAndRevealXdr: vi.fn(),
  buildRevealFromSealed: vi.fn(),
  readVotesCast: vi.fn(async () => 0),
  readIsApproved: vi.fn(async () => true),
  submitSignedXdr: vi.fn(),
}));
vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: { init: vi.fn(), authModal: vi.fn(), disconnect: vi.fn(), signTransaction: vi.fn() },
  Networks: { TESTNET: "Test SDF Network ; September 2015" },
}));

import { FundApp } from "./FundApp";
import type { FundProject } from "./FundProjectGrid";

const projects: FundProject[] = [
  { id: "shadowpay", name: "ShadowPay Wallet", category: "Payments", askUsdc: "10000", blurb: "x", live: true },
  { id: "merkle-id", name: "MerkleID", category: "Identity", askUsdc: "7500", blurb: "y", live: false },
];

describe("FundApp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the project grid and the live testnet badge", () => {
    render(<FundApp projects={projects} proposalId={0} poolUsdc="10000" />);
    expect(screen.getByText("ShadowPay Wallet")).toBeInTheDocument();
    expect(screen.getByText("MerkleID")).toBeInTheDocument();
    expect(screen.getByText(/live on testnet/i)).toBeInTheDocument();
    expect(screen.getByText(/proposal #0/i)).toBeInTheDocument();
  });

  it("shows a connect-to-vote CTA when no wallet is connected", () => {
    render(<FundApp projects={projects} proposalId={0} poolUsdc="10000" />);
    expect(screen.getByText(/connect a wallet to vote privately/i)).toBeInTheDocument();
    // at least one Connect wallet button is present
    expect(screen.getAllByRole("button", { name: /connect wallet/i }).length).toBeGreaterThan(0);
  });

  it("does NOT render any yes/no tally before reveal (privacy)", () => {
    render(<FundApp projects={projects} proposalId={0} poolUsdc="10000" />);
    expect(screen.queryByText(/weighted yes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/weighted no/i)).not.toBeInTheDocument();
  });
});
