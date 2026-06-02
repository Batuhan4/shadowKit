#![cfg(all(test, feature = "offchain-verify"))]
extern crate std;
use crate::test_fixtures::{committed_proof, committed_public_signals, merkle_root_be32, sealed_commit_be32};
use crate::{GovVault, GovVaultClient, GovError};
use shadowkit_shared::{ActionSpec, QuorumCfg, SealedVote, SwapKind};
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};

// The primary `test.rs` suite is gated OUT under `offchain-verify` (it targets the 5-arg ABI), so this
// module carries its own copies of the two shared helpers (mirrors `test.rs`).
fn default_quorum(_env: &Env) -> QuorumCfg {
    QuorumCfg { min_voters: 3, yes_must_exceed_no: true }
}
fn create_default_proposal(env: &Env, gov: &GovVaultClient) -> u32 {
    let spec = ActionSpec {
        kind: SwapKind::Swap,
        asset_in: Address::generate(env),
        asset_out: Address::generate(env),
        amount: 15_000,
        min_out: 14_000,
    };
    let deadline = env.ledger().timestamp() + 1_000;
    gov.create_proposal(&spec, &15_000i128, &deadline)
}

fn deploy(env: &Env) -> (GovVaultClient<'static>, Address) {
    let gov_id = env.register(GovVault {}, ());
    let gov = GovVaultClient::new(env, &gov_id);
    let admin = Address::generate(env); let asset = Address::generate(env);
    let verifier = Address::generate(env); // unused in fallback mode
    gov.init(&admin, &verifier, &merkle_root_be32(env), &asset, &default_quorum(env));
    (gov, admin)
}

// Under offchain-verify the entrypoint takes the trailing `verified: bool` flag (Task 4.22 signature).
#[test]
fn offchain_verify_accepts_coordinator_authorized_verified_vote() {
    let env = Env::default();
    env.mock_all_auths(); // admin (coordinator) require_auth() is the init + fallback gate.
    let (gov, admin) = deploy(&env);
    let id = create_default_proposal(&env, &gov);
    let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
    // verified == true: the coordinator pre-verified off-chain (Task 4.30b proves this is REAL).
    gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed, &true);
    assert_eq!(gov.votes_cast(&id), 1);
    let _ = &admin;
}

#[test]
fn offchain_verify_rejects_unverified_flag() {
    // The contract MUST refuse verified == false even when the coordinator authorized the call.
    // This proves the §2.1 flag is load-bearing (not the dropped-flag "admin says it's fine" hatch).
    let env = Env::default();
    env.mock_all_auths();
    let (gov, _admin) = deploy(&env);
    let id = create_default_proposal(&env, &gov);
    let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
    let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed, &false);
    assert_eq!(res, Err(Ok(GovError::InvalidProof)));
}

#[test]
fn offchain_verify_rejects_unauthorized_vote() {
    // With NO coordinator auth, cast_vote must error even with verified == true.
    let env = Env::default();
    // init + create the proposal under mocked auth, then clear auths for the cast.
    env.mock_all_auths();
    let (gov, _admin) = deploy(&env);
    let id = create_default_proposal(&env, &gov);
    env.set_auths(&[]); // clear: cast_vote sees NO admin auth -> require_auth() fails.
    let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
    let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed, &true);
    assert!(res.is_err()); // auth failure (the off-chain coordinator did not authorize)
}
