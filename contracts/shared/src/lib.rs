#![no_std]
use soroban_sdk::{contracttype, Address, Bytes, BytesN, Vec};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum SwapKind { Swap } // only `swap` in scope (spec §14 YAGNI)

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ActionSpec {
    pub kind: SwapKind,
    pub asset_in: Address,
    pub asset_out: Address,
    pub amount: i128,        // bounded by proposal cap
    pub min_out: i128,       // slippage floor (spec's min_out_policy, materialized)
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProposalStatus { Open, Tallying, Approved, Rejected, Executed }

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct QuorumCfg {
    pub min_voters: u32,         // default 3
    pub yes_must_exceed_no: bool // default true
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalView {
    pub id: u32,
    pub action_spec: ActionSpec,
    pub cap: i128,
    pub deadline: u64,
    pub votes_cast: u32,
    pub status: ProposalStatus,
    pub weighted_yes: Option<i128>, // None until close
    pub weighted_no:  Option<i128>, // None until close
}

// ---- M4/M5 sealed-vote types (added now to avoid a later breaking change; NOT used by M1) ----
/// Opaque tlock ciphertext envelope (foundation §2.6). Unused in M1.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SealedVote {
    pub round: u64,
    pub ciphertext: Bytes,
    pub sealed_commitment_hash: BytesN<32>,
}

/// A single revealed (tlock-decrypted) vote (foundation §2.6). Unused in M1.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteDecryption {
    pub direction: u32,
    pub weight: i128,
    pub sealed_commitment_hash: BytesN<32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Env, Address, testutils::Address as _};

    #[test]
    fn shared_types_construct() {
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let spec = ActionSpec {
            kind: SwapKind::Swap,
            asset_in: a.clone(),
            asset_out: b.clone(),
            amount: 100_i128,
            min_out: 90_i128,
        };
        let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
        let view = ProposalView {
            id: 0,
            action_spec: spec.clone(),
            cap: 1_000_i128,
            deadline: 1_700_000_000_u64,
            votes_cast: 0,
            status: ProposalStatus::Open,
            weighted_yes: None,
            weighted_no: None,
        };
        assert_eq!(view.status, ProposalStatus::Open);
        assert_eq!(cfg.min_voters, 3);
        assert_eq!(spec.amount, 100);
    }
}
