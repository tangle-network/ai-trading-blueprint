//! Multicall3 helpers — canonical address resolution + per-chain env override.
//!
//! Multicall3 is deployed at the same canonical address on every major EVM
//! chain. The list below is the set we explicitly bake into the binary so a
//! greenfield deploy does not need any per-chain configuration. Operators
//! who run a fork with a non-standard deployment can override the address
//! per chain via the `MULTICALL3_<chain_id>` env var (decimal chain id, e.g.
//! `MULTICALL3_1=0x...` for mainnet).
//!
//! See [https://www.multicall3.com] for the upstream deployment list — the
//! address is deterministic via CREATE2 and matches across all listed chains.

use alloy::primitives::{Address, address};

/// Canonical Multicall3 address. Same on every major EVM chain (CREATE2).
pub const CANONICAL_MULTICALL3: Address = address!("cA11bde05977b3631167028862bE2a173976CA11");

/// Set of chain ids where the canonical Multicall3 deployment is known to be
/// live. Tracked so [`multicall3_address`] can refuse to silently default on
/// chains the team has not explicitly verified — operators can still opt in
/// via the `MULTICALL3_<chain_id>` env var when they verify a new chain.
///
/// Sourced from the upstream Multicall3 deployment registry. Includes all
/// major mainnets, L2s, and the popular testnets the dApp ships with.
pub const SUPPORTED_CHAIN_IDS: &[u64] = &[
    1,        // Ethereum mainnet
    10,       // Optimism
    56,       // BNB Smart Chain
    100,      // Gnosis
    137,      // Polygon
    250,      // Fantom
    324,      // zkSync Era
    420,      // Optimism Goerli (legacy)
    1101,     // Polygon zkEVM
    1284,     // Moonbeam
    5000,     // Mantle
    8453,     // Base
    42_161,   // Arbitrum One
    42_220,   // Celo
    43_114,   // Avalanche C-Chain
    59_144,   // Linea
    81_457,   // Blast
    534_352,  // Scroll
    11_155_111, // Sepolia
    84_532,   // Base Sepolia
    421_614,  // Arbitrum Sepolia
    11_155_420, // Optimism Sepolia
    31_337,   // Anvil / Foundry default (local dev)
];

/// Resolve the Multicall3 address for `chain_id`.
///
/// Resolution order:
/// 1. `MULTICALL3_<chain_id>` env var (decimal chain id) if set + parseable.
/// 2. Canonical address when `chain_id` is in [`SUPPORTED_CHAIN_IDS`].
/// 3. `None` otherwise — caller is expected to fall back to the
///    pre-batching per-call RPC pattern.
pub fn multicall3_address(chain_id: u64) -> Option<Address> {
    let env_key = format!("MULTICALL3_{chain_id}");
    if let Ok(raw) = std::env::var(&env_key) {
        match raw.trim().parse::<Address>() {
            Ok(addr) => return Some(addr),
            Err(error) => {
                tracing::warn!(%env_key, %error, "ignoring invalid MULTICALL3 env override");
            }
        }
    }
    if SUPPORTED_CHAIN_IDS.contains(&chain_id) {
        return Some(CANONICAL_MULTICALL3);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_address_is_correct() {
        assert_eq!(
            format!("{CANONICAL_MULTICALL3:#x}"),
            "0xca11bde05977b3631167028862be2a173976ca11"
        );
    }

    #[test]
    fn supported_chains_resolve_to_canonical() {
        for chain_id in [1, 10, 137, 8453, 42_161, 31_337] {
            assert_eq!(multicall3_address(chain_id), Some(CANONICAL_MULTICALL3));
        }
    }

    #[test]
    fn unsupported_chain_returns_none_without_override() {
        // Pick a chain id we don't bake in and that's unlikely to be in env.
        let unusual = 999_999_999u64;
        // Make sure no override is present.
        unsafe {
            std::env::remove_var(format!("MULTICALL3_{unusual}"));
        }
        assert_eq!(multicall3_address(unusual), None);
    }

    #[test]
    fn env_override_takes_precedence() {
        let chain_id = 999_999_998u64;
        let override_addr = "0x1111111111111111111111111111111111111111";
        unsafe {
            std::env::set_var(format!("MULTICALL3_{chain_id}"), override_addr);
        }
        let resolved = multicall3_address(chain_id).expect("env override resolves");
        assert_eq!(format!("{resolved:#x}"), override_addr);
        unsafe {
            std::env::remove_var(format!("MULTICALL3_{chain_id}"));
        }
    }
}
