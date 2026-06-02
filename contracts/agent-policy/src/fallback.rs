#![cfg(feature = "handrolled")]
// fallback.rs — the hand-rolled `__check_auth` treasury account (feature = "handrolled"): the tested
// FALLBACK to the OZ policy. A self-contained custom account with NO `stellar-accounts` dependency
// that (1) verifies a REAL ed25519 session-key signature over the auth digest via the host primitive
// env.crypto().ed25519_verify, (2) enforces the MultiCall single-Context::Contract check, then
// (3) delegates to the SHARED policy::check_swap_gates — the SAME gate engine the OZ `enforce` uses
// (true DRY, ONE gate impl). This is ALSO the live-cross-read treasury host of record (§13.4 verdict:
// a DIRECT GovVault cross-read in __check_auth is permitted during auth).
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl, contracttype,
    crypto::Hash,
    panic_with_error, Address, Bytes, BytesN, Env, Vec,
};

use crate::{policy, PolicyError};

#[contracttype]
#[derive(Clone)]
pub enum HrKey {
    Session,
    GovVault,
    Amm,
    Asset,
    ProposalId,
}

#[contract]
pub struct HandRolledAgentAccount;

#[contractimpl]
impl HandRolledAgentAccount {
    /// §foundation §2.3 init signature: store the owner session pubkey + gov_vault + approved_amm +
    /// treasury_asset + the approved proposal id into instance storage.
    pub fn init(
        env: Env,
        session_pubkey: BytesN<32>,
        gov_vault: Address,
        approved_amm: Address,
        treasury_asset: Address,
        proposal_id: u32,
    ) {
        let st = env.storage().instance();
        st.set(&HrKey::Session, &session_pubkey);
        st.set(&HrKey::GovVault, &gov_vault);
        st.set(&HrKey::Amm, &approved_amm);
        st.set(&HrKey::Asset, &treasury_asset);
        st.set(&HrKey::ProposalId, &proposal_id);
    }
}

#[contractimpl]
impl CustomAccountInterface for HandRolledAgentAccount {
    type Signature = BytesN<64>; // ed25519 session-key signature (§foundation §2.3)
    type Error = soroban_sdk::Error;

    /// Verifies the session-key sig over signature_payload (REAL ed25519 host fn), enforces MultiCall
    /// (exactly ONE Context::Contract in the batch), then applies the SHARED gate engine
    /// `policy::check_swap_gates` (identical to the OZ path: (g) fn==swap · (c) target==amm · arity-4 ·
    /// (d) asset_in==treasury AND asset_in==action.asset_in · (f) asset_out!=asset_in ·
    /// (a) is_approved · (b) !Executed · (e) amount<=cap, with the LIVE GovVault cross-read).
    /// SOURCE: env.crypto().ed25519_verify(public_key:&BytesN<32>, message:&Bytes, signature:&BytesN<64>)
    /// — panics on bad sig (rs-soroban-sdk soroban-sdk/src/crypto.rs, verified 2026-06-02).
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), soroban_sdk::Error> {
        let st = env.storage().instance();
        let pk: BytesN<32> = st.get(&HrKey::Session).unwrap();
        let msg: Bytes = Bytes::from_array(&env, &signature_payload.to_array());
        // REAL ed25519 verify of the session-key signature over the auth digest; panics on bad sig
        // (the host surfaces the panic via the try_invoke_contract_check_auth Err surface — NOT a mock).
        env.crypto().ed25519_verify(&pk, &msg, &signature);

        // MultiCall: exactly ONE contract context permitted in the batch.
        let mut contract_ctx_count = 0u32;
        for c in auth_contexts.iter() {
            if let Context::Contract(_) = c {
                contract_ctx_count += 1;
            }
        }
        if contract_ctx_count != 1 {
            panic_with_error!(&env, PolicyError::MultiCall);
        }

        let gov: Address = st.get(&HrKey::GovVault).unwrap();
        let amm: Address = st.get(&HrKey::Amm).unwrap();
        let asset: Address = st.get(&HrKey::Asset).unwrap();
        let pid: u32 = st.get(&HrKey::ProposalId).unwrap();

        let cc = match auth_contexts.get(0).unwrap() {
            Context::Contract(cc) => cc,
            _ => panic_with_error!(&env, PolicyError::WrongTarget),
        };
        // THE SAME GATE ENGINE as the OZ path (DRY): includes (d') action.asset_in,
        // (f) action.asset_out, MalformedArgs arity check, live GovVault cross-read.
        if let Err(err) = policy::check_swap_gates(&env, &cc, &gov, &amm, &asset, pid) {
            panic_with_error!(&env, err);
        }
        Ok(())
    }
}
