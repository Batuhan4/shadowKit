use soroban_sdk::{contracttype, Address, BytesN, Map};

/// Storage keys. Binding subset (foundation §2.2): Admin, Verifier, MerkleRoot, TreasuryAsset,
/// QuorumCfg, Executor, NextId, Proposal(u32), SealedVotes(u32), Nullifier(BytesN<32>).
/// M1-additive plaintext keys (recorded divergence — see plan header): VoteWeights, VoterVoted,
/// YesWeight, NoWeight. These are M1's plaintext mechanism; M4/M5 replace VoterVoted/YesWeight/NoWeight
/// with the SealedVotes + Nullifier flow. Verifier/MerkleRoot are unused in M1 but kept in the enum
/// so the binding discriminant order never changes. `Executor` (foundation §2.2) is the authorized
/// `mark_executed` caller (the AgentPolicy address); it is kept in the enum here (discriminant order)
/// and POPULATED in M2 via `set_executor` (M1 ships `mark_executed` without the auth gate; M2 tightens it).
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,                  // Address (instance)
    Verifier,              // Address (instance) — M4
    MerkleRoot,            // BytesN<32> (instance) — M4
    TreasuryAsset,         // Address (instance)
    QuorumCfg,             // QuorumCfg (instance)
    Executor,              // Address (instance) — AgentPolicy id; set via set_executor in M2; auth for mark_executed
    NextId,                // u32 (instance)
    Proposal(u32),         // ProposalRecord (persistent)
    SealedVotes(u32),      // Vec<SealedVote> (persistent) — M5
    Nullifier(BytesN<32>), // () (persistent) — M4
    // ---- M1-additive plaintext keys ----
    VoteWeights,           // Map<Address,i128> snapshot of eligible voter weights (instance)
    VoterVoted(u32, Address), // () presence = this voter voted on proposal id (persistent)
    YesWeight(u32),        // i128 running plaintext yes weight (persistent)
    NoWeight(u32),         // i128 running plaintext no weight (persistent)
}

/// Internal persistent record projected into ProposalView by `proposal()`.
#[contracttype]
#[derive(Clone)]
pub struct ProposalRecord {
    pub action_spec: shadowkit_shared::ActionSpec,
    pub cap: i128,
    pub deadline: u64,
    pub status: shadowkit_shared::ProposalStatus,
    pub weighted_yes: Option<i128>,
    pub weighted_no: Option<i128>,
    pub votes_cast: u32,
    pub executed: bool,
}

use soroban_sdk::{Env, panic_with_error};
use shadowkit_shared::QuorumCfg;
use crate::GovError;

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}
pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}
pub fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, GovError::NotInitialized))
}
pub fn set_treasury_asset(env: &Env, a: &Address) {
    env.storage().instance().set(&DataKey::TreasuryAsset, a);
}
pub fn set_quorum_cfg(env: &Env, cfg: &QuorumCfg) {
    env.storage().instance().set(&DataKey::QuorumCfg, cfg);
}
pub fn get_quorum_cfg(env: &Env) -> QuorumCfg {
    env.storage().instance().get(&DataKey::QuorumCfg)
        .unwrap_or_else(|| panic_with_error!(env, GovError::NotInitialized))
}
pub fn set_vote_weights(env: &Env, m: &Map<Address, i128>) {
    env.storage().instance().set(&DataKey::VoteWeights, m);
}
pub fn get_vote_weights(env: &Env) -> Map<Address, i128> {
    env.storage().instance().get(&DataKey::VoteWeights)
        .unwrap_or_else(|| Map::new(env))
}
