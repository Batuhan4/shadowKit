import { describe, it, expect } from "vitest";
import {
  DOCS_NAV,
  DOCS_PAGES,
  prevNext,
  isCurrent,
  type DocsLink,
} from "./docs-nav.ts";

const allLinks = (): DocsLink[] => DOCS_NAV.flatMap((s) => s.links);

describe("docs-nav: sidebar structure", () => {
  it("has at least one section, each with a title and links", () => {
    expect(DOCS_NAV.length).toBeGreaterThan(0);
    for (const section of DOCS_NAV) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.links.length).toBeGreaterThan(0);
    }
  });

  it("starts every docs href at /docs", () => {
    for (const l of allLinks()) {
      expect(l.href.startsWith("/docs")).toBe(true);
    }
  });

  it("has a canonical overview entry at /docs", () => {
    expect(allLinks().some((l) => l.href === "/docs")).toBe(true);
  });

  it("covers every authored docs surface (packages, contracts, circuits, agent, x402, flow, architecture)", () => {
    const hrefs = allLinks().map((l) => l.href);
    for (const required of [
      "/docs",
      "/docs/architecture",
      "/docs/packages",
      "/docs/contracts",
      "/docs/circuits",
      "/docs/agent",
      "/docs/x402",
      "/docs/sealed-voting-flow",
    ]) {
      expect(hrefs).toContain(required);
    }
  });

  it("has no duplicate hrefs", () => {
    const hrefs = allLinks().map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("gives every link a non-empty label", () => {
    for (const l of allLinks()) expect(l.label.length).toBeGreaterThan(0);
  });
});

describe("docs-nav: DOCS_PAGES flat order", () => {
  it("is the section links flattened in order", () => {
    expect(DOCS_PAGES).toEqual(allLinks());
  });
});

describe("docs-nav: isCurrent (active-link matching)", () => {
  it("matches the overview exactly (does not light up on sub-pages)", () => {
    expect(isCurrent("/docs", "/docs")).toBe(true);
    expect(isCurrent("/docs", "/docs/contracts")).toBe(false);
  });

  it("matches sub-pages by prefix and tolerates a trailing slash", () => {
    expect(isCurrent("/docs/contracts", "/docs/contracts")).toBe(true);
    expect(isCurrent("/docs/contracts", "/docs/contracts/")).toBe(true);
  });

  it("does not match a different sub-page", () => {
    expect(isCurrent("/docs/contracts", "/docs/circuits")).toBe(false);
  });
});

describe("docs-nav: prevNext (cross-page navigation)", () => {
  it("has no prev on the first page", () => {
    const first = DOCS_PAGES[0]!;
    expect(prevNext(first.href).prev).toBeNull();
  });

  it("has no next on the last page", () => {
    const last = DOCS_PAGES[DOCS_PAGES.length - 1]!;
    expect(prevNext(last.href).next).toBeNull();
  });

  it("links a middle page to its neighbours", () => {
    const i = 1;
    const mid = DOCS_PAGES[i]!;
    const { prev, next } = prevNext(mid.href);
    expect(prev).toEqual(DOCS_PAGES[i - 1]);
    expect(next).toEqual(DOCS_PAGES[i + 1]);
  });

  it("returns nulls for an unknown href", () => {
    expect(prevNext("/docs/does-not-exist")).toEqual({ prev: null, next: null });
  });
});
