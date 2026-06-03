// RevealStage — the "sealed → revealed" finale. Before reveal it shows the tally as a SEALED field of
// identical DIM marks (the anonymity set) with the privacy copy — count visible, direction not.
// "Close & Reveal" runs the tlock decrypt + close_and_reveal on-chain (REAL, via the injected engine),
// then the dim marks resolve into a weighted YES/NO bar (lime), names the winner (the project wins the
// USDC pool iff Approved), and shows the explorer link.
import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import { explorerTx, short } from "../../lib/config";

export interface RevealOutcome {
  approved: boolean;
  yesW: string;
  noW: string;
  txHash: string;
}

export interface RevealEngine {
  /** Run the REAL tlock reveal -> close_and_reveal on-chain. Returns the weighted tally + tx hash. */
  reveal: () => Promise<RevealOutcome>;
}

export interface RevealStageProps {
  address: string;
  proposalId: number;
  projectName: string;
  poolUsdc: string;
  engine: RevealEngine;
}

type Phase = "sealed" | "revealing" | "revealed" | "error";

const fmt = (raw: string): string => {
  try {
    return Number(raw).toLocaleString("en-US");
  } catch {
    return raw;
  }
};

// The sealed visual: a dim field of identical marks — the tally as an anonymity set. No mark is lit,
// none reveals a direction; only that ballots exist.
function SealedMarks() {
  return (
    <span className="aset rv-sealed-aset" style={{ "--cols": 12 } as CSSProperties} aria-hidden="true">
      {Array.from({ length: 36 }).map((_, i) => (
        <span key={i} className="m" />
      ))}
    </span>
  );
}

export function RevealStage({ address, proposalId, projectName, poolUsdc, engine }: RevealStageProps) {
  const [phase, setPhase] = useState<Phase>("sealed");
  const [outcome, setOutcome] = useState<RevealOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onReveal = useCallback(async () => {
    if (phase === "revealing") return;
    setPhase("revealing");
    setError(null);
    try {
      const res = await engine.reveal();
      setOutcome(res);
      setPhase("revealed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [engine, phase]);

  // Weighted bar proportions (presentation only — derived from the revealed tally).
  const yesN = outcome ? Number(outcome.yesW) || 0 : 0;
  const noN = outcome ? Number(outcome.noW) || 0 : 0;
  const total = yesN + noN;
  const yesPct = total > 0 ? Math.round((yesN / total) * 100) : 50;
  const noPct = 100 - yesPct;

  return (
    <div className="rv card">
      <div className="rv-head">
        <span className="eyebrow">Sealed tally</span>
        <h3 className="rv-title">
          {phase === "revealed" ? "The seal is broken" : "The result is sealed"}
        </h3>
      </div>

      {(phase === "sealed" || phase === "revealing" || phase === "error") && (
        <>
          <div className="rv-sealed-wrap">
            <div className="sealed rv-sealed-vis" aria-hidden="true">
              <SealedMarks />
            </div>
            <p className="rv-copy mono">
              Tally hidden until close — whales can&apos;t see which way it&apos;s going.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary rv-cta"
            onClick={onReveal}
            disabled={phase === "revealing"}
          >
            {phase === "revealing" ? "Revealing… tlock decrypt + close on-chain" : "Close & Reveal"}
          </button>
          {phase === "error" && error && (
            <p className="rv-error mono" role="alert">
              Reveal failed: {error}
            </p>
          )}
        </>
      )}

      {phase === "revealed" && outcome && (
        <div className="rv-revealed" data-testid="reveal-result">
          <p className="rv-caption mono">
            The dim marks resolve — every sealed ballot tlock-decrypted &amp; re-aggregated on-chain.
          </p>

          <div className="rv-bar" role="img" aria-label={`Weighted yes ${fmt(outcome.yesW)}, weighted no ${fmt(outcome.noW)}`}>
            <span className="rv-bar-yes" style={{ width: `${yesPct}%` }} />
            <span className="rv-bar-no" style={{ width: `${noPct}%` }} />
          </div>

          <div className="rv-tally">
            <div className="rv-leg rv-leg-yes">
              <span className="rv-leg-k mono">Weighted YES</span>
              <span className="rv-leg-v mono">{fmt(outcome.yesW)} <span className="rv-leg-pct">· {yesPct}%</span></span>
            </div>
            <div className="rv-leg rv-leg-no">
              <span className="rv-leg-k mono">Weighted NO</span>
              <span className="rv-leg-v mono">{fmt(outcome.noW)} <span className="rv-leg-pct">· {noPct}%</span></span>
            </div>
          </div>

          {outcome.approved ? (
            <div className="rv-winner">
              <span className="tag tag-lime"><span className="rv-wdot" /> Approved</span>
              <p className="rv-winner-line">
                <strong>{projectName}</strong> wins the <strong>{fmt(poolUsdc)} USDC</strong> pool.
              </p>
            </div>
          ) : (
            <div className="rv-winner rv-rejected">
              <span className="tag tag-red">Rejected</span>
              <p className="rv-winner-line">
                <strong>{projectName}</strong> fell short of quorum — no disbursement.
              </p>
            </div>
          )}

          <a
            className="mono rv-link"
            href={explorerTx(outcome.txHash)}
            target="_blank"
            rel="noopener"
            aria-label="View reveal transaction on Stellar Explorer"
          >
            View transaction on Explorer ↗ {short(outcome.txHash, 6, 6)}
          </a>
          <p className="rv-foot mono">closed by {short(address)} · proposal #{proposalId}</p>
        </div>
      )}

      <style>{`
        .rv { display: flex; flex-direction: column; gap: 1.1rem; }
        .rv-title { margin: .35rem 0 0; }
        .rv-sealed-wrap { display: flex; flex-direction: column; gap: .9rem; align-items: center; padding: .6rem 0 .2rem; }
        .rv-sealed-vis { display: grid; place-items: center; }
        .rv-sealed-aset { width: min(280px, 80%); gap: clamp(5px, 1.2vw, 8px); }
        .rv-sealed-aset .m { border-radius: 1.5px; }
        .rv-copy { color: var(--muted); text-align: center; font-size: .78rem; letter-spacing: .02em; margin: 0; max-width: 42ch; }
        .rv-cta { align-self: center; min-height: 42px; }
        .rv-error { color: var(--red); font-size: .85rem; margin: 0; }

        .rv-revealed { display: flex; flex-direction: column; gap: 1rem; animation: rv-unseal .5s ease both; }
        @keyframes rv-unseal { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        .rv-caption { color: var(--muted); font-size: .76rem; letter-spacing: .02em; margin: 0; }
        .rv-bar { display: flex; height: 14px; border-radius: 999px; overflow: hidden; background: var(--line); border: 1px solid var(--line-2); }
        .rv-bar-yes { background: var(--lime); height: 100%; transition: width .5s ease; }
        .rv-bar-no { background: var(--line-2); height: 100%; transition: width .5s ease; }
        .rv-tally { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
        .rv-leg { display: flex; flex-direction: column; gap: .25rem; }
        .rv-leg-no { text-align: right; align-items: flex-end; }
        .rv-leg-k { color: var(--muted); font-size: .68rem; letter-spacing: .12em; text-transform: uppercase; }
        .rv-leg-v { font-size: 1.5rem; font-weight: 700; color: var(--text); }
        .rv-leg-yes .rv-leg-v { color: var(--lime); }
        .rv-leg-pct { font-size: .8rem; font-weight: 400; color: var(--muted); }

        .rv-winner { display: flex; flex-direction: column; gap: .55rem; padding: 1rem; border-radius: var(--radius); border: 1px solid color-mix(in oklab, var(--lime) 45%, var(--line-2)); background: color-mix(in oklab, var(--lime) 7%, transparent); }
        .rv-wdot { width: 6px; height: 6px; border-radius: 50%; background: var(--lime); display: inline-block; }
        .rv-rejected { border-color: var(--line-2); background: var(--bg-2); }
        .rv-winner-line { margin: 0; color: var(--text-2); font-size: .95rem; }
        .rv-link { color: var(--lime); font-size: .82rem; }
        .rv-foot { color: var(--muted); font-size: .74rem; margin: 0; }
        @media (max-width: 480px) { .rv-tally { flex-direction: column; } .rv-leg-no { text-align: left; align-items: flex-start; } }
      `}</style>
    </div>
  );
}
