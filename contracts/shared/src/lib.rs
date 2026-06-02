#![no_std]
// shadowkit-shared: cross-contract types (foundation §2.6). Real types land in M1+.
// M0 stub: a single marker so the no-std lib compiles and is wired into the workspace.
use soroban_sdk::contracttype;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum SwapKind {
    Swap,
}
