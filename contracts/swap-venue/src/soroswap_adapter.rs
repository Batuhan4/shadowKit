#![cfg(feature = "soroswap")]
// soroswap_adapter — the alternate (config-selectable) venue satisfying SwapVenue (foundation §2.4).
// Selection is a config switch (env `SWAP_VENUE=soroswap`), never a code fork in AgentPolicy. M2 created
// this as a trait-conformant adapter delegating to a configured `SwapVenue` router; M6 points it at the
// LIVE Soroswap router via the `swap_exact_tokens_for_tokens` entrypoint.
//
// VERIFIED 2026-06-03 (Task 8.0, charter rule 5) against the canonical Soroswap router contract
//   github.com/soroswap/core  contracts/router/src/lib.rs (SoroswapRouterTrait):
//     fn swap_exact_tokens_for_tokens(
//         e: Env, amount_in: i128, amount_out_min: i128, path: Vec<Address>, to: Address, deadline: u64,
//     ) -> Result<Vec<i128>, CombinedRouterError>   // returns the path amounts; LAST element = amount out.
// The generated #[contractclient] method (RouterClient::swap_exact_tokens_for_tokens) returns the
// unwrapped Ok value (Vec<i128>), so the adapter reads the last element as the realized out amount.
//
// ⚠ LIVE-TESTNET VERIFICATION DEFERRED (spec §13.1): the router *interface* is confirmed from source,
// but a concrete DEPLOYED Soroswap testnet router contract id was NOT confirmable from Context7 (no Rust
// router index) or the Soroswap SDK (off-chain API only). We therefore wire the adapter to the DOCUMENTED
// signature and test it against a Soroswap-shaped mock router; FallbackAMM (M1) remains the tested DEFAULT
// (SWAP_VENUE=fallback). The adapter is NOT faked — every byte of the cross-contract call runs the real
// RouterClient against the registered mock. Live wiring against a real testnet router id is a deploy-time
// concern (set SOROSWAP_ROUTER_ID) once a deployed router is confirmed.
use soroban_sdk::{contract, contractclient, contractimpl, contracttype, vec, Address, Env, Vec};
use crate::SwapVenue;

/// Typed cross-contract client for the LIVE Soroswap router's exact-in swap entrypoint (Task 8.0).
#[contractclient(name = "RouterClient")]
pub trait SoroswapRouter {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
}

#[contracttype]
#[derive(Clone)]
pub enum AdapterKey {
    Router,
    AssetIn,
    AssetOut,
}

#[contract]
pub struct SoroswapAdapter;

#[contractimpl]
impl SoroswapAdapter {
    /// Configure the adapter: the Soroswap router id + the canonical asset pair.
    /// (M6 widens M2's `init(env, router)` to carry the pair needed to build the swap path.)
    pub fn init(env: Env, router: Address, asset_a: Address, asset_b: Address) {
        let s = env.storage().instance();
        s.set(&AdapterKey::Router, &router);
        s.set(&AdapterKey::AssetIn, &asset_a);
        s.set(&AdapterKey::AssetOut, &asset_b);
    }

    /// The configured Soroswap router address.
    pub fn router(env: Env) -> Address {
        env.storage().instance().get(&AdapterKey::Router).unwrap()
    }
}

#[contractimpl]
impl SwapVenue for SoroswapAdapter {
    /// SwapVenue::swap — forwards to the LIVE Soroswap router; returns the actual out amount.
    /// (Trait conformance is the load-bearing contract AgentPolicy authorizes against — kept as an
    /// `impl SwapVenue`, not an inherent impl.)
    fn swap(env: Env, asset_in: Address, amount_in: i128, min_out: i128, to: Address) -> i128 {
        let s = env.storage().instance();
        let router: Address = s.get(&AdapterKey::Router).unwrap();
        let a: Address = s.get(&AdapterKey::AssetIn).unwrap();
        let b: Address = s.get(&AdapterKey::AssetOut).unwrap();
        // path = [asset_in, other_asset]
        let other = if asset_in == a { b } else { a };
        let path = vec![&env, asset_in, other];
        let deadline = env.ledger().timestamp() + 300; // 5 min
        let client = RouterClient::new(&env, &router);
        let amounts = client.swap_exact_tokens_for_tokens(&amount_in, &min_out, &path, &to, &deadline);
        // Soroswap returns the path amounts; the LAST element is the output amount.
        amounts.get(amounts.len() - 1).unwrap()
    }

    /// SwapVenue::reserves — Soroswap reserves live in the pair contract; the router itself is
    /// reserve-less, so the adapter exposes (0, 0). (Reserves are read off-chain via the Soroswap UI.)
    fn reserves(_env: Env) -> (i128, i128) {
        (0, 0)
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
