// VERIFIED 2026-06-02/03 against the INSTALLED packages (charter rule 5): the client pays the 402
// automatically via
//   const client = new x402Client().register("stellar:*", new ExactStellarScheme(signer));
//   const fetchWithPayment = wrapFetchWithPayment(fetch, client);  // from "@x402/fetch"
//
// ⚠ API DRIFT vs the M6 plan (recorded decision): the plan named the client scheme `ExactStellarClient`
//   from top-level "@x402/stellar". The INSTALLED top-level "@x402/stellar" exports the client scheme as
//   `ExactStellarScheme` (NOT `ExactStellarClient`); `ExactStellarClient` does not exist. The plan itself
//   anticipated this ("if the client scheme is exported as ExactStellarScheme from top-level @x402/stellar
//   ... use that name") — we use the installed name. `wrapFetchWithPayment` IS in "@x402/fetch" as planned.
//   `signerSecret` is CLIENT_SECRET (the USDC-funded payer account — distinct from facilitator + payTo;
//   foundation §3.6a).
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme as ExactStellarClientScheme, createEd25519Signer } from "@x402/stellar";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { StellarNetwork } from "./index.js";

/** Build a fetch() that transparently pays any x402 (HTTP 402) challenge it encounters. */
export function makeX402Fetch(signerSecret: string, network: StellarNetwork): typeof fetch {
  const signer = createEd25519Signer(signerSecret, network);
  const client = new x402Client().register("stellar:*", new ExactStellarClientScheme(signer));
  return wrapFetchWithPayment(fetch, client) as typeof fetch;
}
