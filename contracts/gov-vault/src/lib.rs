#![no_std]
mod storage;
mod reveal;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_fixtures;
#[cfg(all(test, feature = "offchain-verify"))]
mod test_offchain;

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
    // M1-additive plaintext errors (recorded divergence; kept for the unchanged plaintext `close`):
    AlreadyVoted       = 16, // (M1; sealed cast_vote uses NullifierUsed instead)
    NotEligible        = 17, // (M1; sealed cast_vote uses StaleMerkleRoot/the proof instead)
    ZeroWeight         = 18, // (reserved)
    QuorumNotMet       = 19, // (reserved; close sets Rejected, does not error)
    InvalidDirection   = 20, // (M1; reserved)
    ProposalAmountOverCap = 21, // create_proposal: action_spec.amount > cap (or <= 0)
    DeadlineInPast     = 22, // create_proposal: deadline <= current ledger timestamp
}

use soroban_sdk::{contractevent, contractimpl, Address, Bytes, BytesN, Env, Vec};
use shadowkit_shared::{ActionSpec, ProposalView, ProposalStatus, QuorumCfg, SealedVote};
use crate::storage::ProposalRecord;
use groth16_verifier::{Bls12381Fr, Groth16VerifierClient, Proof};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreated { #[topic] pub id: u32, pub deadline: u64, pub cap: i128 }

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCast { #[topic] pub id: u32, pub nullifier: BytesN<32> } // no direction/weight

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalClosed { #[topic] pub id: u32, pub approved: bool, pub weighted_yes: i128, pub weighted_no: i128 }

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecuted { #[topic] pub id: u32 }

// index constants for the BINDING public-signal vector
// [merkleRoot, nullifier, proposalId, sealedCommitmentHash] (foundation §4).
const PS_MERKLE_ROOT: u32 = 0;
const PS_NULLIFIER: u32 = 1;
const PS_PROPOSAL_ID: u32 = 2;
const PS_SEALED_COMMIT: u32 = 3;

// ---- Fr <-> bytes helpers (Task 4.21b; direct unit tests in test.rs) ----
// VERIFIED (soroban-sdk 26.0.1): Fr::to_u256(&self)->U256; U256::to_be_bytes(&self)->Bytes (32 bytes);
// inverse of the verifier test's Fr::from_u256(U256::from_be_bytes(..)) round-trip.
pub(crate) fn fr_to_bytes32(env: &Env, f: &Bls12381Fr) -> BytesN<32> {
    let u = f.to_u256();
    let b: Bytes = u.to_be_bytes();
    let mut arr = [0u8; 32];
    for i in 0..32 {
        arr[i] = b.get(i as u32).unwrap();
    }
    BytesN::from_array(env, &arr)
}
pub(crate) fn fr_eq_bytes32(env: &Env, f: &Bls12381Fr, b: &BytesN<32>) -> bool {
    fr_to_bytes32(env, f) == *b
}
pub(crate) fn fr_eq_u32(env: &Env, f: &Bls12381Fr, n: u32) -> bool {
    let mut arr = [0u8; 32];
    arr[28..32].copy_from_slice(&n.to_be_bytes());
    fr_to_bytes32(env, f) == BytesN::from_array(env, &arr)
}

#[contractimpl]
impl GovVault {
    /// Initialize once (foundation §2.2). Reintroduces verifier + merkle_root (M1 deferred them).
    /// `vote_weights` is RETIRED: the snapshot Merkle root + zk proof replace per-address weights.
    /// Admin must auth. Default quorum_cfg per foundation §5: {min_voters:3, yes_must_exceed_no:true}.
    pub fn init(
        env: Env,
        admin: Address,
        verifier: Address,        // Groth16Verifier contract id
        merkle_root: BytesN<32>,  // snapshot root (Poseidon, big-endian 32 bytes)
        treasury_asset: Address,  // SAC of the treasury asset
        quorum_cfg: QuorumCfg,
    ) -> Result<(), GovError> {
        if storage::is_initialized(&env) {
            return Err(GovError::AlreadyInitialized);
        }
        admin.require_auth();
        storage::set_admin(&env, &admin);
        storage::set_verifier(&env, &verifier);
        storage::set_merkle_root(&env, &merkle_root);
        storage::set_treasury_asset(&env, &treasury_asset);
        storage::set_quorum_cfg(&env, &quorum_cfg);
        env.storage().instance().set(&storage::DataKey::NextId, &0u32);
        Ok(())
    }

    /// Create a proposal. Sequential u32 id starting at 0. `cap` bounds ActionSpec.amount;
    /// `deadline` = unix-seconds ledger timestamp. Admin auth required.
    /// INVARIANTS (foundation §5 / §2.6 / spec §9): ActionSpec.amount must be in (0, cap]; the
    /// deadline must be strictly in the future.
    pub fn create_proposal(
        env: Env,
        action_spec: ActionSpec,
        cap: i128,
        deadline: u64,
    ) -> Result<u32, GovError> {
        let admin = storage::get_admin(&env);
        admin.require_auth();
        if action_spec.amount <= 0 || action_spec.amount > cap {
            return Err(GovError::ProposalAmountOverCap);
        }
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
    pub fn votes_cast(env: Env, id: u32) -> Result<u32, GovError> {
        match storage::try_get_proposal(&env, id) {
            Some(rec) => Ok(rec.votes_cast),
            None => Err(GovError::ProposalNotFound),
        }
    }

    /// Close after deadline: compute plaintext weighted tally from running yes/no weights (M4 sealed
    /// votes do NOT feed these, so weighted_yes/no are 0 until M5's close_and_reveal), apply QuorumCfg
    /// (majority + votes_cast>=min_voters), set Approved|Rejected. Single close only.
    /// M1 PLAINTEXT analogue of foundation §2.2 close_and_reveal — kept UNCHANGED in M4 (M5 replaces it).
    /// CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!).
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

    /// True iff status == Approved (read by AgentPolicy in M2). View; no auth.
    pub fn is_approved(env: Env, id: u32) -> bool {
        match storage::try_get_proposal(&env, id) {
            Some(rec) => rec.status == ProposalStatus::Approved,
            None => false,
        }
    }

    /// Approved-proposal spending cap (read by AgentPolicy). ProposalNotFound if absent.
    pub fn cap_of(env: Env, id: u32) -> Result<i128, GovError> {
        match storage::try_get_proposal(&env, id) {
            Some(rec) => Ok(rec.cap),
            None => Err(GovError::ProposalNotFound),
        }
    }

    /// The approved ActionSpec (read by AgentPolicy). ProposalNotFound if absent.
    pub fn action_of(env: Env, id: u32) -> Result<ActionSpec, GovError> {
        match storage::try_get_proposal(&env, id) {
            Some(rec) => Ok(rec.action_spec),
            None => Err(GovError::ProposalNotFound),
        }
    }

    /// Configure the authorized executor (the AgentPolicy smart-account wallet address) permitted to
    /// call `mark_executed`. Admin-auth. Stored at `DataKey::Executor`. Idempotent.
    pub fn set_executor(env: Env, executor: Address) -> Result<(), GovError> {
        let admin = storage::get_admin(&env);
        admin.require_auth();
        storage::set_executor(&env, &executor);
        Ok(())
    }

    /// Single-shot replay guard. Requires status==Approved & not executed. Sets status -> Executed.
    /// AUTH (foundation §2.2): ONLY the configured executor (DataKey::Executor) may call this.
    /// CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!).
    pub fn mark_executed(env: Env, id: u32) -> Result<(), GovError> {
        storage::get_executor(&env).require_auth();
        let mut rec = storage::get_proposal(&env, id);
        if rec.executed || rec.status == ProposalStatus::Executed {
            return Err(GovError::AlreadyExecuted);
        }
        if rec.status != ProposalStatus::Approved {
            return Err(GovError::NotApproved);
        }
        rec.executed = true;
        rec.status = ProposalStatus::Executed;
        storage::set_proposal(&env, id, &rec);
        ProposalExecuted { id }.publish(&env);
        Ok(())
    }

    /// The sealed close path (foundation §2.2): re-aggregate the submitted decryptions against the
    /// stored sealed votes on-chain, set the weighted tally + Approved|Rejected by quorum. The SOLE
    /// close path (M1's plaintext `close` is retired in C7).
    /// CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!) so try_close_and_reveal()
    /// == Err(Ok(GovError::X)) negatives hold.
    ///
    /// C3 SCOPE: deadline guard only. The re-aggregation body + quorum (C4/C6a), the four
    /// reaggregate guards (C5a..C5d) and the AlreadyRevealed guard (C6b) are added red-before-green.
    pub fn close_and_reveal(
        env: Env,
        id: u32,
        revealed_yes_w: i128,
        revealed_no_w: i128,
        decryptions: Vec<shadowkit_shared::VoteDecryption>,
    ) -> Result<(), GovError> {
        let mut rec = match storage::try_get_proposal(&env, id) {
            Some(r) => r,
            None => return Err(GovError::ProposalNotFound),
        };
        // C3: reject reveal before the deadline.
        if env.ledger().timestamp() < rec.deadline {
            return Err(GovError::DeadlineNotReached);
        }
        let sealed: Vec<SealedVote> = env.storage().persistent()
            .get(&storage::DataKey::SealedVotes(id)).unwrap_or(Vec::new(&env));

        // PRIMARY path (default build): on-chain re-aggregation of submitted decryptions, binding
        // each VoteDecryption to its stored SealedVote.sealed_commitment_hash and rejecting any
        // aggregate inconsistent with the stored ciphertexts (the four guards live in reveal.rs).
        let (yes, no) = reveal::reaggregate(&env, &sealed, &decryptions, revealed_yes_w, revealed_no_w);

        // C4 SCOPE quorum (minimal): weighted_yes > weighted_no ONLY. The `votes_cast >= min_voters`
        // clause + the `yes_must_exceed_no` config term are added red-before-green in C6a.
        let passed = yes > no;

        rec.weighted_yes = Some(yes);
        rec.weighted_no = Some(no);
        rec.status = if passed { ProposalStatus::Approved } else { ProposalStatus::Rejected };
        storage::set_proposal(&env, id, &rec);

        ProposalClosed { id, approved: passed, weighted_yes: yes, weighted_no: no }.publish(&env);
        Ok(())
    }
}

impl GovVault {
    // Shared sealed-vote body. The `verified` parameter exists only under the offchain-verify feature.
    // Guards (foundation §2.2): deadline -> nullifier-used -> proposalId-binding -> stale-root ->
    // sealed-commitment -> on-chain verify -> commit. NO TALLY exposed.
    fn cast_vote_inner(
        env: Env,
        id: u32,
        proof: Proof,
        pub_signals: Vec<Bls12381Fr>,
        sealed_ciphertext: SealedVote,
        #[cfg(feature = "offchain-verify")] verified: bool,
    ) -> Result<(), GovError> {
        // 0) proposal exists.
        let mut rec = match storage::try_get_proposal(&env, id) {
            Some(r) => r,
            None => return Err(GovError::ProposalNotFound),
        };
        // 0a) reject votes cast at/after the deadline.
        if env.ledger().timestamp() >= rec.deadline {
            return Err(GovError::DeadlinePassed);
        }
        // 1) public-signal sanity: exactly 4.
        if pub_signals.len() != 4 {
            return Err(GovError::InvalidProof);
        }
        // 2) compute the nullifier (used to commit).
        let nullifier = fr_to_bytes32(&env, &pub_signals.get(PS_NULLIFIER).unwrap());
        // 2a) double-vote guard: this nullifier must not have been used before.
        if storage::nullifier_used(&env, &nullifier) {
            return Err(GovError::NullifierUsed);
        }
        // 2b) proposalId signal == id: binds the proof to THIS proposal => cross-proposal replay fails.
        if !fr_eq_u32(&env, &pub_signals.get(PS_PROPOSAL_ID).unwrap(), id) {
            return Err(GovError::WrongProposalId);
        }
        // 2c) merkleRoot signal == stored snapshot root (anti-stale: vote against the live snapshot).
        let stored_root: BytesN<32> = storage::get_merkle_root(&env);
        if !fr_eq_bytes32(&env, &pub_signals.get(PS_MERKLE_ROOT).unwrap(), &stored_root) {
            return Err(GovError::StaleMerkleRoot);
        }
        // 2d) C1b/C1c: bind ciphertext<->proof ONLY on the verified path. pub_signals[3] is the
        // in-circuit Poseidon(direction,weight,sealKey) (foundation §4); the stored commitment MUST
        // equal it, else the ciphertext is not the one proved -> RevealMismatch. Under
        // `offchain-verify` the proof is not checked, so pub_signals[3] carries no integrity to bind
        // to; reveal-time re-aggregation (close_and_reveal) enforces commitment integrity instead
        // (foundation §2.1/§2.2 fallback).
        #[cfg(not(feature = "offchain-verify"))]
        if !fr_eq_bytes32(&env, &pub_signals.get(PS_SEALED_COMMIT).unwrap(), &sealed_ciphertext.sealed_commitment_hash) {
            return Err(GovError::RevealMismatch);
        }
        // 3) VERIFY the proof on-chain (PRIMARY) or trust the coordinator-asserted flag (FALLBACK).
        #[cfg(not(feature = "offchain-verify"))]
        {
            let verifier = Groth16VerifierClient::new(&env, &storage::get_verifier(&env));
            if !verifier.verify(&proof, &pub_signals) {
                return Err(GovError::InvalidProof);
            }
        }
        #[cfg(feature = "offchain-verify")]
        {
            // FALLBACK (foundation §2.1): a trusted COORDINATOR pre-verified off-chain via
            // snarkjs.groth16.verify and authorized this call. Require coordinator/admin auth AND
            // verified == true. The real off-chain verification lives in the TS coordinator
            // (verifyAndAuthorize); this branch refuses an unverified flag.
            let _ = &proof;
            storage::get_admin(&env).require_auth();
            if !verified {
                return Err(GovError::InvalidProof);
            }
        }
        // 4) commit: mark nullifier used, append sealed vote, bump count.
        storage::mark_nullifier(&env, &nullifier);
        storage::push_sealed_vote(&env, id, &sealed_ciphertext);
        rec.votes_cast += 1;
        storage::set_proposal(&env, id, &rec);
        VoteCast { id, nullifier }.publish(&env);
        Ok(())
    }
}

// The sealed `cast_vote` entrypoint. PRIMARY (default) build: 5 args (on-chain verify is the gate).
// FALLBACK build (`feature = "offchain-verify"`): 6 args (trailing `verified: bool` from the trusted
// coordinator, foundation §2.1). The two builds expose two ABIs — they live in SEPARATE cfg-gated
// `#[contractimpl]` blocks so the soroban macro emits exactly one `cast_vote` per build.
#[cfg(not(feature = "offchain-verify"))]
#[contractimpl]
impl GovVault {
    /// Cast a SEALED vote (foundation §2.2). Verifies the proof on-chain, checks nullifier (double-vote)
    /// + proposalId binding (replay) + deadline + stale-root + sealed-commitment, stores the sealed
    /// ciphertext. EXPOSES NO TALLY. `pub_signals` order BINDING: [merkleRoot, nullifier, proposalId,
    /// sealedCommitmentHash].
    /// CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!) so try_cast_vote() ==
    /// Err(Ok(GovError::X)) negatives hold.
    pub fn cast_vote(
        env: Env,
        id: u32,
        proof: Proof,
        pub_signals: Vec<Bls12381Fr>,
        sealed_ciphertext: SealedVote,
    ) -> Result<(), GovError> {
        Self::cast_vote_inner(env, id, proof, pub_signals, sealed_ciphertext)
    }
}

#[cfg(feature = "offchain-verify")]
#[contractimpl]
impl GovVault {
    /// FALLBACK ABI (foundation §2.1): the trailing `verified: bool` is the trusted-coordinator
    /// off-chain-verify result.
    pub fn cast_vote(
        env: Env,
        id: u32,
        proof: Proof,
        pub_signals: Vec<Bls12381Fr>,
        sealed_ciphertext: SealedVote,
        verified: bool,
    ) -> Result<(), GovError> {
        Self::cast_vote_inner(env, id, proof, pub_signals, sealed_ciphertext, verified)
    }
}

// ===========================================================================================
// FALLBACK 2 (spec §13.2): degraded membership+nullifier circuit, 1-person-1-vote (circuit-min).
// ===========================================================================================
// 3-signal BINDING order for the degraded circuit: [merkleRoot, nullifier, proposalId].
#[cfg(feature = "circuit-min")]
const PSM_MERKLE_ROOT: u32 = 0;
#[cfg(feature = "circuit-min")]
const PSM_NULLIFIER: u32 = 1;
#[cfg(feature = "circuit-min")]
const PSM_PROPOSAL_ID: u32 = 2;

#[cfg(feature = "circuit-min")]
#[contractimpl]
impl GovVault {
    /// FALLBACK 2 (1p1v): degraded membership+nullifier proof; weight is recorded as 1 regardless of
    /// the leaf weight, and there is NO sealed-commitment check (the degraded circuit drops it).
    /// Keeps the deadline + nullifier (double-vote) + proposalId (replay) + stale-root guards.
    /// CARRY-FORWARD: returns Result<(), GovError> (NOT panic_with_error!) so try_cast_vote_min() ==
    /// Err(Ok(GovError::X)) negatives hold (same convention as the primary `cast_vote`).
    pub fn cast_vote_min(
        env: Env,
        id: u32,
        proof: Proof,
        pub_signals: Vec<Bls12381Fr>,
        sealed_ciphertext: SealedVote,
    ) -> Result<(), GovError> {
        let mut rec = match storage::try_get_proposal(&env, id) {
            Some(r) => r,
            None => return Err(GovError::ProposalNotFound),
        };
        if env.ledger().timestamp() >= rec.deadline {
            return Err(GovError::DeadlinePassed);
        }
        if pub_signals.len() != 3 {
            return Err(GovError::InvalidProof);
        }
        let nullifier = fr_to_bytes32(&env, &pub_signals.get(PSM_NULLIFIER).unwrap());
        if storage::nullifier_used(&env, &nullifier) {
            return Err(GovError::NullifierUsed);
        }
        if !fr_eq_u32(&env, &pub_signals.get(PSM_PROPOSAL_ID).unwrap(), id) {
            return Err(GovError::WrongProposalId);
        }
        let stored_root: BytesN<32> = storage::get_merkle_root(&env);
        if !fr_eq_bytes32(&env, &pub_signals.get(PSM_MERKLE_ROOT).unwrap(), &stored_root) {
            return Err(GovError::StaleMerkleRoot);
        }
        // verify the degraded proof against the min embedded VK (4 IC points).
        let verifier = Groth16VerifierClient::new(&env, &storage::get_verifier(&env));
        if !verifier.verify_min(&proof, &pub_signals) {
            return Err(GovError::InvalidProof);
        }
        // 1p1v: store the ciphertext (sealed direction only; weight is forced to 1 at reveal).
        storage::mark_nullifier(&env, &nullifier);
        storage::push_sealed_vote(&env, id, &sealed_ciphertext);
        rec.votes_cast += 1;
        storage::set_proposal(&env, id, &rec);
        VoteCast { id, nullifier }.publish(&env);
        Ok(())
    }
}
