// policy.rs — storage keys + (M2-2) the shared gate engine `check_swap_gates`.
// The gate logic is the ONE implementation reused by OZ `enforce` AND the hand-rolled
// `__check_auth` (feature = "handrolled", Phase 3).
use soroban_sdk::{contracttype, panic_with_error, Address, Env};
use crate::{AgentPolicyParams, PolicyError};

#[contracttype]
#[derive(Clone)]
pub enum PolicyKey {
    Params(Address), // per smart_account (§foundation §2.3)
}

pub fn store_params(env: &Env, sa: &Address, p: &AgentPolicyParams) {
    env.storage()
        .persistent()
        .set(&PolicyKey::Params(sa.clone()), p);
}

pub fn load_params(env: &Env, sa: &Address) -> AgentPolicyParams {
    env.storage()
        .persistent()
        .get(&PolicyKey::Params(sa.clone()))
        .unwrap_or_else(|| panic_with_error!(env, PolicyError::NotInstalled))
}
