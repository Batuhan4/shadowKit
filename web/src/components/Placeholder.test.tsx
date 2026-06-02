import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Placeholder from "./Placeholder.js";

describe("Placeholder", () => {
  it("renders the given title", () => {
    render(<Placeholder title="ShadowKit AgentBoard" />);
    expect(screen.getByRole("heading", { name: "ShadowKit AgentBoard" })).toBeInTheDocument();
  });
  it("shows the scaffold-online marker", () => {
    render(<Placeholder title="x" />);
    expect(screen.getByTestId("agentboard-placeholder")).toHaveTextContent(/scaffold online/i);
  });
});
