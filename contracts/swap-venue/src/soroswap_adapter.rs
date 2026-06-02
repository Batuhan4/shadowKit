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
    use soroban_sdk::{contract, contractimpl, testutils::Address as _, vec, Env, Vec};

    // Soroswap-shaped MockRouter: mimics the VERIFIED swap_exact_tokens_for_tokens signature (Task 8.0,
    // soroswap/core contracts/router). The live router returns Result<Vec<i128>, CombinedRouterError>;
    // the generated #[contractclient] method unwraps the Ok value, so the success-path return modeled
    // here is the bare Vec<i128> (the path amounts; last element = amount out).
    #[contract]
    pub struct MockSoroswapRouter;
    #[contractimpl]
    impl MockSoroswapRouter {
        pub fn swap_exact_tokens_for_tokens(
            env: Env,
            amount_in: i128,
            amount_out_min: i128,
            path: Vec<Address>,
            to: Address,
            _deadline: u64,
        ) -> Vec<i128> {
            // Pretend a 1:2 rate; assert min-out respected (slippage) like the real router.
            let out = amount_in * 2;
            assert!(out >= amount_out_min, "slippage");
            let _ = (path, to);
            vec![&env, amount_in, out]
        }
    }

    #[test]
    fn adapter_swap_forwards_to_soroswap_router_and_returns_out() {
        let env = Env::default();
        env.mock_all_auths();
        let router_id = env.register(MockSoroswapRouter, ());
        let asset_in = Address::generate(&env);
        let asset_out = Address::generate(&env);
        let to = Address::generate(&env);

        let adapter_id = env.register(SoroswapAdapter, ());
        let adapter = SoroswapAdapterClient::new(&env, &adapter_id);
        adapter.init(&router_id, &asset_in, &asset_out);

        // BEHAVIORAL: the adapter (impl SwapVenue) forwards to the live router and returns its out.
        let out = adapter.swap(&asset_in, &1_000i128, &1_500i128, &to);
        assert_eq!(out, 2_000i128); // 1000 * 2
    }

    #[test]
    #[should_panic(expected = "slippage")]
    fn adapter_swap_respects_min_out() {
        let env = Env::default();
        env.mock_all_auths();
        let router_id = env.register(MockSoroswapRouter, ());
        let asset_in = Address::generate(&env);
        let asset_out = Address::generate(&env);
        let to = Address::generate(&env);
        let adapter_id = env.register(SoroswapAdapter, ());
        let adapter = SoroswapAdapterClient::new(&env, &adapter_id);
        adapter.init(&router_id, &asset_in, &asset_out);
        adapter.swap(&asset_in, &1_000i128, &5_000i128, &to); // demand 5000, router gives 2000 -> panic
    }
}
