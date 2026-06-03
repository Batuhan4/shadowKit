import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SealedVoteFlow, type SealedVoteEngine } from "./SealedVoteFlow";

// A stub engine for the COMPONENT layer ONLY (the real ZK/tlock/on-chain engine is exercised in
// voteClient.test.ts with REAL crypto). Per charter: components may stub the proof step at the
// component boundary; the unit under test (voteClient) is NEVER mocked in its own test.
function makeEngine(overrides: Partial<SealedVoteEngine> = {}): SealedVoteEngine {
  return {
    buildProof: vi.fn(async () => ({ proof: {}, publicSignals: {}, sealedCiphertext: {} } as never)),
    seal: vi.fn(async () => {}),
    submit: vi.fn(async () => ({ txHash: "abc123def456", status: "SUCCESS" })),
    ...overrides,
  };
}

const baseProps = {
  address: "GDS7PPKEERWQVBOOLZHKGQRAVIBRVYJXXB4FBZ7WXCGXLW4XONPUNMQH",
  proposalId: 0,
  projectName: "ShadowPay Wallet",
};

describe("SealedVoteFlow", () => {
  it("offers a weighted YES and NO choice before sealing", () => {
    render(<SealedVoteFlow {...baseProps} engine={makeEngine()} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: /seal.*yes/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seal.*no/i })).toBeInTheDocument();
  });

  it("runs proof -> seal -> submit and shows each step + the explorer tx link", async () => {
    const engine = makeEngine();
    const user = userEvent.setup();
    render(<SealedVoteFlow {...baseProps} engine={engine} onDone={() => {}} />);
    await user.click(screen.getByRole("button", { name: /seal.*yes/i }));

    await waitFor(() => expect(engine.submit).toHaveBeenCalled());
    // the three live steps surface to the user
    expect(screen.getByText(/zero-knowledge proof/i)).toBeInTheDocument();
    expect(screen.getByText(/timelock/i)).toBeInTheDocument();
    expect(screen.getByText(/on-chain/i)).toBeInTheDocument();
    // the real explorer link to the tx
    const link = await screen.findByRole("link", { name: /view.*explorer|transaction/i });
    expect(link.getAttribute("href")).toContain("abc123def456");
  });

  it("invokes the engine with direction=1 for YES and direction=0 for NO", async () => {
    const engineYes = makeEngine();
    const user = userEvent.setup();
    const { unmount } = render(<SealedVoteFlow {...baseProps} engine={engineYes} onDone={() => {}} />);
    await user.click(screen.getByRole("button", { name: /seal.*yes/i }));
    await waitFor(() => expect(engineYes.buildProof).toHaveBeenCalledWith(expect.objectContaining({ direction: 1 })));
    unmount();

    const engineNo = makeEngine();
    render(<SealedVoteFlow {...baseProps} engine={engineNo} onDone={() => {}} />);
    await user.click(screen.getByRole("button", { name: /seal.*no/i }));
    await waitFor(() => expect(engineNo.buildProof).toHaveBeenCalledWith(expect.objectContaining({ direction: 0 })));
  });

  it("surfaces an error state (no silent failure) when submit throws", async () => {
    const engine = makeEngine({ submit: vi.fn(async () => { throw new Error("rpc down"); }) });
    const user = userEvent.setup();
    render(<SealedVoteFlow {...baseProps} engine={engine} onDone={() => {}} />);
    await user.click(screen.getByRole("button", { name: /seal.*yes/i }));
    expect(await screen.findByText(/rpc down|failed|error/i)).toBeInTheDocument();
  });

  it("NEVER renders a yes/no tally during the flow (privacy invariant)", async () => {
    const engine = makeEngine();
    const user = userEvent.setup();
    render(<SealedVoteFlow {...baseProps} engine={engine} onDone={() => {}} />);
    await user.click(screen.getByRole("button", { name: /seal.*yes/i }));
    await waitFor(() => expect(engine.submit).toHaveBeenCalled());
    expect(screen.queryByText(/weighted yes|tally:/i)).not.toBeInTheDocument();
  });
});
