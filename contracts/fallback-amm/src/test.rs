#![cfg(test)]
use crate::{AmmError, FallbackAMM, FallbackAMMClient};
use soroban_sdk::{testutils::Address as _, token, Address, Env};
use swap_venue::SwapVenueClient;

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

#[test]
fn test_swap_constant_product_math() {
    let f = setup();
    let lp = Address::generate(&f.env);
    // pool: A=1_000_000, B=1_000_000
    mint(&f.env, &f.asset_a, &lp, 2_000_000);
    mint(&f.env, &f.asset_b, &lp, 2_000_000);
    f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);

    let trader = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &trader, 100_000);
    // swap 10_000 A in. fee 0.3% => amount_in_with_fee = 10_000 * 997 / 1000 = 9_970
    // out = (rb * in_fee) / (ra + in_fee) = (1_000_000 * 9_970) / (1_000_000 + 9_970)
    //     = 9_970_000_000 / 1_009_970 = 9_871  (integer floor)
    let out = f.amm.swap(&f.asset_a, &10_000i128, &1i128, &trader);
    assert_eq!(out, 9_871);
    // reserves: A up by 10_000, B down by out
    let (ra, rb) = f.amm.reserves();
    assert_eq!(ra, 1_010_000);
    assert_eq!(rb, 1_000_000 - 9_871);
    // trader received `out` of B
    assert_eq!(token::Client::new(&f.env, &f.asset_b).balance(&trader), 9_871);
    // trader spent 10_000 of A
    assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&trader), 90_000);
}

#[test]
fn test_swap_reverse_direction() {
    let f = setup();
    let lp = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &lp, 1_000_000);
    mint(&f.env, &f.asset_b, &lp, 1_000_000);
    f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);
    let trader = Address::generate(&f.env);
    mint(&f.env, &f.asset_b, &trader, 100_000);
    // swap B in -> get A out; symmetric math, same numbers
    let out = f.amm.swap(&f.asset_b, &10_000i128, &1i128, &trader);
    assert_eq!(out, 9_871);
    assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&trader), 9_871);
}

#[test]
fn test_swap_unknown_asset_rejected() {
    let f = setup();
    let stranger_asset = make_token(&f.env, &f.admin);
    let trader = Address::generate(&f.env);
    let res = f.amm.try_swap(&stranger_asset, &10_000i128, &1i128, &trader);
    assert_eq!(res, Err(Ok(AmmError::UnknownAsset)));
}

// slippage guard: demand a min_out above the achievable output -> SlippageExceeded, and the
// revert leaves reserves AND balances untouched (no partial state mutation).
#[test]
fn test_swap_slippage_revert() {
    let f = setup();
    let lp = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &lp, 1_000_000);
    mint(&f.env, &f.asset_b, &lp, 1_000_000);
    f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);
    let trader = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &trader, 100_000);
    // demand min_out far above the achievable 9_871 -> SlippageExceeded
    let res = f.amm.try_swap(&f.asset_a, &10_000i128, &10_000i128, &trader);
    assert_eq!(res, Err(Ok(AmmError::SlippageExceeded)));
    // reserves unchanged after revert
    let (ra, rb) = f.amm.reserves();
    assert_eq!(ra, 1_000_000);
    assert_eq!(rb, 1_000_000);
    // trader balance unchanged (no transfer happened)
    assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&trader), 100_000);
}

// zero (or negative) amount_in -> ZeroAmount, before any reserve read/transfer.
#[test]
fn test_swap_zero_amount_revert() {
    let f = setup();
    let lp = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &lp, 1_000_000);
    mint(&f.env, &f.asset_b, &lp, 1_000_000);
    f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);
    let trader = Address::generate(&f.env);
    let res = f.amm.try_swap(&f.asset_a, &0i128, &1i128, &trader);
    assert_eq!(res, Err(Ok(AmmError::ZeroAmount)));
}

// ---- Task 16: venue-agnostic proof — FallbackAMM IS a SwapVenue ----
// Authored in the Task 14.1 RED batch so they share the `no method named 'swap'` red:
// `venue.swap(...)` dispatches through the GENERATED trait client SwapVenueClient to FallbackAMM's
// `swap` entrypoint. Before Task 14.3 implements `swap`, that method does not exist on either the
// concrete OR the trait client -> genuine compile red for the venue-agnostic dispatch path.

#[test]
fn test_fallback_amm_is_a_swap_venue() {
    let f = setup();
    let lp = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &lp, 1_000_000);
    mint(&f.env, &f.asset_b, &lp, 1_000_000);
    f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);

    // Treat the SAME contract id purely through the venue-agnostic interface.
    let venue = SwapVenueClient::new(&f.env, &f.amm.address);
    let (ra, rb) = venue.reserves();
    assert_eq!((ra, rb), (1_000_000, 1_000_000));

    let trader = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &trader, 100_000);
    let out = venue.swap(&f.asset_a, &10_000i128, &1i128, &trader);
    assert_eq!(out, 9_871); // identical behavior whether called via concrete or trait client
    // reserves moved exactly as the concrete-client swap test asserts
    let (ra2, rb2) = venue.reserves();
    assert_eq!(ra2, 1_010_000);
    assert_eq!(rb2, 1_000_000 - 9_871);
}

#[test]
fn test_swap_venue_slippage_through_trait() {
    let f = setup();
    let lp = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &lp, 1_000_000);
    mint(&f.env, &f.asset_b, &lp, 1_000_000);
    f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);
    let venue = SwapVenueClient::new(&f.env, &f.amm.address);
    let trader = Address::generate(&f.env);
    mint(&f.env, &f.asset_a, &trader, 100_000);
    // slippage guard still enforced when called through the trait client. The trait client does not
    // know FallbackAMM's concrete error enum, so it surfaces the raw contract error code (4).
    let res = venue.try_swap(&f.asset_a, &10_000i128, &10_000i128, &trader);
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from_contract_error(
            AmmError::SlippageExceeded as u32
        )))
    );
}
