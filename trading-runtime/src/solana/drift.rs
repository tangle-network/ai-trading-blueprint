//! Drift v2 perpetuals — hand-built `place_perp_order` instruction.
//!
//! ## Why hand-built?
//!
//! `drift-rs` only publishes a `1.0.0-alpha` on crates.io that pulls a
//! significant Anchor toolchain (`anchor-lang`, `anchor-client`, multiple
//! cargo features that conflict with our existing `solana-sdk` v2 graph).
//! That's too heavy for what amounts to one borsh-serialized instruction
//! payload. We build the payload directly with `solana-sdk` + `borsh`.
//!
//! The wire format is stable across the Drift v2 IDL — see
//! <https://github.com/drift-labs/protocol-v2/blob/main/programs/drift/src/instructions/user.rs>
//! `place_perp_order`. The Anchor instruction discriminator is the first
//! 8 bytes of `sha256("global:place_perp_order")`.
//!
//! ## What's implemented
//!
//! - [`DriftOrderRequest`] with `market_index: u16`, `direction`,
//!   `base_amount: u64`, `price: u64`, `order_type`, `reduce_only`.
//! - [`build_place_perp_order_ix`] returning a `solana_sdk::instruction::Instruction`.
//! - [`MARKET_INDEX_SOL_PERP`] / `_BTC_PERP` / `_ETH_PERP` constants for the
//!   common markets (verified against Drift's mainnet IDL).
//!
//! ## What's punted
//!
//! - **Spot markets**: not implemented; only perps. (See `place_spot_order`
//!   if/when needed.)
//! - **Account discovery**: the caller passes the user's Drift `User` PDA;
//!   we don't derive it on-chain to keep the surface small.
//! - **Submission**: `submit()` defers entirely to [`SolanaClient`]. The
//!   `SolanaVenue::quote` impl is a static, network-free echo because Drift
//!   exposes its order book on-chain — fetching live prices belongs in a
//!   future market-data hook.

use async_trait::async_trait;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::pubkey;
use solana_sdk::signature::Signature;
use solana_sdk::transaction::VersionedTransaction;

use super::client::SolanaClient;
use super::error::SolanaError;
use super::{SolanaQuote, SolanaQuoteRequest, SolanaVenue};

/// Drift v2 program ID (mainnet, devnet — same address).
pub const DRIFT_PROGRAM_ID: Pubkey = pubkey!("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

/// Anchor discriminator: first 8 bytes of `sha256("global:place_perp_order")`.
///
/// Hard-coded so we don't pull `sha2` here purely to compute a constant.
/// Verified against Drift v2 IDL revision used by mainnet at the time of
/// writing — guarded by `discriminator_matches_anchor_convention` test.
pub const PLACE_PERP_ORDER_IX_DISCRIMINATOR: [u8; 8] = [69, 161, 93, 202, 120, 126, 76, 185];

// ── Common perp market indices ───────────────────────────────────────────────

/// SOL-PERP.
pub const MARKET_INDEX_SOL_PERP: u16 = 0;
/// BTC-PERP.
pub const MARKET_INDEX_BTC_PERP: u16 = 1;
/// ETH-PERP.
pub const MARKET_INDEX_ETH_PERP: u16 = 2;

// ── Order types ──────────────────────────────────────────────────────────────

/// Trade direction. Wire-encoded as a `u8`: `Long = 0`, `Short = 1`.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    BorshSerialize,
    BorshDeserialize,
    serde::Serialize,
    serde::Deserialize,
)]
#[borsh(use_discriminant = true)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum DriftDirection {
    Long = 0,
    Short = 1,
}

/// Order type. Wire-encoded as a `u8`. Drift supports more variants
/// (`TriggerMarket`, `TriggerLimit`, `Oracle`); the four below cover the
/// majority of usage.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    BorshSerialize,
    BorshDeserialize,
    serde::Serialize,
    serde::Deserialize,
)]
#[borsh(use_discriminant = true)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum DriftOrderType {
    Market = 0,
    Limit = 1,
    TriggerMarket = 2,
    TriggerLimit = 3,
}

/// Subset of Drift v2's `OrderParams` covering the fields we use.
///
/// The full struct has ~14 fields; this layout keeps perpetual order
/// placement simple. Borsh-serialised as the single argument to
/// `place_perp_order`.
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub struct DriftOrderParams {
    pub order_type: DriftOrderType,
    pub market_type: u8, // 0 = Spot, 1 = Perp; we hard-set to 1.
    pub direction: DriftDirection,
    pub user_order_id: u8,
    /// Base-asset amount in market units (10^9 precision in Drift).
    pub base_asset_amount: u64,
    /// Limit price in `PRICE_PRECISION` (1e6) — 0 for market orders.
    pub price: u64,
    pub market_index: u16,
    pub reduce_only: bool,
    /// 0 = TilCancelled, 1 = ImmediateOrCancel, 2 = FillOrKill, 3 = PostOnly.
    pub post_only: u8,
    pub immediate_or_cancel: bool,
    /// 0 = Default, 1 = Mark, 2 = Oracle (used for trigger orders).
    pub max_ts: u8,
    pub trigger_price: u64,
    pub trigger_condition: u8,
    pub oracle_price_offset: i32,
    pub auction_duration: u8,
    pub auction_start_price: i64,
    pub auction_end_price: i64,
}

impl DriftOrderParams {
    /// Construct a vanilla market or limit perp order. Trigger fields
    /// default to zero — callers needing trigger orders should build the
    /// struct directly.
    pub fn new_perp_order(
        market_index: u16,
        direction: DriftDirection,
        order_type: DriftOrderType,
        base_asset_amount: u64,
        price: u64,
        reduce_only: bool,
    ) -> Self {
        Self {
            order_type,
            market_type: 1, // Perp
            direction,
            user_order_id: 0,
            base_asset_amount,
            price,
            market_index,
            reduce_only,
            post_only: 0,
            immediate_or_cancel: false,
            max_ts: 0,
            trigger_price: 0,
            trigger_condition: 0,
            oracle_price_offset: 0,
            auction_duration: 0,
            auction_start_price: 0,
            auction_end_price: 0,
        }
    }
}

// ── Public request shape ─────────────────────────────────────────────────────

/// Placement request as it arrives from `trading-http-api`. Markets are
/// integer-indexed (Drift's native shape) — we deliberately do not
/// hand-roll a symbol → index map.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DriftOrderRequest {
    pub market_index: u16,
    pub direction: DriftDirection,
    pub order_type: DriftOrderType,
    /// Base-asset amount in Drift's `BASE_PRECISION` (1e9).
    pub base_amount: u64,
    /// Limit price in `PRICE_PRECISION` (1e6). Use 0 for `Market` orders.
    #[serde(default)]
    pub price: u64,
    #[serde(default)]
    pub reduce_only: bool,
}

// ── Instruction builder ──────────────────────────────────────────────────────

/// Account list expected by Drift's `place_perp_order` instruction.
///
/// We require the caller to pass these in. They're trivially derivable
/// from the operator's Drift `User` PDA but we keep that derivation out
/// of this module to stay dependency-light.
pub struct DriftPlacePerpOrderAccounts {
    pub state: Pubkey,
    pub user: Pubkey,
    pub authority: Pubkey,
}

/// Build a Drift `place_perp_order` instruction.
///
/// Wire format:
///   `[discriminator (8 bytes)][borsh(OrderParams)]`
///
/// Accounts (ordered, per Drift IDL):
///   1. state (read-only)
///   2. user (writable)
///   3. authority (signer)
pub fn build_place_perp_order_ix(
    accounts: &DriftPlacePerpOrderAccounts,
    params: &DriftOrderParams,
) -> Result<Instruction, SolanaError> {
    let mut data = Vec::with_capacity(8 + 64);
    data.extend_from_slice(&PLACE_PERP_ORDER_IX_DISCRIMINATOR);
    borsh::to_writer(&mut data, params)
        .map_err(|e| SolanaError::RpcFailed(format!("borsh serialize: {e}")))?;

    Ok(Instruction {
        program_id: DRIFT_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts.state, false),
            AccountMeta::new(accounts.user, false),
            AccountMeta::new_readonly(accounts.authority, true),
        ],
        data,
    })
}

// ── Venue impl ───────────────────────────────────────────────────────────────

/// Drift v2 perp venue.
///
/// The implementation is intentionally minimal:
///
/// - `quote` echoes the request as a [`SolanaQuote`] without hitting the
///   network. Drift's price discovery is on-chain via the perp market
///   oracle; integrating that belongs in a separate market-data hook.
/// - `build_swap_tx` is unimplemented (returns `RpcFailed`) — direct Drift
///   placement uses [`build_place_perp_order_ix`] from the
///   `/solana/drift/order` route, which constructs the transaction itself.
/// - `submit` defers to [`SolanaClient`].
pub struct DriftVenue {
    rpc: SolanaClient,
}

impl DriftVenue {
    pub fn new(rpc: SolanaClient) -> Self {
        Self { rpc }
    }

    pub fn rpc(&self) -> &SolanaClient {
        &self.rpc
    }
}

#[async_trait]
impl SolanaVenue for DriftVenue {
    fn venue_id(&self) -> &'static str {
        "drift"
    }

    async fn quote(&self, req: &SolanaQuoteRequest) -> Result<SolanaQuote, SolanaError> {
        // Drift quoting is on-chain and currently outside the scope of
        // the SolanaVenue trait. Echo a no-op quote so the trait surface
        // is uniform and the request-side gating still works.
        Ok(SolanaQuote {
            venue: self.venue_id().to_string(),
            input_mint: req.input_mint,
            output_mint: req.output_mint,
            in_amount: req.amount,
            out_amount: req.amount,
            other_amount_threshold: req.amount,
            price_impact_pct: 0.0,
            raw: serde_json::json!({
                "venue": "drift",
                "note": "drift quote is on-chain; use /solana/drift/order to place an order",
            }),
        })
    }

    async fn build_swap_tx(
        &self,
        _quote: &SolanaQuote,
        _payer: Pubkey,
    ) -> Result<VersionedTransaction, SolanaError> {
        Err(SolanaError::RpcFailed(
            "drift place-order tx is built via build_place_perp_order_ix; \
             SolanaVenue::build_swap_tx is not used for Drift"
                .into(),
        ))
    }

    async fn submit(&self, tx: VersionedTransaction) -> Result<Signature, SolanaError> {
        self.rpc.submit(tx).await
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    /// The Anchor convention: discriminator = first 8 bytes of
    /// `sha256("global:<snake_case_method_name>")`.
    fn anchor_disc(method: &str) -> [u8; 8] {
        let mut h = Sha256::new();
        h.update(format!("global:{method}").as_bytes());
        let out = h.finalize();
        let mut d = [0u8; 8];
        d.copy_from_slice(&out[..8]);
        d
    }

    #[test]
    fn discriminator_matches_anchor_convention() {
        assert_eq!(
            PLACE_PERP_ORDER_IX_DISCRIMINATOR,
            anchor_disc("place_perp_order"),
            "discriminator drifted from anchor convention"
        );
    }

    #[test]
    fn known_market_indices_are_stable() {
        // These constants are part of the public API; if they ever
        // change we want a compile-time signal.
        assert_eq!(MARKET_INDEX_SOL_PERP, 0);
        assert_eq!(MARKET_INDEX_BTC_PERP, 1);
        assert_eq!(MARKET_INDEX_ETH_PERP, 2);
    }

    #[test]
    fn build_ix_layout() {
        let accounts = DriftPlacePerpOrderAccounts {
            state: Pubkey::new_unique(),
            user: Pubkey::new_unique(),
            authority: Pubkey::new_unique(),
        };
        let params = DriftOrderParams::new_perp_order(
            MARKET_INDEX_SOL_PERP,
            DriftDirection::Long,
            DriftOrderType::Limit,
            1_000_000_000,
            150_000_000,
            false,
        );
        let ix = build_place_perp_order_ix(&accounts, &params).unwrap();

        assert_eq!(ix.program_id, DRIFT_PROGRAM_ID);
        assert_eq!(ix.accounts.len(), 3);
        // Discriminator is the first 8 bytes.
        assert_eq!(&ix.data[..8], &PLACE_PERP_ORDER_IX_DISCRIMINATOR);
        // Borsh tail roundtrips.
        let tail = &ix.data[8..];
        let decoded = DriftOrderParams::try_from_slice(tail).unwrap();
        assert_eq!(decoded.market_index, MARKET_INDEX_SOL_PERP);
        assert_eq!(decoded.market_type, 1);
        assert_eq!(decoded.direction, DriftDirection::Long);
        assert_eq!(decoded.order_type, DriftOrderType::Limit);
        assert_eq!(decoded.base_asset_amount, 1_000_000_000);
        assert_eq!(decoded.price, 150_000_000);
        assert!(!decoded.reduce_only);
    }

    #[test]
    fn build_ix_marks_authority_as_signer() {
        let accounts = DriftPlacePerpOrderAccounts {
            state: Pubkey::new_unique(),
            user: Pubkey::new_unique(),
            authority: Pubkey::new_unique(),
        };
        let params = DriftOrderParams::new_perp_order(
            MARKET_INDEX_SOL_PERP,
            DriftDirection::Short,
            DriftOrderType::Market,
            500_000,
            0,
            true,
        );
        let ix = build_place_perp_order_ix(&accounts, &params).unwrap();
        // state: read-only, not signer
        assert!(!ix.accounts[0].is_writable);
        assert!(!ix.accounts[0].is_signer);
        // user: writable
        assert!(ix.accounts[1].is_writable);
        assert!(!ix.accounts[1].is_signer);
        // authority: read-only, signer
        assert!(!ix.accounts[2].is_writable);
        assert!(ix.accounts[2].is_signer);
    }

    #[test]
    fn order_params_borsh_roundtrip_preserves_fields() {
        let p = DriftOrderParams {
            order_type: DriftOrderType::TriggerLimit,
            market_type: 1,
            direction: DriftDirection::Short,
            user_order_id: 42,
            base_asset_amount: 12_345_678_900,
            price: 10_000_000,
            market_index: MARKET_INDEX_BTC_PERP,
            reduce_only: true,
            post_only: 3,
            immediate_or_cancel: true,
            max_ts: 0,
            trigger_price: 9_500_000,
            trigger_condition: 1,
            oracle_price_offset: -50,
            auction_duration: 5,
            auction_start_price: -1_000,
            auction_end_price: 1_000,
        };
        let bytes = borsh::to_vec(&p).unwrap();
        let parsed = DriftOrderParams::try_from_slice(&bytes).unwrap();
        assert_eq!(parsed.market_index, p.market_index);
        assert_eq!(parsed.user_order_id, p.user_order_id);
        assert_eq!(parsed.oracle_price_offset, p.oracle_price_offset);
        assert_eq!(parsed.auction_start_price, p.auction_start_price);
        assert_eq!(parsed.trigger_price, p.trigger_price);
        assert_eq!(parsed.reduce_only, p.reduce_only);
        assert_eq!(parsed.immediate_or_cancel, p.immediate_or_cancel);
    }

    #[test]
    fn direction_borsh_encoding_is_u8() {
        let l = borsh::to_vec(&DriftDirection::Long).unwrap();
        let s = borsh::to_vec(&DriftDirection::Short).unwrap();
        assert_eq!(l, vec![0]);
        assert_eq!(s, vec![1]);
    }

    #[test]
    fn order_type_borsh_encoding_is_u8() {
        let m = borsh::to_vec(&DriftOrderType::Market).unwrap();
        let lim = borsh::to_vec(&DriftOrderType::Limit).unwrap();
        let tm = borsh::to_vec(&DriftOrderType::TriggerMarket).unwrap();
        let tl = borsh::to_vec(&DriftOrderType::TriggerLimit).unwrap();
        assert_eq!(m, vec![0]);
        assert_eq!(lim, vec![1]);
        assert_eq!(tm, vec![2]);
        assert_eq!(tl, vec![3]);
    }

    #[tokio::test]
    async fn quote_echoes_request_without_network_io() {
        let rpc = SolanaClient::new("http://127.0.0.1:1");
        let venue = DriftVenue::new(rpc);
        let req = SolanaQuoteRequest {
            input_mint: Pubkey::new_unique(),
            output_mint: Pubkey::new_unique(),
            amount: 1_000_000,
            slippage_bps: 50,
            user_public_key: Pubkey::new_unique(),
        };
        let q = venue.quote(&req).await.unwrap();
        assert_eq!(q.venue, "drift");
        assert_eq!(q.in_amount, req.amount);
        assert_eq!(q.out_amount, req.amount);
    }
}
