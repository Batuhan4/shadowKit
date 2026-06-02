#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{Fr, G1Affine, G2Affine},
    vec, Env, Vec,
};

mod vk;
mod vk_min;
mod test;

// BINDING re-export (foundation §2.1): downstream crates refer to `groth16_verifier::Bls12381Fr`.
// The reference verifier imports `Fr` directly and adds no re-export; we add this line so the path
// resolves. SAME type as soroban_sdk::crypto::bls12_381::Fr.
pub use soroban_sdk::crypto::bls12_381::Fr as Bls12381Fr;

#[contracttype]
#[derive(Clone)]
pub struct VerificationKey {
    pub alpha: G1Affine,      // vk.alpha_1
    pub beta:  G2Affine,      // vk.beta_2
    pub gamma: G2Affine,      // vk.gamma_2
    pub delta: G2Affine,      // vk.delta_2
    pub ic:    Vec<G1Affine>, // vk.IC — length = (#public signals) + 1
}

#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: G1Affine, // pi_a (G1)
    pub b: G2Affine, // pi_b (G2)
    pub c: G1Affine, // pi_c (G1)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Groth16Error {
    // BINDING discriminant 0 — matches the reference verifier exactly (foundation §2.1).
    MalformedVerifyingKey = 0,
}

#[contract]
pub struct Groth16Verifier;

#[contractimpl]
impl Groth16Verifier {
    /// e(-A,B)·e(alpha,beta)·e(vk_x,gamma)·e(C,delta) == 1, vk_x = ic[0] + Σ pub[i]·ic[i+1].
    /// SOURCE: stellar/soroban-examples groth16_verifier/src/lib.rs (verified 2026-06-02).
    pub fn verify_proof(
        env: Env,
        vk: VerificationKey,
        proof: Proof,
        pub_signals: Vec<Fr>,
    ) -> Result<bool, Groth16Error> {
        let bls = env.crypto().bls12_381();
        if pub_signals.len() + 1 != vk.ic.len() {
            return Err(Groth16Error::MalformedVerifyingKey);
        }
        let mut vk_x = vk.ic.get(0).unwrap();
        for (s, v) in pub_signals.iter().zip(vk.ic.iter().skip(1)) {
            let prod = bls.g1_mul(&v, &s);
            vk_x = bls.g1_add(&vk_x, &prod);
        }
        let neg_a = -proof.a;
        let vp1 = vec![&env, neg_a, vk.alpha, vk_x, proof.c];
        let vp2 = vec![&env, proof.b, vk.beta, vk.gamma, vk.delta];
        Ok(bls.pairing_check(vp1, vp2))
    }

    /// Convenience entrypoint used by GovVault: loads the EMBEDDED VK and verifies.
    /// pub_signals order BINDING: [merkleRoot, nullifier, proposalId, sealedCommitmentHash] (§4).
    /// Returns false on malformed VK (never panics) so callers can map to GovError::InvalidProof.
    pub fn verify(env: Env, proof: Proof, pub_signals: Vec<Fr>) -> bool {
        let vk = vk::embedded_vk(&env);
        Self::verify_proof(env, vk, proof, pub_signals).unwrap_or(false)
    }

    /// Degraded (fallback-2) verify: loads the EMBEDDED min VK (vk_min.rs) for the 3-public-signal
    /// vote_min circuit. pub_signals order BINDING: [merkleRoot, nullifier, proposalId].
    /// Returns false on malformed VK (never panics). (A 3-signal VK has 4 IC points.)
    pub fn verify_min(env: Env, proof: Proof, pub_signals: Vec<Fr>) -> bool {
        let vk = vk_min::embedded_vk_min(&env);
        Self::verify_proof(env, vk, proof, pub_signals).unwrap_or(false)
    }
}
