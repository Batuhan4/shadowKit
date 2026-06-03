// RevealStage — the "shadow → reveal" finale. Before reveal it shows the tally as a SEALED/blurred
// placeholder with the privacy copy. "Close & Reveal" runs the tlock decrypt + close_and_reveal
// on-chain (REAL, via the injected engine), then animates the unseal (gold flash) and shows the
// weighted tally, the winner (the project wins the USDC pool iff Approved), and the explorer link.
import { useCallback, useState } from "react";
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

  return (
    <div className="rv card">
      <div className="rv-head">
        <span className="eyebrow">Sealed tally</span>
        <h3 className="rv-title">The result is sealed</h3>
      </div>

      {(phase === "sealed" || phase === "revealing" || phase === "error") && (
        <>
          <div className="rv-sealed-wrap">
            <div className="sealed rv-blur" aria-hidden="true">
              <div className="rv-fake">
                <span>YES ████</span>
                <span>NO ████</span>
              </div>
            </div>
            <p className="rv-copy">
              🔒 Tally hidden until close — whales can&apos;t see which way it&apos;s going.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary rv-cta"
            onClick={onReveal}
            disabled={phase === "revealing"}
          >
            {phase === "revealing" ? "Revealing… (tlock decrypt + close on-chain)" : "Close & Reveal"}
          </button>
          {phase === "error" && error && (
            <p className="rv-error" role="alert">
              Reveal failed: {error}
            </p>
          )}
        </>
      )}

      {phase === "revealed" && outcome && (
        <div className="rv-revealed" data-testid="reveal-result">
          <div className="rv-tally">
            <div className="rv-bar rv-yes">
              <span className="rv-bar-label">Weighted YES</span>
              <span className="rv-bar-val mono">{fmt(outcome.yesW)}</span>
            </div>
            <div className="rv-bar rv-no">
              <span className="rv-bar-label">Weighted NO</span>
              <span className="rv-bar-val mono">{fmt(outcome.noW)}</span>
            </div>
          </div>

          {outcome.approved ? (
            <div className="rv-winner">
              <span className="badge badge-gold">● Approved</span>
              <p className="rv-winner-line">
                <strong>{projectName}</strong> wins the <strong>{fmt(poolUsdc)} USDC</strong> pool.
              </p>
            </div>
          ) : (
            <div className="rv-winner rv-rejected">
              <span className="badge">● Rejected</span>
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
        .rv-title { margin: .3rem 0 0; }
        .rv-sealed-wrap { display: flex; flex-direction: column; gap: .7rem; align-items: center; padding: .5rem 0; }
        .rv-blur { width: 100%; }
        .rv-fake { display: flex; gap: 2rem; justify-content: center; font-family: var(--font-mono); font-size: 1.6rem; color: var(--mist); padding: 1.4rem 0; }
        .rv-copy { color: var(--mist); text-align: center; font-size: .9rem; margin: 0; }
        .rv-cta { align-self: center; }
        .rv-error { color: var(--red); font-size: .9rem; margin: 0; }
        .rv-revealed { display: flex; flex-direction: column; gap: 1rem; animation: rv-unseal .6s ease both; }
        @keyframes rv-unseal { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: none; } }
        .rv-tally { display: grid; grid-template-columns: 1fr 1fr; gap: .9rem; }
        .rv-bar { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 1rem; display: flex; flex-direction: column; gap: .3rem; }
        .rv-yes { border-color: rgba(86,217,138,.45); }
        .rv-no { border-color: rgba(255,107,129,.4); }
        .rv-bar-label { color: var(--mist); font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; }
        .rv-bar-val { font-size: 1.9rem; font-weight: 700; }
        .rv-yes .rv-bar-val { color: var(--green); }
        .rv-no .rv-bar-val { color: var(--red); }
        .rv-winner { display: flex; flex-direction: column; gap: .5rem; padding: 1rem; border-radius: var(--radius-sm); border: 1px solid rgba(246,196,83,.45); background: rgba(246,196,83,.06); animation: goldFlash 1.2s ease 1; }
        .rv-rejected { border-color: var(--line); background: rgba(255,255,255,.02); animation: none; }
        .rv-winner-line { margin: 0; color: var(--ink); }
        .rv-link { color: var(--cyan); font-size: .85rem; }
        .rv-foot { color: var(--mist-2); font-size: .78rem; margin: 0; }
        @media (max-width: 480px) { .rv-tally { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
