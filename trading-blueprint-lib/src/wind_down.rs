//! TTL wind-down detection for trading bots.
//!
//! When a bot's remaining lifetime drops below a configurable threshold
//! (default: 1 hour), the wind-down system initiates a graceful shutdown
//! sequence: the agent's prompt is swapped to a liquidation prompt so it
//! closes all open positions before the reaper kills the container.

use crate::state::TradingBotRecord;

/// Returns the wind-down threshold in seconds.
///
/// Configurable via `WIND_DOWN_THRESHOLD_SECS` env var. Default: 3600 (1 hour).
pub fn wind_down_threshold_secs() -> u64 {
    std::env::var("WIND_DOWN_THRESHOLD_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3600)
}

/// Current wall-clock time in seconds since Unix epoch.
fn now_secs() -> u64 {
    chrono::Utc::now().timestamp().max(0) as u64
}

/// Check if a bot should enter wind-down mode based on TTL proximity.
///
/// Returns `true` if wind-down should be initiated NOW (first time only).
/// Returns `false` if the bot is already winding down, already stopped,
/// or has plenty of time remaining.
pub fn should_initiate_wind_down(bot: &TradingBotRecord) -> bool {
    should_initiate_wind_down_at(bot, now_secs())
}

/// Testable version with explicit `now` timestamp.
pub fn should_initiate_wind_down_at(bot: &TradingBotRecord, now: u64) -> bool {
    if bot.wind_down_started_at.is_some() {
        return false; // Already in wind-down
    }
    if !bot.trading_active {
        return false; // Already stopped
    }

    let max_lifetime_secs =
        if bot.max_lifetime_days == 0 { 30 } else { bot.max_lifetime_days } * 86400;
    let expires_at = bot.created_at + max_lifetime_secs;
    let remaining = expires_at.saturating_sub(now);

    let threshold = wind_down_threshold_secs();
    remaining <= threshold
}

/// Check if a bot is currently in wind-down mode.
pub fn is_winding_down(bot: &TradingBotRecord) -> bool {
    bot.wind_down_started_at.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_bot(created_at: u64, max_lifetime_days: u64) -> TradingBotRecord {
        TradingBotRecord {
            id: "test".to_string(),
            sandbox_id: "sb".to_string(),
            vault_address: "0xVAULT".to_string(),
            share_token: String::new(),
            strategy_type: "dex".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://localhost:9100".to_string(),
            trading_api_token: "token".to_string(),
            workflow_id: None,
            trading_active: true,
            created_at,
            operator_address: String::new(),
            validator_service_ids: vec![],
            max_lifetime_days,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: String::new(),
        }
    }

    #[test]
    fn test_should_initiate_wind_down_within_threshold() {
        // Bot created 23h ago with 1-day lifetime → 1h remaining → should trigger
        let now = 86400; // 1 day in seconds
        let created_at = now - (23 * 3600); // 23 hours ago
        let bot = make_bot(created_at, 1);

        // Default threshold is 3600s (1 hour), remaining is 3600s → triggers
        assert!(should_initiate_wind_down_at(&bot, now));
    }

    #[test]
    fn test_should_not_wind_down_if_already_started() {
        let now = 86400;
        let created_at = now - (23 * 3600);
        let mut bot = make_bot(created_at, 1);
        bot.wind_down_started_at = Some(now - 100);

        assert!(!should_initiate_wind_down_at(&bot, now));
    }

    #[test]
    fn test_should_not_wind_down_if_plenty_of_time() {
        // Bot created 1 day ago with 30-day lifetime → 29 days remaining
        let now = 86400;
        let created_at = 0;
        let bot = make_bot(created_at, 30);

        assert!(!should_initiate_wind_down_at(&bot, now));
    }

    #[test]
    fn test_should_not_wind_down_if_already_stopped() {
        let now = 86400;
        let created_at = now - (23 * 3600);
        let mut bot = make_bot(created_at, 1);
        bot.trading_active = false;

        assert!(!should_initiate_wind_down_at(&bot, now));
    }

    #[test]
    fn test_is_winding_down() {
        let mut bot = make_bot(0, 30);
        assert!(!is_winding_down(&bot));

        bot.wind_down_started_at = Some(1000);
        assert!(is_winding_down(&bot));
    }

    #[test]
    fn test_default_lifetime_for_zero_days() {
        // Bot with max_lifetime_days=0 defaults to 30 days
        let now = 30 * 86400; // exactly 30 days
        let created_at = now - (30 * 86400 - 1800); // 30 min remaining
        let bot = make_bot(created_at, 0);

        assert!(should_initiate_wind_down_at(&bot, now));
    }

    #[test]
    fn test_wind_down_at_exact_expiry() {
        // Bot already expired → remaining is 0 → should trigger
        let now = 86400 + 100;
        let created_at = 0;
        let bot = make_bot(created_at, 1);

        assert!(should_initiate_wind_down_at(&bot, now));
    }
}
