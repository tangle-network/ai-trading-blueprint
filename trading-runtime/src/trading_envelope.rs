//! Trading Envelope — pre-approved policy surface for instant execution.
//!
//! Instead of per-trade validator round-trips (5-30s), operators approve a
//! trading envelope that defines WHERE and HOW MUCH the bot can trade.
//! Trades within the envelope execute instantly. Cancels always instant.
//!
//! The envelope is NOT the exact strategy — it's the outer bounds. The bot's
//! actual entries/exits within those bounds are unpredictable, preventing
//! front-running by adversaries who read the public code.
//!
//! Game theory: rigid rules = exploitable. The envelope defines a surface,
//! not a path. The bot navigates within it using its own timing and sizing.

use serde::{Deserialize, Serialize};

/// A pre-approved trading envelope defining what the bot is allowed to do.
///
/// Approved once at bot activation (or periodically refreshed). Individual
/// trades within the envelope skip the validator round-trip entirely.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradingEnvelope {
    /// Which assets the bot can trade (e.g., ["ETH", "BTC", "SOL"])
    pub allowed_assets: Vec<String>,

    /// Maximum position size per asset (in USD notional)
    pub max_position_usd: f64,

    /// Maximum leverage allowed
    pub max_leverage: u32,

    /// Maximum total portfolio exposure (sum of all positions, USD notional)
    pub max_total_exposure_usd: f64,

    /// Maximum drawdown from high water mark before circuit break (0.0-1.0)
    pub max_drawdown_pct: f64,

    /// Required stop-loss: maximum distance from entry (0.0-1.0, e.g. 0.05 = 5%)
    /// The exact SL price is chosen by the bot within this range — not fixed.
    pub max_stop_loss_distance: f64,

    /// Minimum stop-loss distance (prevents adversarial tight stops that get hunted)
    pub min_stop_loss_distance: f64,

    /// Whether the bot can open new positions (false = close-only mode)
    pub can_open_positions: bool,

    /// Envelope expiry (Unix timestamp). After this, bot must re-validate.
    /// 0 = no expiry.
    pub expires_at: i64,

    /// Who approved this envelope (operator address or "self" for paper trade)
    pub approved_by: String,

    /// Timestamp when approved
    pub approved_at: i64,
}

impl Default for TradingEnvelope {
    fn default() -> Self {
        Self {
            allowed_assets: vec![
                "ETH".into(),
                "BTC".into(),
                "SOL".into(),
                "ARB".into(),
                "OP".into(),
            ],
            max_position_usd: 1000.0,
            max_leverage: 5,
            max_total_exposure_usd: 3000.0,
            max_drawdown_pct: 0.10,       // 10%
            max_stop_loss_distance: 0.05, // 5%
            min_stop_loss_distance: 0.01, // 1%
            can_open_positions: true,
            expires_at: 0,
            approved_by: "default".into(),
            approved_at: 0,
        }
    }
}

/// Result of validating a trade against the envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeCheck {
    pub allowed: bool,
    pub reason: Option<String>,
}

impl TradingEnvelope {
    /// Check if a trade is within the envelope bounds.
    ///
    /// This is the instant check that replaces the validator round-trip.
    /// Returns allowed=true if all conditions pass.
    pub fn check_trade(
        &self,
        asset: &str,
        size_usd: f64,
        leverage: u32,
        is_open: bool,
        current_total_exposure_usd: f64,
    ) -> EnvelopeCheck {
        // Cancels and closes always allowed
        if !is_open {
            return EnvelopeCheck {
                allowed: true,
                reason: None,
            };
        }

        if !self.can_open_positions {
            return EnvelopeCheck {
                allowed: false,
                reason: Some("envelope is in close-only mode".into()),
            };
        }

        // Check expiry
        if self.expires_at > 0 {
            let now = chrono::Utc::now().timestamp();
            if now > self.expires_at {
                return EnvelopeCheck {
                    allowed: false,
                    reason: Some(format!("envelope expired at {}", self.expires_at)),
                };
            }
        }

        // Check asset whitelist
        let upper = asset.to_uppercase();
        if !self
            .allowed_assets
            .iter()
            .any(|a| a.to_uppercase() == upper)
        {
            return EnvelopeCheck {
                allowed: false,
                reason: Some(format!("asset {asset} not in envelope whitelist")),
            };
        }

        // Check position size
        if size_usd > self.max_position_usd {
            return EnvelopeCheck {
                allowed: false,
                reason: Some(format!(
                    "position ${size_usd:.2} exceeds max ${:.2}",
                    self.max_position_usd
                )),
            };
        }

        // Check leverage
        if leverage > self.max_leverage {
            return EnvelopeCheck {
                allowed: false,
                reason: Some(format!(
                    "leverage {leverage}x exceeds max {}x",
                    self.max_leverage
                )),
            };
        }

        // Check total exposure
        let new_total = current_total_exposure_usd + size_usd;
        if new_total > self.max_total_exposure_usd {
            return EnvelopeCheck {
                allowed: false,
                reason: Some(format!(
                    "total exposure ${new_total:.2} would exceed max ${:.2}",
                    self.max_total_exposure_usd
                )),
            };
        }

        EnvelopeCheck {
            allowed: true,
            reason: None,
        }
    }

    /// Check if a stop-loss distance is within the allowed range.
    pub fn check_stop_loss(&self, distance_pct: f64) -> EnvelopeCheck {
        if distance_pct < self.min_stop_loss_distance {
            return EnvelopeCheck {
                allowed: false,
                reason: Some(format!(
                    "SL distance {:.1}% below minimum {:.1}%",
                    distance_pct * 100.0,
                    self.min_stop_loss_distance * 100.0
                )),
            };
        }
        if distance_pct > self.max_stop_loss_distance {
            return EnvelopeCheck {
                allowed: false,
                reason: Some(format!(
                    "SL distance {:.1}% exceeds maximum {:.1}%",
                    distance_pct * 100.0,
                    self.max_stop_loss_distance * 100.0
                )),
            };
        }
        EnvelopeCheck {
            allowed: true,
            reason: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_envelope_allows_eth() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("ETH", 500.0, 3, true, 0.0);
        assert!(check.allowed, "ETH should be allowed: {:?}", check.reason);
    }

    #[test]
    fn rejects_unknown_asset() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("DOGE", 100.0, 1, true, 0.0);
        assert!(!check.allowed);
        assert!(check.reason.unwrap().contains("whitelist"));
    }

    #[test]
    fn rejects_oversized_position() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("ETH", 5000.0, 3, true, 0.0);
        assert!(!check.allowed);
        assert!(check.reason.unwrap().contains("exceeds max"));
    }

    #[test]
    fn rejects_excessive_leverage() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("ETH", 500.0, 20, true, 0.0);
        assert!(!check.allowed);
        assert!(check.reason.unwrap().contains("leverage"));
    }

    #[test]
    fn rejects_exposure_overflow() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("ETH", 500.0, 3, true, 2800.0);
        assert!(!check.allowed);
        assert!(check.reason.unwrap().contains("total exposure"));
    }

    #[test]
    fn closes_always_allowed() {
        let env = TradingEnvelope {
            can_open_positions: false,
            ..Default::default()
        };
        let check = env.check_trade("ETH", 500.0, 3, false, 0.0);
        assert!(check.allowed, "closes always pass");
    }

    #[test]
    fn close_only_mode_blocks_opens() {
        let env = TradingEnvelope {
            can_open_positions: false,
            ..Default::default()
        };
        let check = env.check_trade("ETH", 500.0, 3, true, 0.0);
        assert!(!check.allowed);
        assert!(check.reason.unwrap().contains("close-only"));
    }

    #[test]
    fn expired_envelope_rejects() {
        let env = TradingEnvelope {
            expires_at: 1000, // long expired
            ..Default::default()
        };
        let check = env.check_trade("ETH", 500.0, 3, true, 0.0);
        assert!(!check.allowed);
        assert!(check.reason.unwrap().contains("expired"));
    }

    #[test]
    fn stop_loss_distance_validation() {
        let env = TradingEnvelope::default();

        // Too tight
        let check = env.check_stop_loss(0.005); // 0.5%
        assert!(!check.allowed);
        assert!(check.reason.unwrap().contains("below minimum"));

        // Too wide
        let check = env.check_stop_loss(0.10); // 10%
        assert!(!check.allowed);
        assert!(check.reason.unwrap().contains("exceeds maximum"));

        // Just right
        let check = env.check_stop_loss(0.03); // 3%
        assert!(check.allowed);
    }

    #[test]
    fn case_insensitive_asset_check() {
        let env = TradingEnvelope::default();
        assert!(env.check_trade("eth", 100.0, 1, true, 0.0).allowed);
        assert!(env.check_trade("Eth", 100.0, 1, true, 0.0).allowed);
        assert!(env.check_trade("ETH", 100.0, 1, true, 0.0).allowed);
    }

    #[test]
    fn envelope_serde_roundtrip() {
        let env = TradingEnvelope::default();
        let json = serde_json::to_string(&env).unwrap();
        let parsed: TradingEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.max_leverage, env.max_leverage);
        assert_eq!(parsed.allowed_assets.len(), env.allowed_assets.len());
    }

    #[test]
    fn exact_at_position_limit_allowed() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("ETH", 1000.0, 3, true, 0.0);
        assert!(check.allowed, "exactly at limit should pass: {:?}", check.reason);
    }

    #[test]
    fn one_above_position_limit_rejected() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("ETH", 1000.01, 3, true, 0.0);
        assert!(!check.allowed);
    }

    #[test]
    fn exact_at_leverage_limit_allowed() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("ETH", 100.0, 5, true, 0.0);
        assert!(check.allowed, "leverage exactly at limit should pass: {:?}", check.reason);
    }

    #[test]
    fn one_above_leverage_limit_rejected() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("ETH", 100.0, 6, true, 0.0);
        assert!(!check.allowed);
    }

    #[test]
    fn exact_at_total_exposure_limit_allowed() {
        let env = TradingEnvelope::default();
        let check = env.check_trade("ETH", 200.0, 1, true, 2800.0);
        assert!(check.allowed, "total at limit should pass: {:?}", check.reason);
    }

    #[test]
    fn stop_loss_exactly_at_minimum_allowed() {
        let env = TradingEnvelope::default();
        let check = env.check_stop_loss(0.01);
        assert!(check.allowed, "stop_loss exactly at min should pass: {:?}", check.reason);
    }

    #[test]
    fn stop_loss_exactly_at_maximum_allowed() {
        let env = TradingEnvelope::default();
        let check = env.check_stop_loss(0.05);
        assert!(check.allowed, "stop_loss exactly at max should pass: {:?}", check.reason);
    }

    #[test]
    fn zero_leverage_always_within_any_limit() {
        let env = TradingEnvelope { max_leverage: 1, ..Default::default() };
        let check = env.check_trade("ETH", 100.0, 0, true, 0.0);
        assert!(check.allowed);
    }
}
