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
