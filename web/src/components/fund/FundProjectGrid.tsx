// FundProjectGrid — SCF-styled candidate community-fund project cards (Anonymity Set). Shows the
// "N votes sealed" COUNT only — NEVER the running yes/no tally (the privacy invariant). The sealed
// votes render as a field of identical DIM marks (the anonymity set): you can count them, but no mark
// reveals a direction. One project is the LIVE on-chain proposal (live:true, selectable); the rest are
// display candidates ("coming soon"). Selecting a live project arms the SealedVoteFlow for that proposal.
import type { CSSProperties } from "react";

export interface FundProject {
  id: string;
  name: string;
  category: string;
  askUsdc: string;
  blurb: string;
  /** true => this project maps to the LIVE proposal and is votable now. */
  live: boolean;
}

export interface FundProjectGridProps {
  projects: FundProject[];
  votesSealed: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const fmtUsdc = (raw: string): string => {
  try {
    return Number(raw).toLocaleString("en-US");
  } catch {
    return raw;
  }
};

// Render N indistinguishable sealed marks — the anonymity set. All dim, all identical: the count is
// public, the direction is not. Caps the visible field so a big round still reads cleanly.
function SealedField({ count }: { count: number }) {
  const MAX = 24;
  const shown = Math.min(count, MAX);
  return (
    <span
      className="aset fp-aset"
      style={{ "--cols": Math.min(Math.max(count, 1), 12) } as CSSProperties}
      aria-hidden="true"
    >
      {Array.from({ length: shown }).map((_, i) => (
        <span key={i} className="m" />
      ))}
    </span>
  );
}

export function FundProjectGrid({ projects, votesSealed, selectedId, onSelect }: FundProjectGridProps) {
  return (
    <div className="fund-grid">
      {projects.map((p) => {
        const selected = selectedId === p.id;
        const interactive = p.live;
        const cardStyle: CSSProperties = { textAlign: "left", width: "100%" };
        const inner = (
          <>
            <div className="fp-head">
              <span className="tag">{p.category}</span>
              {p.live ? (
                <span className="tag tag-lime fp-live-tag">
                  <span className="fp-livedot" /> Live round
                </span>
              ) : (
                <span className="tag">Coming soon</span>
              )}
            </div>
            <h3 className="fp-name">{p.name}</h3>
            <p className="fp-blurb">{p.blurb}</p>
            <div className="fp-foot">
              <span className="fp-ask mono">{fmtUsdc(p.askUsdc)} USDC</span>
              {p.live ? (
                <span className="fp-sealed" title="Count only — direction stays sealed">
                  <SealedField count={votesSealed} />
                  <span className="fp-sealed-n mono">{votesSealed} votes sealed</span>
                </span>
              ) : null}
            </div>
          </>
        );
        return (
          <div
            key={p.id}
            data-project={p.id}
            data-selected={selected ? "true" : "false"}
            className={`card fp-card${selected ? " fp-selected" : ""}${interactive ? " fp-live" : " fp-soon"}`}
          >
            {interactive ? (
              <button
                type="button"
                className="fp-btn"
                style={cardStyle}
                aria-pressed={selected}
                aria-label={`Select ${p.name} to vote`}
                onClick={() => onSelect(p.id)}
              >
                {inner}
              </button>
            ) : (
              <div className="fp-static">{inner}</div>
            )}
          </div>
        );
      })}

      <style>{`
        .fund-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: clamp(.9rem, 2vw, 1.2rem); }
        .fp-card { padding: 0; overflow: hidden; transition: border-color .18s ease, transform .12s ease; }
        .fp-card.fp-live:hover { border-color: var(--lime); transform: translateY(-2px); }
        .fp-selected { border-color: var(--lime) !important; }
        .fp-soon { opacity: 0.55; }
        .fp-btn, .fp-static { display: block; background: none; border: 0; color: inherit; cursor: pointer; padding: clamp(1.1rem, 2vw, 1.4rem); font: inherit; min-height: 42px; }
        .fp-btn:focus-visible { outline: 2px solid var(--lime); outline-offset: -2px; border-radius: var(--radius-lg); }
        .fp-static { cursor: default; }
        .fp-head { display: flex; justify-content: space-between; align-items: center; gap: .5rem; margin-bottom: .9rem; }
        .fp-live-tag { display: inline-flex; align-items: center; gap: .4em; }
        .fp-livedot { width: 6px; height: 6px; border-radius: 50%; background: var(--lime); display: inline-block; }
        .fp-name { font-size: 1.18rem; margin: 0 0 .35rem; }
        .fp-blurb { color: var(--text-2); font-size: .88rem; line-height: 1.45; margin: 0 0 1rem; min-height: 2.6em; }
        .fp-foot { display: flex; justify-content: space-between; align-items: flex-end; gap: .8rem; padding-top: .85rem; border-top: 1px solid var(--line); }
        .fp-ask { color: var(--lime); font-weight: 600; font-size: .9rem; }
        .fp-sealed { display: inline-flex; flex-direction: column; align-items: flex-end; gap: .4rem; }
        .fp-aset { width: 92px; gap: 4px; }
        .fp-aset .m { border-radius: 1.5px; }
        .fp-sealed-n { color: var(--muted); font-size: .72rem; letter-spacing: .02em; }
      `}</style>
    </div>
  );
}
