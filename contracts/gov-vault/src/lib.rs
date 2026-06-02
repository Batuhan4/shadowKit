#![no_std]
mod storage;
#[cfg(test)]
mod test;

use soroban_sdk::{contract, contracterror};

#[contract]
pub struct GovVault;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum GovError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    NotAdmin           = 3,
    ProposalNotFound   = 4,
    DeadlinePassed     = 5,
    DeadlineNotReached = 6,
    NullifierUsed      = 7,
    WrongProposalId    = 8,
    InvalidProof       = 9,
    StaleMerkleRoot    = 10,
    AlreadyRevealed    = 11,
    NotRevealed        = 12,
    RevealMismatch     = 13,
    AlreadyExecuted    = 14,
    NotApproved        = 15,
    // M1-additive plaintext errors (recorded divergence):
    AlreadyVoted       = 16, // plaintext double-vote by same voter
    NotEligible        = 17, // voter not in snapshot weight map
    ZeroWeight         = 18, // voter weight <= 0
    QuorumNotMet       = 19, // (reserved; close sets Rejected, does not error)
    InvalidDirection   = 20, // cast_vote direction was neither 0 (no) nor 1 (yes)
    ProposalAmountOverCap = 21, // create_proposal: action_spec.amount > cap (or <= 0)
    DeadlineInPast     = 22, // create_proposal: deadline <= current ledger timestamp
}

use soroban_sdk::{contractevent, contractimpl, Address, Env, Map};
use shadowkit_shared::{ActionSpec, ProposalView, ProposalStatus, QuorumCfg};
use crate::storage::ProposalRecord;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreated { #[topic] pub id: u32, pub deadline: u64, pub cap: i128 }

#[contractimpl]
impl GovVault {
    /// Initialize once. `vote_weights` is the M1 plaintext snapshot (voter -> token weight).
    /// Admin must auth. Default quorum_cfg per foundation §5: {min_voters:3, yes_must_exceed_no:true}.
    pub fn init(
        env: Env,
        admin: Address,
        treasury_asset: Address,
        quorum_cfg: QuorumCfg,
        vote_weights: Map<Address, i128>,
    ) -> Result<(), GovError> {
        if storage::is_initialized(&env) {
            return Err(GovError::AlreadyInitialized);
        }
        admin.require_auth();
        storage::set_admin(&env, &admin);
        storage::set_treasury_asset(&env, &treasury_asset);
        storage::set_quorum_cfg(&env, &quorum_cfg);
        storage::set_vote_weights(&env, &vote_weights);
        env.storage().instance().set(&storage::DataKey::NextId, &0u32);
        Ok(())
    }

    /// Read a voter's snapshot weight (0 if not eligible). View; no auth.
    pub fn weight_of(env: Env, voter: Address) -> i128 {
        storage::get_vote_weights(&env).get(voter).unwrap_or(0)
    }

    /// Create a proposal. Sequential u32 id starting at 0. `cap` bounds ActionSpec.amount;
    /// `deadline` = unix-seconds ledger timestamp. Admin auth required.
    /// INVARIANTS (foundation §5 / §2.6 / spec §9): ActionSpec.amount must be in (0, cap]; the
    /// deadline must be strictly in the future. These guarantee the cap invariant that AgentPolicy
    /// (M2) and the safeguard "amount <= proposal cap" rely on, and that the proposal is votable.
    pub fn create_proposal(
        env: Env,
        action_spec: ActionSpec,
        cap: i128,
        deadline: u64,
    ) -> Result<u32, GovError> {
        let admin = storage::get_admin(&env);
        admin.require_auth();
        // cap invariant: 0 < amount <= cap
        if action_spec.amount <= 0 || action_spec.amount > cap {
            return Err(GovError::ProposalAmountOverCap);
        }
        // deadline must be in the future
        if deadline <= env.ledger().timestamp() {
            return Err(GovError::DeadlineInPast);
        }
        let id = storage::next_id(&env);
        let rec = ProposalRecord {
            action_spec,
            cap,
            deadline,
            status: ProposalStatus::Open,
            weighted_yes: None,
            weighted_no: None,
            votes_cast: 0,
            executed: false,
        };
        storage::set_proposal(&env, id, &rec);
        env.storage().persistent().set(&storage::DataKey::YesWeight(id), &0i128);
        env.storage().persistent().set(&storage::DataKey::NoWeight(id), &0i128);
        ProposalCreated { id, deadline, cap }.publish(&env);
        Ok(id)
    }

    /// Full read model. weighted_yes/no are None until close. Never leaks tally early.
    pub fn proposal(env: Env, id: u32) -> Result<ProposalView, GovError> {
        match storage::try_get_proposal(&env, id) {
            Some(rec) => Ok(storage::to_view(id, &rec)),
            None => Err(GovError::ProposalNotFound),
        }
    }

    /// Participation count (safe — no direction).
    pub fn votes_cast(env: Env, id: u32) -> u32 {
        storage::get_proposal(&env, id).votes_cast
    }
}
