use alloy::primitives::{Address, B256, Signature, U256, keccak256};
use alloy::signers::SignerSync;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolValue;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::contracts::{ITradeValidator, ITradingVault};
use crate::error::TradingError;

const DOMAIN_NAME: &str = "TradeValidator";
const DOMAIN_VERSION: &str = "1";
const UNISWAP_ENVELOPE_TYPE: &str = "UniswapEnvelope(bytes32 envelopeId,bytes32 botIdHash,address vault,uint256 chainId,address router,address tokenIn,address tokenOut,bytes32 action,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxSlippageBps,uint256 minOutputPerInput,uint256 validFrom,uint256 validUntil,uint256 nonce,bytes32 approvalSignersHash,uint256 minSignatures)";
const UNISWAP_ENVELOPE_APPROVAL_TYPE: &str =
    "UniswapEnvelopeApproval(bytes32 envelopeHash,uint256 score)";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniswapEnvelope {
    pub envelope_id: String,
    pub bot_id_hash: String,
    pub vault: String,
    pub chain_id: u64,
    pub router: String,
    pub token_in: String,
    pub token_out: String,
    #[serde(default = "default_action")]
    pub action: String,
    pub max_single_amount_in: String,
    pub max_total_amount_in: String,
    pub max_slippage_bps: u64,
    pub min_output_per_input: String,
    pub valid_from: u64,
    pub valid_until: u64,
    pub nonce: u64,
    pub approval_signers_hash: String,
    pub min_signatures: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniswapEnvelopeSignature {
    pub signer: String,
    pub score: u32,
    pub signature: String,
    pub chain_id: u64,
    pub verifying_contract: String,
    #[serde(default)]
    pub validated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedUniswapEnvelope {
    pub envelope: UniswapEnvelope,
    pub approval_signers: Vec<String>,
    #[serde(default)]
    pub signatures: Vec<UniswapEnvelopeSignature>,
}

#[derive(Debug, Clone)]
pub struct UniswapEnvelopeBinding<'a> {
    pub bot_id: &'a str,
    pub vault_address: &'a str,
    pub chain_id: u64,
}

impl SignedUniswapEnvelope {
    pub fn verify_binding(&self, binding: &UniswapEnvelopeBinding<'_>) -> Result<(), TradingError> {
        let expected_bot = keccak256(binding.bot_id.as_bytes());
        if parse_b256(&self.envelope.bot_id_hash, "bot_id_hash")? != expected_bot {
            return Err(TradingError::ValidatorError(
                "Uniswap envelope bot_id_hash does not match authenticated bot".into(),
            ));
        }
        if !addresses_equal(&self.envelope.vault, binding.vault_address)? {
            return Err(TradingError::ValidatorError(
                "Uniswap envelope vault does not match authenticated bot".into(),
            ));
        }
        if self.envelope.chain_id != binding.chain_id {
            return Err(TradingError::ValidatorError(
                "Uniswap envelope chain_id does not match authenticated bot".into(),
            ));
        }
        if !self.envelope.action.eq_ignore_ascii_case("swap") {
            return Err(TradingError::ValidatorError(
                "Uniswap envelope action must be swap".into(),
            ));
        }
        if self.envelope.valid_until < chrono::Utc::now().timestamp().max(0) as u64 {
            return Err(TradingError::ValidatorError(
                "Uniswap envelope is expired".into(),
            ));
        }
        if approval_signers_hash(&self.approval_signers)?
            != parse_b256(
                &self.envelope.approval_signers_hash,
                "approval_signers_hash",
            )?
        {
            return Err(TradingError::ValidatorError(
                "Uniswap envelope approval_signers_hash does not match approval_signers".into(),
            ));
        }
        Ok(())
    }

    pub fn signatures_and_scores(&self) -> Result<(Vec<Vec<u8>>, Vec<U256>), TradingError> {
        let mut signatures = Vec::with_capacity(self.signatures.len());
        let mut scores = Vec::with_capacity(self.signatures.len());
        for item in &self.signatures {
            let raw = item.signature.strip_prefix("0x").unwrap_or(&item.signature);
            let bytes = hex::decode(raw).map_err(|e| {
                TradingError::ValidatorError(format!("Invalid Uniswap envelope signature hex: {e}"))
            })?;
            if bytes.len() != 65 {
                return Err(TradingError::ValidatorError(format!(
                    "Uniswap envelope signature must be 65 bytes, got {}",
                    bytes.len()
                )));
            }
            signatures.push(bytes);
            scores.push(U256::from(item.score));
        }
        Ok((signatures, scores))
    }

    pub fn approval_signer_addresses(&self) -> Result<Vec<Address>, TradingError> {
        parse_addresses(&self.approval_signers, "Uniswap envelope approval signer")
    }

    pub fn verify_local_signatures(&self) -> Result<Vec<Address>, TradingError> {
        let mut seen = HashSet::new();
        let approval_signers: HashSet<Address> =
            self.approval_signer_addresses()?.into_iter().collect();
        let mut verified = Vec::new();
        for sig in &self.signatures {
            let digest =
                self.envelope
                    .digest(sig.score as u64, sig.chain_id, &sig.verifying_contract)?;
            let recovered = recover_signer(&sig.signature, digest)?;
            let claimed: Address = sig.signer.parse().map_err(|e| {
                TradingError::ValidatorError(format!(
                    "Invalid Uniswap envelope signer {}: {e}",
                    sig.signer
                ))
            })?;
            if recovered != claimed {
                return Err(TradingError::ValidatorError(
                    "Uniswap envelope signature recovered a different signer".into(),
                ));
            }
            if !approval_signers.contains(&recovered) {
                return Err(TradingError::ValidatorError(format!(
                    "Uniswap envelope signer {recovered:#x} is not in the approval signer set"
                )));
            }
            if seen.insert(recovered) {
                verified.push(recovered);
            }
        }
        if verified.len() < self.envelope.min_signatures as usize {
            return Err(TradingError::ValidatorError(format!(
                "Uniswap envelope has {} unique signatures, requires {}",
                verified.len(),
                self.envelope.min_signatures
            )));
        }
        Ok(verified)
    }
}

impl UniswapEnvelope {
    pub fn to_vault_contract(&self) -> Result<ITradingVault::UniswapEnvelope, TradingError> {
        Ok(ITradingVault::UniswapEnvelope {
            envelopeId: parse_b256(&self.envelope_id, "envelope_id")?,
            botIdHash: parse_b256(&self.bot_id_hash, "bot_id_hash")?,
            vault: parse_address(&self.vault, "vault")?,
            chainId: U256::from(self.chain_id),
            router: parse_address(&self.router, "router")?,
            tokenIn: parse_address(&self.token_in, "token_in")?,
            tokenOut: parse_address(&self.token_out, "token_out")?,
            action: action_hash(&self.action)?,
            maxSingleAmountIn: parse_u256(&self.max_single_amount_in, "max_single_amount_in")?,
            maxTotalAmountIn: parse_u256(&self.max_total_amount_in, "max_total_amount_in")?,
            maxSlippageBps: U256::from(self.max_slippage_bps),
            minOutputPerInput: parse_u256(&self.min_output_per_input, "min_output_per_input")?,
            validFrom: U256::from(self.valid_from),
            validUntil: U256::from(self.valid_until),
            nonce: U256::from(self.nonce),
            approvalSignersHash: parse_b256(&self.approval_signers_hash, "approval_signers_hash")?,
            minSignatures: U256::from(self.min_signatures),
        })
    }

    pub fn to_validator_contract(&self) -> Result<ITradeValidator::UniswapEnvelope, TradingError> {
        let envelope = self.to_vault_contract()?;
        Ok(ITradeValidator::UniswapEnvelope {
            envelopeId: envelope.envelopeId,
            botIdHash: envelope.botIdHash,
            vault: envelope.vault,
            chainId: envelope.chainId,
            router: envelope.router,
            tokenIn: envelope.tokenIn,
            tokenOut: envelope.tokenOut,
            action: envelope.action,
            maxSingleAmountIn: envelope.maxSingleAmountIn,
            maxTotalAmountIn: envelope.maxTotalAmountIn,
            maxSlippageBps: envelope.maxSlippageBps,
            minOutputPerInput: envelope.minOutputPerInput,
            validFrom: envelope.validFrom,
            validUntil: envelope.validUntil,
            nonce: envelope.nonce,
            approvalSignersHash: envelope.approvalSignersHash,
            minSignatures: envelope.minSignatures,
        })
    }

    pub fn envelope_hash(&self) -> Result<B256, TradingError> {
        Ok(keccak256(SolValue::abi_encode(&(
            keccak256(UNISWAP_ENVELOPE_TYPE.as_bytes()),
            parse_b256(&self.envelope_id, "envelope_id")?,
            parse_b256(&self.bot_id_hash, "bot_id_hash")?,
            parse_address(&self.vault, "vault")?,
            U256::from(self.chain_id),
            parse_address(&self.router, "router")?,
            parse_address(&self.token_in, "token_in")?,
            parse_address(&self.token_out, "token_out")?,
            action_hash(&self.action)?,
            parse_u256(&self.max_single_amount_in, "max_single_amount_in")?,
            parse_u256(&self.max_total_amount_in, "max_total_amount_in")?,
            U256::from(self.max_slippage_bps),
            parse_u256(&self.min_output_per_input, "min_output_per_input")?,
            U256::from(self.valid_from),
            U256::from(self.valid_until),
            U256::from(self.nonce),
            parse_b256(&self.approval_signers_hash, "approval_signers_hash")?,
            U256::from(self.min_signatures),
        ))))
    }

    pub fn digest(
        &self,
        score: u64,
        chain_id: u64,
        verifying_contract: &str,
    ) -> Result<B256, TradingError> {
        let verifying_contract = parse_address(verifying_contract, "verifying_contract")?;
        Ok(keccak256(
            [
                [0x19u8, 0x01].as_slice(),
                domain_separator(chain_id, verifying_contract).as_slice(),
                keccak256(SolValue::abi_encode(&(
                    keccak256(UNISWAP_ENVELOPE_APPROVAL_TYPE.as_bytes()),
                    self.envelope_hash()?,
                    U256::from(score),
                )))
                .as_slice(),
            ]
            .concat(),
        ))
    }

    pub fn sign_with_private_key(
        &self,
        private_key: &str,
        score: u32,
        chain_id: u64,
        verifying_contract: &str,
    ) -> Result<UniswapEnvelopeSignature, TradingError> {
        let signer: PrivateKeySigner = private_key.parse().map_err(|e| {
            TradingError::ValidatorError(format!("Invalid Uniswap envelope signer key: {e}"))
        })?;
        let digest = self.digest(score as u64, chain_id, verifying_contract)?;
        let signature = signer.sign_hash_sync(&digest).map_err(|e| {
            TradingError::ValidatorError(format!("Uniswap envelope signing failed: {e}"))
        })?;
        Ok(UniswapEnvelopeSignature {
            signer: format!("{:#x}", signer.address()),
            score,
            signature: format!("0x{}", hex::encode(signature.as_bytes())),
            chain_id,
            verifying_contract: verifying_contract.to_string(),
            validated_at: Some(chrono::Utc::now().to_rfc3339()),
        })
    }
}

pub fn bot_id_hash(bot_id: &str) -> String {
    format!("0x{}", hex::encode(keccak256(bot_id.as_bytes()).as_slice()))
}

pub fn approval_signers_hash(signers: &[String]) -> Result<B256, TradingError> {
    let addresses = parse_addresses(signers, "Uniswap envelope approval signer")?;
    let mut packed = Vec::with_capacity(addresses.len() * 20);
    for address in addresses {
        packed.extend_from_slice(address.as_slice());
    }
    Ok(keccak256(packed))
}

fn default_action() -> String {
    "swap".into()
}

fn domain_separator(chain_id: u64, verifying_contract: Address) -> B256 {
    keccak256(SolValue::abi_encode(&(
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        ),
        keccak256(DOMAIN_NAME.as_bytes()),
        keccak256(DOMAIN_VERSION.as_bytes()),
        U256::from(chain_id),
        verifying_contract,
    )))
}

fn parse_address(value: &str, label: &str) -> Result<Address, TradingError> {
    value
        .parse()
        .map_err(|e| TradingError::ValidatorError(format!("Invalid {label} address {value}: {e}")))
}

fn parse_addresses(values: &[String], label: &str) -> Result<Vec<Address>, TradingError> {
    values
        .iter()
        .map(|value| parse_address(value, label))
        .collect()
}

fn parse_b256(value: &str, label: &str) -> Result<B256, TradingError> {
    value
        .parse()
        .map_err(|e| TradingError::ValidatorError(format!("Invalid {label} {value}: {e}")))
}

fn parse_u256(value: &str, label: &str) -> Result<U256, TradingError> {
    U256::from_str_radix(value, 10)
        .map_err(|e| TradingError::ValidatorError(format!("Invalid {label} {value}: {e}")))
}

fn action_hash(action: &str) -> Result<B256, TradingError> {
    if action.starts_with("0x") {
        parse_b256(action, "action")
    } else {
        Ok(keccak256(action.as_bytes()))
    }
}

fn addresses_equal(left: &str, right: &str) -> Result<bool, TradingError> {
    Ok(parse_address(left, "left")? == parse_address(right, "right")?)
}

fn recover_signer(signature: &str, digest: B256) -> Result<Address, TradingError> {
    let raw = signature.strip_prefix("0x").unwrap_or(signature);
    let bytes = hex::decode(raw)
        .map_err(|e| TradingError::ValidatorError(format!("Invalid signature hex: {e}")))?;
    if bytes.len() != 65 {
        return Err(TradingError::ValidatorError(format!(
            "Signature must be 65 bytes, got {}",
            bytes.len()
        )));
    }
    let parity = if bytes[64] >= 27 {
        (bytes[64] - 27) == 1
    } else {
        bytes[64] == 1
    };
    Signature::from_bytes_and_parity(&bytes[..64], parity)
        .recover_address_from_prehash(&digest)
        .map_err(|e| {
            TradingError::ValidatorError(format!("Uniswap envelope signature recovery failed: {e}"))
        })
}
