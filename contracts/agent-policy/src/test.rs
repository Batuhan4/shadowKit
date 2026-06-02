#![cfg(test)]
extern crate std;
use crate::{AgentPolicy, AgentPolicyClient};
use gov_vault::{GovVault, GovVaultClient};
use shadowkit_shared::{ActionSpec, QuorumCfg, SwapKind};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, Env, Map,
};

// ---- fixtures: minimal happy-path GovVault helpers adapted to the REAL M1 gov-vault API ----
// DIVERGENCE FROM PLAN: the plan's fixtures assumed init(admin, verifier, root, asset, quorum) and
// close_and_reveal. The REAL M1 API (contracts/gov-vault/src/{lib,test}.rs, §foundation §2.2) is:
//   init(admin, usdc_asset, &QuorumCfg, &Map<Address,i128> weights)
//   create_proposal(&ActionSpec, &cap, &deadline) -> u32
//   cast_vote(&id, &voter, &direction)     (direction 1 = yes, 0 = no)
//   close(&id)                              (after deadline; no separate reveal in M1 plaintext)
// We mirror M1's test.rs `vote_scenario` exactly (3 yes votes, advance past deadline, close).
pub mod fixtures {
    use super::*;

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: 26, // carry-forward: SDK 26 host rejects proto 25
            sequence_number: 10,
            network_id: [0; 32],
            base_reserve: 10,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 16,
            max_entry_ttl: 10_000_000,
        });
    }

    /// Deploy a GovVault. Returns (client, gov_id). The treasury asset is provided per proposal
    /// via the ActionSpec; init takes a single `usdc` stand-in asset address (unused by the probe).
    pub fn deploy_gov(env: &Env) -> (GovVaultClient<'static>, Address) {
        let gv_id = env.register(GovVault, ());
        let gv = GovVaultClient::new(env, &gv_id);
        (gv, gv_id)
    }

    /// Create a swap proposal (asset_in -> asset_out, amount, cap) and drive it to Approved using
    /// M1's PLAINTEXT 3-yes-votes-then-close sequence. Returns the Approved proposal id.
    /// `gv` must be freshly deployed (init is called here with 3 eligible voters).
    pub fn approve_swap(
        env: &Env,
        gv: &GovVaultClient,
        asset_in: &Address,
        asset_out: &Address,
        amount: i128,
        cap: i128,
    ) -> u32 {
        let admin = Address::generate(env);
        let usdc = Address::generate(env); // init's asset slot (proposal carries its own assets)
        let v1 = Address::generate(env);
        let v2 = Address::generate(env);
        let v3 = Address::generate(env);
        let mut w: Map<Address, i128> = Map::new(env);
        w.set(v1.clone(), 10);
        w.set(v2.clone(), 10);
        w.set(v3.clone(), 10);
        let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
        env.mock_all_auths();
        gv.init(&admin, &usdc, &cfg, &w);

        set_time(env, 1_000);
        let spec = ActionSpec {
            kind: SwapKind::Swap,
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            amount,
            min_out: 1i128,
        };
        let deadline: u64 = 2_000;
        let id = gv.create_proposal(&spec, &cap, &deadline);
        // 3 yes votes -> votes_cast(3) >= min_voters(3) AND yes>no -> Approved on close
        gv.cast_vote(&id, &v1, &1u32);
        gv.cast_vote(&id, &v2, &1u32);
        gv.cast_vote(&id, &v3, &1u32);
        set_time(env, 2_001); // advance past deadline
        gv.close(&id);
        id
    }
}

// §13.4 EASY-CASE PROBE: a NORMAL entrypoint cross-read of GovVault returns its real state.
// (M1 proves normal cross-reads work; this wires our client. HARD case = M2-V1c.)
#[test]
fn cross_read_probe_returns_govvault_state() {
    let env = Env::default();
    env.mock_all_auths(); // mocks GovVault admin/governance auth ONLY; the cross-read itself is real
    let (gv, gv_id) = fixtures::deploy_gov(&env);
    let asset_in = Address::generate(&env);
    let asset_out = Address::generate(&env);
    let id = fixtures::approve_swap(&env, &gv, &asset_in, &asset_out, 10_000, 10_000);

    // sanity: the proposal really is Approved on-chain
    assert_eq!(gv.is_approved(&id), true, "fixture must produce an Approved proposal");

    let probe_id = env.register(AgentPolicy, ());
    let approved = AgentPolicyClient::new(&env, &probe_id).probe_cross_read(&gv_id, &id);
    assert_eq!(approved, true, "cross-contract read of GovVault.is_approved must succeed");
}
