// The primary suite targets the 5-arg `cast_vote` ABI. Under `feature = "offchain-verify"` the
// entrypoint takes a trailing `verified: bool` (6-arg ABI), so this primary suite is compiled ONLY in
// builds WITHOUT that feature; the fallback ABI is covered by `test_offchain.rs` (which carries its own
// copies of the `default_quorum`/`create_default_proposal` helpers since `crate::test::*` is gated out).
#![cfg(all(test, not(feature = "offchain-verify")))]
extern crate std;
use crate::{GovVault, GovVaultClient, GovError};
use shadowkit_shared::{ActionSpec, QuorumCfg, ProposalStatus, SwapKind, SealedVote};
use soroban_sdk::{testutils::Address as _, testutils::{Ledger, LedgerInfo}, Address, Bytes, BytesN, Env};

use crate::test_fixtures::{
    committed_proof, committed_public_signals, merkle_root_be32, sealed_commit_be32,
};

// ---- shared helpers ----

pub(crate) fn default_quorum(_env: &Env) -> QuorumCfg {
    QuorumCfg { min_voters: 3, yes_must_exceed_no: true }
}

fn sample_spec(env: &Env) -> ActionSpec {
    ActionSpec {
        kind: SwapKind::Swap,
        asset_in: Address::generate(env),
        asset_out: Address::generate(env),
        amount: 15_000,
        min_out: 14_000,
    }
}

fn set_time(env: &Env, ts: u64) {
    env.ledger().set(LedgerInfo {
        timestamp: ts,
        protocol_version: 26, // carry-forward correction: SDK 26.0.1 host rejects proto 25
        sequence_number: 10,
        network_id: [0; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 16,
        max_entry_ttl: 10_000_000,
    });
}

/// Deploy verifier + gov-vault, init with the COMMITTED snapshot root (the root the committed proof
/// was built against) + the default (strict) quorum. Returns (gov_client, verifier_id).
fn deploy_with_committed_root(env: &Env) -> (GovVaultClient<'static>, Address) {
    let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
    let gov_id = env.register(GovVault {}, ());
    let gov = GovVaultClient::new(env, &gov_id);
    let admin = Address::generate(env);
    let asset = Address::generate(env);
    let root = merkle_root_be32(env); // BINDING: the snapshot root the committed proof was built against
    gov.init(&admin, &verifier_id, &root, &asset, &default_quorum(env));
    (gov, verifier_id)
}

/// Deploy + init with the committed root and a LENIENT quorum (min_voters:1, yes_must_exceed_no:false)
/// so a single sealed vote is enough to reach quorum at close (M4 sealed votes do not feed a plaintext
/// tally, so weighted_yes/no are 0; approval is driven by participation under the lenient quorum).
fn deploy_lenient(env: &Env) -> (GovVaultClient<'static>, Address) {
    let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
    let gov_id = env.register(GovVault {}, ());
    let gov = GovVaultClient::new(env, &gov_id);
    let admin = Address::generate(env);
    let asset = Address::generate(env);
    let root = merkle_root_be32(env);
    gov.init(&admin, &verifier_id, &root, &asset,
        &QuorumCfg { min_voters: 1, yes_must_exceed_no: false });
    (gov, verifier_id)
}

/// Create a proposal with a future deadline relative to the current ledger time.
pub(crate) fn create_default_proposal(env: &Env, gov: &GovVaultClient) -> u32 {
    let spec = sample_spec(env);
    let deadline = env.ledger().timestamp() + 1_000;
    gov.create_proposal(&spec, &15_000i128, &deadline)
}

fn committed_sealed(env: &Env) -> SealedVote {
    SealedVote {
        round: 0,
        ciphertext: Bytes::from_array(env, b"sealed-blob"),
        sealed_commitment_hash: sealed_commit_be32(env),
    }
}

/// Test scaffolding (M5): write a sealed vote DIRECTLY into storage and bump votes_cast, bypassing
/// the proof path (separately covered by C1). The commitment hash is filled from a single byte so a
/// test can build matching `VoteDecryption`s deterministically. Returns the BytesN<32> commitment.
/// `round` is recorded as the round field (the on-chain reveal does not re-fetch per-vote rounds).
fn store_sealed(env: &Env, gov: &GovVaultClient, id: u32, byte: u8, round: u64) -> BytesN<32> {
    use crate::storage::{DataKey, ProposalRecord};
    let hash = BytesN::from_array(env, &[byte; 32]);
    let sealed = SealedVote { round, ciphertext: Bytes::from_array(env, b"ct"), sealed_commitment_hash: hash.clone() };
    env.as_contract(&gov.address, || {
        let mut votes: soroban_sdk::Vec<SealedVote> =
            env.storage().persistent().get(&DataKey::SealedVotes(id)).unwrap_or(soroban_sdk::Vec::new(env));
        votes.push_back(sealed);
        env.storage().persistent().set(&DataKey::SealedVotes(id), &votes);
        let mut rec: ProposalRecord = env.storage().persistent().get(&DataKey::Proposal(id)).unwrap();
        rec.votes_cast += 1;
        env.storage().persistent().set(&DataKey::Proposal(id), &rec);
    });
    hash
}

/// Store `n` sealed votes directly (distinct commitment bytes), bumping votes_cast each time.
fn store_n_sealed(env: &Env, gov: &GovVaultClient, id: u32, n: u32) {
    for k in 0..n {
        store_sealed(env, gov, id, 0xA0u8.wrapping_add(k as u8), 100 + k as u64);
    }
}

/// Create a proposal whose deadline is exactly `deadline` (sets a near-zero base time first).
fn create_proposal_with_deadline(env: &Env, gov: &GovVaultClient, deadline: u64) -> u32 {
    set_time(env, 1);
    let spec = sample_spec(env);
    gov.create_proposal(&spec, &15_000i128, &deadline)
}

/// Advance the ledger clock to `ts`.
fn advance_to(env: &Env, ts: u64) { set_time(env, ts); }

// ============================================================================
// Task 4.19a — init reintroduces verifier + merkle_root (foundation §2.2)
// ============================================================================

#[test]
fn test_init_sets_state() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    // No panic == success; init succeeded with verifier + merkle_root set. A subsequent proposal
    // create succeeds (proves admin/state were stored).
    let id = create_default_proposal(&env, &gov);
    assert_eq!(id, 0);
}

#[test]
fn test_double_init_rejects() {
    let env = Env::default();
    env.mock_all_auths();
    let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
    let gov_id = env.register(GovVault {}, ());
    let gov = GovVaultClient::new(&env, &gov_id);
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let root = merkle_root_be32(&env);
    gov.init(&admin, &verifier_id, &root, &asset, &default_quorum(&env));
    let res = gov.try_init(&admin, &verifier_id, &root, &asset, &default_quorum(&env));
    assert_eq!(res, Err(Ok(GovError::AlreadyInitialized)));
}

// ============================================================================
// Task 4.21b — Fr<->bytes helper unit tests
// ============================================================================

use crate::{fr_eq_u32, fr_eq_bytes32, fr_to_bytes32};
use crate::test_fixtures::fr;

#[test]
fn fr_eq_u32_matches_only_the_same_u32() {
    let env = Env::default();
    assert_eq!(fr_eq_u32(&env, &fr(&env, "5"), 5), true);
    assert_eq!(fr_eq_u32(&env, &fr(&env, "5"), 6), false);
    assert_eq!(fr_eq_u32(&env, &fr(&env, "5"), 0), false);
    assert_eq!(fr_eq_u32(&env, &fr(&env, "0"), 0), true);
}

#[test]
fn fr_to_bytes32_roundtrips_be32() {
    let env = Env::default();
    let b = fr_to_bytes32(&env, &fr(&env, "1"));
    let mut expect = [0u8; 32];
    expect[31] = 1;
    assert_eq!(b, BytesN::from_array(&env, &expect));
}

#[test]
fn fr_eq_bytes32_compares_field_to_be32() {
    let env = Env::default();
    let mut one = [0u8; 32];
    one[31] = 1;
    assert_eq!(fr_eq_bytes32(&env, &fr(&env, "1"), &BytesN::from_array(&env, &one)), true);
    let mut two = [0u8; 32];
    two[31] = 2;
    assert_eq!(fr_eq_bytes32(&env, &fr(&env, "1"), &BytesN::from_array(&env, &two)), false);
}

// ============================================================================
// Task 4.21/4.22 — sealed cast_vote happy path
// ============================================================================

#[test]
fn sealed_cast_vote_happy_path() {
    let env = Env::default();
    env.mock_all_auths(); // admin auth for create_proposal; the PROOF itself is the real gate.
    let (gov, _verifier) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &committed_sealed(&env));
    assert_eq!(gov.votes_cast(&id), 1);
    let pv = gov.proposal(&id);
    assert_eq!(pv.weighted_yes, None); // NO tally before close
    assert_eq!(pv.weighted_no, None);
}

// ============================================================================
// Task C1a — cast_vote stores the FULL SealedVote (round + ciphertext + commitment)
// ============================================================================

#[test]
fn cast_vote_stores_full_sealed_vote() {
    use crate::storage::DataKey;
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    // The commitment MUST equal the fixture's 4th public signal so the C1b binding holds.
    let sealed = SealedVote {
        round: 12345u64,
        ciphertext: Bytes::from_array(&env, b"armored-ciphertext-bytes"),
        sealed_commitment_hash: sealed_commit_be32(&env), // == public signal[3]
    };
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    // read back exactly what was stored
    let stored: soroban_sdk::Vec<SealedVote> = env.as_contract(&gov.address, || {
        env.storage().persistent().get(&DataKey::SealedVotes(id)).unwrap()
    });
    assert_eq!(stored.len(), 1);
    let s = stored.get(0).unwrap();
    assert_eq!(s.round, 12345u64);
    assert_eq!(s.ciphertext, Bytes::from_array(&env, b"armored-ciphertext-bytes"));
    assert_eq!(s.sealed_commitment_hash, sealed_commit_be32(&env));
}

// ============================================================================
// Task C1b — cast_vote binds the ciphertext commitment to the proof (pub_signals[3])
// ============================================================================

#[test]
fn cast_vote_rejects_commitment_not_bound_to_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    // valid fixture proof/signals, but the ciphertext commitment is WRONG (not == pub_signals[3]).
    let wrong = BytesN::from_array(&env, &[0x11; 32]);
    assert_ne!(wrong, sealed_commit_be32(&env));
    let sealed = SealedVote {
        round: 7u64,
        ciphertext: Bytes::from_array(&env, b"ct"),
        sealed_commitment_hash: wrong,
    };
    let r = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}

// ============================================================================
// Task 4.23 — double-vote (same nullifier) -> NullifierUsed
// ============================================================================

#[test]
fn double_vote_same_nullifier_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    let sealed = committed_sealed(&env);
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    // Second identical vote reuses the same nullifier -> NullifierUsed.
    let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    assert_eq!(res, Err(Ok(GovError::NullifierUsed)));
}

// ============================================================================
// Task 4.24 — replay across proposals (proposalId binding) -> WrongProposalId
// ============================================================================

#[test]
fn replay_other_proposal_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id0 = create_default_proposal(&env, &gov); // committed proof has proposalId == 0
    let id1 = create_default_proposal(&env, &gov); // id1 == 1
    assert_eq!(id1, 1);
    let sealed = committed_sealed(&env);
    // The committed proof's proposalId signal is 0; casting it on proposal 1 must be rejected.
    let res = gov.try_cast_vote(&id1, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    assert_eq!(res, Err(Ok(GovError::WrongProposalId)));
    // Sanity: it DOES succeed on proposal 0.
    gov.cast_vote(&id0, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    assert_eq!(gov.votes_cast(&id0), 1);
}

// ============================================================================
// Task 4.25a — post-deadline vote -> DeadlinePassed
// ============================================================================

#[test]
fn post_deadline_vote_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    let pv = gov.proposal(&id);
    env.ledger().set_timestamp(pv.deadline + 1);
    let sealed = committed_sealed(&env);
    let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    assert_eq!(res, Err(Ok(GovError::DeadlinePassed)));
}

// ============================================================================
// Task 4.25b — stale snapshot root -> StaleMerkleRoot
// ============================================================================

#[test]
fn stale_merkle_root_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    // init with a DIFFERENT root than the proof was built against.
    let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
    let gov_id = env.register(GovVault {}, ());
    let gov = GovVaultClient::new(&env, &gov_id);
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let wrong_root = BytesN::from_array(&env, &[7u8; 32]);
    gov.init(&admin, &verifier_id, &wrong_root, &asset, &default_quorum(&env));
    let id = create_default_proposal(&env, &gov);
    let sealed = committed_sealed(&env);
    let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    assert_eq!(res, Err(Ok(GovError::StaleMerkleRoot)));
}

// ============================================================================
// Task 4.25c — sealed-commitment mismatch -> RevealMismatch (M5 C1b: was InvalidProof in M4)
// ============================================================================

#[test]
fn sealed_commitment_mismatch_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    // ciphertext's commitment hash is WRONG (not the proof's sealedCommitmentHash signal).
    let sealed = SealedVote {
        round: 0,
        ciphertext: Bytes::from_array(&env, b"a"),
        sealed_commitment_hash: BytesN::from_array(&env, &[9u8; 32]), // != public signal[3]
    };
    let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    assert_eq!(res, Err(Ok(GovError::RevealMismatch)));
}

// ============================================================================
// Task 4.25d — invalid (tampered) proof -> InvalidProof
// ============================================================================

#[test]
fn invalid_proof_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    // Tamper pi_a so the pairing check fails, but keep the public signals (root/id/commit checks pass).
    let mut bad = committed_proof(&env);
    bad.a = bad.c.clone(); // valid G1 point, wrong proof -> on-chain verify returns false.
    let sealed = committed_sealed(&env);
    let res = gov.try_cast_vote(&id, &bad, &committed_public_signals(&env), &sealed);
    assert_eq!(res, Err(Ok(GovError::InvalidProof)));
}

// ============================================================================
// Task 4.26 — proposal() exposes NO tally before close (privacy invariant)
// ============================================================================

#[test]
fn proposal_view_hides_tally_before_close() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &committed_sealed(&env));
    let pv = gov.proposal(&id);
    assert!(matches!(pv.status, ProposalStatus::Open | ProposalStatus::Tallying));
    assert_eq!(pv.weighted_yes, None);
    assert_eq!(pv.weighted_no, None);
    assert_eq!(pv.votes_cast, 1); // participation IS exposed (no direction).
}

// ============================================================================
// Task C2 — proposal() exposes NO tally before close, even with several sealed votes
// ============================================================================

#[test]
fn proposal_exposes_no_tally_before_close() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    store_n_sealed(&env, &gov, id, 3); // 3 sealed votes stored
    let view = gov.proposal(&id);
    assert_eq!(view.votes_cast, 3);        // participation is public
    assert_eq!(view.weighted_yes, None);   // tally SEALED
    assert_eq!(view.weighted_no, None);
    assert_eq!(view.status, ProposalStatus::Open);
}

// ============================================================================
// Task C3 — close_and_reveal rejects a PRE-DEADLINE reveal
// ============================================================================

use shadowkit_shared::VoteDecryption;

#[test]
fn close_and_reveal_before_deadline_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_proposal_with_deadline(&env, &gov, 1000); // deadline far in the future
    store_n_sealed(&env, &gov, id, 3);
    // ledger time is BEFORE the deadline -> must reject DeadlineNotReached
    let res = gov.try_close_and_reveal(&id, &0i128, &0i128, &soroban_sdk::vec![&env]);
    assert_eq!(res, Err(Ok(GovError::DeadlineNotReached)));
}

// ============================================================================
// Task C4 — close_and_reveal accepts a CORRECT reveal -> weighted tally + Approved
// ============================================================================

#[test]
fn close_and_reveal_correct_sets_weighted_tally_and_approves() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env); // default quorum {min_voters:3, yes_must_exceed_no:true}
    let id = create_proposal_with_deadline(&env, &gov, 1000);
    let s0 = store_sealed(&env, &gov, id, 0xA1, 100);
    let s1 = store_sealed(&env, &gov, id, 0xA2, 101);
    let s2 = store_sealed(&env, &gov, id, 0xA3, 102);
    advance_to(&env, 1001); // past deadline
    // decryptions: yes 100 (A1), yes 250 (A2), no 300 (A3) -> yes=350, no=300 -> approved (3 voters)
    let decs = soroban_sdk::vec![
        &env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: s0 },
        VoteDecryption { direction: 1, weight: 250, sealed_commitment_hash: s1 },
        VoteDecryption { direction: 0, weight: 300, sealed_commitment_hash: s2 },
    ];
    gov.close_and_reveal(&id, &350i128, &300i128, &decs);
    let v = gov.proposal(&id);
    assert_eq!(v.weighted_yes, Some(350));
    assert_eq!(v.weighted_no, Some(300));
    assert_eq!(v.status, ProposalStatus::Approved);
    assert!(gov.is_approved(&id));
}

// ============================================================================
// Tasks C5a–C5d — close_and_reveal rejects a WRONG reveal (each guard red-before-green)
// ============================================================================

/// Deploy + 3 stored sealed votes (B1/B2/B3) + ledger past the deadline. Returns (id, h0, h1, h2).
fn setup_revealable(env: &Env, gov: &GovVaultClient) -> (u32, BytesN<32>, BytesN<32>, BytesN<32>) {
    let id = create_proposal_with_deadline(env, gov, 1000);
    let h0 = store_sealed(env, gov, id, 0xB1, 100);
    let h1 = store_sealed(env, gov, id, 0xB2, 101);
    let h2 = store_sealed(env, gov, id, 0xB3, 102);
    advance_to(env, 1001);
    (id, h0, h1, h2)
}

#[test]
fn reveal_wrong_length_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let (id, h0, h1, _h2) = setup_revealable(&env, &gov);
    let decs = soroban_sdk::vec![&env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 0, weight: 50,  sealed_commitment_hash: h1 }]; // only 2 of 3
    let r = gov.try_close_and_reveal(&id, &100i128, &50i128, &decs);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}

#[test]
fn reveal_wrong_commitment_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let (id, h0, h1, _h2) = setup_revealable(&env, &gov);
    let bogus = BytesN::from_array(&env, &[0xFF; 32]);
    let decs = soroban_sdk::vec![&env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h1 },
        VoteDecryption { direction: 0, weight: 50,  sealed_commitment_hash: bogus }]; // h2 swapped
    let r = gov.try_close_and_reveal(&id, &200i128, &50i128, &decs);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}

#[test]
fn reveal_bad_direction_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let (id, h0, h1, h2) = setup_revealable(&env, &gov);
    let decs = soroban_sdk::vec![&env,
        VoteDecryption { direction: 2, weight: 100, sealed_commitment_hash: h0 }, // not a bit
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h1 },
        VoteDecryption { direction: 0, weight: 50,  sealed_commitment_hash: h2 }];
    // with direction==2 silently counted as "no" (the pre-C5c else-branch), real sums would be
    // yes=100, no=150; the attacker submits those, so without the bit guard it SUCCEEDS.
    let r = gov.try_close_and_reveal(&id, &100i128, &150i128, &decs);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}

#[test]
fn reveal_lying_aggregate_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let (id, h0, h1, h2) = setup_revealable(&env, &gov);
    // real sums: yes=200, no=50; attacker CLAIMS yes=999 to flip quorum
    let decs = soroban_sdk::vec![&env,
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h0 },
        VoteDecryption { direction: 1, weight: 100, sealed_commitment_hash: h1 },
        VoteDecryption { direction: 0, weight: 50,  sealed_commitment_hash: h2 }];
    let r = gov.try_close_and_reveal(&id, &999i128, &50i128, &decs);
    assert_eq!(r, Err(Ok(GovError::RevealMismatch)));
}

// ============================================================================
// Structural tests (carried from M1, migrated to the foundation init signature)
// ============================================================================

#[test]
fn test_create_proposal_sequential_ids() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id0 = create_default_proposal(&env, &gov);
    let id1 = create_default_proposal(&env, &gov);
    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
}

#[test]
fn test_proposal_view_no_tally_before_close() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let spec = sample_spec(&env);
    let id = gov.create_proposal(&spec, &15_000i128, &2_000_000_000u64);
    let view = gov.proposal(&id);
    assert_eq!(view.id, id);
    assert_eq!(view.status, ProposalStatus::Open);
    assert_eq!(view.votes_cast, 0);
    assert_eq!(view.cap, 15_000);
    assert_eq!(view.deadline, 2_000_000_000);
    assert_eq!(view.weighted_yes, None);
    assert_eq!(view.weighted_no, None);
}

#[test]
fn test_proposal_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    assert_eq!(gov.try_proposal(&99u32), Err(Ok(GovError::ProposalNotFound)));
}

#[test]
fn test_create_proposal_rejects_amount_over_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let spec = sample_spec(&env); // amount 15_000
    let res = gov.try_create_proposal(&spec, &10_000i128, &2_000_000_000u64);
    assert_eq!(res, Err(Ok(GovError::ProposalAmountOverCap)));
}

#[test]
fn test_create_proposal_rejects_nonpositive_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let mut spec = sample_spec(&env);
    spec.amount = 0;
    let res = gov.try_create_proposal(&spec, &10_000i128, &2_000_000_000u64);
    assert_eq!(res, Err(Ok(GovError::ProposalAmountOverCap)));
}

#[test]
fn test_create_proposal_rejects_past_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    set_time(&env, 1_000);
    let spec = sample_spec(&env);
    let res = gov.try_create_proposal(&spec, &15_000i128, &1_000u64); // deadline == now
    assert_eq!(res, Err(Ok(GovError::DeadlineInPast)));
}

// ============================================================================
// cast_vote VoteCast event emission (binding payload)
// ============================================================================

#[test]
fn test_cast_vote_emits_votecast_event() {
    use soroban_sdk::{vec, Event};
    use soroban_sdk::testutils::Events;
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let contract_id = gov.address.clone();
    let id = create_default_proposal(&env, &gov);
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &committed_sealed(&env));

    // The contract emits VoteCast{ id, nullifier } where nullifier == be32(public.json[0]).
    let expected_nullifier: BytesN<32> = {
        use std::string::String;
        use crate::test_fixtures::{be32, PUBLIC};
        let arr: std::vec::Vec<String> = serde_json::from_str(PUBLIC).unwrap();
        BytesN::from_array(&env, &be32(&arr[0]))
    };
    let vote_cast = crate::VoteCast { id, nullifier: expected_nullifier };
    // SDK 26.0.1: Events::all() returns ONLY the LAST contract invocation's events.
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (contract_id.clone(), vote_cast.topics(&env), vote_cast.data(&env)),
        ]
    );
}

// ============================================================================
// close: weighted tally (0 in M4; sealed votes do not feed plaintext tally) + QuorumCfg
// ============================================================================

/// Build an APPROVED proposal: deploy lenient, create proposal, cast the committed sealed vote
/// (participation=1), advance past deadline, close. Returns (gov, id, spec_unused).
fn approved_proposal(env: &Env) -> (GovVaultClient<'static>, u32) {
    let (gov, _v) = deploy_lenient(env);
    set_time(env, 1_000);
    let spec = sample_spec(env);
    let id = gov.create_proposal(&spec, &15_000i128, &2_000u64);
    gov.cast_vote(&id, &committed_proof(env), &committed_public_signals(env), &committed_sealed(env));
    set_time(env, 2_001); // past deadline
    gov.close(&id);
    (gov, id)
}

#[test]
fn test_close_quorum_pass_sets_approved() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, id) = approved_proposal(&env);
    let view = gov.proposal(&id);
    assert_eq!(view.status, ProposalStatus::Approved);
    // M4 sealed votes do not feed the plaintext tally -> 0/0 (real reveal lands in M5).
    assert_eq!(view.weighted_yes, Some(0));
    assert_eq!(view.weighted_no, Some(0));
}

#[test]
fn test_close_quorum_fail_low_participation() {
    let env = Env::default();
    env.mock_all_auths();
    // strict quorum (min_voters:3); a single sealed vote -> participation 1 < 3 -> Rejected.
    let (gov, _v) = deploy_with_committed_root(&env);
    set_time(&env, 1_000);
    let spec = sample_spec(&env);
    let id = gov.create_proposal(&spec, &15_000i128, &2_000u64);
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &committed_sealed(&env));
    set_time(&env, 2_001);
    gov.close(&id);
    let view = gov.proposal(&id);
    assert_eq!(view.status, ProposalStatus::Rejected);
}

#[test]
fn test_close_before_deadline_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_lenient(&env);
    set_time(&env, 1_000);
    let spec = sample_spec(&env);
    let id = gov.create_proposal(&spec, &15_000i128, &5_000u64);
    set_time(&env, 1_500); // before deadline 5000
    assert_eq!(gov.try_close(&id), Err(Ok(GovError::DeadlineNotReached)));
}

#[test]
fn test_close_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, id) = approved_proposal(&env);
    assert_eq!(gov.try_close(&id), Err(Ok(GovError::AlreadyRevealed)));
}

#[test]
fn test_close_emits_proposalclosed_event() {
    use soroban_sdk::{vec, Event};
    use soroban_sdk::testutils::Events;
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env); // strict quorum, no votes
    let contract_id = gov.address.clone();
    set_time(&env, 1_000);
    let spec = sample_spec(&env);
    let id = gov.create_proposal(&spec, &15_000i128, &2_000u64);
    set_time(&env, 2_001);
    gov.close(&id);

    // approved=false (0 voters < min 3), weighted_yes=0, weighted_no=0
    let closed = crate::ProposalClosed { id, approved: false, weighted_yes: 0i128, weighted_no: 0i128 };
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (contract_id.clone(), closed.topics(&env), closed.data(&env)),
        ]
    );
}

#[test]
fn test_close_emits_proposalclosed_event_approved() {
    use soroban_sdk::Event;
    use soroban_sdk::testutils::Events;
    let env = Env::default();
    env.mock_all_auths();
    let (gov, id) = approved_proposal(&env);
    let contract_id = gov.address.clone();
    // The LAST emitted event must be the approved ProposalClosed (weighted 0/0 in M4).
    let closed = crate::ProposalClosed { id, approved: true, weighted_yes: 0i128, weighted_no: 0i128 };
    let all = env.events().all();
    let xdr_events = all.events();
    let last = xdr_events.last().unwrap().clone();
    assert_eq!(last, closed.to_xdr(&env, &contract_id));
}

// ============================================================================
// read accessors is_approved / cap_of / action_of (+ ProposalNotFound negatives)
// ============================================================================

#[test]
fn test_is_approved_reflects_status() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, id) = approved_proposal(&env);
    assert_eq!(gov.is_approved(&id), true);
}

#[test]
fn test_is_approved_false_for_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    // strict quorum, single vote -> Rejected (participation < 3).
    let (gov, _v) = deploy_with_committed_root(&env);
    set_time(&env, 1_000);
    let spec = sample_spec(&env);
    let id = gov.create_proposal(&spec, &15_000i128, &2_000u64);
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &committed_sealed(&env));
    set_time(&env, 2_001);
    gov.close(&id);
    assert_eq!(gov.is_approved(&id), false);
}

#[test]
fn test_cap_of_and_action_of_return_stored_values() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let spec = sample_spec(&env);
    let id = gov.create_proposal(&spec, &15_000i128, &2_000_000_000u64);
    assert_eq!(gov.cap_of(&id), 15_000);
    assert_eq!(gov.action_of(&id), spec);
}

#[test]
fn test_cap_of_not_found_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    assert_eq!(gov.try_cap_of(&123u32), Err(Ok(GovError::ProposalNotFound)));
}

#[test]
fn test_action_of_not_found_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    assert_eq!(gov.try_action_of(&123u32), Err(Ok(GovError::ProposalNotFound)));
}

// ============================================================================
// mark_executed single-shot replay guard
// ============================================================================

#[test]
fn test_mark_executed_single_shot() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, id) = approved_proposal(&env);
    assert_eq!(gov.is_approved(&id), true);
    let agent = Address::generate(&env);
    gov.set_executor(&agent);
    gov.mark_executed(&id);
    let view = gov.proposal(&id);
    assert_eq!(view.status, ProposalStatus::Executed);
    assert_eq!(gov.try_mark_executed(&id), Err(Ok(GovError::AlreadyExecuted)));
}

#[test]
fn test_mark_executed_requires_approved() {
    let env = Env::default();
    env.mock_all_auths();
    // strict quorum, single vote -> Rejected.
    let (gov, _v) = deploy_with_committed_root(&env);
    set_time(&env, 1_000);
    let spec = sample_spec(&env);
    let id = gov.create_proposal(&spec, &15_000i128, &2_000u64);
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &committed_sealed(&env));
    set_time(&env, 2_001);
    gov.close(&id);
    assert_eq!(gov.is_approved(&id), false);
    let agent = Address::generate(&env);
    gov.set_executor(&agent);
    assert_eq!(gov.try_mark_executed(&id), Err(Ok(GovError::NotApproved)));
}

// ---- integration: sealed vote -> approve -> execute ----

#[test]
fn integration_vote_to_approve_flow() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_lenient(&env);
    set_time(&env, 1_000);
    let spec = sample_spec(&env);
    let id = gov.create_proposal(&spec, &15_000i128, &2_000u64);
    assert_eq!(gov.proposal(&id).status, ProposalStatus::Open);

    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &committed_sealed(&env));
    assert_eq!(gov.votes_cast(&id), 1);
    // NO tally exposed before close (privacy invariant).
    assert_eq!(gov.proposal(&id).weighted_yes, None);

    set_time(&env, 2_001);
    gov.close(&id);

    let view = gov.proposal(&id);
    assert_eq!(view.status, ProposalStatus::Approved);
    assert_eq!(gov.is_approved(&id), true);
    assert_eq!(gov.cap_of(&id), 15_000);
    assert_eq!(gov.action_of(&id), spec);

    let agent = Address::generate(&env);
    gov.set_executor(&agent);
    gov.mark_executed(&id);
    assert_eq!(gov.proposal(&id).status, ProposalStatus::Executed);
    assert_eq!(gov.try_mark_executed(&id), Err(Ok(GovError::AlreadyExecuted)));
}

#[test]
fn integration_no_quorum_blocks_execution() {
    let env = Env::default();
    env.mock_all_auths();
    // strict quorum, single vote -> Rejected -> cannot execute.
    let (gov, _v) = deploy_with_committed_root(&env);
    set_time(&env, 1_000);
    let spec = sample_spec(&env);
    let id = gov.create_proposal(&spec, &15_000i128, &2_000u64);
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &committed_sealed(&env));
    set_time(&env, 2_001);
    gov.close(&id);
    assert_eq!(gov.is_approved(&id), false);
    let agent = Address::generate(&env);
    gov.set_executor(&agent);
    assert_eq!(gov.try_mark_executed(&id), Err(Ok(GovError::NotApproved)));
}

// ============================================================================
// mark_executed auth gate: configured executor only (foundation §2.2)
// ============================================================================
use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
use soroban_sdk::{vec as sdk_vec, IntoVal};

#[test]
fn mark_executed_allows_configured_executor() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, id) = approved_proposal(&env);
    assert_eq!(gov.is_approved(&id), true);

    let agent = Address::generate(&env);
    gov.set_executor(&agent);

    gov
        .mock_auths(&[MockAuth {
            address: &agent,
            invoke: &MockAuthInvoke {
                contract: &gov.address,
                fn_name: "mark_executed",
                args: sdk_vec![&env, id.into_val(&env)],
                sub_invokes: &[],
            },
        }])
        .mark_executed(&id);

    assert_eq!(gov.proposal(&id).status, ProposalStatus::Executed);
}

// ============================================================================
// Task 4.35 — on-chain round-trip with a FRESHLY generated proof via the FULL prover path
// ============================================================================
use crate::test_fixtures::{fresh_proof, fresh_public_signals, fresh_merkle_root_be32, fresh_sealed_commit_be32};

// PROVES the prover's re-map (generateVoteProof) and the contract's re-map agree ON-CHAIN: a proof
// generated by the full @shadowkit/zk-prover path for a DIFFERENT secret/root is accepted by
// gov-vault::cast_vote. A re-map bug in EITHER path makes this fail (StaleMerkleRoot / InvalidProof).
#[test]
fn onchain_accepts_fresh_prover_proof_end_to_end() {
    let env = Env::default();
    env.mock_all_auths();
    // init with the FRESH bundle's root (different from the canonical committed root).
    let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
    let gov_id = env.register(GovVault {}, ());
    let gov = GovVaultClient::new(&env, &gov_id);
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    gov.init(&admin, &verifier_id, &fresh_merkle_root_be32(&env), &asset, &default_quorum(&env));
    let id = create_default_proposal(&env, &gov);
    let sealed = SealedVote {
        round: 0,
        ciphertext: Bytes::from_array(&env, b"fresh-e2e"),
        sealed_commitment_hash: fresh_sealed_commit_be32(&env),
    };
    gov.cast_vote(&id, &fresh_proof(&env), &fresh_public_signals(&env), &sealed);
    assert_eq!(gov.votes_cast(&id), 1);
    assert_eq!(gov.proposal(&id).weighted_yes, None); // still no tally
}

#[test]
fn onchain_accepts_committed_proof_end_to_end() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _v) = deploy_with_committed_root(&env);
    let id = create_default_proposal(&env, &gov);
    let sealed = SealedVote {
        round: 0,
        ciphertext: Bytes::from_array(&env, b"e2e"),
        sealed_commitment_hash: sealed_commit_be32(&env),
    };
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
    assert_eq!(gov.votes_cast(&id), 1);
}

#[test]
#[should_panic] // host auth failure: the configured executor `agent` did not authorize the call
fn mark_executed_rejects_non_executor() {
    let env = Env::default();
    env.mock_all_auths();
    let (gov, id) = approved_proposal(&env);
    assert_eq!(gov.is_approved(&id), true);

    let agent = Address::generate(&env);
    let rogue = Address::generate(&env);
    gov.set_executor(&agent);

    gov
        .mock_auths(&[MockAuth {
            address: &rogue,
            invoke: &MockAuthInvoke {
                contract: &gov.address,
                fn_name: "mark_executed",
                args: sdk_vec![&env, id.into_val(&env)],
                sub_invokes: &[],
            },
        }])
        .mark_executed(&id);
}

// ============================================================================
// Task 4.36b — FALLBACK 2 (1p1v) cast_vote_min: counts-one + double-vote + replay negatives
// ============================================================================
#[cfg(feature = "circuit-min")]
mod min_path {
    use super::*;
    use crate::test_fixtures::{committed_proof_min, committed_public_signals_min, merkle_root_min_be32};

    fn deploy_min(env: &Env) -> GovVaultClient<'static> {
        let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
        let gov_id = env.register(GovVault {}, ());
        let gov = GovVaultClient::new(env, &gov_id);
        let admin = Address::generate(env); let asset = Address::generate(env);
        gov.init(&admin, &verifier_id, &merkle_root_min_be32(env), &asset, &default_quorum(env));
        gov
    }

    #[test]
    fn cast_vote_min_1p1v_counts_one() {
        let env = Env::default(); env.mock_all_auths();
        let gov = deploy_min(&env);
        let id = create_default_proposal(&env, &gov);
        let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"min"), sealed_commitment_hash: BytesN::from_array(&env, &[0u8; 32]) };
        gov.cast_vote_min(&id, &committed_proof_min(&env), &committed_public_signals_min(&env), &sealed);
        assert_eq!(gov.votes_cast(&id), 1);
        assert_eq!(gov.proposal(&id).weighted_yes, None);
    }

    #[test]
    fn cast_vote_min_double_vote_rejected() {
        let env = Env::default(); env.mock_all_auths();
        let gov = deploy_min(&env);
        let id = create_default_proposal(&env, &gov);
        let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"min"), sealed_commitment_hash: BytesN::from_array(&env, &[0u8; 32]) };
        gov.cast_vote_min(&id, &committed_proof_min(&env), &committed_public_signals_min(&env), &sealed);
        let res = gov.try_cast_vote_min(&id, &committed_proof_min(&env), &committed_public_signals_min(&env), &sealed);
        assert_eq!(res, Err(Ok(GovError::NullifierUsed)));
    }

    #[test]
    fn cast_vote_min_replay_other_proposal_rejected() {
        let env = Env::default(); env.mock_all_auths();
        let gov = deploy_min(&env);
        let _id0 = create_default_proposal(&env, &gov);
        let id1 = create_default_proposal(&env, &gov); // == 1; committed_min proof has proposalId 0
        let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"min"), sealed_commitment_hash: BytesN::from_array(&env, &[0u8; 32]) };
        let res = gov.try_cast_vote_min(&id1, &committed_proof_min(&env), &committed_public_signals_min(&env), &sealed);
        assert_eq!(res, Err(Ok(GovError::WrongProposalId)));
    }
}
