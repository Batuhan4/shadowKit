#![no_std]
#[cfg(test)]
mod test;

// fallback-amm: constant-product USDC/XLM pool implementing the venue-agnostic SwapVenue
// interface (foundation §2.5). `token` is soroban-sdk's built-in SAC token module:
// `token::Client::new(&env, &asset)` (read/transfer) and `token::StellarAssetClient::new(&env, &asset)`
// (admin mint, tests only). Verified ctx7 /stellar/rs-soroban-sdk 2026-06-02.
//
// CARRY-FORWARD CORRECTION (SDK 26.0.1): entrypoints with negative tests return
// `Result<_, AmmError>` (NOT panic_with_error!) so the charter's negative tests can assert
// `try_<fn>() == Err(Ok(AmmError::X))`. `try_` client methods only surface the typed contract
// error when the entrypoint declares `-> Result<T, AmmError>` and returns `Err(AmmError::X)`.
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
};

#[contracttype]
#[derive(Clone)]
pub enum AmmKey {
    AssetA,
    AssetB,
    ReserveA,
    ReserveB,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AmmError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    UnknownAsset = 3,          // asset_in is neither asset_a nor asset_b
    SlippageExceeded = 4,      // out < min_out
    InsufficientLiquidity = 5,
    ZeroAmount = 6,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swapped {
    #[topic]
    pub asset_in: Address,
    pub amount_in: i128,
    pub amount_out: i128,
}

#[contract]
pub struct FallbackAMM;

#[contractimpl]
impl FallbackAMM {
    /// Set the two pool assets (e.g. USDC SAC, XLM SAC). Once only.
    pub fn init(env: Env, asset_a: Address, asset_b: Address) -> Result<(), AmmError> {
        if env.storage().instance().has(&AmmKey::AssetA) {
            return Err(AmmError::AlreadyInitialized);
        }
        env.storage().instance().set(&AmmKey::AssetA, &asset_a);
        env.storage().instance().set(&AmmKey::AssetB, &asset_b);
        env.storage().instance().set(&AmmKey::ReserveA, &0i128);
        env.storage().instance().set(&AmmKey::ReserveB, &0i128);
        Ok(())
    }

    /// Deposit liquidity; `from` must auth. Pulls amount_a/amount_b into the pool, updates reserves.
    pub fn add_liquidity(
        env: Env,
        from: Address,
        amount_a: i128,
        amount_b: i128,
    ) -> Result<(), AmmError> {
        from.require_auth();
        if amount_a <= 0 || amount_b <= 0 {
            return Err(AmmError::ZeroAmount);
        }
        let asset_a: Address = env
            .storage()
            .instance()
            .get(&AmmKey::AssetA)
            .ok_or(AmmError::NotInitialized)?;
        let asset_b: Address = env.storage().instance().get(&AmmKey::AssetB).unwrap();
        let this = env.current_contract_address();
        token::Client::new(&env, &asset_a).transfer(&from, &this, &amount_a);
        token::Client::new(&env, &asset_b).transfer(&from, &this, &amount_b);
        let ra: i128 = env.storage().instance().get(&AmmKey::ReserveA).unwrap_or(0);
        let rb: i128 = env.storage().instance().get(&AmmKey::ReserveB).unwrap_or(0);
        env.storage().instance().set(&AmmKey::ReserveA, &(ra + amount_a));
        env.storage().instance().set(&AmmKey::ReserveB, &(rb + amount_b));
        Ok(())
    }

    /// (reserve_a, reserve_b). Implements SwapVenue::reserves.
    pub fn reserves(env: Env) -> (i128, i128) {
        let ra: i128 = env.storage().instance().get(&AmmKey::ReserveA).unwrap_or(0);
        let rb: i128 = env.storage().instance().get(&AmmKey::ReserveB).unwrap_or(0);
        (ra, rb)
    }
}
