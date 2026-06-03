# ShadowKit — Design System: "Anonymity Set"

> The source of truth for the site's look & feel. Every page is built to this.

## The idea

Zero-knowledge voting has one beautiful core: **your vote is one of thousands of identical marks, and no one can tell which one is yours.** That set of indistinguishable members is the *anonymity set*. The whole site *is* an anonymity set — dense fields of identical glyphs, a few quietly lit, none traceable to a person. Privacy isn't a dark mood here; it's a crowd you disappear into. Democratic, mathematical, calm.

**Not:** AI neon (purple/cyan gradients, glows). **Not:** warm-paper editorial (Anthropic). **Not:** generic crypto tropes (vault, terminal, blueprint). This is its own thing.

## Principles

1. **Show, don't tell.** Minimal copy. The anonymity-set visual carries the meaning. Big type, lots of negative space, one idea per screen.
2. **One lit mark.** A single acid-lime accent, used sparingly — it's "the proven member," the signal, the CTA. Everything else is charcoal + bone. No second accent competing.
3. **Mathematical, flat.** No gradients, no glows, no drop-shadow soup. Hairline rules, monospace metadata, exact spacing.
4. **Sealed → revealed.** Sealed state = dim, uniform, blurred/redacted. Revealed = lit + aggregated. The transition is the drama.
5. **Responsive by construction.** Fluid `clamp()` type, capped measure, grids that reflow. Looks intentional on phone → 4K.

## Tokens

```
--bg        #0F0F12   page (charcoal, faint cool)
--bg-2      #15151a   sunk
--panel     #1a1a20   raised surface
--line      #28282f   hairline
--line-2    #383840   stronger rule / dim glyph
--text      #ECEAE3   headings / strong (bone)
--text-2    #b6b3ac   body
--muted     #7c7984   captions (neutral, NEVER purple-tinted)
--lime      #B6F03A   THE accent — the lit mark, signal, action
--lime-2    #cdff5e   hover/bright
--lime-deep #97cf24   pressed / on-lime text base
--red       #ff5b4c   blocked / danger (rare)
```
On-chain success reuses `--lime` (a proven/lit thing). There is intentionally **one** accent.

## Type

- **Display + UI:** Archivo (800 for headlines, 600/500 for UI). Tight tracking, big sizes.
- **Mono:** JetBrains Mono — every label, metadata, hash, glyph-field, eyebrow. Heavy mono usage = the technical/cryptographic register.
- Fluid scale: `h1 clamp(2.6rem, 6vw, 5.4rem)`, body `clamp(15.5px, .5vw+14.5px, 17.5px)`.

## Signature motif — the anonymity set

A grid/field of identical small marks (a monospace glyph or dot). The vast majority are **dim** (`--line-2`); a handful are **lit** (`--lime`). One may be larger = "you" — but its position is arbitrary and shifts, so it's never pinnable. Caption register: *"Your vote is one of these. No one can tell which."*

- **Hero:** the field is the hero art (beside/behind the headline).
- **Dividers:** a thin strip of marks separates sections.
- **Sealed tally:** marks present but uniform/dim (count visible, direction not). **Revealed:** marks resolve into a weighted bar.
- **Nullifier:** each cast vote shows a short hash glyph — unique, but unlinkable to identity.

## Components

- Buttons: flat. Primary = lime fill, dark text. Ghost = hairline border, lime on hover.
- Cards: `--panel` + hairline, generous padding, hover lifts border to lime.
- Tags: mono pill, hairline; `tag-lime` / `tag-ok` / `tag-red`.
- Code/docs: dark panel, mono, lime for tokens/links.

## Docs

Use **Starlight** (Astro's docs framework — GitBook-like: sidebar, search, responsive) themed to these tokens (charcoal bg, lime accent, Archivo/JetBrains Mono).

## Responsive

- Content measure capped (`--measure 1200px`, 1340 past 2K) so 4K doesn't stretch; centered with air.
- Everything in `clamp()` / `%` / `fr`. Grids → single column under ~720px. Nav collapses to a menu under 760px.
- Touch targets ≥ 42px. Test phone (390), tablet (834), desktop (1440), 2K (2560), 4K (3840).
