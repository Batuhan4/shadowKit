import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RevealStage, type RevealEngine } from "./RevealStage";

function makeEngine(overrides: Partial<RevealEngine> = {}): RevealEngine {
  return {
    reveal: vi.fn(async () => ({
      approved: true,
      yesW: "350",
      noW: "300",
      txHash: "reveal789hash",
    })),
    ...overrides,
  };
}

const baseProps = {
  address: "GDS7PPKEERWQVBOOLZHKGQRAVIBRVYJXXB4FBZ7WXCGXLW4XONPUNMQH",
  proposalId: 0,
  projectName: "ShadowPay Wallet",
  poolUsdc: "10000",
};

describe("RevealStage", () => {
  it("renders the SEALED state with the privacy copy before reveal", () => {
    render(<RevealStage {...baseProps} engine={makeEngine()} />);
    expect(screen.getByText(/tally hidden until close/i)).toBeInTheDocument();
    // the sealed visual is present (the blurred tally placeholder)
    expect(document.querySelector(".sealed")).toBeTruthy();
    // no real numbers leaked before reveal
    expect(screen.queryByText(/350/)).not.toBeInTheDocument();
  });

  it("offers a Close & Reveal action", () => {
    render(<RevealStage {...baseProps} engine={makeEngine()} />);
    expect(screen.getByRole("button", { name: /close.*reveal/i })).toBeInTheDocument();
  });

  it("runs the reveal, shows the weighted tally, the winner and the disbursement link", async () => {
    const engine = makeEngine();
    const user = userEvent.setup();
    render(<RevealStage {...baseProps} engine={engine} />);
    await user.click(screen.getByRole("button", { name: /close.*reveal/i }));

    await waitFor(() => expect(engine.reveal).toHaveBeenCalled());
    // tally revealed
    expect(await screen.findByText(/350/)).toBeInTheDocument();
    expect(screen.getByText(/300/)).toBeInTheDocument();
    // winner announced (approved => the project wins the pool)
    expect(screen.getByText(/ShadowPay Wallet/)).toBeInTheDocument();
    // explorer link to the reveal/disbursement tx
    const link = await screen.findByRole("link", { name: /explorer|transaction/i });
    expect(link.getAttribute("href")).toContain("reveal789hash");
  });

  it("shows a REJECTED outcome when the proposal does not pass", async () => {
    const engine = makeEngine({
      reveal: vi.fn(async () => ({ approved: false, yesW: "100", noW: "300", txHash: "rej0xhash" })),
    });
    const user = userEvent.setup();
    render(<RevealStage {...baseProps} engine={engine} />);
    await user.click(screen.getByRole("button", { name: /close.*reveal/i }));
    expect(await screen.findByText(/rejected|did not pass|not approved/i)).toBeInTheDocument();
  });

  it("surfaces an error if the reveal throws (no silent failure)", async () => {
    const engine = makeEngine({ reveal: vi.fn(async () => { throw new Error("round not released"); }) });
    const user = userEvent.setup();
    render(<RevealStage {...baseProps} engine={engine} />);
    await user.click(screen.getByRole("button", { name: /close.*reveal/i }));
    expect(await screen.findByText(/round not released|error|failed/i)).toBeInTheDocument();
  });
});
