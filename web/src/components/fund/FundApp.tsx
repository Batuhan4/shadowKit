// FundApp — the ShadowFund client island. Wires the REAL pieces end-to-end:
//   • Stellar Wallets Kit (testnet) for connect + signing,
//   • voteClient (REAL snarkjs proof + REAL tlock seal + REAL on-chain cast_vote) for SealedVoteFlow,
//   • voteClient (REAL tlock reveal + REAL close_and_reveal) for RevealStage.
// The voter's secret/witness never leaves the browser; the wallet pays the tx fee and signs.
//
// The demo's 3 sealed votes come from the deterministic snapshot (web/src/lib/snapshot.json — the
// SAME members the gov-vault merkle_root was init'd with). Each member casts in snapshot order; their
// sealed ciphertexts (tracked here) feed the REAL tlock reveal. cast_vote/close_and_reveal need no
// special auth on the deployed contract (privacy lives in the proof), so any connected wallet works.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WalletConnect } from "./WalletConnect";
import { FundProjectGrid, type FundProject } from "./FundProjectGrid";
import { SealedVoteFlow, type SealedVoteEngine } from "./SealedVoteFlow";
import { RevealStage, type RevealEngine } from "./RevealStage";
import { CONFIG } from "../../lib/config";
import {
  loadArtifacts,
  buildVoteProof,
  buildCastVoteXdr,
  buildCloseAndRevealXdr,
  buildRevealFromSealed,
  readVotesCast,
  readIsApproved,
  submitSignedXdr,
  type Artifacts,
  type SnapshotMember,
  type SealedCiphertext,
  type VoteProofResult,
} from "../../lib/voteClient";
import snapshot from "../../lib/snapshot.json";

export interface FundAppProps {
  projects: FundProject[];
  /** the live on-chain proposal id this round votes on. */
  proposalId: number;
  /** the USDC pool the winning project receives. */
  poolUsdc: string;
}

const members = snapshot.members as SnapshotMember[];

/** A bundle carried between proof -> seal -> submit in the SealedVoteFlow engine. */
interface VoteBundle {
  result: VoteProofResult;
  memberIndex: number;
}

export function FundApp({ projects, proposalId, poolUsdc }: FundAppProps) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    projects.find((p) => p.live)?.id ?? null,
  );
  const [votesSealed, setVotesSealed] = useState<number>(0);
  const [walletError, setWalletError] = useState<string | null>(null);

  // Per-session GovVault proposal: the deployed contract needs a FRESH short-deadline proposal each
  // session (create_proposal requires admin auth + deadline>now; close_and_reveal requires
  // now>=deadline). We POST /api/session/create-proposal (admin-signed server-side) to mint one, and
  // use its id+deadline for the vote/reveal flow. The `proposalId` PROP stays the fallback default.
  const [sessionProposalId, setSessionProposalId] = useState<number | null>(null);
  const [sessionDeadline, setSessionDeadline] = useState<number | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));

  // The active proposal: the freshly-minted session proposal if present, else the prop default.
  const activeProposalId = sessionProposalId ?? proposalId;

  // the kit instance + artifacts are lazy/heavy — load once.
  const kitRef = useRef<typeof import("@creit.tech/stellar-wallets-kit").StellarWalletsKit | null>(null);
  const artifactsRef = useRef<Artifacts | null>(null);
  // each member votes once per round, in snapshot order; track which member is next + their ciphertexts.
  const nextMemberRef = useRef<number>(0);
  const sealedRef = useRef<SealedCiphertext[]>([]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );

  // initial on-chain read of the participation count (safe — never the tally).
  useEffect(() => {
    let alive = true;
    readVotesCast(activeProposalId)
      .then((n) => {
        if (alive) {
          setVotesSealed(n);
          nextMemberRef.current = Math.min(n, members.length - 1);
        }
      })
      .catch(() => {/* proposal may not exist yet; leave count at 0 */});
    return () => {
      alive = false;
    };
  }, [activeProposalId]);

  // Live 1s ticker for the deadline countdown (only runs while a session deadline is set).
  useEffect(() => {
    if (sessionDeadline == null) return;
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [sessionDeadline]);

  // Mint a fresh per-session proposal (admin-signed server-side) and adopt its id + deadline.
  const startSession = useCallback(async () => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      const res = await fetch("/api/session/create-proposal", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `create-proposal ${res.status}`);
      }
      const { proposalId: id, deadline } = (await res.json()) as {
        proposalId: number;
        deadline: number;
      };
      // a new session resets the per-round vote bookkeeping.
      sealedRef.current = [];
      nextMemberRef.current = 0;
      setVotesSealed(0);
      setSessionProposalId(id);
      setSessionDeadline(deadline);
      setNowSec(Math.floor(Date.now() / 1000));
    } catch (e) {
      setSessionError((e as Error).message);
    } finally {
      setSessionLoading(false);
    }
  }, []);

  const secondsLeft =
    sessionDeadline != null ? Math.max(0, sessionDeadline - nowSec) : null;

  const getKit = useCallback(async () => {
    if (kitRef.current) return kitRef.current;
    const { StellarWalletsKit, Networks } = await import("@creit.tech/stellar-wallets-kit");
    const { defaultModules } = await import("@creit.tech/stellar-wallets-kit/modules/utils");
    const { SwkAppDarkTheme } = await import("@creit.tech/stellar-wallets-kit/types");
    StellarWalletsKit.init({
      modules: defaultModules(),
      network: Networks.TESTNET,
      theme: SwkAppDarkTheme,
    });
    kitRef.current = StellarWalletsKit;
    return StellarWalletsKit;
  }, []);

  const onConnect = useCallback(async () => {
    setConnecting(true);
    setWalletError(null);
    try {
      const kit = await getKit();
      const { address: addr } = await kit.authModal();
      setAddress(addr);
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      // user-closed-modal is not an error worth shouting about.
      if (!/closed the modal/i.test(msg)) setWalletError(msg);
    } finally {
      setConnecting(false);
    }
  }, [getKit]);

  const onDisconnect = useCallback(async () => {
    try {
      const kit = await getKit();
      await kit.disconnect();
    } catch {/* ignore */}
    setAddress(null);
  }, [getKit]);

  const getArtifacts = useCallback(async () => {
    if (!artifactsRef.current) artifactsRef.current = await loadArtifacts();
    return artifactsRef.current;
  }, []);

  // REAL SealedVoteFlow engine: build proof+seal -> wallet signs cast_vote -> submit on-chain.
  const voteEngine: SealedVoteEngine = useMemo(
    () => ({
      buildProof: async ({ direction }) => {
        if (!address) throw new Error("connect a wallet first");
        const artifacts = await getArtifacts();
        const memberIndex = nextMemberRef.current % members.length;
        const member = { ...members[memberIndex]!, direction };
        // Seal to the live session deadline (so the tlock round unlocks at close); fall back to a
        // near-future deadline if no session was bootstrapped (the prop-default proposal path).
        const deadline = sessionDeadline ?? Math.floor(Date.now() / 1000) + 90;
        const result = await buildVoteProof(member, activeProposalId, deadline, artifacts);
        return { result, memberIndex } satisfies VoteBundle;
      },
      seal: async () => {/* the tlock seal happens inside buildVoteProof; nothing extra here */},
      submit: async (bundle) => {
        if (!address) throw new Error("connect a wallet first");
        const { result } = bundle as VoteBundle;
        const xdr = await buildCastVoteXdr(address, activeProposalId, result);
        const kit = await getKit();
        const { signedTxXdr } = await kit.signTransaction(xdr, {
          networkPassphrase: CONFIG.networkPassphrase,
          address,
        });
        const res = await submitSignedXdr(signedTxXdr);
        // record this round's sealed ciphertext for the reveal + advance to the next member.
        sealedRef.current.push(result.sealedCiphertext);
        nextMemberRef.current = (nextMemberRef.current + 1) % members.length;
        setVotesSealed((n) => n + 1);
        return res;
      },
    }),
    [address, getArtifacts, getKit, activeProposalId, sessionDeadline],
  );

  // REAL RevealStage engine: tlock-decrypt this round's sealed votes -> close_and_reveal on-chain.
  const revealEngine: RevealEngine = useMemo(
    () => ({
      reveal: async () => {
        if (!address) throw new Error("connect a wallet first");
        const sealed = sealedRef.current;
        if (sealed.length === 0) {
          throw new Error("no sealed votes recorded this session — cast votes before revealing");
        }
        const { revealedYesW, revealedNoW, decryptions } = await buildRevealFromSealed(sealed);
        const xdr = await buildCloseAndRevealXdr(
          address,
          activeProposalId,
          revealedYesW,
          revealedNoW,
          decryptions,
        );
        const kit = await getKit();
        const { signedTxXdr } = await kit.signTransaction(xdr, {
          networkPassphrase: CONFIG.networkPassphrase,
          address,
        });
        const res = await submitSignedXdr(signedTxXdr);
        const approved = await readIsApproved(activeProposalId);
        return { approved, yesW: revealedYesW, noW: revealedNoW, txHash: res.txHash };
      },
    }),
    [address, getKit, activeProposalId],
  );

  return (
    <div className="fundapp">
      <div className="fundapp-bar">
        <div className="fundapp-bar-left">
          <span className="tag tag-lime"><span className="fundapp-livedot" /> Live on testnet</span>
          <span className="mono fundapp-prop">proposal #{activeProposalId}</span>
          {sessionProposalId != null && (
            <span className="tag tag-lime">fresh session</span>
          )}
        </div>
        <WalletConnect
          address={address}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          busy={connecting}
        />
      </div>

      <div className="fundapp-session">
        <button
          type="button"
          className="btn btn-primary fundapp-session-btn"
          onClick={startSession}
          disabled={sessionLoading}
        >
          {sessionLoading
            ? "Minting proposal…"
            : sessionProposalId != null
              ? "Start a new voting session"
              : "Start voting session"}
        </button>
        {sessionProposalId != null && secondsLeft != null && (
          <span className="fundapp-countdown mono" role="status" aria-live="polite">
            {secondsLeft > 0 ? (
              <>closes in <strong>{secondsLeft}s</strong> · deadline {sessionDeadline}</>
            ) : (
              <>deadline reached — reveal now</>
            )}
          </span>
        )}
        {sessionProposalId == null && !sessionLoading && (
          <span className="fundapp-session-hint">
            Mints a fresh short-deadline GovVault proposal so this round can close & reveal live.
          </span>
        )}
      </div>
      {sessionError && (
        <p className="fundapp-werr" role="alert">
          Session error: {sessionError}
        </p>
      )}
      {walletError && (
        <p className="fundapp-werr" role="alert">
          Wallet error: {walletError}
        </p>
      )}

      <section className="fundapp-grid">
        <FundProjectGrid
          projects={projects}
          votesSealed={votesSealed}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </section>

      <section className="fundapp-action">
        {address && selectedProject?.live ? (
          <SealedVoteFlow
            address={address}
            proposalId={activeProposalId}
            projectName={selectedProject.name}
            engine={voteEngine}
            onDone={() => {/* count already advanced in submit */}}
          />
        ) : (
          <div className="card fundapp-cta">
            <span className="eyebrow">{address ? "Almost there" : "Step 1"}</span>
            <h3>{address ? "Pick a live project to vote" : "Connect a wallet to vote privately"}</h3>
            <p className="muted">
              Your vote is sealed with a zero-knowledge proof (identity, weight & direction hidden) and
              timelock-encrypted so the running tally stays invisible until close.
            </p>
            {!address && (
              <WalletConnect address={null} onConnect={onConnect} onDisconnect={onDisconnect} busy={connecting} />
            )}
          </div>
        )}

        {address && selectedProject ? (
          <RevealStage
            address={address}
            proposalId={activeProposalId}
            projectName={selectedProject.name}
            poolUsdc={poolUsdc}
            engine={revealEngine}
          />
        ) : null}
      </section>

      <style>{`
        .fundapp { display: flex; flex-direction: column; gap: clamp(1.2rem, 2.5vw, 1.7rem); }
        .fundapp-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
        .fundapp-bar-left { display: inline-flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
        .fundapp-livedot { width: 6px; height: 6px; border-radius: 50%; background: var(--lime); display: inline-block; }
        .fundapp-prop { color: var(--muted); font-size: .78rem; }
        .fundapp-session { display: inline-flex; align-items: center; gap: .9rem; flex-wrap: wrap; }
        .fundapp-session-btn { min-height: 42px; }
        .fundapp-countdown { color: var(--text-2); font-size: .8rem; letter-spacing: .02em; }
        .fundapp-countdown strong { color: var(--lime); font-weight: 700; }
        .fundapp-session-hint { color: var(--muted); font-size: .78rem; max-width: 48ch; }
        .fundapp-werr { color: var(--red); font-family: var(--font-mono); font-size: .82rem; margin: 0; }
        .fundapp-action { display: grid; grid-template-columns: 1.15fr 1fr; gap: clamp(1rem, 2vw, 1.4rem); align-items: start; }
        .fundapp-cta { display: flex; flex-direction: column; gap: .7rem; }
        .fundapp-cta h3 { margin: 0; }
        .fundapp-cta p { margin: 0; }
        @media (max-width: 880px) { .fundapp-action { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}

export default FundApp;
