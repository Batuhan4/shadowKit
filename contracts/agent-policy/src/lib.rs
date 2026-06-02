#![no_std]
// Compile-only probe (Task M2-V1a) that the OZ Policy trait + helper types resolve at the verified
// `stellar_accounts` ROOT-module path. SOURCE: stellar-accounts (git v0.8.0-rc.1, soroban-sdk 26.0.0)
// packages/accounts/src/{lib,policies/mod,smart_account/mod}.rs (verified 2026-06-02).
//
// DIVERGENCE FROM PLAN: the OZ crate is pinned via git (v0.8.0-rc.1), not crates.io "0.7.1",
// because the published 0.7.1 targets soroban-sdk 25.3.x and is incompatible with our 26.0.0
// workspace (two soroban-sdk majors in the tree). See the workspace Cargo.toml comment.
use soroban_sdk::auth::Context;
use stellar_accounts::policies::Policy;
use stellar_accounts::smart_account::{AuthPayload, ContextRule, ContextRuleType, Signer};

// A do-nothing fn that names every imported symbol so a typo in the path fails to compile.
// `Policy` is a trait with an associated type; we name it via a generic bound rather than `dyn`,
// so we do not require it to be object-safe.
#[allow(dead_code)]
fn _probe(
    _payload: Option<AuthPayload>,
    _rule: Option<ContextRule>,
    _rule_ty: Option<ContextRuleType>,
    _signer: Option<Signer>,
    _ctx: Option<Context>,
) {
    // Name the `Policy` trait so a path typo fails to compile.
    fn _names_policy<P: Policy>() {}
}
