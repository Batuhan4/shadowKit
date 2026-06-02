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
    use stellar_accounts::smart_account::{ContextRule, ContextRuleType};

    #[allow(dead_code)] // asset_out/cap are part of the harness surface used by downstream M2 tasks
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

    // ----- Task M2-3: a REAL OZ smart-account host with AgentPolicy installed on its Default rule -----
    use crate::test_account::{TestEd25519Verifier, TestSmartAccount};
    use ed25519_dalek::SigningKey;
    use soroban_sdk::{Bytes, BytesN, Map};
    use stellar_accounts::smart_account::Signer as OzSigner;

    #[allow(dead_code)] // gov/asset_out/id/cap are part of the harness surface for downstream M2 tasks
    pub struct OzHostSetup {
        pub env: Env,
        pub host: Address, // the treasury smart-account (where AgentPolicy params are installed)
        pub gov: Address,
        pub amm: Address,
        pub asset_in: Address,
        pub asset_out: Address,
        pub id: u32,
        pub cap: i128,
        pub sk: SigningKey,      // the session signing key (REAL ed25519)
        pub pubkey: BytesN<32>,  // the registered session pubkey
        pub verifier: Address,   // the ed25519 verifier contract
        pub rule_id: u32,        // the host's Default context rule id
    }

    /// Deploy GovVault (Approved swap asset_in->asset_out cap), the AgentPolicy, a TestEd25519Verifier,
    /// and a TestSmartAccount host with the session ed25519 signer registered AND AgentPolicy installed
    /// as a policy on the Default rule (install_params = AgentPolicyParams). Returns OzHostSetup.
    /// SOURCE: registration mirrors examples/multisig-smart-account/account (External signer + policy map);
    /// the OZ constructor's add_context_rule calls PolicyClient::install(params, rule, host).
    pub fn setup_oz_host(cap: i128) -> OzHostSetup {
        let env = Env::default();
        // mock_all_auths so the GovVault admin/governance auths AND the AgentPolicy install's
        // smart_account.require_auth() (run during host construction) resolve. The SESSION ed25519
        // signature exercised by __check_auth is REAL (verified by the real verifier), NOT mocked.
        env.mock_all_auths();

        let (gv, gov) = fixtures::deploy_gov(&env);
        let amm = Address::generate(&env);
        let asset_in = Address::generate(&env);
        let asset_out = Address::generate(&env);
        let id = fixtures::approve_swap(&env, &gv, &asset_in, &asset_out, cap, cap);

        // REAL session key + verifier.
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubkey = BytesN::from_array(&env, &sk.verifying_key().to_bytes());
        let verifier = env.register(TestEd25519Verifier, ());

        // Deploy the AgentPolicy and install it on the host's Default rule with our params.
        let policy_id = env.register(AgentPolicy, ());
        let params = AgentPolicyParams {
            gov_vault: gov.clone(),
            approved_amm: amm.clone(),
            treasury_asset: asset_in.clone(),
            proposal_id: id,
        };
        let signers: Vec<OzSigner> = soroban_sdk::vec![
            &env,
            OzSigner::External(verifier.clone(), Bytes::from_array(&env, &pubkey.to_array()))
        ];
        let mut policies: Map<Address, Val> = Map::new(&env);
        policies.set(policy_id.clone(), params.into_val(&env)); // install_params = AgentPolicyParams
        let host = env.register(TestSmartAccount, (signers, policies));

        OzHostSetup {
            env, host, gov, amm, asset_in, asset_out, id, cap,
            sk, pubkey, verifier,
            rule_id: 0u32, // __constructor registers the Default rule as the first rule (id 0)
        }
    }

    // ----- Task M2-6/M2-7: the on-chain HERO-LOOP setup (REAL SAC tokens + REAL FallbackAMM). -----
    // Unlike setup_oz_host (which uses generated placeholder addresses for assets/amm), the hero loop
    // needs ACTUAL token contracts whose balances move and an ACTUAL FallbackAMM with liquidity. The
    // treasury host holds USDC; FallbackAMM.swap(usdc, ...) pulls USDC FROM and pushes XLM TO the
    // treasury (to.require_auth() == the treasury host). AgentPolicy is installed so enforce gates the
    // swap during a real __check_auth (the gate-pass is asserted with a REAL session signature).
    use fallback_amm::{FallbackAMM, FallbackAMMClient};
    use soroban_sdk::token;

    #[allow(dead_code)] // some fields are part of the harness surface used by the integration tests
    pub struct FullAssetsSetup {
        pub env: Env,
        pub treasury: Address, // the OZ-hosted TestSmartAccount wallet (treasury) holding USDC
        pub gov: Address,
        pub amm: Address, // the REAL FallbackAMM (== approved_amm)
        pub usdc: Address,       // USDC SAC contract id (treasury asset / asset_in)
        pub usdc_admin: Address, // USDC SAC admin (mint authority)
        pub xlm: Address,        // XLM SAC contract id (asset_out, the REAL output)
        pub xlm_admin: Address,  // XLM SAC admin (mint authority)
        pub id: u32,
        pub cap: i128,
        pub sk: SigningKey,     // REAL ed25519 session key
        pub pubkey: BytesN<32>, // registered session pubkey
        pub verifier: Address,  // ed25519 verifier contract
        pub rule_id: u32,       // the treasury host's Default context rule id
    }

    /// Build the full on-chain hero-loop fixture with REAL SAC tokens and a REAL FallbackAMM.
    /// `approved` selects whether the gov proposal reaches quorum (Approved) or stays Open.
    /// Liquidity is seeded so the swap returns a positive XLM out. The treasury is NOT funded here
    /// (the test mints into it so before/after deltas are explicit).
    fn build_full(amount_cap: i128, approved: bool) -> FullAssetsSetup {
        let env = Env::default();
        // GovVault admin/governance auths AND the AgentPolicy install's smart_account.require_auth()
        // (host construction) AND liquidity-provider auth are mocked. The SESSION ed25519 signature
        // exercised by __check_auth (the gate-pass proof) is REAL.
        env.mock_all_auths();

        // REAL SAC tokens: USDC (treasury asset / asset_in), XLM (asset_out).
        let usdc_admin = Address::generate(&env);
        let xlm_admin = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(usdc_admin.clone())
            .address();
        let xlm = env
            .register_stellar_asset_contract_v2(xlm_admin.clone())
            .address();

        // REAL FallbackAMM(usdc, xlm) + seeded liquidity (so swap yields positive out).
        let amm_id = env.register(FallbackAMM, ());
        let amm = FallbackAMMClient::new(&env, &amm_id);
        amm.init(&usdc, &xlm);
        let lp = Address::generate(&env);
        token::StellarAssetClient::new(&env, &usdc).mint(&lp, &1_000_000i128);
        token::StellarAssetClient::new(&env, &xlm).mint(&lp, &1_000_000i128);
        amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);

        // GovVault proposal binding the REAL SAC pair (usdc -> xlm), cap = amount_cap.
        let (gv, gov) = fixtures::deploy_gov(&env);
        let id = if approved {
            fixtures::approve_swap(&env, &gv, &usdc, &xlm, amount_cap, amount_cap)
        } else {
            fixtures::create_open_swap(&env, &gv, &usdc, &xlm, amount_cap, amount_cap)
        };

        // REAL session key + verifier.
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubkey = BytesN::from_array(&env, &sk.verifying_key().to_bytes());
        let verifier = env.register(TestEd25519Verifier, ());

        // AgentPolicy installed on the treasury host's Default rule; approved_amm == the REAL AMM,
        // treasury_asset == usdc.
        let policy_id = env.register(AgentPolicy, ());
        let params = AgentPolicyParams {
            gov_vault: gov.clone(),
            approved_amm: amm_id.clone(),
            treasury_asset: usdc.clone(),
            proposal_id: id,
        };
        let signers: Vec<OzSigner> = soroban_sdk::vec![
            &env,
            OzSigner::External(verifier.clone(), Bytes::from_array(&env, &pubkey.to_array()))
        ];
        let mut policies: Map<Address, Val> = Map::new(&env);
        policies.set(policy_id.clone(), params.into_val(&env));
        let treasury = env.register(TestSmartAccount, (signers, policies));

        FullAssetsSetup {
            env,
            treasury,
            gov,
            amm: amm_id,
            usdc,
            usdc_admin,
            xlm,
            xlm_admin,
            id,
            cap: amount_cap,
            sk,
            pubkey,
            verifier,
            rule_id: 0u32,
        }
    }

    /// Hero loop (M2-6): the gov proposal is APPROVED (quorum reached) and bound to the REAL usdc->xlm
    /// SAC pair on the REAL FallbackAMM.
    pub fn setup_full_with_assets(amount_cap: i128) -> FullAssetsSetup {
        build_full(amount_cap, true)
    }

    /// Negative loop (M2-7): SAME wiring but the proposal stays Open (no quorum) -> is_approved == false.
    pub fn setup_full_open_with_assets(amount_cap: i128) -> FullAssetsSetup {
        build_full(amount_cap, false)
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

// ===========================================================================
// Task M2-3 — OZ smart-account host + REAL ed25519 auth integration.
// Proves AgentPolicy::enforce runs INSIDE a real do_check_auth flow (the §13.4 cross-read path),
// authenticated by a REAL ed25519 session signature (NOT mock_all_auths for the signer-under-test).
//
// We invoke TestSmartAccount.__check_auth via `env.try_invoke_contract_check_auth::<Error>` — the
// exact host code path the runtime uses for auth — so we can assert the EXACT Ok/Err outcome with
// the contract error code surfaced. (DIVERGENCE vs plan snippet: the plan assumed a generated
// `try___check_auth` client method; the soroban-sdk 26.0.1 contractimpl for CustomAccountInterface
// does NOT generate one, so we reuse the M2-V1c driver primitive `try_invoke_contract_check_auth`,
// SOURCE soroban-sdk 26.0.1 env.rs:1602. This is NOT catch_unwind — it is the host Err surface.)

/// Invoke the host's __check_auth via the real host primitive; surface the contract Error code.
fn check_auth(
    env: &Env,
    host: &Address,
    signature_payload: &BytesN<32>,
    signed: &crate::test::AuthPayload,
    auth_contexts: &Vec<Context>,
) -> Result<(), Result<soroban_sdk::Error, soroban_sdk::InvokeError>> {
    env.try_invoke_contract_check_auth::<soroban_sdk::Error>(
        host,
        signature_payload,
        signed.clone().into_val(env),
        auth_contexts,
    )
}

#[test]
fn oz_real_auth_allows_valid_swap() {
    let h = gates::setup_oz_host(15_000i128);
    // The swap context the treasury authorizes: swap(asset_in, amount<=cap, min_out, to=host).
    let ctx = gates::swap_ctx(&h.env, &h.amm, &h.asset_in, 10_000, 1, &h.host);
    let auth_contexts: Vec<Context> = soroban_sdk::vec![&h.env, ctx];
    // The host hands __check_auth a 32-byte signature_payload; sign_auth_payload signs the host
    // digest sha256(payload || context_rule_ids.to_xdr()) with the REAL session key. corrupt_sig=false.
    let payload = BytesN::from_array(&h.env, &[9u8; 32]);
    let signed = sign_auth_payload(&h.env, &h.verifier, &h.sk, &h.pubkey, &payload, h.rule_id, false);
    // GovVault admin auths mocked; the SESSION signature + enforce cross-read are REAL.
    h.env.mock_all_auths_allowing_non_root_auth();
    let res = check_auth(&h.env, &h.host, &payload, &signed, &auth_contexts);
    assert_eq!(
        res,
        Ok(()),
        "valid real-signed swap authorized by OZ host + policy must pass: {:?}",
        res
    );
}

#[test]
fn oz_real_auth_rejects_over_cap_proving_enforce_ran() {
    // PROVES enforce actually ran: a TAMPERED over-cap arg makes the REAL auth path reject. If enforce
    // were NOT running during auth, an over-cap swap would wrongly pass.
    let h = gates::setup_oz_host(10_000i128);
    let ctx = gates::swap_ctx(&h.env, &h.amm, &h.asset_in, 10_001, 1, &h.host); // over cap
    let auth_contexts: Vec<Context> = soroban_sdk::vec![&h.env, ctx];
    let payload = BytesN::from_array(&h.env, &[9u8; 32]);
    let signed = sign_auth_payload(&h.env, &h.verifier, &h.sk, &h.pubkey, &payload, h.rule_id, false);
    h.env.mock_all_auths_allowing_non_root_auth();
    let res = check_auth(&h.env, &h.host, &payload, &signed, &auth_contexts);
    // The host surfaces the policy's OverCap as a contract error => enforce DID run during auth.
    let expected = soroban_sdk::Error::from_contract_error(PolicyError::OverCap as u32);
    assert_eq!(
        res,
        Err(Ok(expected)),
        "over-cap must be rejected by enforce (OverCap) during real auth (got {:?})",
        res
    );
}

#[test]
fn oz_real_auth_rejects_bad_sig() {
    // corrupt_sig=true: the driver flips the last signature byte -> a genuinely invalid ed25519
    // signature over the host digest, presented against the REGISTERED pubkey. The verifier's
    // ed25519_verify (REAL) fails during do_check_auth.
    let h = gates::setup_oz_host(15_000i128);
    let ctx = gates::swap_ctx(&h.env, &h.amm, &h.asset_in, 1_000, 1, &h.host);
    let auth_contexts: Vec<Context> = soroban_sdk::vec![&h.env, ctx];
    let payload = BytesN::from_array(&h.env, &[9u8; 32]);
    let signed = sign_auth_payload(&h.env, &h.verifier, &h.sk, &h.pubkey, &payload, h.rule_id, true);
    h.env.mock_all_auths_allowing_non_root_auth();
    let res = check_auth(&h.env, &h.host, &payload, &signed, &auth_contexts);
    assert!(
        res.is_err(),
        "bad signature must be rejected by the ed25519 verifier during __check_auth (got {:?})",
        res
    );
}

#[test]
fn oz_real_auth_rejects_multi_call() {
    // ONE auth batch with TWO contract contexts -> the __check_auth MultiCall override rejects with
    // PolicyError::MultiCall (mapped into soroban_sdk::Error). context_rule_ids must be index-aligned.
    let h = gates::setup_oz_host(15_000i128);
    let ctx1 = gates::swap_ctx(&h.env, &h.amm, &h.asset_in, 1_000, 1, &h.host);
    let ctx2 = gates::swap_ctx(&h.env, &h.amm, &h.asset_in, 1_000, 1, &h.host);
    let auth_contexts: Vec<Context> = soroban_sdk::vec![&h.env, ctx1, ctx2]; // TWO contract contexts
    let payload = BytesN::from_array(&h.env, &[9u8; 32]);
    let mut signed =
        sign_auth_payload(&h.env, &h.verifier, &h.sk, &h.pubkey, &payload, h.rule_id, false);
    // two context_rule_ids (index-aligned) so the do_check_auth length check would pass; the override
    // trips FIRST (it counts contract contexts before delegating).
    signed.context_rule_ids = soroban_sdk::vec![&h.env, h.rule_id, h.rule_id];
    h.env.mock_all_auths_allowing_non_root_auth();
    let res = check_auth(&h.env, &h.host, &payload, &signed, &auth_contexts);
    // MultiCall surfaces as PolicyError::MultiCall (mapped into soroban_sdk::Error by the override).
    let expected = soroban_sdk::Error::from_contract_error(PolicyError::MultiCall as u32);
    assert_eq!(
        res,
        Err(Ok(expected)),
        "multi-call auth batch must be rejected by the override with MultiCall (got {:?})",
        res
    );
}

// ===========================================================================
// Phase 3 — Hand-rolled __check_auth fallback (feature = "handrolled"), FULLY tested.
// Self-contained custom account, NO stellar-accounts dependency, verifying a REAL ed25519
// session-key signature (env.crypto().ed25519_verify) then applying the IDENTICAL gate set via the
// SHARED policy::check_swap_gates (+ MultiCall single-context). Same allow + reject matrix as OZ.
// ===========================================================================
#[cfg(feature = "handrolled")]
mod handrolled {
    use super::*;
    use crate::fallback::{HandRolledAgentAccount, HandRolledAgentAccountClient};
    // SigningKey is the only symbol not already provided by `super::*` (which re-exports
    // ed25519_dalek::Signer as _, testutils::Address as _, soroban_sdk Address/BytesN/Env/Vec/vec).
    use ed25519_dalek::SigningKey;

    /// Deploy HandRolledAgentAccount registered with `sk`'s pubkey, a real GovVault (Approved or Open),
    /// and a fixed AMM/asset. Takes the SigningKey so the pubkey is derived in THIS env (no throwaway env).
    #[allow(dead_code)] // asset_out/amm part of the harness surface used by the reject matrix
    struct HrSetup {
        env: Env,
        account: Address,
        gov: Address,
        amm: Address,
        asset_in: Address,
        asset_out: Address,
        id: u32,
    }

    fn build_hr(cap: i128, sk: &SigningKey, approved: bool) -> HrSetup {
        let env = Env::default();
        env.mock_all_auths();
        let (gv, gov) = fixtures::deploy_gov(&env);
        let amm = Address::generate(&env);
        let asset_in = Address::generate(&env);
        let asset_out = Address::generate(&env);
        let id = if approved {
            fixtures::approve_swap(&env, &gv, &asset_in, &asset_out, cap, cap)
        } else {
            fixtures::create_open_swap(&env, &gv, &asset_in, &asset_out, cap, cap)
        };
        let pubkey = BytesN::from_array(&env, &sk.verifying_key().to_bytes()); // pubkey in THIS env
        let account = env.register(HandRolledAgentAccount, ());
        HandRolledAgentAccountClient::new(&env, &account)
            .init(&pubkey, &gov, &amm, &asset_in, &id);
        HrSetup { env, account, gov, amm, asset_in, asset_out, id }
    }

    fn setup_for_handrolled(cap: i128, sk: &SigningKey) -> HrSetup {
        build_hr(cap, sk, true)
    }
    fn setup_open_for_handrolled(cap: i128, sk: &SigningKey) -> HrSetup {
        build_hr(cap, sk, false)
    }

    /// Sign the RAW 32-byte payload with `sk` and call __check_auth for ONE context. The hand-rolled
    /// account verifies the sig over signature_payload DIRECTLY (no context_rule_ids digest — that is
    /// OZ-host-specific). We drive it through the host primitive `try_invoke_contract_check_auth`
    /// (SOURCE soroban-sdk 26.0.1 env.rs:1602) — the exact host auth code path — so we can assert the
    /// EXACT Ok/Err with the contract error code surfaced. (DIVERGENCE vs plan snippet: the soroban-sdk
    /// 26.0.1 contractimpl for CustomAccountInterface does NOT generate a `try___check_auth` client
    /// method — same finding as M2-3. This is NOT catch_unwind; it is the host Err surface.)
    fn hr_check(
        s: &HrSetup,
        sk: &SigningKey,
        ctx: Context,
    ) -> Result<(), Result<soroban_sdk::Error, soroban_sdk::InvokeError>> {
        hr_check_ctxs(s, sk, soroban_sdk::vec![&s.env, ctx])
    }

    /// Like hr_check but takes the full auth_contexts vec (used by the multi-call reject).
    fn hr_check_ctxs(
        s: &HrSetup,
        sk: &SigningKey,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Result<soroban_sdk::Error, soroban_sdk::InvokeError>> {
        let payload = BytesN::from_array(&s.env, &[5u8; 32]);
        let sig = BytesN::from_array(&s.env, &sk.sign(&payload.to_array()).to_bytes()); // REAL ed25519
        s.env.try_invoke_contract_check_auth::<soroban_sdk::Error>(
            &s.account,
            &payload,
            sig.into_val(&s.env),
            &auth_contexts,
        )
    }

    #[test]
    fn handrolled_allows_valid_swap_with_real_sig() {
        // REAL ed25519 key (NOT an invented env helper). SOURCE: ed25519-dalek 2.1.1.
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let s = setup_for_handrolled(15_000i128, &sk);
        let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 10_000, 1, &s.account);
        let res = hr_check(&s, &sk, ctx);
        assert_eq!(res, Ok(()), "valid real-signed swap must pass __check_auth: {:?}", res);
    }

    // ----- M2-5: the hand-rolled reject matrix (REAL signatures, each asserting the EXACT error). -----
    // The fallback safeguard proof: a hallucinating agent cannot move treasury funds wrong even when
    // the OZ host is not the host of record. The signature is REAL (signed with the registered key) so
    // the GATE rejects, not the sig — EXCEPT bad-sig where the sig is deliberately wrong. Each case
    // asserts the EXACT Err(Ok(soroban_sdk::Error::from_contract_error(PolicyError::X as u32))) via the
    // host try_ surface (NOT catch_unwind). Mirrors the OZ reject matrix exactly (shared gate engine).

    /// Map a PolicyError to the exact host-surfaced Err the try_ primitive returns.
    fn err(code: PolicyError) -> Result<(), Result<soroban_sdk::Error, soroban_sdk::InvokeError>> {
        Err(Ok(soroban_sdk::Error::from_contract_error(code as u32)))
    }

    #[test]
    fn handrolled_rejects_not_approved() {
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let s = setup_open_for_handrolled(15_000i128, &sk); // created, not voted/closed -> not approved
        let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 1_000, 1, &s.account);
        assert_eq!(hr_check(&s, &sk, ctx), err(PolicyError::NotApproved));
    }

    #[test]
    fn handrolled_rejects_over_cap() {
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let s = setup_for_handrolled(10_000i128, &sk);
        let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 10_001, 1, &s.account); // over cap
        assert_eq!(hr_check(&s, &sk, ctx), err(PolicyError::OverCap));
    }

    #[test]
    fn handrolled_rejects_wrong_target() {
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let s = setup_for_handrolled(10_000i128, &sk);
        let bad = Address::generate(&s.env); // target != approved_amm
        let ctx = gates::swap_ctx(&s.env, &bad, &s.asset_in, 1_000, 1, &s.account);
        assert_eq!(hr_check(&s, &sk, ctx), err(PolicyError::WrongTarget));
    }

    #[test]
    fn handrolled_rejects_wrong_asset_in() {
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let s = setup_for_handrolled(10_000i128, &sk);
        let bad_asset = Address::generate(&s.env); // asset_in != treasury_asset
        let ctx = gates::swap_ctx(&s.env, &s.amm, &bad_asset, 1_000, 1, &s.account);
        assert_eq!(hr_check(&s, &sk, ctx), err(PolicyError::WrongAsset));
    }

    #[test]
    fn handrolled_rejects_wrong_asset_out() {
        // Approve a proposal whose action.asset_out == action.asset_in (not a real, approved output).
        // gate (f) via the SHARED check_swap_gates: cannot route funds to a worthless/self token.
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let env = Env::default();
        env.mock_all_auths();
        let (gv, gov) = fixtures::deploy_gov(&env);
        let amm = Address::generate(&env);
        let asset_in = Address::generate(&env);
        let asset_out = Address::generate(&env);
        // asset_out deliberately == asset_in -> gate (f) WrongAssetOut
        let id = fixtures::approve_swap(&env, &gv, &asset_in, &asset_in, 10_000, 10_000);
        let pubkey = BytesN::from_array(&env, &sk.verifying_key().to_bytes());
        let account = env.register(HandRolledAgentAccount, ());
        HandRolledAgentAccountClient::new(&env, &account)
            .init(&pubkey, &gov, &amm, &asset_in, &id);
        let s = HrSetup { env, account, gov, amm, asset_in, asset_out, id };
        let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 1_000, 1, &s.account);
        assert_eq!(hr_check(&s, &sk, ctx), err(PolicyError::WrongAssetOut));
    }

    #[test]
    fn handrolled_rejects_malformed_args() {
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let s = setup_for_handrolled(10_000i128, &sk);
        // a `swap` context with WRONG arity (2 args) -> MalformedArgs
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
        assert_eq!(hr_check(&s, &sk, ctx), err(PolicyError::MalformedArgs));
    }

    #[test]
    fn handrolled_rejects_already_executed() {
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let s = setup_for_handrolled(10_000i128, &sk);
        // status -> Executed (executor require_auth satisfied by build_hr's mock_all_auths + set_executor).
        GovVaultClient::new(&s.env, &s.gov).mark_executed(&s.id);
        let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 1_000, 1, &s.account);
        assert_eq!(hr_check(&s, &sk, ctx), err(PolicyError::AlreadyExecuted));
    }

    #[test]
    fn handrolled_rejects_bad_signature() {
        // Sign with a DIFFERENT key than the registered session pubkey -> the REAL env.crypto()
        // .ed25519_verify fails; the host surfaces it via try_ (NOT catch_unwind). Exact policy code
        // is not applicable (the failure is in host crypto), so assert res.is_err().
        let sk = SigningKey::from_bytes(&[11u8; 32]); // registered session key
        let s = setup_for_handrolled(15_000i128, &sk);
        let wrong_sk = SigningKey::from_bytes(&[99u8; 32]); // a DIFFERENT key
        let ctx = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 1_000, 1, &s.account);
        let res = hr_check(&s, &wrong_sk, ctx);
        assert!(
            res.is_err(),
            "a signature from the wrong key must fail the real ed25519 verify in __check_auth (got {:?})",
            res
        );
    }

    #[test]
    fn handrolled_rejects_multi_call() {
        // TWO contract contexts in ONE auth batch -> the MultiCall override rejects (single-context).
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let s = setup_for_handrolled(15_000i128, &sk);
        let ctx1 = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 1_000, 1, &s.account);
        let ctx2 = gates::swap_ctx(&s.env, &s.amm, &s.asset_in, 1_000, 1, &s.account);
        let auth_contexts: Vec<Context> = soroban_sdk::vec![&s.env, ctx1, ctx2];
        assert_eq!(hr_check_ctxs(&s, &sk, auth_contexts), err(PolicyError::MultiCall));
    }
}

// ===========================================================================
// Phase 4 — Cross-contract HERO-LOOP integration (vote->approve->agent-swap->balances move;
// quorum-blocked negative). The ON-CHAIN proof: a hallucinating agent literally cannot move treasury
// funds wrong, and a correctly-approved swap moves REAL SAC balances through the policy-gated wallet.
// ===========================================================================
mod integration {
    use super::*;
    use soroban_sdk::{testutils::MockAuth, testutils::MockAuthInvoke, token};

    /// Task M2-6 — THE HERO LOOP, on-chain. vote -> Approved+cap -> the agent's session key signs the
    /// swap -> the policy authorizes it through the host (`enforce` runs with a REAL ed25519 signature)
    /// -> FallbackAMM.swap executes and REAL SAC balances move (USDC down, XLM up) -> mark_executed.
    ///
    /// AUTH BOUNDARY (charter rule 4): the gate-pass is proven by driving the treasury host's
    /// __check_auth over the EXACT swap context with the REAL session signature (NOT mock_all_auths
    /// for the signer-under-test) — `env.try_invoke_contract_check_auth`, the same host Err-surface
    /// primitive used in M2-3/M2-V1c (the soroban-sdk 26.0.1 contractimpl for CustomAccountInterface
    /// does NOT generate a `try___check_auth` client method, recorded divergence from the plan snippet).
    /// The balance-moving FallbackAMM.swap is then submitted with `mock_auths` SCOPED to the treasury
    /// host's swap call (so `to.require_auth()` inside the AMM resolves for the treasury) — the gate-pass
    /// is real and separately asserted, and the balance move is observed on-chain.
    #[test]
    fn hero_loop_moves_balances() {
        let s = gates::setup_full_with_assets(10_000i128);

        // Fund the treasury with 10_000 USDC (the asset_in for the approved swap).
        token::StellarAssetClient::new(&s.env, &s.usdc).mint(&s.treasury, &10_000i128);
        let usdc = token::Client::new(&s.env, &s.usdc);
        let xlm = token::Client::new(&s.env, &s.xlm);
        let treasury_usdc_before = usdc.balance(&s.treasury);
        let treasury_xlm_before = xlm.balance(&s.treasury);
        assert_eq!(treasury_usdc_before, 10_000i128, "treasury funded with 10_000 USDC");
        assert_eq!(treasury_xlm_before, 0i128, "treasury holds no XLM before the swap");

        // 1) GATE-PASS PROOF: drive the treasury host's __check_auth over the EXACT swap context with
        //    a REAL session signature. enforce runs the gates LIVE (is_approved, !executed, cap, asset
        //    binding) and must return Ok(()). If enforce did NOT run, an over-cap/unapproved swap would
        //    wrongly pass — the negative test (execute_without_quorum_is_blocked) proves it rejects.
        let swap_ctx = gates::swap_ctx(&s.env, &s.amm, &s.usdc, 10_000, 1, &s.treasury);
        let auth_contexts: Vec<Context> = soroban_sdk::vec![&s.env, swap_ctx];
        let signature_payload = BytesN::from_array(&s.env, &[9u8; 32]);
        let signed = sign_auth_payload(
            &s.env, &s.verifier, &s.sk, &s.pubkey, &signature_payload, s.rule_id, false,
        );
        s.env.mock_all_auths_allowing_non_root_auth();
        let gate = check_auth(&s.env, &s.treasury, &signature_payload, &signed, &auth_contexts);
        assert_eq!(
            gate,
            Ok(()),
            "the approved, in-cap swap must pass enforce under a REAL host auth (got {:?})",
            gate
        );

        // 2) BALANCE-MOVING SWAP: the treasury host authorizes FallbackAMM.swap(usdc, 10_000, 1, to=treasury).
        //    mock_auths SCOPED to the treasury's swap satisfies `to.require_auth()` inside the AMM (the
        //    swap's `to`/`from` IS the treasury). The AMM's swap pulls asset_in via
        //    `usdc.transfer(treasury -> amm, 10_000)` whose `from` is the treasury — that nested transfer
        //    is the sub-invoke the treasury must also authorize. (The asset_out transfer amm -> treasury
        //    is authorized by the AMM itself, not the treasury.) USDC leaves, XLM arrives.
        let usdc_transfer_sub = MockAuthInvoke {
            contract: &s.usdc,
            fn_name: "transfer",
            args: (s.treasury.clone(), s.amm.clone(), 10_000i128).into_val(&s.env),
            sub_invokes: &[],
        };
        let out = swap_venue::SwapVenueClient::new(&s.env, &s.amm)
            .mock_auths(&[MockAuth {
                address: &s.treasury,
                invoke: &MockAuthInvoke {
                    contract: &s.amm,
                    fn_name: "swap",
                    args: (s.usdc.clone(), 10_000i128, 1i128, s.treasury.clone()).into_val(&s.env),
                    sub_invokes: &[usdc_transfer_sub],
                },
            }])
            .swap(&s.usdc, &10_000i128, &1i128, &s.treasury);

        // 3) mark_executed (single-shot replay guard). GovVault executor auth mocked for THIS call only.
        s.env.mock_all_auths_allowing_non_root_auth();
        GovVaultClient::new(&s.env, &s.gov).mark_executed(&s.id);

        // ASSERT real on-chain balance movement THROUGH the policy-gated treasury wallet.
        let treasury_usdc_after = usdc.balance(&s.treasury);
        let treasury_xlm_after = xlm.balance(&s.treasury);
        assert!(
            treasury_usdc_after < treasury_usdc_before,
            "USDC must LEAVE the treasury (before {} -> after {})",
            treasury_usdc_before, treasury_usdc_after
        );
        assert!(
            treasury_xlm_after > treasury_xlm_before,
            "XLM must ARRIVE in the treasury (before {} -> after {})",
            treasury_xlm_before, treasury_xlm_after
        );
        // exact deltas: all 10_000 USDC spent; XLM out == constant-product result == swap return value.
        assert_eq!(treasury_usdc_after, 0i128, "all 10_000 USDC spent");
        assert_eq!(treasury_xlm_after, out, "treasury XLM == the swap's reported out");
        assert!(out > 0, "swap must return a positive out (got {})", out);

        // the proposal is now Executed (single-shot replay guard fired).
        assert_eq!(
            GovVaultClient::new(&s.env, &s.gov).proposal(&s.id).status,
            shadowkit_shared::ProposalStatus::Executed,
            "proposal must be Executed after the hero loop"
        );
    }

    /// Task M2-7 — NEGATIVE: the SAME on-chain wiring but WITHOUT quorum/approval. The swap is driven
    /// through the treasury host's __check_auth (so enforce runs FOR REAL with a REAL session signature)
    /// and is REJECTED with the EXACT PolicyError::NotApproved via the host Err surface (NOT
    /// catch_unwind). Then assert the treasury balances DID NOT move (the swap was never authorized).
    #[test]
    fn execute_without_quorum_is_blocked() {
        // proposal CREATED but NOT closed/approved (no quorum) -> is_approved == false.
        let s = gates::setup_full_open_with_assets(10_000i128);
        token::StellarAssetClient::new(&s.env, &s.usdc).mint(&s.treasury, &10_000i128);
        let usdc = token::Client::new(&s.env, &s.usdc);
        let xlm = token::Client::new(&s.env, &s.xlm);
        let usdc_before = usdc.balance(&s.treasury);
        let xlm_before = xlm.balance(&s.treasury);
        assert_eq!(usdc_before, 10_000i128);

        // The gate is exercised FOR REAL: host __check_auth -> enforce -> NotApproved (NO catch_unwind).
        let swap_ctx = gates::swap_ctx(&s.env, &s.amm, &s.usdc, 10_000, 1, &s.treasury);
        let auth_contexts: Vec<Context> = soroban_sdk::vec![&s.env, swap_ctx];
        let signature_payload = BytesN::from_array(&s.env, &[3u8; 32]);
        let signed = sign_auth_payload(
            &s.env, &s.verifier, &s.sk, &s.pubkey, &signature_payload, s.rule_id, false,
        );
        s.env.mock_all_auths_allowing_non_root_auth();
        let res = check_auth(&s.env, &s.treasury, &signature_payload, &signed, &auth_contexts);
        // The host surfaces the policy's NotApproved as a contract error => enforce ran and rejected.
        let expected = soroban_sdk::Error::from_contract_error(PolicyError::NotApproved as u32);
        assert_eq!(
            res,
            Err(Ok(expected)),
            "swap must be blocked (NotApproved) when the proposal has no quorum (got {:?})",
            res
        );

        // and NO funds moved (the swap was never authorized).
        assert_eq!(
            usdc.balance(&s.treasury),
            usdc_before,
            "no USDC may leave the treasury when the proposal is not approved"
        );
        assert_eq!(
            xlm.balance(&s.treasury),
            xlm_before,
            "no XLM may arrive when the proposal is not approved"
        );
    }
}
