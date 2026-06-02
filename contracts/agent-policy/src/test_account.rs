#![cfg(test)]
// Minimal OZ-hosted smart-account + ed25519 verifier for the §13.4 cross-read-in-enforce-during-auth
// probe (Task M2-V1c). The full integration host (MultiCall override, funding) is M2-3.
// SOURCE: stellar-contracts @ v0.8.0-rc.1 (c5632d9)
//   examples/multisig-smart-account/account/src/contract.rs
//   examples/multisig-smart-account/ed25519-verifier/src/contract.rs
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    Address, Bytes, BytesN, Env, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{
    self, AuthPayload, ContextRule, ContextRuleType, ExecutionEntryPoint, Signer, SmartAccount,
};
use stellar_accounts::verifiers::{ed25519 as ed25519_verifier, Verifier};

/// Reusable ed25519 verifier contract (registers ed25519 External signers).
#[contract]
pub struct TestEd25519Verifier;
#[contractimpl]
impl Verifier for TestEd25519Verifier {
    type KeyData = BytesN<32>;
    type SigData = BytesN<64>;
    fn verify(e: &Env, signature_payload: Bytes, key_data: BytesN<32>, sig_data: BytesN<64>) -> bool {
        ed25519_verifier::verify(e, &signature_payload, &key_data, &sig_data)
    }
    fn canonicalize_key(e: &Env, key_data: BytesN<32>) -> Bytes {
        ed25519_verifier::canonicalize_key(e, &key_data)
    }
    fn batch_canonicalize_key(e: &Env, keys_data: Vec<BytesN<32>>) -> Vec<Bytes> {
        ed25519_verifier::batch_canonicalize_key(e, &keys_data)
    }
}

/// Minimal OZ-hosted smart account. The MultiCall override + funding come in M2-3.
#[contract]
pub struct TestSmartAccount;
#[contractimpl]
impl TestSmartAccount {
    pub fn __constructor(e: &Env, signers: Vec<Signer>, policies: Map<Address, Val>) {
        smart_account::add_context_rule(
            e,
            &ContextRuleType::Default,
            &String::from_str(e, "agent"),
            None,
            &signers,
            &policies,
        );
    }
}
#[contractimpl]
impl CustomAccountInterface for TestSmartAccount {
    // SOURCE: soroban-sdk 26.0.1 auth.rs:99 `type Error: Into<Error>`. We use the raw
    // `soroban_sdk::Error` so the override can surface BOTH SmartAccountError (via Into) AND our
    // PolicyError::MultiCall (via Error::from_contract_error). `from_contract_error(code: u32)`
    // SOURCE: soroban-env-common 26.1.3 error.rs:306 (re-exported as soroban_sdk::Error).
    type Error = soroban_sdk::Error;
    type Signature = AuthPayload;
    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        // MultiCall gate (M2-3): exactly ONE contract context permitted per auth batch.
        // do_check_auth validates each context independently and would otherwise accept >1 (verified
        // stellar-accounts v0.8.0-rc.1 storage.rs:do_check_auth — it iterates auth_contexts). The
        // override is the hook that counts the batch and maps a multi-call to PolicyError::MultiCall.
        let mut contract_ctxs = 0u32;
        for c in auth_contexts.iter() {
            if let Context::Contract(_) = c {
                contract_ctxs += 1;
            }
        }
        if contract_ctxs > 1 {
            // SmartAccountError has no MultiCall variant; surface our policy code as a host Error.
            return Err(soroban_sdk::Error::from_contract_error(
                crate::PolicyError::MultiCall as u32,
            ));
        }
        // Delegate to the OZ host: authenticates the ed25519 signature then runs each policy's
        // `enforce` (the §13.4 cross-read path). SmartAccountError converts into soroban_sdk::Error.
        smart_account::do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
            .map_err(|err| err.into())
    }
}
#[contractimpl(contracttrait)]
impl SmartAccount for TestSmartAccount {}
#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for TestSmartAccount {}
