// SealedVoteFlow — the signature ShadowFund interaction. On YES/NO the flow runs the THREE live steps
// and shows each as a sealed-progress line:
//   1) build the zero-knowledge proof (REAL snarkjs over /zk/*),
//   2) timelock-seal the (weight,direction) to a drand round (REAL tlock),
//   3) submit cast_vote on-chain (REAL wallet-signed tx) -> explorer link.
// The running tally is NEVER shown here (privacy). The actual crypto/on-chain logic is injected as an
// `engine` so the page wires the REAL voteClient and tests can stub the engine at the component layer.
import { useCallback, useState } from "react";
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
  { key: "proof", label: "Building zero-knowledge proof", detail: "snarkjs Groth16 over the live circuit — hides identity, weight & direction" },
  { key: "seal", label: "Timelock-sealing your vote", detail: "tlock → drand quicknet — undecryptable until close" },
  { key: "submit", label: "Submitting cast_vote on-chain", detail: "wallet-signed Soroban tx on testnet" },
];

export function SealedVoteFlow({ address, proposalId, projectName, engine, onDone }: SealedVoteFlowProps) {
  const [running, setRunning] = useState(false);
  const [stepStates, setStepStates] = useState<Record<Step["key"], StepState>>({
    proof: "idle",
    seal: "idle",
    submit: "idle",
  });
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setStep = (k: Step["key"], s: StepState) =>
    setStepStates((prev) => ({ ...prev, [k]: s }));

  const cast = useCallback(
    async (direction: 0 | 1) => {
      if (running) return;
      setRunning(true);
      setError(null);
      setTxHash(null);
      setStepStates({ proof: "idle", seal: "idle", submit: "idle" });
      try {
        setStep("proof", "active");
        const bundle = await engine.buildProof({ direction });
        setStep("proof", "done");

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
        </div>
      )}

      {started && (
        <ol className="svf-steps" aria-label="Sealed vote progress">
          {STEPS.map((s) => {
            const st = stepStates[s.key];
            return (
              <li key={s.key} data-step={s.key} data-state={st} className={`svf-step is-${st}`}>
                <span className="svf-marker" aria-hidden="true">
                  {st === "done" ? "✓" : st === "error" ? "✕" : st === "active" ? "◐" : "○"}
                </span>
                <span className="svf-step-body">
                  <span className="svf-step-label">{s.label}</span>
                  <span className="svf-step-detail">{s.detail}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {txHash && (
        <div className="svf-result" data-testid="svf-success">
          <p className="svf-ok">
            <span className="badge badge-green">● Sealed &amp; recorded</span> Your vote is in —
            its direction stays hidden until close.
          </p>
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
        <p className="svf-error" role="alert">
          Vote failed: {error}
        </p>
      )}

      <style>{`
        .svf { display: flex; flex-direction: column; gap: 1.2rem; }
        .svf-title { margin: .3rem 0 .2rem; }
        .svf-sub { color: var(--mist-2); font-size: .82rem; }
        .svf-choice { display: flex; gap: .8rem; flex-wrap: wrap; }
        .svf-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .7rem; }
        .svf-step { display: flex; gap: .8rem; align-items: flex-start; padding: .7rem .9rem; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255,255,255,.015); }
        .svf-step.is-active { border-color: var(--veil); box-shadow: var(--glow-veil); }
        .svf-step.is-done { border-color: rgba(86,217,138,.45); }
        .svf-step.is-error { border-color: rgba(255,107,129,.6); }
        .svf-marker { font-family: var(--font-mono); width: 1.3em; text-align: center; }
        .svf-step.is-active .svf-marker { color: var(--veil); animation: svf-spin 1.1s linear infinite; }
        .svf-step.is-done .svf-marker { color: var(--green); }
        .svf-step.is-error .svf-marker { color: var(--red); }
        @keyframes svf-spin { to { transform: rotate(360deg); } }
        .svf-step-body { display: flex; flex-direction: column; }
        .svf-step-label { font-family: var(--font-display); font-weight: 600; font-size: .95rem; }
        .svf-step-detail { color: var(--mist); font-size: .82rem; }
        .svf-result { display: flex; flex-direction: column; gap: .5rem; }
        .svf-ok { margin: 0; color: var(--ink); font-size: .92rem; }
        .svf-link { color: var(--cyan); font-size: .85rem; }
        .svf-error { color: var(--red); font-size: .9rem; margin: 0; }
        @media (prefers-reduced-motion: reduce) { .svf-step.is-active .svf-marker { animation: none; } }
      `}</style>
    </div>
  );
}
