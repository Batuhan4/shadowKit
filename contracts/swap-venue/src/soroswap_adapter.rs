#![cfg(feature = "soroswap")]
// soroswap_adapter — the alternate (config-selectable) venue. A REAL `SwapVenue` that delegates
// to a configured router implementing OUR `SwapVenue` trait, forwarding `swap`/`reserves` via the
// generated `SwapVenueClient`. Selection is a config switch (env `SWAP_VENUE=soroswap`), never a
// code fork in AgentPolicy (§foundation §2.4). M2 scope = trait-conformance + REAL delegation,
// proven by a behavioral test against a mock router. M6 swaps the configured router for the live
// Soroswap router (or a Soroswap->SwapVenue shim) once the live signature is confirmed (spec §13.1).
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};
use crate::{SwapVenue, SwapVenueClient};

#[contracttype]
#[derive(Clone)]
pub enum AdapterKey {
    Router,
}

#[contract]
pub struct SoroswapAdapter;

#[contractimpl]
impl SoroswapAdapter {
    /// Configure the router address (any contract implementing `SwapVenue`).
    pub fn init(env: Env, router: Address) {
        env.storage().instance().set(&AdapterKey::Router, &router);
    }

    /// The configured router address.
    pub fn router(env: Env) -> Address {
        env.storage().instance().get(&AdapterKey::Router).unwrap()
    }
}

#[contractimpl]
impl SwapVenue for SoroswapAdapter {
    /// REAL delegation: forward the swap to the configured router's `SwapVenue::swap` and return its
    /// out. The delegation mechanism here is real + tested (against a mock router); M6 points
    /// `Router` at the live Soroswap router once the live signature is confirmed (spec §13.1).
    fn swap(env: Env, asset_in: Address, amount_in: i128, min_out: i128, to: Address) -> i128 {
        let router: Address = env.storage().instance().get(&AdapterKey::Router).unwrap();
        SwapVenueClient::new(&env, &router).swap(&asset_in, &amount_in, &min_out, &to)
    }

    fn reserves(env: Env) -> (i128, i128) {
        let router: Address = env.storage().instance().get(&AdapterKey::Router).unwrap();
        SwapVenueClient::new(&env, &router).reserves()
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{contract, contractimpl, testutils::Address as _, Env};

    // Mock router implementing SwapVenue: returns a deterministic out and fixed reserves so the
    // delegation is observable (no real token movement needed — the assertion is "the adapter
    // forwarded to the router and returned ITS result").
    #[contract]
    pub struct MockRouter;
    #[contractimpl]
    impl SwapVenue for MockRouter {
        fn swap(_e: Env, _asset_in: Address, amount_in: i128, _min_out: i128, _to: Address) -> i128 {
            amount_in * 2 // deterministic, observable delegation result
        }
        fn reserves(_e: Env) -> (i128, i128) {
            (1_000i128, 2_000i128)
        }
    }

    #[test]
    fn adapter_delegates_swap_to_router() {
        let env = Env::default();
        env.mock_all_auths();
        let router = env.register(MockRouter, ());
        let adapter = env.register(SoroswapAdapter, ());
        let c = SoroswapAdapterClient::new(&env, &adapter);
        c.init(&router);
        assert_eq!(c.router(), router);
        // BEHAVIORAL: the adapter forwards to the router and returns its out (amount_in*2).
        let asset = Address::generate(&env);
        let to = Address::generate(&env);
        let out = c.swap(&asset, &100i128, &1i128, &to);
        assert_eq!(out, 200i128, "adapter must delegate swap to the configured router");
        assert_eq!(
            c.reserves(),
            (1_000i128, 2_000i128),
            "adapter must delegate reserves to the router"
        );
    }
}
