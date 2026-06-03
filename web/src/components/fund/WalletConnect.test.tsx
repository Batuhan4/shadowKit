import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletConnect } from "./WalletConnect";

describe("WalletConnect", () => {
  it("shows a Connect button when no address is connected", () => {
    render(<WalletConnect address={null} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
  });

  it("calls onConnect when the connect button is clicked", async () => {
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(<WalletConnect address={null} onConnect={onConnect} onDisconnect={() => {}} />);
    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("shows a shortened address and a disconnect control when connected", async () => {
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    const addr = "GDS7PPKEERWQVBOOLZHKGQRAVIBRVYJXXB4FBZ7WXCGXLW4XONPUNMQH";
    render(<WalletConnect address={addr} onConnect={() => {}} onDisconnect={onDisconnect} />);
    // shortened head…tail
    expect(screen.getByText(/GDS7…NMQH/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});
