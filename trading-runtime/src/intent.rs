use crate::error::TradingError;
use crate::types::*;
use chrono::Utc;
use rust_decimal::Decimal;
use sha3::{Digest, Keccak256};
use uuid::Uuid;

pub struct TradeIntentBuilder {
    strategy_id: Option<String>,
    action: Option<Action>,
    token_in: Option<String>,
    token_out: Option<String>,
    amount_in: Option<Decimal>,
    min_amount_out: Option<Decimal>,
    target_protocol: Option<String>,
    chain_id: Option<u64>,
    deadline_secs: Option<i64>,
    metadata: serde_json::Value,
}

impl TradeIntentBuilder {
    pub fn new() -> Self {
        Self {
            strategy_id: None,
            action: None,
            token_in: None,
            token_out: None,
            amount_in: None,
            min_amount_out: None,
            target_protocol: None,
            chain_id: None,
            deadline_secs: None,
            metadata: serde_json::Value::Null,
        }
    }

    pub fn strategy_id(mut self, id: impl Into<String>) -> Self {
        self.strategy_id = Some(id.into());
        self
    }

    pub fn action(mut self, action: Action) -> Self {
        self.action = Some(action);
        self
    }

    pub fn token_in(mut self, token: impl Into<String>) -> Self {
        self.token_in = Some(token.into());
        self
    }

    pub fn token_out(mut self, token: impl Into<String>) -> Self {
        self.token_out = Some(token.into());
        self
    }

    pub fn amount_in(mut self, amount: Decimal) -> Self {
        self.amount_in = Some(amount);
        self
    }

    pub fn min_amount_out(mut self, amount: Decimal) -> Self {
        self.min_amount_out = Some(amount);
        self
    }

    pub fn target_protocol(mut self, protocol: impl Into<String>) -> Self {
        self.target_protocol = Some(protocol.into());
        self
    }

    pub fn chain_id(mut self, chain_id: u64) -> Self {
        self.chain_id = Some(chain_id);
        self
    }

    pub fn deadline_secs(mut self, secs: i64) -> Self {
        self.deadline_secs = Some(secs);
        self
    }

    pub fn metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = metadata;
        self
    }

    pub fn build(self) -> Result<TradeIntent, TradingError> {
        let now = Utc::now();
        let deadline_secs = self.deadline_secs.unwrap_or(300);

        Ok(TradeIntent {
            id: Uuid::new_v4(),
            strategy_id: self
                .strategy_id
                .ok_or_else(|| TradingError::ConfigError("strategy_id required".into()))?,
            action: self
                .action
                .ok_or_else(|| TradingError::ConfigError("action required".into()))?,
            token_in: self
                .token_in
                .ok_or_else(|| TradingError::ConfigError("token_in required".into()))?,
            token_out: self
                .token_out
                .ok_or_else(|| TradingError::ConfigError("token_out required".into()))?,
            amount_in: self
                .amount_in
                .ok_or_else(|| TradingError::ConfigError("amount_in required".into()))?,
            min_amount_out: self.min_amount_out.unwrap_or(Decimal::ZERO),
            target_protocol: self
                .target_protocol
                .ok_or_else(|| TradingError::ConfigError("target_protocol required".into()))?,
            chain_id: self.chain_id.unwrap_or(42161),
            deadline: now + chrono::Duration::seconds(deadline_secs),
            metadata: self.metadata,
            created_at: now,
        })
    }
}

impl Default for TradeIntentBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// Hash a trade intent for signing
pub fn hash_intent(intent: &TradeIntent) -> String {
    let mut hasher = Keccak256::new();
    hasher.update(intent.id.as_bytes());
    hasher.update(intent.strategy_id.as_bytes());
    hasher.update(intent.token_in.as_bytes());
    hasher.update(intent.token_out.as_bytes());
    hasher.update(intent.amount_in.to_string().as_bytes());
    hasher.update(intent.min_amount_out.to_string().as_bytes());
    hasher.update(intent.target_protocol.as_bytes());
    hasher.update(intent.chain_id.to_be_bytes());
    let result = hasher.finalize();
    format!("0x{}", hex::encode(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_intent() {
        let intent = TradeIntentBuilder::new()
            .strategy_id("test-strategy")
            .action(Action::Swap)
            .token_in("0xTokenA")
            .token_out("0xTokenB")
            .amount_in(Decimal::new(1000, 0))
            .min_amount_out(Decimal::new(990, 0))
            .target_protocol("uniswap_v3")
            .chain_id(42161)
            .build()
            .unwrap();

        assert_eq!(intent.strategy_id, "test-strategy");
        assert_eq!(intent.action, Action::Swap);
        assert_eq!(intent.chain_id, 42161);
    }

    #[test]
    fn test_build_intent_missing_required() {
        let result = TradeIntentBuilder::new().build();
        assert!(result.is_err());
    }

    #[test]
    fn test_hash_intent_deterministic() {
        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let hash1 = hash_intent(&intent);
        let hash2 = hash_intent(&intent);
        assert_eq!(hash1, hash2);
        assert!(hash1.starts_with("0x"));
    }
}
