// PLACEHOLDER — replaced in Task 4.15 by `cargo run -p groth16-verifier --bin embed_vk --features host-tools`
// (byte arrays generated from circuits/vote/fixtures/verification_key.json). Returns an all-zero VK so the
// crate compiles; the embedded-VK test (4.15) drives the real values.
use soroban_sdk::{vec, Env, Vec};
use soroban_sdk::crypto::bls12_381::{G1Affine, G2Affine};
use crate::VerificationKey;

pub fn embedded_vk(env: &Env) -> VerificationKey {
    let z1 = G1Affine::from_array(env, &[0u8; 96]);
    let z2 = G2Affine::from_array(env, &[0u8; 192]);
    VerificationKey {
        alpha: z1.clone(),
        beta: z2.clone(),
        gamma: z2.clone(),
        delta: z2,
        ic: vec![env, z1.clone(), z1],
    }
}
