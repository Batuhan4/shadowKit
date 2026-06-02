#![no_std]
// swap-venue: venue-agnostic SwapVenue trait + generated SwapVenueClient (foundation §2.4).
// `#[contractclient(name = "SwapVenueClient")]` on a trait generates a typed cross-contract
// client (`SwapVenueClient`) usable against any contract that exports `swap`/`reserves`.
// Verified pattern: ctx7 /stellar/rs-soroban-sdk — a #[contractclient] on a trait produces a
// typed client usable across contracts (2026-06-02).
use soroban_sdk::{contractclient, Address, Env};

/// Common interface every venue (FallbackAMM, Soroswap adapter) satisfies.
/// AgentPolicy (M2) only ever authorizes calls to `swap` on the configured venue address.
#[contractclient(name = "SwapVenueClient")]
pub trait SwapVenue {
    /// Swap exactly `amount_in` of `asset_in` for >= `min_out` of the other asset, sent `to`.
    /// Returns the actual amount out. Reverts if out < min_out (slippage guard).
    fn swap(env: Env, asset_in: Address, amount_in: i128, min_out: i128, to: Address) -> i128;

    /// Current reserves (reserve_a, reserve_b) keyed by the pool's canonical asset ordering.
    fn reserves(env: Env) -> (i128, i128);
}

// M2-8: the alternate (config-selectable) venue. Compiled only under `--features soroswap`; the
// default build (and the existing SwapVenue trait) is untouched. M6 wires the live Soroswap router.
#[cfg(feature = "soroswap")]
pub mod soroswap_adapter;
