#![cfg(test)]
extern crate std;
use crate::{AgentPolicy, AgentPolicyClient};
use gov_vault::{GovVault, GovVaultClient};
use shadowkit_shared::{ActionSpec, QuorumCfg, SwapKind};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, Env, Map,
};
// OZ types reused across the V1c probe (re-pathed via crate::test::* in the probe helpers).
pub use stellar_accounts::smart_account::{AuthPayload, Signer};

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
        // Task M2-0c: configure an executor so `mark_executed`'s `get_executor().require_auth()`
        // gate resolves (mock_all_auths satisfies the executor signer). The reject_already_executed
        // gate test marks the proposal Executed via this path; without an executor set, mark_executed
        // panics NotInitialized reading DataKey::Executor (gov-vault storage.rs:get_executor).
        let executor = Address::generate(env);
        gv.set_executor(&executor);

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

    /// Like `approve_swap` but the proposal is CREATED ONLY (no votes, no close) so it stays Open
    /// and `is_approved == false`. Used by the reject_not_approved gate test. Returns the Open id.
    pub fn create_open_swap(
        env: &Env,
        gv: &GovVaultClient,
        asset_in: &Address,
        asset_out: &Address,
        amount: i128,
        cap: i128,
    ) -> u32 {
        let admin = Address::generate(env);
        let usdc = Address::generate(env);
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
        let executor = Address::generate(env);
        gv.set_executor(&executor);

        set_time(env, 1_000);
        let spec = ActionSpec {
            kind: SwapKind::Swap,
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            amount,
            min_out: 1i128,
        };
        let deadline: u64 = 2_000;
        gv.create_proposal(&spec, &cap, &deadline) // NOT voted/closed -> stays Open
    }
}

// ===========================================================================
// Task M2-V1c — the BINDING §13.4 probe: cross-read INSIDE `enforce` DURING AUTH.
// ===========================================================================
use crate::test_account::{TestEd25519Verifier, TestSmartAccount};
use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short,
    xdr::ToXdr,
    Bytes, BytesN, IntoVal, Symbol, Val, Vec,
};
use stellar_accounts::policies::Policy;
use stellar_accounts::smart_account::ContextRule;

// Throwaway policy: enforce() performs ONE cross-read of GovVault and GATES on the result.
// The cross-read runs DURING the host's __check_auth -> do_check_auth -> enforce. SOURCE: §13.4.
// SOURCE for the trait-impl shape: examples/multisig-smart-account/spending-limit-policy/src/contract.rs.
//
// Gating on the read value (panic when NOT approved) is deliberate: it proves the cross-read REALLY
// executed during auth and its result flows into the auth decision (no false green from a skipped
// read). enforce panics with a recognizable message if GovVault.is_approved(read_id) == false.
#[contract]
pub struct CrossReadProbePolicy;
#[contractimpl]
impl Policy for CrossReadProbePolicy {
    type AccountParams = Address; // the GovVault address

    fn enforce(
        e: &Env,
        _context: Context,
        _signers: Vec<Signer>,
        _rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth(); // OZ policy convention
        let gov: Address = e
            .storage()
            .persistent()
            .get(&(symbol_short!("gov"), smart_account.clone()))
            .unwrap();
        let read_id: u32 = e
            .storage()
            .persistent()
            .get(&symbol_short!("readid"))
            .unwrap_or(0u32);
        // THE §13.4 CROSS-READ DURING AUTH (live read of GovVault from inside enforce):
        let approved = gov_vault::GovVaultClient::new(e, &gov).is_approved(&read_id);
        // Gate on the live read so the verdict cannot be a false green from a skipped/ignored read.
        if !approved {
            panic!("CROSS_READ_GATE: GovVault.is_approved(read_id) was false during auth");
        }
    }

    fn install(e: &Env, gov: Address, _rule: ContextRule, smart_account: Address) {
        e.storage()
            .persistent()
            .set(&(symbol_short!("gov"), smart_account), &gov);
    }

    fn uninstall(_e: &Env, _rule: ContextRule, _sa: Address) {}
}

/// Build a signed AuthPayload for ONE context. The signed digest is
/// sha256(signature_payload.to_bytes() || context_rule_ids.to_xdr()) per do_check_auth
/// (stellar-accounts smart_account/storage.rs:493-495, verified 2026-06-02).
/// If `corrupt_sig` is true, the last signature byte is flipped so the ed25519 verify FAILS
/// (negative control proving the host's auth path is real, not bypassed).
fn sign_auth_payload(
    env: &Env,
    verifier: &Address,
    sk: &SigningKey,
    pubkey: &BytesN<32>,
    signature_payload: &BytesN<32>,
    rule_id: u32,
    corrupt_sig: bool,
) -> crate::test::AuthPayload {
    let context_rule_ids: Vec<u32> = soroban_sdk::vec![env, rule_id];
    // digest = sha256(signature_payload.bytes ++ context_rule_ids.to_xdr())
    let mut preimage = Bytes::from_array(env, &signature_payload.to_array());
    preimage.append(&context_rule_ids.clone().to_xdr(env));
    let digest = env.crypto().sha256(&preimage); // Hash<32>
    let digest_bytes = digest.to_bytes().to_array(); // [u8;32]
    let mut sig: [u8; 64] = sk.sign(&digest_bytes).to_bytes(); // REAL ed25519 over the digest
    if corrupt_sig {
        sig[63] ^= 0x01; // flip one bit -> a genuinely invalid ed25519 signature
    }
    let signer = Signer::External(
        verifier.clone(),
        Bytes::from_array(env, &pubkey.to_array()),
    );
    let mut signers: soroban_sdk::Map<Signer, Bytes> = soroban_sdk::Map::new(env);
    signers.set(signer, Bytes::from_array(env, &sig));
    crate::test::AuthPayload {
        signers,
        context_rule_ids,
    }
}

/// Result of driving a real host auth probe.
struct ProbeOutcome {
    ok: bool,
    /// True iff the failure looks like a cross-read/cross-contract rejection rather than a plain
    /// auth/gate failure (used to distinguish the two §13.4 verdict branches).
    err_dbg: std::string::String,
}

/// Drive a REAL host auth: invoke `TestSmartAccount.__check_auth` (via the host's
/// `call_account_contract_check_auth`) with a REAL ed25519-signed AuthPayload and ONE
/// ContractContext, so `do_check_auth` runs `CrossReadProbePolicy::enforce` (the §13.4 cross-read)
/// DURING authorization. Returns whether the host accepts (i.e. the cross-read was permitted).
/// SOURCE: soroban-sdk 26.0.1 env.rs:1602 `try_invoke_contract_check_auth`.
fn drive_host_auth(
    env: &Env,
    host: &Address,
    target: &Address,
    sk: &SigningKey,
    pubkey: &BytesN<32>,
    verifier: &Address,
    rule_id: u32,
    corrupt_sig: bool,
) -> ProbeOutcome {
    // The context being authorized: a contract call on `target` (fn name irrelevant for the probe).
    let ctx = Context::Contract(ContractContext {
        contract: target.clone(),
        fn_name: Symbol::new(env, "swap"),
        args: soroban_sdk::vec![env],
    });
    let auth_contexts: Vec<Context> = soroban_sdk::vec![env, ctx];

    // Choose any 32-byte signature payload (the host hashes it into the auth digest we sign).
    let signature_payload = BytesN::from_array(env, &[3u8; 32]);
    let payload = sign_auth_payload(env, verifier, sk, pubkey, &signature_payload, rule_id, corrupt_sig);

    let res = env.try_invoke_contract_check_auth::<soroban_sdk::InvokeError>(
        host,
        &signature_payload,
        payload.into_val(env),
        &auth_contexts,
    );
    ProbeOutcome {
        ok: res.is_ok(),
        err_dbg: std::format!("{:?}", res),
    }
}

/// Build the host with `CrossReadProbePolicy` installed and the probe `read_id` set in policy storage.
/// Returns (host, target, sk, pubkey, verifier).
fn build_probe_host(
    env: &Env,
    gv_id: &Address,
    read_id: u32,
) -> (Address, Address, SigningKey, BytesN<32>, Address) {
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    let pubkey = BytesN::from_array(env, &sk.verifying_key().to_bytes());
    let verifier = env.register(TestEd25519Verifier, ());

    let policy_id = env.register(CrossReadProbePolicy, ());
    let signers: Vec<Signer> = soroban_sdk::vec![
        env,
        Signer::External(verifier.clone(), Bytes::from_array(env, &pubkey.to_array()))
    ];
    let mut policies: soroban_sdk::Map<Address, Val> = soroban_sdk::Map::new(env);
    policies.set(policy_id.clone(), gv_id.clone().into_val(env)); // install_params = GovVault addr
    let host = env.register(TestSmartAccount, (signers, policies));

    // Tell the probe policy WHICH proposal id to live-read during enforce.
    env.as_contract(&policy_id, || {
        env.storage()
            .persistent()
            .set(&symbol_short!("readid"), &read_id);
    });

    let target = Address::generate(env);
    (host, target, sk, pubkey, verifier)
}

// THE BINDING §13.4 PROBE: a cross-contract READ of GovVault performed INSIDE the OZ
// `Policy::enforce` DURING a real host `__check_auth` flow succeeds. The probe policy GATES on
// the live read (panics if not approved), so a pass means the read genuinely executed and its
// result drove the auth decision.
#[test]
fn cross_read_in_enforce_during_auth() {
    let env = Env::default();
    // GovVault admin/governance auth is mocked; the host __check_auth (and its ed25519 verify) is REAL.
    env.mock_all_auths_allowing_non_root_auth();

    let (gv, gv_id) = fixtures::deploy_gov(&env);
    let asset_in = Address::generate(&env);
    let asset_out = Address::generate(&env);
    // proposal id 0 approved (the probe policy live-reads is_approved(&0))
    let id = fixtures::approve_swap(&env, &gv, &asset_in, &asset_out, 1_000, 1_000);
    assert_eq!(id, 0, "probe reads is_approved(read_id=0); fixture must produce id 0");
    assert_eq!(gv.is_approved(&0u32), true, "id 0 must be Approved before the probe");

    let (host, target, sk, pubkey, verifier) = build_probe_host(&env, &gv_id, 0u32);

    let outcome = drive_host_auth(&env, &host, &target, &sk, &pubkey, &verifier, 0u32, false);

    // VERDICT: Ok(()) => DIRECT cross-read in enforce during auth WORKS (OZ policy is primary).
    // Err => cross-read rejected during auth => hand-rolled __check_auth becomes the live host of record.
    assert!(
        outcome.ok,
        "BINDING §13.4 VERDICT would flip to NO. Host rejected auth: {}",
        outcome.err_dbg
    );
}

// NEGATIVE CONTROL A — proves the GREEN above is NOT a false green from a skipped read:
// when the probe policy live-reads an UNAPPROVED id during enforce, the gate panics and the
// host auth FAILS. If the cross-read were skipped/ignored, this would (wrongly) still pass.
#[test]
fn cross_read_gate_rejects_when_read_id_unapproved() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (gv, gv_id) = fixtures::deploy_gov(&env);
    let asset_in = Address::generate(&env);
    let asset_out = Address::generate(&env);
    let _id = fixtures::approve_swap(&env, &gv, &asset_in, &asset_out, 1_000, 1_000); // id 0 approved
    assert_eq!(gv.is_approved(&5u32), false, "id 5 does not exist -> not approved");

    // Point the probe at id 5 (NOT approved) -> the live cross-read returns false -> gate panics.
    let (host, target, sk, pubkey, verifier) = build_probe_host(&env, &gv_id, 5u32);
    let outcome = drive_host_auth(&env, &host, &target, &sk, &pubkey, &verifier, 0u32, false);

    assert!(
        !outcome.ok,
        "the live cross-read of an UNAPPROVED id must fail auth (proves the read really ran)"
    );
}

// NEGATIVE CONTROL B — proves the host's auth path is REAL (ed25519 actually verified), not
// bypassed by mock_all_auths_allowing_non_root_auth: a corrupted session signature FAILS auth.
#[test]
fn host_auth_rejects_bad_session_signature() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (gv, gv_id) = fixtures::deploy_gov(&env);
    let asset_in = Address::generate(&env);
    let asset_out = Address::generate(&env);
    let _id = fixtures::approve_swap(&env, &gv, &asset_in, &asset_out, 1_000, 1_000); // id 0 approved

    let (host, target, sk, pubkey, verifier) = build_probe_host(&env, &gv_id, 0u32);
    // corrupt_sig = true -> a genuinely invalid ed25519 signature.
    let outcome = drive_host_auth(&env, &host, &target, &sk, &pubkey, &verifier, 0u32, true);

    assert!(
        !outcome.ok,
        "a corrupted ed25519 session signature must fail host auth (proves auth is real)"
    );
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

// ===========================================================================
// Task M2-1 — AgentPolicyParams + PolicyError + storage round-trip (the safeguard's type surface).
// ===========================================================================
use crate::{AgentPolicyParams, PolicyError};

#[test]
fn params_roundtrip_and_error_codes() {
    let env = Env::default();
    env.mock_all_auths();
    let sa = Address::generate(&env); // the smart-account (treasury) address
    let gov = Address::generate(&env);
    let amm = Address::generate(&env);
    let asset = Address::generate(&env);
    let p = AgentPolicyParams {
        gov_vault: gov.clone(),
        approved_amm: amm.clone(),
        treasury_asset: asset.clone(),
        proposal_id: 0u32,
    };

    let pid = env.register(AgentPolicy, ());
    let c = AgentPolicyClient::new(&env, &pid);
    // store params via a thin test-only setter that mirrors `install` storage write:
    c.test_set_params(&sa, &p);
    let got = c.params(&sa);
    assert_eq!(got, p);

    // error discriminants are part of the ABI (§foundation §2.3)
    assert_eq!(PolicyError::NotApproved as u32, 2);
    assert_eq!(PolicyError::OverCap as u32, 6);
    assert_eq!(PolicyError::MultiCall as u32, 8);
    assert_eq!(PolicyError::MalformedArgs as u32, 9);
    assert_eq!(PolicyError::WrongAssetOut as u32, 10);
}

// ===========================================================================
// Task M2-2 — the gate engine harness (`gates` submodule, support code, NO assertions).
// Reused by EVERY allow/reject case (single try_test_enforce mechanism, no catch_unwind).
// Also provides `gates::rule(...)` used by the M2-1b install/uninstall auth tests.
// ===========================================================================
pub mod gates {
    use super::fixtures;
    use crate::{AgentPolicy, AgentPolicyClient, AgentPolicyParams};
    use soroban_sdk::{
        auth::{Context, ContractContext},
        symbol_short, testutils::Address as _, vec, Address, Env, IntoVal, String, Val, Vec,
    };
    use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

    pub struct Setup {
        pub env: Env,
        pub policy: AgentPolicyClient<'static>,
        pub sa: Address,
        pub gov: Address,
        pub amm: Address,
        pub asset_in: Address,
        pub asset_out: Address,
        pub id: u32,
        pub cap: i128,
    }

    /// Deploy GovVault + AgentPolicy, approve proposal `id` (swap asset_in->asset_out, amount=cap,
    /// cap), install policy params via the cfg(test) setter. Returns the Setup.
    pub fn setup(cap: i128) -> Setup {
        let env = Env::default();
        env.mock_all_auths(); // governance/admin auths mocked; the GATE under test is real
        let (gv, gov) = fixtures::deploy_gov(&env);
        let amm = Address::generate(&env);
        let asset_in = Address::generate(&env);
        let asset_out = Address::generate(&env);
        let id = fixtures::approve_swap(&env, &gv, &asset_in, &asset_out, cap, cap); // -> Approved
        let sa = Address::generate(&env);
        let pid = env.register(AgentPolicy, ());
        let policy = AgentPolicyClient::new(&env, &pid);
        let params = AgentPolicyParams {
            gov_vault: gov.clone(),
            approved_amm: amm.clone(),
            treasury_asset: asset_in.clone(),
            proposal_id: id,
        };
        policy.test_set_params(&sa, &params);
        Setup { env, policy, sa, gov, amm, asset_in, asset_out, id, cap }
    }

    /// Same as setup but the proposal is CREATED ONLY (not voted/closed) -> is_approved == false.
    pub fn setup_open(cap: i128) -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        let (gv, gov) = fixtures::deploy_gov(&env);
        let amm = Address::generate(&env);
        let asset_in = Address::generate(&env);
        let asset_out = Address::generate(&env);
        let id = fixtures::create_open_swap(&env, &gv, &asset_in, &asset_out, cap, cap); // NOT approved
        let sa = Address::generate(&env);
        let pid = env.register(AgentPolicy, ());
        let policy = AgentPolicyClient::new(&env, &pid);
        let params = AgentPolicyParams {
            gov_vault: gov.clone(),
            approved_amm: amm.clone(),
            treasury_asset: asset_in.clone(),
            proposal_id: id,
        };
        policy.test_set_params(&sa, &params);
        Setup { env, policy, sa, gov, amm, asset_in, asset_out, id, cap }
    }

    /// Build a Context::Contract for `swap(asset_in, amount_in, min_out, to)` on `target`.
    /// arg order MUST match SwapVenue::swap (§foundation §2.4): (asset_in, amount_in, min_out, to)
    /// — arity 4.
    pub fn swap_ctx(
        env: &Env,
        target: &Address,
        asset_in: &Address,
        amount_in: i128,
        min_out: i128,
        to: &Address,
    ) -> Context {
        let args: Vec<Val> = vec![
            env,
            asset_in.into_val(env),
            amount_in.into_val(env),
            min_out.into_val(env),
            to.into_val(env),
        ];
        Context::Contract(ContractContext {
            contract: target.clone(),
            fn_name: symbol_short!("swap"),
            args,
        })
    }

    /// A minimal ContextRule with a CallContract type (gates don't depend on signers here;
    /// signatures are the host's job, tested in M2-3). Field set verified against stellar-accounts
    /// v0.8.0-rc.1 smart_account/storage.rs:155 (id, context_type, name, signers, signer_ids,
    /// policies, policy_ids, valid_until).
    pub fn rule(env: &Env, target: &Address) -> ContextRule {
        ContextRule {
            id: 1,
            context_type: ContextRuleType::CallContract(target.clone()),
            name: String::from_str(env, "swap-rule"),
            signers: Vec::new(env),
            signer_ids: Vec::new(env),
            policies: Vec::new(env),   // Vec<Address>
            policy_ids: Vec::new(env), // Vec<u32>
            valid_until: None,         // Option<u32>
        }
    }
}

// ===========================================================================
// Task M2-1b — REAL install/uninstall auth tests (acceptance tests for M2-2's `impl Policy`).
// These are RED until M2-2's `impl Policy for AgentPolicy` lands (no `install`/`uninstall` method).
// ===========================================================================
#[test]
fn install_stores_params_with_sa_auth() {
    let env = Env::default();
    let sa = Address::generate(&env);
    let gov = Address::generate(&env);
    let amm = Address::generate(&env);
    let asset = Address::generate(&env);
    let p = AgentPolicyParams {
        gov_vault: gov,
        approved_amm: amm.clone(),
        treasury_asset: asset,
        proposal_id: 0u32,
    };
    let pid = env.register(AgentPolicy, ());
    let c = AgentPolicyClient::new(&env, &pid);
    let rule = gates::rule(&env, &amm);
    // require_auth for `sa` must be satisfied: authorize ONLY the install call for `sa`.
    // SOURCE: soroban_sdk 26.0.1 testutils/mock_auth.rs MockAuth{address,invoke} /
    // MockAuthInvoke{contract,fn_name,args,sub_invokes} (verified 2026-06-02).
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &sa,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &pid,
            fn_name: "install",
            args: (p.clone(), rule.clone(), sa.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    c.install(&p, &rule, &sa);
    assert_eq!(c.params(&sa), p);
}

#[test]
fn install_without_sa_auth_fails() {
    let env = Env::default();
    let sa = Address::generate(&env);
    let amm = Address::generate(&env);
    let p = AgentPolicyParams {
        gov_vault: Address::generate(&env),
        approved_amm: amm.clone(),
        treasury_asset: Address::generate(&env),
        proposal_id: 0u32,
    };
    let pid = env.register(AgentPolicy, ());
    let c = AgentPolicyClient::new(&env, &pid);
    let rule = gates::rule(&env, &amm);
    // NO mock_auths for `sa` -> require_auth() must fail. try_install surfaces the error.
    let res = c.try_install(&p, &rule, &sa);
    assert!(res.is_err(), "install must require smart-account auth");
}

#[test]
fn uninstall_removes_params_with_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let sa = Address::generate(&env);
    let amm = Address::generate(&env);
    let p = AgentPolicyParams {
        gov_vault: Address::generate(&env),
        approved_amm: amm.clone(),
        treasury_asset: Address::generate(&env),
        proposal_id: 0u32,
    };
    let pid = env.register(AgentPolicy, ());
    let c = AgentPolicyClient::new(&env, &pid);
    let rule = gates::rule(&env, &amm);
    c.install(&p, &rule, &sa);
    assert_eq!(c.params(&sa), p);
    c.uninstall(&rule, &sa);
    // params now gone -> params() panic_with_error!(NotInstalled). `params` returns a plain value
    // (not Result<_, PolicyError>), so try_params surfaces the panic as
    // Err(Ok(soroban_sdk::Error::from_contract_error(NotInstalled))) — NOT Err(Ok(PolicyError::X)).
    // (FIX vs plan snippet, which wrote Err(Ok(PolicyError::NotInstalled)): that only type-checks for
    // functions whose declared return is Result<_, PolicyError>; `params` is infallible+panicking.)
    let expected =
        soroban_sdk::Error::from_contract_error(PolicyError::NotInstalled as u32);
    assert_eq!(c.try_params(&sa), Err(Ok(expected)));
}

// ===========================================================================
// Task M2-2 — ALLOW (the gate engine + test_enforce harness; ONE red->green cycle).
// ===========================================================================
#[test]
fn allow_valid_swap() {
    let s = gates::setup(15_000i128);
    let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 15_000, 1, &s.sa);
    // try_test_enforce surfaces the contract Result; Ok(()) == allowed.
    let res = s.policy.try_test_enforce(&ctx, &s.sa);
    assert_eq!(res, Ok(Ok(())), "valid swap must be allowed");
}

// ---- The reject matrix (each asserts the EXACT PolicyError via try_test_enforce). The safeguard. ----

#[test]
fn reject_not_approved() {
    let s = gates::setup_open(15_000i128); // created, not voted/closed -> is_approved == false
    let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 1_000, 1, &s.sa);
    let res = s.policy.try_test_enforce(&ctx, &s.sa);
    assert_eq!(res, Err(Ok(PolicyError::NotApproved)));
}

#[test]
fn reject_over_cap() {
    let s = gates::setup(10_000i128);
    let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 10_001, 1, &s.sa);
    assert_eq!(
        s.policy.try_test_enforce(&ctx, &s.sa),
        Err(Ok(PolicyError::OverCap))
    );
}

#[test]
fn reject_wrong_target() {
    let s = gates::setup(10_000i128);
    let bad = Address::generate(&s.env);
    let ctx = gates::swap_ctx(&s.env, &bad, &s.asset_in, 1_000, 1, &s.sa);
    assert_eq!(
        s.policy.try_test_enforce(&ctx, &s.sa),
        Err(Ok(PolicyError::WrongTarget))
    );
}

#[test]
fn reject_wrong_asset() {
    let s = gates::setup(10_000i128);
    let bad_asset = Address::generate(&s.env);
    let ctx = gates::swap_ctx(&s.env, &s.amm, &bad_asset, 1_000, 1, &s.sa);
    assert_eq!(
        s.policy.try_test_enforce(&ctx, &s.sa),
        Err(Ok(PolicyError::WrongAsset))
    );
}

#[test]
fn reject_wrong_asset_out() {
    // Approve a proposal whose action.asset_out == action.asset_in (not a real, approved output).
    // Proves gate (f): the policy binds the swap to the APPROVED output asset; a hallucinating agent
    // cannot route funds to a worthless/self token.
    let env = Env::default();
    env.mock_all_auths();
    let (gv, gov) = fixtures::deploy_gov(&env);
    let amm = Address::generate(&env);
    let asset_in = Address::generate(&env);
    // asset_out deliberately == asset_in -> gate (f) WrongAssetOut
    let id = fixtures::approve_swap(&env, &gv, &asset_in, &asset_in, 10_000, 10_000);
    let sa = Address::generate(&env);
    let pid = env.register(AgentPolicy, ());
    let policy = AgentPolicyClient::new(&env, &pid);
    policy.test_set_params(
        &sa,
        &AgentPolicyParams {
            gov_vault: gov,
            approved_amm: amm.clone(),
            treasury_asset: asset_in.clone(),
            proposal_id: id,
        },
    );
    let ctx = gates::swap_ctx(&env, &amm, &asset_in, 1_000, 1, &sa);
    assert_eq!(
        policy.try_test_enforce(&ctx, &sa),
        Err(Ok(PolicyError::WrongAssetOut))
    );
}

#[test]
fn reject_already_executed() {
    let s = gates::setup(10_000i128);
    // status -> Executed. mark_executed's executor require_auth is satisfied by setup's
    // mock_all_auths (which also set_executor'd the gov-vault); the gate under test is the policy's
    // already-executed rejection (real).
    GovVaultClient::new(&s.env, &s.gov).mark_executed(&s.id);
    let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 1_000, 1, &s.sa);
    assert_eq!(
        s.policy.try_test_enforce(&ctx, &s.sa),
        Err(Ok(PolicyError::AlreadyExecuted))
    );
}

#[test]
fn reject_wrong_fn() {
    let s = gates::setup(10_000i128);
    // arity-4 args so it reaches the fn gate (fn_name != "swap")
    let args: Vec<Val> = soroban_sdk::vec![
        &s.env,
        s.asset_in.into_val(&s.env),
        1_000i128.into_val(&s.env),
        1i128.into_val(&s.env),
        s.sa.into_val(&s.env)
    ];
    let ctx = Context::Contract(ContractContext {
        contract: s.amm.clone(),
        fn_name: symbol_short!("transfer"),
        args,
    });
    assert_eq!(
        s.policy.try_test_enforce(&ctx, &s.sa),
        Err(Ok(PolicyError::WrongFn))
    );
}

#[test]
fn reject_malformed_args() {
    let s = gates::setup(10_000i128);
    // a `swap` context with WRONG arity (2 args) -> MalformedArgs, NOT WrongAsset/OverCap
    let args: Vec<Val> = soroban_sdk::vec![
        &s.env,
        s.asset_in.into_val(&s.env),
        1_000i128.into_val(&s.env)
    ];
    let ctx = Context::Contract(ContractContext {
        contract: s.amm.clone(),
        fn_name: symbol_short!("swap"),
        args,
    });
    assert_eq!(
        s.policy.try_test_enforce(&ctx, &s.sa),
        Err(Ok(PolicyError::MalformedArgs))
    );
}
