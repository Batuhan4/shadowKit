// contracts/gov-vault/src/reveal.rs
use soroban_sdk::{panic_with_error, Env, Vec};
use shadowkit_shared::{SealedVote, VoteDecryption};
use crate::GovError;

/// Re-aggregate submitted decryptions against stored sealed votes (foundation §2.2).
/// Returns (yes_weight, no_weight).
///
/// Four integrity guards, each introduced red-before-green in C5a..C5d:
///  C5a length match, C5b per-vote commitment binding, C5c direction-bit, C5d claimed-aggregate match.
pub fn reaggregate(
    env: &Env,
    sealed: &Vec<SealedVote>,
    decryptions: &Vec<VoteDecryption>,
    revealed_yes_w: i128,
    revealed_no_w: i128,
) -> (i128, i128) {
    // C5a: (1) length match — one decryption per stored sealed vote (foundation §2.2).
    let _ = (revealed_yes_w, revealed_no_w); // consumed by the aggregate guard in C5d
    if decryptions.len() != sealed.len() {
        panic_with_error!(env, GovError::RevealMismatch);
    }
    let mut yes: i128 = 0;
    let mut no: i128 = 0;
    for i in 0..sealed.len() {
        let s = sealed.get(i).unwrap();
        let d = decryptions.get(i).unwrap();
        // C5b: (2) bind each decryption to its EXACT stored ciphertext — no substitution.
        if d.sealed_commitment_hash != s.sealed_commitment_hash {
            panic_with_error!(env, GovError::RevealMismatch);
        }
        // C3: no direction-bit guard yet (added C5c). direction==1 -> yes, anything else -> no.
        if d.direction == 1 {
            yes += d.weight;
        } else {
            no += d.weight;
        }
    }
    (yes, no)
}
