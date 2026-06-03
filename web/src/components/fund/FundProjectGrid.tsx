// FundProjectGrid — SCF-styled candidate community-fund project cards (on-brand dark). Shows the
// "N votes sealed" COUNT only — NEVER the running yes/no tally (the privacy invariant). One project
// is the LIVE on-chain proposal (live:true, selectable); the rest are display candidates ("coming
// soon"). Selecting a live project arms the SealedVoteFlow for that proposal.
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
              <span className="badge badge-veil">{p.category}</span>
              {p.live ? (
                <span className="badge badge-cyan">● Live round</span>
              ) : (
                <span className="badge">Coming soon</span>
              )}
            </div>
            <h3 className="fp-name">{p.name}</h3>
            <p className="fp-blurb">{p.blurb}</p>
            <div className="fp-foot">
              <span className="fp-ask mono">{fmtUsdc(p.askUsdc)} USDC</span>
              {p.live ? (
                <span className="fp-sealed mono" title="Count only — direction stays sealed">
                  🔒 {votesSealed} votes sealed
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
        .fund-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1.1rem; }
        .fp-card { padding: 0; overflow: hidden; transition: border-color .2s ease, box-shadow .2s ease, transform .12s ease; }
        .fp-card.fp-live:hover { border-color: var(--veil); box-shadow: var(--glow-veil); transform: translateY(-2px); }
        .fp-selected { border-color: var(--cyan) !important; box-shadow: var(--glow-cyan) !important; }
        .fp-soon { opacity: 0.62; }
        .fp-btn, .fp-static { display: block; background: none; border: 0; color: inherit; cursor: pointer; padding: 1.25rem; font: inherit; }
        .fp-static { cursor: default; }
        .fp-head { display: flex; justify-content: space-between; align-items: center; gap: .5rem; margin-bottom: .85rem; }
        .fp-name { font-size: 1.12rem; margin: 0 0 .35rem; }
        .fp-blurb { color: var(--mist); font-size: .9rem; margin: 0 0 1rem; min-height: 2.5em; }
        .fp-foot { display: flex; justify-content: space-between; align-items: center; gap: .6rem; padding-top: .85rem; border-top: 1px solid var(--line); }
        .fp-ask { color: var(--gold); font-weight: 700; font-size: .92rem; }
        .fp-sealed { color: var(--veil); font-size: .8rem; }
      `}</style>
    </div>
  );
}
