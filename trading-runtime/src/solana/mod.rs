//! Solana venue integration — Jupiter (DEX aggregator) and Drift v2 (perps).
//!
//! Like Hyperliquid, these are off-chain-envelope venues: the bot's
//! `apply_envelope_checks` gate runs server-side in `trading-http-api`
//! before any tx is signed or submitted. There is no on-chain envelope
//! contract for Solana — the operator's keypair signs raw versioned
//! transactions returned by Jupiter, or hand-built Drift instructions.
//!
//! ## Modules
//!
//! - [`error`] — typed [`SolanaError`] mapped to HTTP status codes.
//! - [`keys`] — operator keypair loading from sandbox-injected secrets.
//! - [`client`] — thin async wrapper around `solana-client`'s `RpcClient`.
//! - [`jupiter`] — Jupiter swap aggregator (HTTP API).
//! - [`drift`] — Drift v2 perps (hand-built place_perp_order instruction).

pub mod client;
pub mod drift;
pub mod error;
pub mod jupiter;
pub mod keys;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_sdk::transaction::VersionedTransaction;

pub use error::SolanaError;

/// Off-chain-envelope venue running on Solana.
///
/// Implementations are stateless from the trait's POV — RPC clients,
/// HTTP clients, and other venue state live behind the impl.
#[async_trait]
pub trait SolanaVenue: Send + Sync {
    /// Stable identifier (`"jupiter"`, `"drift"`).
    fn venue_id(&self) -> &'static str;

    /// Fetch a quote for the requested swap/order.
    async fn quote(&self, req: &SolanaQuoteRequest) -> Result<SolanaQuote, SolanaError>;

    /// Build a versioned transaction that, when signed, executes the trade.
    ///
    /// The transaction is unsigned — the caller adds the operator signature
    /// via `solana-sdk` after policy gating.
    async fn build_swap_tx(
        &self,
        quote: &SolanaQuote,
        payer: Pubkey,
    ) -> Result<VersionedTransaction, SolanaError>;

    /// Submit a signed transaction to the cluster and return its signature.
    async fn submit(&self, tx: VersionedTransaction) -> Result<Signature, SolanaError>;
}

/// Request to quote a swap or perp order on a Solana venue.
///
/// Money values are **token atoms** (`u64`). For native SOL this is
/// lamports; for SPL tokens it's the raw integer amount in the mint's
/// fixed-decimal base.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolanaQuoteRequest {
    /// Input mint (the asset being sold/spent). For Drift perps this is
    /// the collateral mint (typically USDC).
    pub input_mint: Pubkey,
    /// Output mint. For Drift perps this can be set to the same mint as
    /// `input_mint` — markets are indexed, not addressed by mint.
    pub output_mint: Pubkey,
    /// Atoms of `input_mint` to spend.
    pub amount: u64,
    /// Maximum allowed slippage in basis points (100 bps = 1%).
    pub slippage_bps: u16,
    /// The wallet that will sign and pay.
    pub user_public_key: Pubkey,
}

/// Quoted swap/order parameters returned by a venue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolanaQuote {
    /// Venue identifier (`"jupiter"`, `"drift"`).
    pub venue: String,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    /// Atoms of `input_mint` actually being routed.
    pub in_amount: u64,
    /// Best-case atoms of `output_mint` the venue expects to deliver.
    pub out_amount: u64,
    /// Slippage-adjusted minimum-out the venue commits to (the
    /// `other_amount_threshold` field in Jupiter's quote response).
    pub other_amount_threshold: u64,
    /// Estimated price impact as a fractional percentage, e.g. `0.0023` = 23bps.
    pub price_impact_pct: f64,
    /// Raw venue payload (Jupiter quote JSON, etc.) — preserved verbatim
    /// so `build_swap_tx` can re-submit it without round-tripping the
    /// typed shape.
    pub raw: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::pubkey::Pubkey;

    #[test]
    fn quote_request_serde_roundtrip() {
        let req = SolanaQuoteRequest {
            input_mint: Pubkey::new_unique(),
            output_mint: Pubkey::new_unique(),
            amount: 1_000_000,
            slippage_bps: 50,
            user_public_key: Pubkey::new_unique(),
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: SolanaQuoteRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req.amount, parsed.amount);
        assert_eq!(req.slippage_bps, parsed.slippage_bps);
        assert_eq!(req.input_mint, parsed.input_mint);
    }

    #[test]
    fn quote_serde_roundtrip() {
        let q = SolanaQuote {
            venue: "jupiter".into(),
            input_mint: Pubkey::new_unique(),
            output_mint: Pubkey::new_unique(),
            in_amount: 1_000_000,
            out_amount: 999_000,
            other_amount_threshold: 989_010,
            price_impact_pct: 0.0023,
            raw: serde_json::json!({"foo": "bar"}),
        };
        let json = serde_json::to_string(&q).unwrap();
        let parsed: SolanaQuote = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.venue, "jupiter");
        assert_eq!(parsed.out_amount, 999_000);
    }
}
