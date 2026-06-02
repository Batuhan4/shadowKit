// packages/zk-prover/test/seal.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_DRAND, clientFor } from "../src/drandConfig.js";

describe("drandConfig", () => {
  it("defaults to drand quicknet (verified against installed tlock-js mainnetClient 2026-06-02)", () => {
    // SOURCE: tlock-js@0.9.0 index.js mainnetClient() — chainHash + publicKey + URL are
    // exactly quicknet (MAINNET_CHAIN_URL = api.drand.sh/<hash>, period 3, genesis 1692803367,
    // schemeID bls-unchained-g1-rfc9380). drand-client build/index.d.ts ChainVerificationParams
    // REQUIRES BOTH { chainHash, publicKey } — chainHash alone does NOT pin the chain.
    expect(DEFAULT_DRAND.chainHash).toBe(
      "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    );
    expect(DEFAULT_DRAND.publicKey).toBe(
      "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
    );
    expect(DEFAULT_DRAND.chainUrl).toContain("api.drand.sh");
  });

  it("builds a drand-client ChainClient (tlock-js accepts) with verification ENABLED", () => {
    const client = clientFor();
    // drand-client ChainClient exposes chain() + an options bag (SOURCE: drand-client
    // build/index.d.ts: interface ChainClient { options, latest(), get(), chain() }).
    expect(typeof (client as { chain?: unknown }).chain).toBe("function");
    const opts = (client as { options: { disableBeaconVerification: boolean;
      chainVerificationParams?: { chainHash: string; publicKey: string } } }).options;
    // Verification MUST be ON and pinned to quicknet's { chainHash, publicKey }
    // (this is what fails if you only pass { chainHash } — see drand-client ChainOptions).
    expect(opts.disableBeaconVerification).toBe(false);
    expect(opts.chainVerificationParams?.chainHash).toBe(DEFAULT_DRAND.chainHash);
    expect(opts.chainVerificationParams?.publicKey).toBe(DEFAULT_DRAND.publicKey);
  });
});
