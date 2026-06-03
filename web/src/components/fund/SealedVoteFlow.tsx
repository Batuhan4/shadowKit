// SealedVoteFlow — the signature ShadowFund interaction. On YES/NO the flow runs the THREE live steps
// and shows each as a sealed-progress line with lime ticks:
//   1) build the zero-knowledge proof (REAL snarkjs over /zk/*),
//   2) timelock-seal the (weight,direction) to a drand round (REAL tlock),
//   3) submit cast_vote on-chain (REAL wallet-signed tx) -> explorer link.
// The running tally is NEVER shown here (privacy). The actual crypto/on-chain logic is injected as an
// `engine` so the page wires the REAL voteClient and tests can stub the engine at the component layer.
import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import { explorerTx, short } from "../../lib/config";

export interface SealedVoteEngine {
  /** Build a REAL ZK proof + tlock seal for {direction}. Returns the opaque proof bundle. */
  buildProof: (args: { direction: 0 | 1 }) => Promise<unknown>;
  /** Optional post-proof seal confirmation hook (the seal happens inside buildProof; this lets the
   *  page report drand round details). No-op acceptable. */
  seal: (bundle: unknown) => Promise<void>;
  /** Submit cast_vote on-chain (wallet signs). Returns the tx hash + status. */
  submit: (bundle: unknown) => Promise<{ txHash: string; status: string }>;
}

export interface SealedVoteFlowProps {
  address: string;
  proposalId: number;
  projectName: string;
  engine: SealedVoteEngine;
  onDone: (txHash: string) => void;
}

type StepState = "idle" | "active" | "done" | "error";
interface Step {
  key: "proof" | "seal" | "submit";
  label: string;
  detail: string;
}

const STEPS: Step[] = [
  { key: "proof", label: "Build zero-knowledge proof", detail: "snarkjs Groth16 over the live circuit — hides identity, weight & direction" },
  { key: "seal", label: "Timelock-seal the vote", detail: "tlock → drand quicknet — undecryptable until close" },
  { key: "submit", label: "Cast on-chain, tally sealed", detail: "wallet-signed Soroban tx on testnet" },
];

// The bundle is opaque to this component, but it CARRIES a nullifier (unique per vote, unlinkable to
// identity) and the drand round it sealed to. We read them defensively for display only — never logic.
interface BundleShape {
  result?: { publicSignals?: { nullifier?: unknown }; sealedCiphertext?: { round?: unknown } };
  publicSignals?: { nullifier?: unknown };
  sealedCiphertext?: { round?: unknown };
}
function readNullifier(bundle: unknown): string | null {
  const b = bundle as BundleShape | null | undefined;
  const n = b?.result?.publicSignals?.nullifier ?? b?.publicSignals?.nullifier;
  return typeof n === "string" || typeof n === "number" ? String(n) : null;
}
function readRound(bundle: unknown): string | null {
  const b = bundle as BundleShape | null | undefined;
  const r = b?.result?.sealedCiphertext?.round ?? b?.sealedCiphertext?.round;
  return typeof r === "number" ? String(r) : null;
}
// Shorten a long decimal nullifier into a mono glyph: 4831…0072.
function shortNullifier(n: string): string {
  return n.length <= 13 ? n : `${n.slice(0, 6)}…${n.slice(-4)}`;
}

export function SealedVoteFlow({ address, proposalId, projectName, engine, onDone }: SealedVoteFlowProps) {
  const [running, setRunning] = useState(false);
  const [stepStates, setStepStates] = useState<Record<Step["key"], StepState>>({
    proof: "idle",
    seal: "idle",
    submit: "idle",
  });
  const [txHash, setTxHash] = useState<string | null>(null);
  const [nullifier, setNullifier] = useState<string | null>(null);
  const [round, setRound] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setStep = (k: Step["key"], s: StepState) =>
    setStepStates((prev) => ({ ...prev, [k]: s }));

  const cast = useCallback(
    async (direction: 0 | 1) => {
      if (running) return;
      setRunning(true);
      setError(null);
      setTxHash(null);
      setNullifier(null);
      setRound(null);
      setStepStates({ proof: "idle", seal: "idle", submit: "idle" });
      try {
        setStep("proof", "active");
        const bundle = await engine.buildProof({ direction });
        setStep("proof", "done");
        // surface the nullifier + sealed round for display (unique mark, unlinkable to identity).
        setNullifier(readNullifier(bundle));
        setRound(readRound(bundle));

        setStep("seal", "active");
        await engine.seal(bundle);
        setStep("seal", "done");

        setStep("submit", "active");
        const res = await engine.submit(bundle);
        setStep("submit", "done");
        setTxHash(res.txHash);
        onDone(res.txHash);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        // mark the currently-active step as failed
        setStepStates((prev) => {
          const next = { ...prev };
          for (const s of STEPS) if (next[s.key] === "active") next[s.key] = "error";
          return next;
        });
      } finally {
        setRunning(false);
      }
    },
    [engine, onDone, running],
  );

  const started = running || txHash !== null || error !== null;

  return (
    <div className="svf card">
      <div className="svf-head">
        <span className="eyebrow">Cast a sealed vote</span>
        <h3 className="svf-title">Fund {projectName}?</h3>
        <p className="svf-sub mono">
          voting as {short(address)} · proposal #{proposalId}
        </p>
      </div>

      {!started && (
        <div className="svf-choice">
          <button type="button" className="btn btn-primary" disabled={running} onClick={() => cast(1)}>
            Seal a YES vote
          </button>
          <button type="button" className="btn btn-ghost" disabled={running} onClick={() => cast(0)}>
            Seal a NO vote
          </button>
          <p className="svf-hint mono">↑ direction is sealed too — the chain never learns which you picked.</p>
        </div>
      )}

      {started && (
        <ol className="svf-steps" aria-label="Sealed vote progress">
          {STEPS.map((s, i) => {
            const st = stepStates[s.key];
            return (
              <li key={s.key} data-step={s.key} data-state={st} className={`svf-step is-${st}`}>
                <span className="svf-marker mono" aria-hidden="true">
                  {st === "done" ? "✓" : st === "error" ? "✕" : st === "active" ? "◇" : "·"}
                </span>
                <span className="svf-step-body">
                  <span className="svf-step-label">
                    <span className="svf-step-n mono">0{i + 1}</span> {s.label}
                  </span>
                  <span className="svf-step-detail">{s.detail}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {txHash && (
        <div className="svf-result" data-testid="svf-success">
          <div className="svf-mark-wrap">
            <span className="aset svf-mark" style={{ "--cols": 1 } as CSSProperties} aria-hidden="true">
              <span className="m lit" />
            </span>
            <p className="svf-ok">
              <span className="svf-ok-tag mono">SEALED &amp; RECORDED</span><br />
              Your vote is in — one more indistinguishable mark. Direction stays hidden until close.
            </p>
          </div>
          {nullifier && (
            <p className="svf-null mono" title="A unique per-vote tag — prevents double-voting, links to no identity.">
              nullifier {shortNullifier(nullifier)}
              {round && <> · sealed to drand round {round}</>}
            </p>
          )}
          <a
            className="mono svf-link"
            href={explorerTx(txHash)}
            target="_blank"
            rel="noopener"
            aria-label="View transaction on Stellar Explorer"
          >
            View transaction on Explorer ↗ {short(txHash, 6, 6)}
          </a>
        </div>
      )}

      {error && (
        <p className="svf-error mono" role="alert">
          Vote failed: {error}
        </p>
      )}

      <style>{`
        .svf { display: flex; flex-direction: column; gap: 1.2rem; }
        .svf-title { margin: .35rem 0 .25rem; }
        .svf-sub { color: var(--muted); font-size: .78rem; }
        .svf-choice { display: flex; gap: .8rem; flex-wrap: wrap; align-items: center; }
        .svf-choice .btn { min-height: 42px; }
        .svf-hint { flex-basis: 100%; color: var(--muted); font-size: .72rem; margin: .2rem 0 0; }
        .svf-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .55rem; }
        .svf-step { display: flex; gap: .85rem; align-items: flex-start; padding: .7rem .9rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2); opacity: .6; transition: opacity .15s, border-color .15s; }
        .svf-step.is-active { opacity: 1; border-color: var(--lime); }
        .svf-step.is-done { opacity: 1; border-color: var(--line-2); }
        .svf-step.is-error { opacity: 1; border-color: var(--red); }
        .svf-marker { width: 1.2em; text-align: center; color: var(--muted); font-size: .95rem; line-height: 1.5; }
        .svf-step.is-active .svf-marker { color: var(--lime); animation: svf-pulse 1.1s ease-in-out infinite; }
        .svf-step.is-done .svf-marker { color: var(--lime); }
        .svf-step.is-error .svf-marker { color: var(--red); }
        @keyframes svf-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
        .svf-step-body { display: flex; flex-direction: column; gap: .15rem; }
        .svf-step-label { font-family: var(--font-display); font-weight: 600; font-size: .95rem; color: var(--text); }
        .svf-step-n { color: var(--muted); font-size: .72rem; font-weight: 400; margin-right: .15rem; }
        .svf-step-detail { color: var(--muted); font-size: .8rem; line-height: 1.4; }
        .svf-result { display: flex; flex-direction: column; gap: .7rem; padding-top: .3rem; border-top: 1px solid var(--line); }
        .svf-mark-wrap { display: flex; align-items: flex-start; gap: .9rem; padding-top: .8rem; }
        .svf-mark { width: 22px; flex: 0 0 auto; }
        .svf-mark .m { width: 22px; height: 22px; }
        .svf-ok { margin: 0; color: var(--text-2); font-size: .9rem; line-height: 1.5; }
        .svf-ok-tag { color: var(--lime); font-size: .72rem; letter-spacing: .12em; }
        .svf-null { margin: 0; color: var(--muted); font-size: .76rem; letter-spacing: .02em; }
        .svf-link { color: var(--lime); font-size: .82rem; }
        .svf-error { color: var(--red); font-size: .85rem; margin: 0; }
        @media (prefers-reduced-motion: reduce) { .svf-step.is-active .svf-marker { animation: none; } }
      `}</style>
    </div>
  );
}
