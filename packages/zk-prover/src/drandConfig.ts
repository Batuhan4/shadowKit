// packages/zk-prover/src/drandConfig.ts
// Drand quicknet config + drand-client ChainClient factory (the type tlock-js consumes).
//
// SOURCE (verified 2026-06-02 against the INSTALLED packages — see provenance §0):
//  - drand-client build/index.d.ts:
//      type ChainOptions = { disableBeaconVerification: boolean; noCache: boolean;
//                            chainVerificationParams?: ChainVerificationParams }
//      type ChainVerificationParams = { chainHash: string; publicKey: string }
//      interface ChainClient { options: ChainOptions; latest(); get(round); chain() }
//    => `chainHash` is NOT a top-level option. Passing `{ chainHash }` to HttpCachingChain
//       does NOT pin/verify the chain — the beacon is accepted UNVERIFIED. Real pinning needs the
//       full `chainVerificationParams: { chainHash, publicKey }` AND disableBeaconVerification:false.
//  - drand-client build/http-caching-chain.d.ts: constructor(baseUrl, options?: ChainOptions).
//  - tlock-js@0.9.0 index.js mainnetClient(): builds HttpCachingChain(MAINNET_CHAIN_URL, {
//      ...defaultChainOptions, chainVerificationParams: { chainHash: "52db9ba7...e971",
//      publicKey: "83cf0f2896...ece45a" } }) wrapped in HttpChainClient — i.e. mainnet == quicknet,
//      WITH verification on. MAINNET_CHAIN_URL = https://api.drand.sh/52db9ba7...e971.
import {
  HttpChainClient,
  HttpCachingChain,
  defaultChainOptions,
  type ChainOptions,
  type ChainClient,
} from "drand-client";
import { mainnetClient } from "tlock-js";

export interface DrandConfig {
  chainUrl: string;
  chainHash: string;
  publicKey: string; // REQUIRED by ChainVerificationParams — without it the chain is unverified
}

/** drand quicknet — exactly what tlock-js mainnetClient() pins (BLS, 3s period, RFC9380). */
export const DEFAULT_DRAND: DrandConfig = {
  chainHash:
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  chainUrl:
    "https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
};

/** Build a drand-client ChainClient tlock-js accepts. For the DEFAULT (quicknet) we return
 *  tlock-js mainnetClient() verbatim (it already pins quicknet's { chainHash, publicKey } with
 *  verification ON). For a custom DrandConfig we construct the SAME shape explicitly so beacon
 *  verification stays enabled and pinned (NEVER the silently-unverified `{ chainHash }` form). */
export function clientFor(drand: DrandConfig = DEFAULT_DRAND): ChainClient {
  if (
    drand.chainHash === DEFAULT_DRAND.chainHash &&
    drand.chainUrl === DEFAULT_DRAND.chainUrl &&
    drand.publicKey === DEFAULT_DRAND.publicKey
  ) {
    // tlock-js mainnetClient() === quicknet, verification on (SOURCE above).
    return mainnetClient();
  }
  const opts: ChainOptions = {
    ...defaultChainOptions,
    disableBeaconVerification: false, // verify the beacon signature
    chainVerificationParams: { chainHash: drand.chainHash, publicKey: drand.publicKey },
  };
  const chain = new HttpCachingChain(drand.chainUrl, opts);
  return new HttpChainClient(chain, opts);
}
