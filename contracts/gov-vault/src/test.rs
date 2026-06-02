#![cfg(test)]
use crate::{GovVault, GovVaultClient, GovError};
use shadowkit_shared::QuorumCfg;
use soroban_sdk::{testutils::Address as _, Address, Env, Map};

fn setup() -> (Env, GovVaultClient<'static>, Address, Address) {
    let env = Env::default();
    let contract_id = env.register(GovVault, ());
    let client = GovVaultClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc = Address::generate(&env);
    (env, client, admin, usdc)
}

/// Build a Map<Address,i128> of voter -> weight for the snapshot.
fn weights(env: &Env, entries: &[(Address, i128)]) -> Map<Address, i128> {
    let mut m = Map::new(env);
    for (a, w) in entries.iter() {
        m.set(a.clone(), *w);
    }
    m
}

#[test]
fn test_init_sets_state() {
    let (env, client, admin, usdc) = setup();
    let v1 = Address::generate(&env);
    let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
    let w = weights(&env, &[(v1.clone(), 10)]);
    env.mock_all_auths();
    client.init(&admin, &usdc, &cfg, &w);
    // No panic == success. weight_of exposes the snapshot.
    assert_eq!(client.weight_of(&v1), 10);
}

#[test]
fn test_double_init_rejects() {
    let (env, client, admin, usdc) = setup();
    let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
    let w = weights(&env, &[]);
    env.mock_all_auths();
    client.init(&admin, &usdc, &cfg, &w);
    let res = client.try_init(&admin, &usdc, &cfg, &w);
    assert_eq!(res, Err(Ok(GovError::AlreadyInitialized)));
}

use shadowkit_shared::{ActionSpec, SwapKind, ProposalStatus};
use soroban_sdk::testutils::Ledger as _;

fn sample_spec(env: &Env) -> ActionSpec {
    ActionSpec {
        kind: SwapKind::Swap,
        asset_in: Address::generate(env),
        asset_out: Address::generate(env),
        amount: 15_000,
        min_out: 14_000,
    }
}

fn init_default(env: &Env, client: &GovVaultClient, admin: &Address, usdc: &Address) {
    let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
    let w = weights(env, &[]);
    env.mock_all_auths();
    client.init(admin, usdc, &cfg, &w);
}

#[test]
fn test_create_proposal_sequential_ids() {
    let (env, client, admin, usdc) = setup();
    init_default(&env, &client, &admin, &usdc);
    let spec = sample_spec(&env);
    let id0 = client.create_proposal(&spec, &15_000i128, &2_000_000_000u64);
    let id1 = client.create_proposal(&spec, &15_000i128, &2_000_000_000u64);
    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
}

#[test]
fn test_proposal_view_no_tally_before_close() {
    let (env, client, admin, usdc) = setup();
    init_default(&env, &client, &admin, &usdc);
    let spec = sample_spec(&env);
    let id = client.create_proposal(&spec, &15_000i128, &2_000_000_000u64);
    let view = client.proposal(&id);
    assert_eq!(view.id, id);
    assert_eq!(view.status, ProposalStatus::Open);
    assert_eq!(view.votes_cast, 0);
    assert_eq!(view.cap, 15_000);
    assert_eq!(view.deadline, 2_000_000_000);
    // BINDING invariant (foundation §2.2 / §7): no tally exposed before close.
    assert_eq!(view.weighted_yes, None);
    assert_eq!(view.weighted_no, None);
}

#[test]
fn test_proposal_not_found() {
    let (env, client, admin, usdc) = setup();
    init_default(&env, &client, &admin, &usdc);
    assert_eq!(client.try_proposal(&99u32), Err(Ok(GovError::ProposalNotFound)));
}

// INVARIANT (foundation §5 / §2.6: "amount bounded by proposal cap"; spec §9 "ActionSpec: cap bounds amount"):
// create_proposal MUST reject a spec whose amount exceeds cap (and a non-positive amount), so the
// cap invariant AgentPolicy (M2) and the safeguard "amount <= proposal cap" depend on cannot be
// silently violated at create time.
#[test]
fn test_create_proposal_rejects_amount_over_cap() {
    let (env, client, admin, usdc) = setup();
    init_default(&env, &client, &admin, &usdc);
    // spec.amount = 15_000 but cap = 10_000 -> amount > cap -> reject
    let spec = sample_spec(&env); // amount 15_000
    let res = client.try_create_proposal(&spec, &10_000i128, &2_000_000_000u64);
    assert_eq!(res, Err(Ok(GovError::ProposalAmountOverCap)));
}

#[test]
fn test_create_proposal_rejects_nonpositive_amount() {
    let (env, client, admin, usdc) = setup();
    init_default(&env, &client, &admin, &usdc);
    let mut spec = sample_spec(&env);
    spec.amount = 0; // amount must be strictly positive (0 <= cap, but a 0-amount swap is invalid)
    // the impl rejects amount <= 0 with the SAME error code as amount > cap (ProposalAmountOverCap)
    let res = client.try_create_proposal(&spec, &10_000i128, &2_000_000_000u64);
    assert_eq!(res, Err(Ok(GovError::ProposalAmountOverCap)));
}

// INVARIANT: deadline must be strictly in the future relative to the current ledger timestamp,
// otherwise the proposal is born un-votable and close() could run immediately.
#[test]
fn test_create_proposal_rejects_past_deadline() {
    let (env, client, admin, usdc) = setup();
    init_default(&env, &client, &admin, &usdc);
    // Advance ledger time to 1_000; a deadline of 1_000 (== now) or earlier must be rejected.
    // (set_time helper is introduced in Task 5.1; until then, set the ledger inline here.)
    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1_000,
        protocol_version: 26, // SDK 26.0.1 host min proto = 26 (was 25 in plan; testutils.rs default is 26)
        sequence_number: 10,
        network_id: [0; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 16,
        max_entry_ttl: 10_000_000,
    });
    let spec = sample_spec(&env);
    let res = client.try_create_proposal(&spec, &15_000i128, &1_000u64); // deadline == now
    assert_eq!(res, Err(Ok(GovError::DeadlineInPast)));
}
