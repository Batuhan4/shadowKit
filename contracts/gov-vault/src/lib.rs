#![no_std]
// gov-vault stub (foundation §2). Real entrypoints land in the owning milestone.
use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct Placeholder;

#[contractimpl]
impl Placeholder {
    /// M0 stub: proves the crate compiles & registers; replaced in its milestone.
    pub fn ping(_env: Env) -> u32 {
        0
    }
}
