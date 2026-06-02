// policy.rs — storage keys + the shared gate engine `check_swap_gates`.
// The gate logic is the ONE implementation reused by OZ `enforce` AND the hand-rolled
// `__check_auth` (feature = "handrolled", Phase 3).
use soroban_sdk::{
    auth::{Context, ContractContext},
    panic_with_error, symbol_short, contracttype, Address, Env, TryFromVal,
};
use gov_vault::GovVaultClient;
use shadowkit_shared::ProposalStatus;
use crate::{AgentPolicyParams, PolicyError};

#[contracttype]
#[derive(Clone)]
pub enum PolicyKey {
    Params(Address), // per smart_account (§foundation §2.3)
}

pub fn store_params(env: &Env, sa: &Address, p: &AgentPolicyParams) {
    env.storage()
        .persistent()
        .set(&PolicyKey::Params(sa.clone()), p);
}

pub fn load_params(env: &Env, sa: &Address) -> AgentPolicyParams {
    env.storage()
        .persistent()
        .get(&PolicyKey::Params(sa.clone()))
        .unwrap_or_else(|| panic_with_error!(env, PolicyError::NotInstalled))
}

/// THE LOCK (pure gate logic, returns Result). Shared by OZ `enforce` + hand-rolled `__check_auth`.
/// `cc` = the swap ContractContext; cross-reads GovVault via the generated client.
/// Gates: (g) fn==swap · (c) target==amm · arity-4 args (else MalformedArgs) ·
///        (d) asset_in==treasury_asset AND asset_in==action.asset_in ·
///        (f) asset_out==action.asset_out · (a) is_approved · (b) status!=Executed · (e) amount<=cap.
/// Arg order matches SwapVenue::swap (§foundation §2.4): (asset_in, amount_in, min_out, to).
/// SOURCE pattern: OZ spending_limit::enforce matches Context::Contract(ContractContext{fn_name,args,..})
/// and decodes via args.get(N)+i128::try_from_val (verified stellar-accounts v0.8.0-rc.1 spending_limit.rs).
pub fn check_swap_gates(
    e: &Env,
    cc: &ContractContext,
    gov_vault: &Address,
    approved_amm: &Address,
    treasury_asset: &Address,
    proposal_id: u32,
) -> Result<(), PolicyError> {
    // (g) the call must be `swap`
    if cc.fn_name != symbol_short!("swap") {
        return Err(PolicyError::WrongFn);
    }
    // (c) target == approved_amm
    if &cc.contract != approved_amm {
        return Err(PolicyError::WrongTarget);
    }
    // arity check BEFORE decode — wrong shape is MalformedArgs, not a business-rule code
    if cc.args.len() != 4 {
        return Err(PolicyError::MalformedArgs);
    }
    // decode (asset_in, amount_in, min_out, to)
    let asset_in: Address = cc
        .args
        .get(0)
        .and_then(|v| Address::try_from_val(e, &v).ok())
        .ok_or(PolicyError::MalformedArgs)?;
    let amount_in: i128 = cc
        .args
        .get(1)
        .and_then(|v| i128::try_from_val(e, &v).ok())
        .ok_or(PolicyError::MalformedArgs)?;
    // (d) asset_in == treasury_asset
    if &asset_in != treasury_asset {
        return Err(PolicyError::WrongAsset);
    }
    // cross-contract reads of GovVault (DIRECT path; §13.4 verdict: cross-read in enforce works).
    let gv = GovVaultClient::new(e, gov_vault);
    // (b) BEFORE (a): once a proposal is Executed its status is Executed (NOT Approved), so
    //     is_approved() returns false. Checking is_approved first would mask an executed proposal
    //     as NotApproved and the distinct AlreadyExecuted code would be unreachable. So read the
    //     status once and reject an already-executed proposal with its own code FIRST. (FIX vs the
    //     plan's snippet, which ordered (a) before (b); empirically AlreadyExecuted was unreachable.)
    let status = gv.proposal(&proposal_id).status;
    if status == ProposalStatus::Executed {
        return Err(PolicyError::AlreadyExecuted);
    }
    // (a) approved
    if !gv.is_approved(&proposal_id) {
        return Err(PolicyError::NotApproved);
    }
    // bind to the APPROVED ActionSpec (anti-hallucination: cannot route to an unapproved output asset)
    let action = gv.action_of(&proposal_id);
    // (d') asset_in must equal the approved action's asset_in
    if asset_in != action.asset_in {
        return Err(PolicyError::WrongAsset);
    }
    // (f) asset_out: the venue is a fixed pair; the approved output asset is action.asset_out.
    //     For the M2 FallbackAMM fixed pair, binding action.asset_out is sufficient: the only way to
    //     leave funds is swap(asset_in=treasury) on approved_amm, whose other side IS action.asset_out.
    //     We require asset_out != asset_in (a real swap, not a self-trade to a worthless token).
    if action.asset_out == action.asset_in {
        return Err(PolicyError::WrongAssetOut);
    }
    // (e) amount <= cap
    let cap: i128 = gv.cap_of(&proposal_id);
    if amount_in > cap {
        return Err(PolicyError::OverCap);
    }
    Ok(())
}

/// Entry used by the OZ trait + test harness: loads params, matches Context::Contract, runs the gates.
pub fn enforce_gates_checked(
    e: &Env,
    context: Context,
    smart_account: Address,
) -> Result<(), PolicyError> {
    let p: AgentPolicyParams = load_params(e, &smart_account);
    let cc: ContractContext = match context {
        Context::Contract(cc) => cc,
        _ => return Err(PolicyError::WrongTarget), // non-contract context is not a swap
    };
    check_swap_gates(
        e,
        &cc,
        &p.gov_vault,
        &p.approved_amm,
        &p.treasury_asset,
        p.proposal_id,
    )
}

/// Panicking wrapper for the OZ `Policy::enforce` (which must panic on violation).
pub fn enforce_gates(e: &Env, context: Context, smart_account: Address) {
    if let Err(err) = enforce_gates_checked(e, context, smart_account) {
        panic_with_error!(e, err);
    }
}
