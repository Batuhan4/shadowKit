// contracts/gov-vault/src/reveal.rs
use soroban_sdk::{Env, Vec};
use shadowkit_shared::{SealedVote, VoteDecryption};

/// Re-aggregate submitted decryptions against stored sealed votes (foundation §2.2).
/// Returns (yes_weight, no_weight).
///
/// C3 SCOPE (minimal): sum `weight` by `direction` only. The four integrity guards
/// (length, per-vote commitment binding, direction-bit, claimed-aggregate match) are added
/// one-per-cycle in C5a..C5d, each with its own failing test first. Unused params (`sealed`,
/// `revealed_*`) are wired now so the signature is stable across those cycles; `let _ = ...`
/// suppresses unused warnings until C5 consumes them. This is NOT a stub of behavior under test
/// — the guards do not yet exist, so their tests legitimately fail in C5.
pub fn reaggregate(
    _env: &Env,
    sealed: &Vec<SealedVote>,
    decryptions: &Vec<VoteDecryption>,
    revealed_yes_w: i128,
    revealed_no_w: i128,
) -> (i128, i128) {
    let _ = (sealed, revealed_yes_w, revealed_no_w); // consumed by guards added in C5a..C5d
    let mut yes: i128 = 0;
    let mut no: i128 = 0;
    for i in 0..decryptions.len() {
        let d = decryptions.get(i).unwrap();
        // C3: no direction-bit guard yet (added C5c). direction==1 -> yes, anything else -> no.
        if d.direction == 1 {
            yes += d.weight;
        } else {
            no += d.weight;
        }
    }
    (yes, no)
}
