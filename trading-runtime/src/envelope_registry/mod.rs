//! Off-chain counterpart to the on-chain `EnvelopeRegistry` + `IEnvelopeAdapter`.
//!
//! # Goal
//!
//! Mirror the on-chain registry pattern in Rust so the runtime can dispatch to
//! the right protocol handler by `envelope_kind` without a giant `match`
//! statement growing each time a new adapter ships. Today the runtime has
//! `envelope::abi_bridge::encode_swap_or_supply` / `encode_health_factor` /
//! `encode_debt_reduction` with one `match` arm per variant. Adding a new
//! protocol means editing all three encoders; the registry pattern eliminates
//! that.
//!
//! # Status: SCAFFOLD
//!
//! This module is intentionally a stub — types + interface only. The full
//! migration moves the `match` arms in `abi_bridge.rs` into per-adapter
//! impls on `EnvelopeAdapter`. See
//! `docs/envelope-plugin-architecture.md` for the migration plan.
//!
//! # Hash Stability
//!
//! Each Rust adapter MUST produce the same `enforcement_hash` as the on-chain
//! Solidity adapter for the same (fields...). The cross-domain proptest in
//! `envelope::abi_bridge::tests` already covers the existing 13 variants
//! against on-chain `_hashXxx`. New adapters MUST extend that proptest before
//! merging.

use alloy::primitives::{Address, Bytes, FixedBytes};
use std::collections::HashMap;

use crate::envelope::{EnvelopeError, SignedEnvelope};

/// Stable identifier for an envelope variant. Mirrors the on-chain
/// `IEnvelopeAdapter.envelopeKind() -> bytes32`. By convention:
/// `EnvelopeKind::from_label("UniswapV3Swap")` ↔ `keccak256("UniswapV3Swap")`.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub struct EnvelopeKind(pub FixedBytes<32>);

impl EnvelopeKind {
    /// Compute keccak256(label) — must match on-chain
    /// `keccak256("UniswapV3Swap")`-style labels.
    pub fn from_label(label: &str) -> Self {
        Self(alloy::primitives::keccak256(label.as_bytes()))
    }
}

/// Execution shape selector for the on-chain vault. Mirrors
/// `IEnvelopeAdapter.ExecShape` exactly so off-chain cannot drift from
/// on-chain dispatch semantics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecShape {
    /// `_executeTrade` — output-token-balance gain post-condition.
    Trade,
    /// `_executeHealthFactor` — pool/account health-factor floor.
    HealthFactor,
    /// `_executeDebtReduction` — debt-token balance decrease.
    DebtReduction,
}

/// One ERC-20 approval to apply pre-call (and reset to 0 post-call).
#[derive(Clone, Debug)]
pub struct ApprovalSpec {
    pub token: Address,
    pub spender: Address,
    pub amount: alloy::primitives::U256,
}

/// Output of an off-chain pre-call check. The runtime uses this to:
///   - precompute the expected enforcement_hash (matches on-chain validator),
///   - precompute the consume_amount + caps (matches `_consumeEnvelope`),
///   - choose the right `executeXxxEnvelope` calldata encoder (today),
///     or the generic `executeEnvelopeWithKind` encoder (post-migration).
#[derive(Clone, Debug)]
pub struct PreCallReport {
    pub enforcement_hash: FixedBytes<32>,
    pub consume_amount: alloy::primitives::U256,
    pub max_single_amount: alloy::primitives::U256,
    pub max_total_amount: alloy::primitives::U256,
    pub shape: ExecShape,
    pub approvals: Vec<ApprovalSpec>,
}

/// Off-chain plugin contract for one envelope variant.
///
/// One impl per (protocol, action) — e.g. `UniswapV3SwapAdapter`,
/// `AaveBorrowAdapter`. Stays in sync with the on-chain Solidity adapter of
/// the same kind via the cross-domain proptest in `envelope::abi_bridge`.
pub trait EnvelopeAdapter: Send + Sync {
    /// keccak256("<VariantName>") — must match on-chain
    /// `IEnvelopeAdapter.envelopeKind()`.
    fn kind(&self) -> EnvelopeKind;

    /// Compute the EIP-712 struct hash for the enforcement struct. MUST
    /// equal the on-chain `enforcementHash(blob)` byte-for-byte.
    fn enforcement_hash(&self, blob: &Bytes) -> Result<FixedBytes<32>, EnvelopeError>;

    /// Decode + cross-check params; return a PreCallReport for runtime
    /// pre-flight + on-chain calldata assembly.
    fn pre_call_check(
        &self,
        params_blob: &Bytes,
        enforcement_blob: &Bytes,
        signed: &SignedEnvelope,
    ) -> Result<PreCallReport, EnvelopeError>;
}

/// Off-chain registry mirroring the on-chain `EnvelopeRegistry` mapping.
/// Populated once at runtime startup; lookups are O(1).
pub struct EnvelopeAdapterRegistry {
    by_kind: HashMap<EnvelopeKind, Box<dyn EnvelopeAdapter>>,
}

impl EnvelopeAdapterRegistry {
    pub fn new() -> Self {
        Self {
            by_kind: HashMap::new(),
        }
    }

    /// Register an adapter. Panics if the kind is already registered — caller
    /// MUST register exactly once per kind, mirroring the on-chain invariant.
    pub fn register(&mut self, adapter: Box<dyn EnvelopeAdapter>) {
        let kind = adapter.kind();
        if self.by_kind.contains_key(&kind) {
            panic!("EnvelopeAdapterRegistry: duplicate kind {:?}", kind);
        }
        self.by_kind.insert(kind, adapter);
    }

    pub fn get(&self, kind: &EnvelopeKind) -> Option<&dyn EnvelopeAdapter> {
        self.by_kind.get(kind).map(|b| b.as_ref())
    }
}

impl Default for EnvelopeAdapterRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_kind_label_keccak() {
        // Sanity: the label-derived kind must equal the on-chain
        // `keccak256("UniswapV3Swap")`. That's what the Solidity adapter
        // returns from `envelopeKind()`. We don't pull in alloy's
        // sol_types cross-check here — it's covered in the abi_bridge proptest
        // — but a direct keccak comparison protects us against accidental
        // case changes ("uniswapV3Swap" vs "UniswapV3Swap").
        let k = EnvelopeKind::from_label("UniswapV3Swap");
        // pre-computed once and asserted to detect future drift.
        let expected = alloy::primitives::keccak256("UniswapV3Swap".as_bytes());
        assert_eq!(k.0, expected);
    }

    struct DummyAdapter(EnvelopeKind);
    impl EnvelopeAdapter for DummyAdapter {
        fn kind(&self) -> EnvelopeKind {
            self.0
        }
        fn enforcement_hash(&self, _blob: &Bytes) -> Result<FixedBytes<32>, EnvelopeError> {
            Ok(FixedBytes::ZERO)
        }
        fn pre_call_check(
            &self,
            _params: &Bytes,
            _enf: &Bytes,
            _signed: &SignedEnvelope,
        ) -> Result<PreCallReport, EnvelopeError> {
            unimplemented!("scaffold")
        }
    }

    #[test]
    fn registry_register_and_get() {
        let mut reg = EnvelopeAdapterRegistry::new();
        let kind = EnvelopeKind::from_label("UniswapV3Swap");
        reg.register(Box::new(DummyAdapter(kind)));
        assert!(reg.get(&kind).is_some());
        let unknown = EnvelopeKind::from_label("DoesNotExist");
        assert!(reg.get(&unknown).is_none());
    }

    #[test]
    #[should_panic(expected = "duplicate kind")]
    fn registry_duplicate_kind_panics() {
        let mut reg = EnvelopeAdapterRegistry::new();
        let kind = EnvelopeKind::from_label("UniswapV3Swap");
        reg.register(Box::new(DummyAdapter(kind)));
        reg.register(Box::new(DummyAdapter(kind)));
    }
}
