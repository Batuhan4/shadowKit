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

use soroban_sdk::{contractimpl, Address, Env, Map};
use shadowkit_shared::QuorumCfg;

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
}
