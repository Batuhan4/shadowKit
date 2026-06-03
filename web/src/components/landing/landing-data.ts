// Landing-page content model. Pure data + one helper so the front door's copy and its live-contract
// wiring are unit-testable (no Astro render needed). Accents map to the brand tokens in global.css.
// Single source of truth consumed by the Astro section components in this directory.
import { CONFIG, explorerContract } from "../../lib/config.ts";

export type Accent = "veil" | "cyan" | "gold" | "green" | "neutral";

export interface StoryStage {
  key: "sealed" | "timelock" | "reveal" | "execute";
  index: string; // "01"..
  accent: Accent;
  tag: string; // tech badge (ZK, drand, …)
  title: string;
  body: string;
}

/** The signature visual: shadow → reveal pipeline, four stages, violet → cyan → gold → green. */
export const STORY_STAGES: StoryStage[] = [
  {
    key: "sealed",
    index: "01",
    accent: "veil",
    tag: "ZK",
    title: "Sealed vote",
    body: "A Groth16 zk-SNARK proves you're an eligible member and casts your weighted choice without revealing who you are, how you voted, or how much weight you hold.",
  },
  {
    key: "timelock",
    index: "02",
    accent: "cyan",
    tag: "drand",
    title: "Timelocked tally",
    body: "Each ballot is timelock-encrypted to a future drand beacon. The running count is mathematically unreadable until the deadline — no whale can watch and swing the result.",
  },
  {
    key: "reveal",
    index: "03",
    accent: "gold",
    tag: "reveal",
    title: "The unseal",
    body: "When the round closes the beacon drops, every sealed ballot decrypts at once, and the tally counts up in the open. This is the gold moment — shadow becomes light.",
  },
  {
    key: "execute",
    index: "04",
    accent: "green",
    tag: "on-chain",
    title: "Agent executes",
    body: "An LLM-bounded agent reads the approved outcome and submits the swap on-chain itself — gated by an on-chain policy it cannot break. No 3am multisig, no human in the loop.",
  },
];

export interface DemoCard {
  title: string;
  badge: string;
  accent: Accent;
  blurb: string;
  href: string;
  cta: string;
}

/** Three doorways into the product: the two live demos + the SDK docs. */
export const DEMO_CARDS: DemoCard[] = [
  {
    title: "Private Voting",
    badge: "ShadowFund",
    accent: "veil",
    blurb: "Cast a sealed, weighted vote on a community fund. A real ZK proof hides your identity and the tally stays timelocked until close — then it unseals on-chain.",
    href: "/demo/fund",
    cta: "Open ShadowFund",
  },
  {
    title: "AI AgentBoard",
    badge: "AgentBoard",
    accent: "cyan",
    blurb: "Watch an autonomous agent take the approved outcome, draft a bounded plan with Gemini, clear the on-chain policy gate, and execute the real swap — live, streamed.",
    href: "/demo/agent",
    cta: "Watch AgentBoard",
  },
  {
    title: "SDK & Docs",
    badge: "ShadowKit SDK",
    accent: "neutral",
    blurb: "ShadowKit ships as infrastructure: four packages — contracts, circuits, the agent runtime, and x402 — that any Stellar project can drop in. The demos are just the showroom.",
    href: "/docs",
    cta: "Read the docs",
  },
];

export interface HowStep {
  n: number;
  title: string;
  body: string;
}

/** How it works — four concise numbered steps. */
export const HOW_STEPS: HowStep[] = [
  {
    n: 1,
    title: "Snapshot the roll",
    body: "Eligible members are committed into a Merkle root. Your membership becomes a private witness — never an on-chain identity.",
  },
  {
    n: 2,
    title: "Cast a sealed ZK vote",
    body: "snarkjs builds a Groth16 proof in your browser and binds it to a nullifier, so you can vote once, privately, with your real weight.",
  },
  {
    n: 3,
    title: "Timelock, then reveal",
    body: "Ballots stay encrypted to a future drand round. At the deadline the timelock opens and the tally is decrypted and counted in the open.",
  },
  {
    n: 4,
    title: "Policy-gated agent swap",
    body: "The agent reads the approved result and submits the swap on-chain, bounded by a policy contract that rejects anything the vote didn't authorize.",
  },
];

export interface Track {
  name: string;
  accent: Accent;
  line: string;
}

/** Hackathon tracks. */
export const TRACKS: Track[] = [
  {
    name: "Hack Privacy",
    accent: "veil",
    line: "Zero-knowledge sealed ballots + timelock encryption — who voted, how, and how much, all hidden until close.",
  },
  {
    name: "Hack Agentic",
    accent: "cyan",
    line: "An autonomous, LLM-bounded agent that executes the decision on-chain inside a policy it mathematically cannot break.",
  },
];

export interface LiveContract {
  label: string;
  id: string;
  href: string;
}

/** Four real, deployed testnet contract ids → stellar.expert links. */
export function buildLiveContracts(): LiveContract[] {
  return [
    { label: "GovVault", id: CONFIG.govVaultId },
    { label: "Groth16 Verifier", id: CONFIG.verifierId },
    { label: "USDC (SAC)", id: CONFIG.usdcId },
    { label: "Swap AMM", id: CONFIG.ammId },
  ].map((c) => ({ ...c, href: explorerContract(c.id) }));
}
