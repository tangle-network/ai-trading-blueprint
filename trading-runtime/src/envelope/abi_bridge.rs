//! Bridge between off-chain Rust envelope types and on-chain Solidity ABI types.
//!
//! Each `to_*_call` constructs the exact ABI-encoded calldata for a TradingVault
//! `executeXxxEnvelope` function. The shared envelope→Solidity converter
//! `to_sol_envelope` reuses the off-chain Rust hashing — there's no second
//! source of truth.

use alloy::primitives::{Address, Bytes, FixedBytes, U256, keccak256};
use alloy::sol_types::SolCall;

use crate::contracts::ITradingVault;
use crate::envelope::{
    AaveBorrowEnforcement, AaveRepayEnforcement, AaveSupplyEnforcement, AaveWithdrawEnforcement,
    AerodromeSwapEnforcement, EnvelopeEnforcement, EnvelopeError, MorphoBorrowEnforcement,
    MorphoRepayEnforcement, MorphoSupplyEnforcement, MorphoWithdrawEnforcement, SignedEnvelope,
    UniswapV3SwapEnforcement, UniswapV4SwapEnforcement,
};

/// Convert a SignedEnvelope into the Solidity `Envelope` struct expected on-chain.
/// `policyHash` and `enforcementHash` are computed from the off-chain authoritative
/// types so the on-chain hash equals the digest the validators signed.
pub fn to_sol_envelope(signed: &SignedEnvelope) -> Result<ITradingVault::Envelope, EnvelopeError> {
    let vault: Address = signed
        .vault_address
        .parse()
        .map_err(
            |e: alloy::hex::FromHexError| EnvelopeError::InvalidAddress {
                addr: signed.vault_address.clone(),
                reason: e.to_string(),
            },
        )?;
    let bot_id_hash = keccak256(signed.bot_id.as_bytes());
    let protocol_hash = keccak256(signed.protocol.to_ascii_lowercase().as_bytes());
    let policy_hash = signed.policy.struct_hash()?;
    let enforcement_hash = match &signed.enforcement {
        Some(e) => e.struct_hash()?,
        None => FixedBytes::ZERO,
    };
    let signers_hash = sorted_addresses_hash(&signed.approval_signers)?;
    Ok(ITradingVault::Envelope {
        version: signed.version,
        botIdHash: bot_id_hash,
        vault,
        chainId: signed.chain_id,
        protocolHash: protocol_hash,
        policyHash: policy_hash,
        enforcementHash: enforcement_hash,
        issuedAt: signed.issued_at,
        expiresAt: signed.expires_at,
        nonce: signed.nonce,
        signersHash: signers_hash,
        minSignatures: signed.min_signatures as u64,
    })
}

/// Sorted-address hash matching `_hashApprovalSigners` in TradeValidator.sol.
fn sorted_addresses_hash(values: &[String]) -> Result<FixedBytes<32>, EnvelopeError> {
    let mut addrs: Vec<Address> = values
        .iter()
        .map(|v| {
            v.parse::<Address>().map_err(|e: alloy::hex::FromHexError| {
                EnvelopeError::InvalidAddress {
                    addr: v.clone(),
                    reason: e.to_string(),
                }
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    addrs.sort();
    let mut packed = Vec::with_capacity(addrs.len() * 20);
    for a in addrs {
        packed.extend_from_slice(a.as_slice());
    }
    Ok(keccak256(packed))
}

/// Sort approval signers (case-insensitive ascending) and return as Address slice
/// for ABI calls. Vault expects the same ordering used by `_hashApprovalSigners`.
pub fn sorted_signer_addresses(values: &[String]) -> Result<Vec<Address>, EnvelopeError> {
    let mut addrs: Vec<Address> = values
        .iter()
        .map(|v| {
            v.parse::<Address>().map_err(|e: alloy::hex::FromHexError| {
                EnvelopeError::InvalidAddress {
                    addr: v.clone(),
                    reason: e.to_string(),
                }
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    addrs.sort();
    Ok(addrs)
}

/// Decompose `signed.signatures` into the `(bytes[], uint256[])` shape every
/// `executeXxxEnvelope` expects.
pub fn signatures_and_scores(
    signed: &SignedEnvelope,
) -> Result<(Vec<Bytes>, Vec<U256>), EnvelopeError> {
    let mut sigs = Vec::with_capacity(signed.signatures.len());
    let mut scores = Vec::with_capacity(signed.signatures.len());
    for s in &signed.signatures {
        let raw = s.signature.strip_prefix("0x").unwrap_or(&s.signature);
        let bytes = hex::decode(raw).map_err(|e| EnvelopeError::InvalidSignatureHex {
            reason: e.to_string(),
        })?;
        if bytes.len() != 65 {
            return Err(EnvelopeError::InvalidSignatureLength { got: bytes.len() });
        }
        sigs.push(Bytes::from(bytes));
        scores.push(U256::from(s.score));
    }
    Ok((sigs, scores))
}

// ── Per-protocol Rust → Solidity converters ──

impl UniswapV3SwapEnforcement {
    pub fn to_sol(&self) -> ITradingVault::UniswapV3SwapEnforcement {
        ITradingVault::UniswapV3SwapEnforcement {
            feeTier: U256::from(self.fee_tier),
            maxSingleAmountIn: self.max_single_amount_in,
            maxTotalAmountIn: self.max_total_amount_in,
            minOutputPerInput: self.min_output_per_input,
            router: self.router,
            tokenIn: self.token_in,
            tokenOut: self.token_out,
        }
    }
}

impl UniswapV4SwapEnforcement {
    pub fn to_sol(&self) -> ITradingVault::UniswapV4SwapEnforcement {
        let tick = alloy::primitives::I256::try_from(self.tick_spacing as i64).unwrap();
        ITradingVault::UniswapV4SwapEnforcement {
            currency0: self.currency0,
            currency1: self.currency1,
            fee: U256::from(self.fee),
            tickSpacing: tick,
            hooks: self.hooks,
            zeroForOne: self.zero_for_one,
            maxSingleAmountIn: self.max_single_amount_in,
            maxTotalAmountIn: self.max_total_amount_in,
            minOutputPerInput: self.min_output_per_input,
            universalRouter: self.universal_router,
        }
    }
}

impl AerodromeSwapEnforcement {
    pub fn to_sol(&self) -> ITradingVault::AerodromeSwapEnforcement {
        let tick = alloy::primitives::I256::try_from(self.tick_spacing as i64).unwrap();
        ITradingVault::AerodromeSwapEnforcement {
            maxSingleAmountIn: self.max_single_amount_in,
            maxTotalAmountIn: self.max_total_amount_in,
            minOutputPerInput: self.min_output_per_input,
            router: self.router,
            tickSpacing: tick,
            tokenIn: self.token_in,
            tokenOut: self.token_out,
        }
    }
}

impl AaveSupplyEnforcement {
    pub fn to_sol(&self) -> ITradingVault::AaveSupplyEnforcement {
        ITradingVault::AaveSupplyEnforcement {
            asset: self.asset,
            maxSingleAmount: self.max_single_amount,
            maxTotalAmount: self.max_total_amount,
            pool: self.pool,
        }
    }
}

impl AaveWithdrawEnforcement {
    pub fn to_sol(&self) -> ITradingVault::AaveWithdrawEnforcement {
        ITradingVault::AaveWithdrawEnforcement {
            asset: self.asset,
            maxSingleAmount: self.max_single_amount,
            maxTotalAmount: self.max_total_amount,
            minHealthFactor: self.min_health_factor,
            pool: self.pool,
        }
    }
}

impl AaveBorrowEnforcement {
    pub fn to_sol(&self) -> ITradingVault::AaveBorrowEnforcement {
        ITradingVault::AaveBorrowEnforcement {
            asset: self.asset,
            interestRateMode: U256::from(self.interest_rate_mode),
            maxSingleAmount: self.max_single_amount,
            maxTotalAmount: self.max_total_amount,
            minHealthFactor: self.min_health_factor,
            pool: self.pool,
        }
    }
}

impl AaveRepayEnforcement {
    pub fn to_sol(&self) -> ITradingVault::AaveRepayEnforcement {
        ITradingVault::AaveRepayEnforcement {
            asset: self.asset,
            debtToken: self.debt_token,
            interestRateMode: U256::from(self.interest_rate_mode),
            maxSingleAmount: self.max_single_amount,
            maxTotalAmount: self.max_total_amount,
            pool: self.pool,
        }
    }
}

impl MorphoSupplyEnforcement {
    pub fn to_sol(&self) -> ITradingVault::MorphoSupplyEnforcement {
        ITradingVault::MorphoSupplyEnforcement {
            maxSingleAmount: self.max_single_amount,
            maxTotalAmount: self.max_total_amount,
            marketId: self.market_id,
            morpho: self.morpho,
        }
    }
}

impl MorphoWithdrawEnforcement {
    pub fn to_sol(&self) -> ITradingVault::MorphoWithdrawEnforcement {
        ITradingVault::MorphoWithdrawEnforcement {
            maxSingleAmount: self.max_single_amount,
            maxTotalAmount: self.max_total_amount,
            marketId: self.market_id,
            minCollateralRatio: self.min_collateral_ratio,
            morpho: self.morpho,
        }
    }
}

impl MorphoBorrowEnforcement {
    pub fn to_sol(&self) -> ITradingVault::MorphoBorrowEnforcement {
        ITradingVault::MorphoBorrowEnforcement {
            maxSingleAmount: self.max_single_amount,
            maxTotalAmount: self.max_total_amount,
            marketId: self.market_id,
            minCollateralRatio: self.min_collateral_ratio,
            morpho: self.morpho,
        }
    }
}

impl MorphoRepayEnforcement {
    pub fn to_sol(&self) -> ITradingVault::MorphoRepayEnforcement {
        ITradingVault::MorphoRepayEnforcement {
            maxSingleAmount: self.max_single_amount,
            maxTotalAmount: self.max_total_amount,
            marketId: self.market_id,
            morpho: self.morpho,
        }
    }
}

/// Encode the right `executeXxxEnvelope` calldata based on the enforcement variant.
/// Returns the encoded bytes ready to wrap in an EncodedTransaction.
///
/// For each shape (trade / debt-reduction / health-factor) the params type differs;
/// callers pass the matching shape. We return the abi-encoded calldata only;
/// callers handle gas, value, etc.
pub enum EnvelopeExecCall {
    Trade(Vec<u8>),         // ExecuteParams shape
    DebtReduction(Vec<u8>), // DebtReductionParams shape
    HealthFactor(Vec<u8>),  // HealthFactorParams shape
}

pub fn encode_swap_or_supply(
    signed: &SignedEnvelope,
    params: ITradingVault::ExecuteParams,
) -> Result<EnvelopeExecCall, EnvelopeError> {
    let env = to_sol_envelope(signed)?;
    let signers = sorted_signer_addresses(&signed.approval_signers)?;
    let (sigs, scores) = signatures_and_scores(signed)?;
    let enforcement = signed.require_enforcement()?;
    let data = match enforcement {
        EnvelopeEnforcement::UniswapV3Swap(e) => ITradingVault::executeUniswapV3SwapEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        EnvelopeEnforcement::UniswapV4Swap(e) => ITradingVault::executeUniswapV4SwapEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        EnvelopeEnforcement::AerodromeSwap(e) => ITradingVault::executeAerodromeSwapEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        EnvelopeEnforcement::AaveSupply(e) => ITradingVault::executeAaveSupplyEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        EnvelopeEnforcement::MorphoSupply(e) => ITradingVault::executeMorphoSupplyEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        other => {
            return Err(EnvelopeError::UnsupportedEnforcementVariant {
                variant: format!("{other:?}"),
                protocol: "swap_or_supply".into(),
            });
        }
    };
    Ok(EnvelopeExecCall::Trade(data))
}

pub fn encode_health_factor(
    signed: &SignedEnvelope,
    params: ITradingVault::HealthFactorParams,
) -> Result<EnvelopeExecCall, EnvelopeError> {
    let env = to_sol_envelope(signed)?;
    let signers = sorted_signer_addresses(&signed.approval_signers)?;
    let (sigs, scores) = signatures_and_scores(signed)?;
    let enforcement = signed.require_enforcement()?;
    let data = match enforcement {
        EnvelopeEnforcement::AaveWithdraw(e) => ITradingVault::executeAaveWithdrawEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        EnvelopeEnforcement::AaveBorrow(e) => ITradingVault::executeAaveBorrowEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        EnvelopeEnforcement::MorphoWithdraw(e) => {
            ITradingVault::executeMorphoWithdrawEnvelopeCall {
                params,
                env,
                enf: e.to_sol(),
                approvalSigners: signers,
                signatures: sigs,
                scores,
            }
            .abi_encode()
        }
        EnvelopeEnforcement::MorphoBorrow(e) => ITradingVault::executeMorphoBorrowEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        other => {
            return Err(EnvelopeError::UnsupportedEnforcementVariant {
                variant: format!("{other:?}"),
                protocol: "health_factor".into(),
            });
        }
    };
    Ok(EnvelopeExecCall::HealthFactor(data))
}

pub fn encode_debt_reduction(
    signed: &SignedEnvelope,
    params: ITradingVault::DebtReductionParams,
) -> Result<EnvelopeExecCall, EnvelopeError> {
    let env = to_sol_envelope(signed)?;
    let signers = sorted_signer_addresses(&signed.approval_signers)?;
    let (sigs, scores) = signatures_and_scores(signed)?;
    let enforcement = signed.require_enforcement()?;
    let data = match enforcement {
        EnvelopeEnforcement::AaveRepay(e) => ITradingVault::executeAaveRepayEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        EnvelopeEnforcement::MorphoRepay(e) => ITradingVault::executeMorphoRepayEnvelopeCall {
            params,
            env,
            enf: e.to_sol(),
            approvalSigners: signers,
            signatures: sigs,
            scores,
        }
        .abi_encode(),
        other => {
            return Err(EnvelopeError::UnsupportedEnforcementVariant {
                variant: format!("{other:?}"),
                protocol: "debt_reduction".into(),
            });
        }
    };
    Ok(EnvelopeExecCall::DebtReduction(data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{TradingPolicy, VaultPolicy};
    use rust_decimal::Decimal;
    use std::str::FromStr;

    /// Reimplements the Solidity `_hashEnvelope` calculation in Rust by ABI-encoding
    /// the converted Solidity Envelope struct directly. If this matches the off-chain
    /// `SignedEnvelope::digest()`, off-chain signatures will verify on-chain.
    fn solidity_compatible_envelope_struct_hash(env: &ITradingVault::Envelope) -> FixedBytes<32> {
        use alloy::sol_types::SolValue;
        let envelope_typehash = keccak256(
            "Envelope(uint64 version,bytes32 botIdHash,address vault,uint64 chainId,bytes32 protocolHash,bytes32 policyHash,bytes32 enforcementHash,uint64 issuedAt,uint64 expiresAt,uint64 nonce,bytes32 signersHash,uint64 minSignatures)"
                .as_bytes(),
        );
        keccak256(SolValue::abi_encode(&(
            envelope_typehash,
            U256::from(env.version),
            env.botIdHash,
            env.vault,
            U256::from(env.chainId),
            env.protocolHash,
            env.policyHash,
            env.enforcementHash,
            U256::from(env.issuedAt),
            U256::from(env.expiresAt),
            U256::from(env.nonce),
            env.signersHash,
            U256::from(env.minSignatures),
        )))
    }

    fn solidity_compatible_envelope_digest(env: &ITradingVault::Envelope) -> FixedBytes<32> {
        use alloy::sol_types::SolValue;
        let domain_typehash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                .as_bytes(),
        );
        let domain_separator = keccak256(SolValue::abi_encode(&(
            domain_typehash,
            keccak256(b"TradingEnvelope"),
            keccak256(b"2"),
            U256::from(env.chainId),
            env.vault,
        )));
        let struct_hash = solidity_compatible_envelope_struct_hash(env);
        keccak256(
            [
                &[0x19u8, 0x01],
                domain_separator.as_slice(),
                struct_hash.as_slice(),
            ]
            .concat(),
        )
    }

    #[test]
    fn rust_digest_matches_solidity_compatible_digest() {
        // The off-chain `SignedEnvelope::digest()` MUST equal what the on-chain
        // `_envelopeDigest` produces, otherwise sigs won't verify on-chain.
        // Set verifying_contract to the vault so it matches the Solidity
        // domain (which uses address(this) i.e. the vault).
        let signed = SignedEnvelope {
            version: 2,
            bot_id: "bot-cross-domain".into(),
            vault_address: "0x0000000000000000000000000000000000000077".into(),
            chain_id: 31337,
            protocol: "uniswap_v3".into(),
            policy: TradingPolicy {
                max_trade_size_usd: Decimal::from(1000),
                max_total_exposure_usd: Decimal::from(3000),
                max_drawdown_pct: Decimal::from(10),
                can_open_positions: true,
                perps: None,
                vault: Some(VaultPolicy {
                    allowed_protocols: vec!["uniswap_v3".into()],
                    allowed_tokens_in: vec![],
                    allowed_tokens_out: vec![],
                    max_slippage_bps: 100,
                }),
                clob: None,
            },
            approval_signers: vec![
                "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266".into(),
                "0x70997970c51812dc3a010c7d01b50e0d17dc79c8".into(),
            ],
            min_signatures: 2,
            issued_at: 1_700_000_000,
            expires_at: 1_700_003_600,
            nonce: 1,
            verifying_contract: "0x0000000000000000000000000000000000000077".into(),
            enforcement: Some(EnvelopeEnforcement::UniswapV3Swap(
                UniswapV3SwapEnforcement {
                    router: Address::from_str("0xE592427A0AEce92De3Edee1F18E0157C05861564")
                        .unwrap(),
                    token_in: Address::from_str("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
                        .unwrap(),
                    token_out: Address::from_str("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
                        .unwrap(),
                    fee_tier: 3000,
                    max_single_amount_in: U256::from(1_000_000_000_000_000_000u128),
                    max_total_amount_in: U256::from(10_000_000_000_000_000_000u128),
                    min_output_per_input: U256::from(2_900_000_000u128),
                },
            )),
            signatures: vec![],
        };

        let rust_digest = signed.digest().unwrap();
        let sol_envelope = to_sol_envelope(&signed).unwrap();
        let solidity_digest = solidity_compatible_envelope_digest(&sol_envelope);

        assert_eq!(
            rust_digest, solidity_digest,
            "off-chain Rust digest must equal on-chain Solidity digest"
        );
    }

    #[test]
    fn to_sol_envelope_uses_off_chain_hashes() {
        let signed = SignedEnvelope {
            version: 2,
            bot_id: "bot-1".into(),
            vault_address: "0x0000000000000000000000000000000000000001".into(),
            chain_id: 31337,
            protocol: "uniswap_v3".into(),
            policy: TradingPolicy {
                max_trade_size_usd: Decimal::from(1000),
                max_total_exposure_usd: Decimal::from(3000),
                max_drawdown_pct: Decimal::from(10),
                can_open_positions: true,
                perps: None,
                vault: Some(VaultPolicy {
                    allowed_protocols: vec!["uniswap_v3".into()],
                    allowed_tokens_in: vec![],
                    allowed_tokens_out: vec![],
                    max_slippage_bps: 100,
                }),
                clob: None,
            },
            approval_signers: vec!["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266".into()],
            min_signatures: 1,
            issued_at: 1000,
            expires_at: 1_000_000_000_000,
            nonce: 1,
            verifying_contract: "0x5FbDB2315678afecb367f032d93F642f64180aa3".into(),
            enforcement: Some(EnvelopeEnforcement::UniswapV3Swap(
                UniswapV3SwapEnforcement {
                    router: Address::from_str("0xE592427A0AEce92De3Edee1F18E0157C05861564")
                        .unwrap(),
                    token_in: Address::from_str("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
                        .unwrap(),
                    token_out: Address::from_str("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
                        .unwrap(),
                    fee_tier: 3000,
                    max_single_amount_in: U256::from(1u128),
                    max_total_amount_in: U256::from(2u128),
                    min_output_per_input: U256::from(1u128),
                },
            )),
            signatures: vec![],
        };
        let env = to_sol_envelope(&signed).unwrap();
        assert_eq!(env.version, 2);
        assert_eq!(env.chainId, 31337);
        assert_ne!(env.policyHash, FixedBytes::ZERO);
        assert_ne!(env.enforcementHash, FixedBytes::ZERO);
    }
}
