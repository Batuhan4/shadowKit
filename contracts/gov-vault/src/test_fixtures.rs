#![cfg(test)]
extern crate std;
use std::{string::String, vec::Vec as StdVec};
use ark_bls12_381::{Fq, Fq2};
use ark_serialize::CanonicalSerialize;
use core::str::FromStr;
use serde::Deserialize;
use soroban_sdk::{crypto::bls12_381::{Fr, G1Affine, G2Affine, G1_SERIALIZED_SIZE, G2_SERIALIZED_SIZE}, Bytes, BytesN, Env, U256, Vec};
use groth16_verifier::Proof;

#[derive(Deserialize)]
struct ProofJson { pi_a: [String; 3], pi_b: [[String; 2]; 3], pi_c: [String; 3] }

pub const PROOF: &str = include_str!("../../../circuits/vote/fixtures/proof.json");
pub const PUBLIC: &str = include_str!("../../../circuits/vote/fixtures/public.json");

fn g1(e: &Env, x: &str, y: &str) -> G1Affine {
    let p = ark_bls12_381::G1Affine::new(Fq::from_str(x).unwrap(), Fq::from_str(y).unwrap());
    let mut b = [0u8; G1_SERIALIZED_SIZE];
    p.serialize_uncompressed(&mut b[..]).unwrap();
    G1Affine::from_array(e, &b)
}
fn g2(e: &Env, x1: &str, x2: &str, y1: &str, y2: &str) -> G2Affine {
    let x = Fq2::new(Fq::from_str(x1).unwrap(), Fq::from_str(x2).unwrap());
    let y = Fq2::new(Fq::from_str(y1).unwrap(), Fq::from_str(y2).unwrap());
    let p = ark_bls12_381::G2Affine::new(x, y);
    let mut b = [0u8; G2_SERIALIZED_SIZE];
    p.serialize_uncompressed(&mut b[..]).unwrap();
    G2Affine::from_array(e, &b)
}
pub fn be32(dec: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    for ch in dec.bytes() {
        let d = (ch - b'0') as u16;
        let mut c = d;
        for i in (0..32).rev() {
            let v = a[i] as u16 * 10 + c;
            a[i] = (v & 0xff) as u8;
            c = v >> 8;
        }
    }
    a
}
pub fn fr(e: &Env, dec: &str) -> Fr {
    Fr::from_u256(U256::from_be_bytes(e, &Bytes::from_array(e, &be32(dec))))
}

pub fn committed_proof(e: &Env) -> Proof {
    let p: ProofJson = serde_json::from_str(PROOF).unwrap();
    Proof {
        a: g1(e, &p.pi_a[0], &p.pi_a[1]),
        b: g2(e, &p.pi_b[0][0], &p.pi_b[0][1], &p.pi_b[1][0], &p.pi_b[1][1]),
        c: g1(e, &p.pi_c[0], &p.pi_c[1]),
    }
}

// public.json native order = [nullifier, merkleRoot, proposalId, sealedCommitmentHash] (Task 4.10).
// GovVault expects BINDING order [merkleRoot, nullifier, proposalId, sealedCommitmentHash] — the
// CLIENT re-maps before calling cast_vote. For contract tests we build the BINDING vector.
pub fn committed_public_signals(e: &Env) -> Vec<Fr> {
    let arr: StdVec<String> = serde_json::from_str(PUBLIC).unwrap();
    // arr[0]=nullifier, arr[1]=merkleRoot, arr[2]=proposalId, arr[3]=sealedCommitmentHash
    let mut v = Vec::new(e);
    v.push_back(fr(e, &arr[1])); // merkleRoot
    v.push_back(fr(e, &arr[0])); // nullifier
    v.push_back(fr(e, &arr[2])); // proposalId
    v.push_back(fr(e, &arr[3])); // sealedCommitmentHash
    v
}
pub fn merkle_root_be32(e: &Env) -> BytesN<32> {
    let arr: StdVec<String> = serde_json::from_str(PUBLIC).unwrap();
    BytesN::from_array(e, &be32(&arr[1]))
}
pub fn sealed_commit_be32(e: &Env) -> BytesN<32> {
    let arr: StdVec<String> = serde_json::from_str(PUBLIC).unwrap();
    BytesN::from_array(e, &be32(&arr[3]))
}

// ---- Task 4.35 FRESH bundle (generated via the FULL @shadowkit/zk-prover generateVoteProof path
//      for a DIFFERENT secret/root; proves the prover re-map and the contract re-map agree on-chain) ----
pub const FRESH_PROOF: &str = include_str!("../../../circuits/vote/fixtures-fresh/proof.json");
pub const FRESH_PUBLIC: &str = include_str!("../../../circuits/vote/fixtures-fresh/public.json");

pub fn fresh_proof(e: &Env) -> Proof {
    let p: ProofJson = serde_json::from_str(FRESH_PROOF).unwrap();
    Proof {
        a: g1(e, &p.pi_a[0], &p.pi_a[1]),
        b: g2(e, &p.pi_b[0][0], &p.pi_b[0][1], &p.pi_b[1][0], &p.pi_b[1][1]),
        c: g1(e, &p.pi_c[0], &p.pi_c[1]),
    }
}
// FRESH_PUBLIC native order [nullifier, merkleRoot, proposalId, sealedCommit] -> BINDING order
// EXACTLY as committed_public_signals does.
pub fn fresh_public_signals(e: &Env) -> Vec<Fr> {
    let arr: StdVec<String> = serde_json::from_str(FRESH_PUBLIC).unwrap();
    let mut v = Vec::new(e);
    v.push_back(fr(e, &arr[1])); // merkleRoot
    v.push_back(fr(e, &arr[0])); // nullifier
    v.push_back(fr(e, &arr[2])); // proposalId
    v.push_back(fr(e, &arr[3])); // sealedCommitmentHash
    v
}
pub fn fresh_merkle_root_be32(e: &Env) -> BytesN<32> {
    let arr: StdVec<String> = serde_json::from_str(FRESH_PUBLIC).unwrap();
    BytesN::from_array(e, &be32(&arr[1]))
}
pub fn fresh_sealed_commit_be32(e: &Env) -> BytesN<32> {
    let arr: StdVec<String> = serde_json::from_str(FRESH_PUBLIC).unwrap();
    BytesN::from_array(e, &be32(&arr[3]))
}
