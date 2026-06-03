import { describe, it, expect } from "vitest";
import { CONFIG, explorerContract } from "../../lib/config.ts";
import {
  STORY_STAGES,
  DEMO_CARDS,
  HOW_STEPS,
  TRACKS,
  buildLiveContracts,
} from "./landing-data.ts";

describe("landing-data: STORY_STAGES (shadow → reveal pipeline)", () => {
  it("models the 4 signature stages in order", () => {
    expect(STORY_STAGES).toHaveLength(4);
    expect(STORY_STAGES.map((s) => s.key)).toEqual([
      "sealed",
      "timelock",
      "reveal",
      "execute",
    ]);
  });

  it("binds each stage to a brand accent (veil → cyan → gold → green)", () => {
    expect(STORY_STAGES.map((s) => s.accent)).toEqual([
      "veil",
      "cyan",
      "gold",
      "green",
    ]);
  });

  it("gives every stage non-empty title + body copy (no lorem)", () => {
    for (const s of STORY_STAGES) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.body.trim().length).toBeGreaterThan(12);
      expect(s.body.toLowerCase()).not.toContain("lorem");
    }
  });
});

describe("landing-data: DEMO_CARDS (the three doorways)", () => {
  it("links Private Voting, AI AgentBoard, and SDK & Docs", () => {
    expect(DEMO_CARDS.map((c) => c.href)).toEqual([
      "/demo/fund",
      "/demo/agent",
      "/docs",
    ]);
  });

  it("assigns the brand accents veil / cyan / (neutral) per spec", () => {
    expect(DEMO_CARDS[0]!.accent).toBe("veil");
    expect(DEMO_CARDS[1]!.accent).toBe("cyan");
  });

  it("has a title, blurb, and CTA label on every card", () => {
    for (const c of DEMO_CARDS) {
      expect(c.title.trim()).not.toBe("");
      expect(c.blurb.trim().length).toBeGreaterThan(12);
      expect(c.cta.trim()).not.toBe("");
    }
  });
});

describe("landing-data: HOW_STEPS (4 numbered steps)", () => {
  it("has exactly four steps numbered 1..4 in order", () => {
    expect(HOW_STEPS).toHaveLength(4);
    expect(HOW_STEPS.map((s) => s.n)).toEqual([1, 2, 3, 4]);
  });

  it("describes snapshot → sealed ZK vote → timelock reveal → agent swap", () => {
    const blob = HOW_STEPS.map((s) => `${s.title} ${s.body}`).join(" ").toLowerCase();
    expect(blob).toContain("snapshot");
    expect(blob).toContain("zk");
    expect(blob).toContain("timelock");
    expect(blob).toContain("agent");
  });
});

describe("landing-data: TRACKS", () => {
  it("lists both hackathon tracks with the brand accents", () => {
    expect(TRACKS).toHaveLength(2);
    expect(TRACKS.map((t) => t.name)).toEqual(["Hack Privacy", "Hack Agentic"]);
    expect(TRACKS.map((t) => t.accent)).toEqual(["veil", "cyan"]);
  });
});

describe("landing-data: buildLiveContracts (real testnet ids)", () => {
  const live = buildLiveContracts();

  it("surfaces 4 real CONFIG contract ids", () => {
    expect(live).toHaveLength(4);
  });

  it("uses live ids straight from CONFIG (no placeholders)", () => {
    const ids = live.map((c) => c.id);
    expect(ids).toContain(CONFIG.govVaultId);
    expect(ids).toContain(CONFIG.verifierId);
    expect(ids).toContain(CONFIG.usdcId);
    expect(ids).toContain(CONFIG.ammId);
    for (const c of live) {
      expect(c.id).toMatch(/^C[A-Z2-7]{55}$/); // soroban contract strkey
    }
  });

  it("each entry resolves to a stellar.expert testnet contract link", () => {
    for (const c of live) {
      expect(c.href).toBe(explorerContract(c.id));
      expect(c.href).toContain("/explorer/testnet/contract/");
    }
  });

  it("labels every entry", () => {
    for (const c of live) expect(c.label.trim()).not.toBe("");
  });
});
