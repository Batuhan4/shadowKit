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
