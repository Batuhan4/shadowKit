# Vendored: `@google/design.md`

A vendored snapshot of Google Labs' **DESIGN.md** format specification + CLI.
This is third-party code kept here for reference and local use.

- **Source:** https://github.com/google-labs-code/design.md
- **Commit:** `18508f27ab7ccb9e14ee906f76ec5f91c26d461f` (2026-06-02)
- **License:** Apache-2.0 — see [`./LICENSE`](./LICENSE)
- **Vendored:** 2026-06-03 · tracked files only (no `.git` history)
- **Format status:** `alpha` (expect changes)

## What it is
A format for describing a design system to coding agents: machine-readable
**YAML token frontmatter** (colors, typography, spacing, rounded, components)
+ human-readable **Markdown rationale**. Ships the `@google/design.md` CLI to
`lint` / `diff` / `export` tokens to **Tailwind v3/v4** and **W3C DTCG**.

- Spec: [`./docs/spec.md`](./docs/spec.md)
- Examples: [`./examples/`](./examples/) (`atmospheric-glass`, `paws-and-paths`, `totality-festival`)

## Use the published CLI (recommended — no build needed)
```bash
npx @google/design.md@latest lint DESIGN.md
npx @google/design.md@latest export --format css-tailwind DESIGN.md > theme.css   # Tailwind v4
npx @google/design.md@latest export --format json-tailwind DESIGN.md > theme.json # Tailwind v3
npx @google/design.md@latest export --format dtcg DESIGN.md > tokens.json         # W3C tokens
npx @google/design.md@latest spec                                                 # print the spec
```

## Run from this vendored source (needs Bun)
```bash
cd vendor/design.md && bun install
bun run packages/cli/src/index.ts lint ../../DESIGN.md
```

## Update this snapshot
```bash
git clone --depth 1 https://github.com/google-labs-code/design.md /tmp/dmd
git -C /tmp/dmd archive HEAD | tar -x -C vendor/design.md
```
