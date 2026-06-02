#![cfg(test)]
extern crate std;
use std::{string::String, vec::Vec as StdVec};

use ark_bls12_381::{Fq, Fq2};
use ark_serialize::CanonicalSerialize;
use core::str::FromStr;
use soroban_sdk::{
    crypto::bls12_381::{Fr, G1Affine, G2Affine, G1_SERIALIZED_SIZE, G2_SERIALIZED_SIZE},
    Env, Vec, U256,
};
use serde::Deserialize;

use crate::{Groth16Verifier, Groth16VerifierClient, Proof, VerificationKey};

// ---- fixture JSON shapes (snarkjs verification_key.json / proof.json / public.json) ----
#[derive(Deserialize)]
struct VkJson {
    vk_alpha_1: [String; 3],
    vk_beta_2: [[String; 2]; 3],
    vk_gamma_2: [[String; 2]; 3],
    vk_delta_2: [[String; 2]; 3],
    #[serde(rename = "IC")]
    ic: StdVec<[String; 3]>,
}
#[derive(Deserialize)]
struct ProofJson {
    pi_a: [String; 3],
    pi_b: [[String; 2]; 3],
    pi_c: [String; 3],
}

fn g1(env: &Env, x: &str, y: &str) -> G1Affine {
    let p = ark_bls12_381::G1Affine::new(Fq::from_str(x).unwrap(), Fq::from_str(y).unwrap());
    let mut buf = [0u8; G1_SERIALIZED_SIZE];
    p.serialize_uncompressed(&mut buf[..]).unwrap();
    G1Affine::from_array(env, &buf)
}
fn g2(env: &Env, x1: &str, x2: &str, y1: &str, y2: &str) -> G2Affine {
    let x = Fq2::new(Fq::from_str(x1).unwrap(), Fq::from_str(x2).unwrap());
    let y = Fq2::new(Fq::from_str(y1).unwrap(), Fq::from_str(y2).unwrap());
    let p = ark_bls12_381::G2Affine::new(x, y);
    let mut buf = [0u8; G2_SERIALIZED_SIZE];
    p.serialize_uncompressed(&mut buf[..]).unwrap();
    G2Affine::from_array(env, &buf)
}
// snarkjs Fr decimal string -> soroban Fr via U256 from big-endian 32 bytes.
fn fr(env: &Env, dec: &str) -> Fr {
    let n = num_to_be32(dec);
    Fr::from_u256(U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &n)))
}
// decimal string -> 32-byte big-endian (tiny base-10 schoolbook into bytes; field-size safe).
fn num_to_be32(dec: &str) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for ch in dec.bytes() {
        let d = (ch - b'0') as u16;
        // acc = acc*10 + d  (big-endian, MSB at index 0)
        let mut carry = d;
        for i in (0..32).rev() {
            let v = acc[i] as u16 * 10 + carry;
            acc[i] = (v & 0xff) as u8;
            carry = v >> 8;
        }
    }
    acc
}

const VK: &str = include_str!("../../../circuits/vote/fixtures/verification_key.json");
const PROOF: &str = include_str!("../../../circuits/vote/fixtures/proof.json");
const PUBLIC: &str = include_str!("../../../circuits/vote/fixtures/public.json");

fn load_vk(env: &Env) -> VerificationKey {
    let v: VkJson = serde_json::from_str(VK).unwrap();
    let mut ic = Vec::new(env);
    for p in &v.ic {
        ic.push_back(g1(env, &p[0], &p[1]));
    }
    VerificationKey {
        alpha: g1(env, &v.vk_alpha_1[0], &v.vk_alpha_1[1]),
        beta: g2(env, &v.vk_beta_2[0][0], &v.vk_beta_2[0][1], &v.vk_beta_2[1][0], &v.vk_beta_2[1][1]),
        gamma: g2(env, &v.vk_gamma_2[0][0], &v.vk_gamma_2[0][1], &v.vk_gamma_2[1][0], &v.vk_gamma_2[1][1]),
        delta: g2(env, &v.vk_delta_2[0][0], &v.vk_delta_2[0][1], &v.vk_delta_2[1][0], &v.vk_delta_2[1][1]),
        ic,
    }
}
fn load_proof(env: &Env) -> Proof {
    let p: ProofJson = serde_json::from_str(PROOF).unwrap();
    Proof {
        a: g1(env, &p.pi_a[0], &p.pi_a[1]),
        b: g2(env, &p.pi_b[0][0], &p.pi_b[0][1], &p.pi_b[1][0], &p.pi_b[1][1]),
        c: g1(env, &p.pi_c[0], &p.pi_c[1]),
    }
}
fn load_public(env: &Env) -> Vec<Fr> {
    let arr: StdVec<String> = serde_json::from_str(PUBLIC).unwrap();
    let mut out = Vec::new(env);
    for s in &arr {
        out.push_back(fr(env, s));
    }
    out
}
fn client(e: &Env) -> Groth16VerifierClient<'_> {
    Groth16VerifierClient::new(e, &e.register(Groth16Verifier {}, ()))
}

#[test]
fn valid_proof_verifies_true() {
    let env = Env::default();
    let c = client(&env);
    assert_eq!(c.verify_proof(&load_vk(&env), &load_proof(&env), &load_public(&env)), true);
}

#[test]
fn embedded_vk_accepts_committed_proof() {
    let env = Env::default();
    let c = client(&env);
    // `verify` loads the EMBEDDED vk (vk.rs) — must accept the same committed proof.
    assert_eq!(c.verify(&load_proof(&env), &load_public(&env)), true);
}
