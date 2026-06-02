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

use soroban_sdk::{contractevent, contractimpl, Address, BytesN, Env, Map};
use soroban_sdk::xdr::ToXdr;
use shadowkit_shared::{ActionSpec, ProposalView, ProposalStatus, QuorumCfg};
use crate::storage::ProposalRecord;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreated { #[topic] pub id: u32, pub deadline: u64, pub cap: i128 }

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCast { #[topic] pub id: u32, pub nullifier: BytesN<32> } // no direction/weight

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalClosed { #[topic] pub id: u32, pub approved: bool, pub weighted_yes: i128, pub weighted_no: i128 }

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

    /// PLAINTEXT vote (M1). `voter` must auth; `direction` is 1 (yes) or 0 (no).
    /// Reads the voter's snapshot weight, prevents double-vote, enforces deadline,
    /// updates the running plaintext tally (kept private until `close`), bumps participation.
    /// M4/M5 REPLACE this with the sealed signature (foundation §2.2).
    /// CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!) so the charter's
    /// try_cast_vote() == Err(Ok(GovError::X)) negatives hold.
    pub fn cast_vote(env: Env, id: u32, voter: Address, direction: u32) -> Result<(), GovError> {
        voter.require_auth();
        let mut rec = storage::get_proposal(&env, id);
        // deadline: cast must be at/before deadline
        if env.ledger().timestamp() > rec.deadline {
            return Err(GovError::DeadlinePassed);
        }
        // direction must be a bit (0 or 1). Use a DEDICATED M1-additive error, NOT the binding
        // InvalidProof (code 9, whose foundation §2.2 meaning is "groth16 verify returned false").
        if direction != 0 && direction != 1 {
            return Err(GovError::InvalidDirection);
        }
        // eligibility + weight
        let weight = storage::get_vote_weights(&env).get(voter.clone()).unwrap_or(0);
        if weight <= 0 {
            return Err(GovError::NotEligible);
        }
        // double-vote guard (plaintext analogue of nullifier)
        if storage::has_voted(&env, id, &voter) {
            return Err(GovError::AlreadyVoted);
        }
        storage::mark_voted(&env, id, &voter);
        if direction == 1 {
            storage::add_yes(&env, id, weight);
        } else {
            storage::add_no(&env, id, weight);
        }
        rec.votes_cast += 1;
        storage::set_proposal(&env, id, &rec);
        // VoteCast event: foundation §2.2 uses BytesN<32> nullifier; M1 has no nullifier,
        // so we emit a deterministic voter-derived 32-byte id (sha256 of the voter's XDR bytes) to keep
        // the binding event shape stable. Recorded divergence.
        // .to_bytes() is the documented Hash<32> -> BytesN<32> conversion (verified SDK 26.0.1
        // src/crypto.rs: sha256 -> Hash<32>; Hash::to_bytes -> BytesN<N>).
        let voter_id: BytesN<32> = env.crypto().sha256(&voter.clone().to_xdr(&env)).to_bytes();
        VoteCast { id, nullifier: voter_id }.publish(&env);
        Ok(())
    }

    /// Close after deadline: compute plaintext weighted tally from running yes/no weights,
    /// apply QuorumCfg (yes>no AND votes_cast>=min_voters), set Approved|Rejected. Single close only.
    /// M1 PLAINTEXT analogue of foundation §2.2 close_and_reveal (no sealed votes / re-aggregation).
    /// DIVERGENCE (recorded, see task header): M1 transitions Open -> Approved|Rejected atomically and
    /// never sets ProposalStatus::Tallying (no observable intermediate window in single-shot plaintext
    /// close). M5's multi-step close_and_reveal is where Tallying becomes observable.
    /// CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!) so the charter's
    /// try_close() == Err(Ok(GovError::X)) negatives hold.
    pub fn close(env: Env, id: u32) -> Result<(), GovError> {
        let mut rec = storage::get_proposal(&env, id);
        if rec.weighted_yes.is_some() {
            return Err(GovError::AlreadyRevealed);
        }
        if env.ledger().timestamp() <= rec.deadline {
            return Err(GovError::DeadlineNotReached);
        }
        let yes = storage::get_yes(&env, id);
        let no = storage::get_no(&env, id);
        let cfg = storage::get_quorum_cfg(&env);
        let majority_ok = if cfg.yes_must_exceed_no { yes > no } else { yes >= no };
        let participation_ok = rec.votes_cast >= cfg.min_voters;
        let approved = majority_ok && participation_ok;
        rec.weighted_yes = Some(yes);
        rec.weighted_no = Some(no);
        rec.status = if approved { ProposalStatus::Approved } else { ProposalStatus::Rejected };
        storage::set_proposal(&env, id, &rec);
        ProposalClosed { id, approved, weighted_yes: yes, weighted_no: no }.publish(&env);
        Ok(())
    }
}
