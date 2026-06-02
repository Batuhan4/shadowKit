use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Storage keys. Binding subset (foundation §2.2): Admin, Verifier, MerkleRoot, TreasuryAsset,
/// QuorumCfg, Executor, NextId, Proposal(u32), SealedVotes(u32), Nullifier(BytesN<32>).
/// M4 (Task 4.19a) reintroduces Verifier/MerkleRoot (M1 deferred them) and POPULATES SealedVotes +
/// Nullifier via the sealed `cast_vote`. The M1 plaintext VoteWeights/VoterVoted snapshot path was
/// RETIRED in M4: the snapshot Merkle root + zk proof replace per-address weights. YesWeight/NoWeight
/// remain (M1 plaintext `close` machinery, kept UNCHANGED — M5 replaces close with close_and_reveal).
/// `Executor` (foundation §2.2) is the authorized `mark_executed` caller (the AgentPolicy address);
/// POPULATED in M2 via `set_executor`.
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
    SealedVotes(u32),      // Vec<SealedVote> (persistent) — M4 sealed cast_vote
    Nullifier(BytesN<32>), // () (persistent) — M4 double-vote guard
    // ---- M1 plaintext `close` machinery (kept UNCHANGED; M5 retires it) ----
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
/// Store the configured executor (the AgentPolicy address) authorized to call `mark_executed`
/// (foundation §2.2). Kept at `DataKey::Executor` (instance). Set via `GovVault::set_executor`.
pub fn set_executor(env: &Env, executor: &Address) {
    env.storage().instance().set(&DataKey::Executor, executor);
}
/// Read the configured executor. Panics `NotInitialized` if `set_executor` was never called
/// (mark_executed cannot enforce its auth gate without a configured executor).
pub fn get_executor(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Executor)
        .unwrap_or_else(|| panic_with_error!(env, GovError::NotInitialized))
}
// ---- M4 sealed-vote storage helpers (foundation §2.2) ----
pub fn get_verifier(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Verifier)
        .unwrap_or_else(|| panic_with_error!(env, GovError::NotInitialized))
}
pub fn set_verifier(env: &Env, v: &Address) {
    env.storage().instance().set(&DataKey::Verifier, v);
}
pub fn get_merkle_root(env: &Env) -> BytesN<32> {
    env.storage().instance().get(&DataKey::MerkleRoot)
        .unwrap_or_else(|| panic_with_error!(env, GovError::NotInitialized))
}
pub fn set_merkle_root(env: &Env, r: &BytesN<32>) {
    env.storage().instance().set(&DataKey::MerkleRoot, r);
}
pub fn nullifier_used(env: &Env, n: &BytesN<32>) -> bool {
    env.storage().persistent().has(&DataKey::Nullifier(n.clone()))
}
pub fn mark_nullifier(env: &Env, n: &BytesN<32>) {
    env.storage().persistent().set(&DataKey::Nullifier(n.clone()), &());
}
pub fn push_sealed_vote(env: &Env, id: u32, v: &shadowkit_shared::SealedVote) {
    let mut votes: Vec<shadowkit_shared::SealedVote> =
        env.storage().persistent().get(&DataKey::SealedVotes(id)).unwrap_or(Vec::new(env));
    votes.push_back(v.clone());
    env.storage().persistent().set(&DataKey::SealedVotes(id), &votes);
}

use shadowkit_shared::ProposalView;

pub fn next_id(env: &Env) -> u32 {
    let id: u32 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
    env.storage().instance().set(&DataKey::NextId, &(id + 1));
    id
}
pub fn set_proposal(env: &Env, id: u32, rec: &ProposalRecord) {
    env.storage().persistent().set(&DataKey::Proposal(id), rec);
}
pub fn get_proposal(env: &Env, id: u32) -> ProposalRecord {
    env.storage().persistent().get(&DataKey::Proposal(id))
        .unwrap_or_else(|| panic_with_error!(env, GovError::ProposalNotFound))
}
pub fn try_get_proposal(env: &Env, id: u32) -> Option<ProposalRecord> {
    env.storage().persistent().get(&DataKey::Proposal(id))
}
pub fn add_yes(env: &Env, id: u32, w: i128) {
    let cur: i128 = env.storage().persistent().get(&DataKey::YesWeight(id)).unwrap_or(0);
    env.storage().persistent().set(&DataKey::YesWeight(id), &(cur + w));
}
pub fn add_no(env: &Env, id: u32, w: i128) {
    let cur: i128 = env.storage().persistent().get(&DataKey::NoWeight(id)).unwrap_or(0);
    env.storage().persistent().set(&DataKey::NoWeight(id), &(cur + w));
}
pub fn get_yes(env: &Env, id: u32) -> i128 {
    env.storage().persistent().get(&DataKey::YesWeight(id)).unwrap_or(0)
}
pub fn get_no(env: &Env, id: u32) -> i128 {
    env.storage().persistent().get(&DataKey::NoWeight(id)).unwrap_or(0)
}

pub fn to_view(id: u32, rec: &ProposalRecord) -> ProposalView {
    ProposalView {
        id,
        action_spec: rec.action_spec.clone(),
        cap: rec.cap,
        deadline: rec.deadline,
        votes_cast: rec.votes_cast,
        status: rec.status.clone(),
        weighted_yes: rec.weighted_yes,
        weighted_no: rec.weighted_no,
    }
}
