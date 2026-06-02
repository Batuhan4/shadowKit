#![no_std]
// agent-policy — the OZ Smart Account custom policy that is THE safeguard: a hallucinating agent
// literally cannot move treasury funds wrong. The policy's gate logic (six gates + call-shape +
// single-context) is enforced inside the OZ `Policy::enforce` during host `__check_auth`.
//
// SOURCE: stellar-accounts (git tag v0.8.0-rc.1 / commit c5632d9, soroban-sdk 26.0.1) + §foundation
// §2.3. The OZ crate is depended on via a git pin (v0.8.0-rc.1) because the *published* crates.io
// stellar-accounts 0.7.1 targets soroban-sdk 25.3.x, incompatible with our 26.x workspace (see the
// workspace Cargo.toml comment for the empirical finding).
//
// §13.4 VERDICT (resolved empirically in test::cross_read_in_enforce_during_auth): DIRECT
// cross-contract read of GovVault inside `enforce` DURING auth WORKS. So the OZ policy is the
// primary host of record and gates (a) is_approved / (b) !executed are read LIVE via GovVaultClient
// inside `enforce`. No stale mirror is needed.
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};
use gov_vault::GovVaultClient;

mod policy;
#[cfg(feature = "handrolled")]
mod fallback;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_account;

pub use policy::PolicyKey;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentPolicyParams {
    pub gov_vault: Address,
    pub approved_amm: Address,
    pub treasury_asset: Address,
    pub proposal_id: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PolicyError {
    NotInstalled = 1,
    NotApproved = 2,
    AlreadyExecuted = 3,
    WrongTarget = 4,
    WrongAsset = 5,
    OverCap = 6,
    WrongFn = 7,
    MultiCall = 8,
    MalformedArgs = 9, // wrong arity / un-decodable swap args (NOT a business-rule violation)
    WrongAssetOut = 10, // asset_out != approved action.asset_out (funds routed to unapproved token)
}

#[contract]
pub struct AgentPolicy;

#[contractimpl]
impl AgentPolicy {
    /// Read installed params for a smart account. Panics NotInstalled if absent. (§foundation §2.3)
    pub fn params(env: Env, smart_account: Address) -> AgentPolicyParams {
        policy::load_params(&env, &smart_account)
    }

    /// TEST-ONLY mirror of `install`'s storage write (the gate UNIT tests seed params directly;
    /// the REAL `install` is covered by its own auth test in Task M2-1b). Behind cfg(test) so it
    /// never ships.
    #[cfg(test)]
    pub fn test_set_params(env: Env, smart_account: Address, params: AgentPolicyParams) {
        policy::store_params(&env, &smart_account, &params);
    }

    // NOTE: `test_enforce` (the `Result<(), PolicyError>` harness) and `impl Policy`
    // (enforce/install/uninstall) are ADDED in Task M2-2 once `policy::enforce_gates_checked` exists.

    /// §13.4 EASY-CASE probe (Task M2-V1b): cross-read GovVault from a NORMAL entrypoint.
    pub fn probe_cross_read(env: Env, gov_vault: Address, id: u32) -> bool {
        GovVaultClient::new(&env, &gov_vault).is_approved(&id)
    }
}
