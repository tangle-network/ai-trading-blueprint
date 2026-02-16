//! Shared chain client for connecting to EVM-compatible blockchains.
//!
//! Provides a configured provider with a local signer (private key)
//! for submitting transactions.

use alloy::network::{Ethereum, EthereumWallet};
use alloy::providers::fillers::{
    BlobGasFiller, ChainIdFiller, FillProvider, GasFiller, JoinFill, NonceFiller, WalletFiller,
};
use alloy::providers::{Identity, ProviderBuilder, RootProvider};
use alloy::signers::local::PrivateKeySigner;

use crate::error::TradingError;

/// The concrete provider type produced by `ProviderBuilder::new().wallet(...).connect_http(...)`.
///
/// This is a fully-configured provider that fills nonce, gas, chain ID, and
/// signs transactions with the supplied wallet.
pub type HttpProvider = FillProvider<
    JoinFill<
        JoinFill<
            Identity,
            JoinFill<GasFiller, JoinFill<BlobGasFiller, JoinFill<NonceFiller, ChainIdFiller>>>,
        >,
        WalletFiller<EthereumWallet>,
    >,
    RootProvider<Ethereum>,
    Ethereum,
>;

/// A chain client wrapping an alloy provider with a local signer.
pub struct ChainClient {
    pub provider: HttpProvider,
    pub wallet: EthereumWallet,
    pub chain_id: u64,
}

impl ChainClient {
    /// Create a new chain client from an RPC URL and hex-encoded private key.
    ///
    /// The private key should be a hex string (with or without "0x" prefix).
    pub fn new(rpc_url: &str, private_key: &str, chain_id: u64) -> Result<Self, TradingError> {
        let signer: PrivateKeySigner = private_key
            .parse()
            .map_err(|e| TradingError::ConfigError(format!("Invalid private key: {e}")))?;

        let wallet = EthereumWallet::from(signer);

        let url: url::Url = rpc_url
            .parse()
            .map_err(|e| TradingError::ConfigError(format!("Invalid RPC URL: {e}")))?;

        let provider = ProviderBuilder::new()
            .wallet(wallet.clone())
            .connect_http(url);

        Ok(Self {
            provider,
            wallet,
            chain_id,
        })
    }

    /// Get a reference to the underlying provider.
    pub fn provider(&self) -> &HttpProvider {
        &self.provider
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chain_client_creation() {
        // Use a well-known test private key (Hardhat account #0)
        let private_key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let client = ChainClient::new("http://localhost:8545", private_key, 31337);
        assert!(client.is_ok());
        let client = client.unwrap();
        assert_eq!(client.chain_id, 31337);
    }

    #[test]
    fn test_invalid_private_key() {
        let result = ChainClient::new("http://localhost:8545", "not-a-key", 1);
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_rpc_url() {
        let private_key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let result = ChainClient::new("not a url", private_key, 1);
        assert!(result.is_err());
    }
}
