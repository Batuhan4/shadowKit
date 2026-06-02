#![cfg(test)]
use crate::{AmmError, FallbackAMM, FallbackAMMClient};
use soroban_sdk::{testutils::Address as _, token, Address, Env};

struct Fixture<'a> {
    env: Env,
    amm: FallbackAMMClient<'a>,
    asset_a: Address,
    asset_b: Address,
    admin: Address,
}

/// Create a SAC token, return its contract address.
/// `register_stellar_asset_contract_v2(admin)` returns a `StellarAssetContract`; `.address()` is the
/// SAC id. Verified against soroban-sdk 26.0.1 testutils (env.rs:1094, testutils.rs:714) 2026-06-02.
fn make_token(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract_v2(admin.clone()).address()
}

fn setup() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset_a = make_token(&env, &admin);
    let asset_b = make_token(&env, &admin);
    let amm_id = env.register(FallbackAMM, ());
    let amm = FallbackAMMClient::new(&env, &amm_id);
    amm.init(&asset_a, &asset_b);
    Fixture { env, amm, asset_a, asset_b, admin }
}

/// Mint `amount` of `asset` to `to` using the SAC admin client.
fn mint(env: &Env, asset: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, asset).mint(to, &amount);
}

#[test]
fn test_add_liquidity_updates_reserves() {
    let f = setup();
    let lp = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &lp, 1_000_000);
    mint(&f.env, &f.asset_b, &lp, 1_000_000);
    f.amm.add_liquidity(&lp, &100_000i128, &50_000i128);
    let (ra, rb) = f.amm.reserves();
    assert_eq!(ra, 100_000);
    assert_eq!(rb, 50_000);
    // tokens actually moved from lp into the amm
    let amm_addr = f.amm.address.clone();
    assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&amm_addr), 100_000);
    assert_eq!(token::Client::new(&f.env, &f.asset_b).balance(&amm_addr), 50_000);
    assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&lp), 900_000);
}
