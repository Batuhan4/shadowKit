// Single source of truth for the ShadowKit docs sidebar + cross-page navigation.
// Pure data + helpers (no Astro/React) so it is unit-testable and consumed by DocsLayout.astro.
// Order here IS the reading order (overview → architecture → reference → flow).

export interface DocsLink {
  href: string;
  label: string;
  /** one-line blurb shown on the overview index */
  blurb?: string;
}

export interface DocsSection {
  title: string;
  links: DocsLink[];
}

export const DOCS_NAV: DocsSection[] = [
  {
    title: "Getting started",
    links: [
      {
        href: "/docs",
        label: "Overview",
        blurb: "What ShadowKit is, the install, and a 60-second quickstart.",
      },
      {
        href: "/docs/architecture",
        label: "Architecture",
        blurb: "How the ZK, timelock, governance, and agent layers fit together.",
      },
    ],
  },
  {
    title: "SDK reference",
    links: [
      {
        href: "/docs/packages",
        label: "Packages",
        blurb: "The four TypeScript libraries and their public APIs.",
      },
      {
        href: "/docs/contracts",
        label: "Contracts",
        blurb: "The Soroban contracts, deployed live on testnet, with explorer links.",
      },
      {
        href: "/docs/circuits",
        label: "Circuits",
        blurb: "The vote circuit, its constraints, and the binding public-signal order.",
      },
      {
        href: "/docs/agent",
        label: "Agent",
        blurb: "The watch → reveal → plan → policy → execute loop.",
      },
      {
        href: "/docs/x402",
        label: "x402 services",
        blurb: "Agent-pays + ShadowKit-sells, both over real x402 on Stellar.",
      },
    ],
  },
  {
    title: "Guides",
    links: [
      {
        href: "/docs/sealed-voting-flow",
        label: "Sealed voting flow",
        blurb: "End-to-end: seal a vote, close, reveal, and execute.",
      },
    ],
  },
];

/** Flattened reading order — drives prev/next and the overview cards. */
export const DOCS_PAGES: DocsLink[] = DOCS_NAV.flatMap((s) => s.links);

/** Normalize a pathname for comparison (drop a single trailing slash, keep root "/"). */
const norm = (p: string): string =>
  p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;

/**
 * Is `href` the active sidebar entry for the current `pathname`?
 * The overview (`/docs`) matches ONLY the exact path so it does not light up on every sub-page;
 * sub-pages match by prefix (tolerating a trailing slash).
 */
export function isCurrent(href: string, pathname: string): boolean {
  const here = norm(pathname);
  if (href === "/docs") return here === "/docs";
  return here === href || here.startsWith(href + "/");
}

/** Previous/next pages in reading order for the given href (nulls at the ends / unknown href). */
export function prevNext(href: string): {
  prev: DocsLink | null;
  next: DocsLink | null;
} {
  const i = DOCS_PAGES.findIndex((p) => p.href === norm(href));
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? DOCS_PAGES[i - 1] ?? null : null,
    next: i < DOCS_PAGES.length - 1 ? DOCS_PAGES[i + 1] ?? null : null,
  };
}
