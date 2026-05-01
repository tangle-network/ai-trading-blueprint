use crate::error::TradingError;
use crate::types::*;
use chrono::Utc;
use rust_decimal::Decimal;
use sha3::{Digest, Keccak256};
use std::collections::BTreeMap;
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

fn canonical_json_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(canonical_json_value).collect())
        }
        serde_json::Value::Object(map) => {
            let sorted = map
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json_value(value)))
                .collect::<BTreeMap<_, _>>();
            serde_json::Value::Object(sorted.into_iter().collect())
        }
        _ => value.clone(),
    }
}

fn update_hash_field(hasher: &mut Keccak256, name: &str, value: &[u8]) {
    hasher.update(name.as_bytes());
    hasher.update([0]);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

/// Hash a trade intent for signing.
///
/// This is the canonical logical trade hash. It intentionally excludes random
/// identifiers and creation time, and includes the signed deadline.
pub fn hash_intent(intent: &TradeIntent) -> String {
    let mut hasher = Keccak256::new();
    update_hash_field(&mut hasher, "version", b"trade-intent-v1");
    update_hash_field(
        &mut hasher,
        "action",
        serde_json::to_string(&intent.action)
            .unwrap_or_default()
            .as_bytes(),
    );
    update_hash_field(&mut hasher, "strategy_id", intent.strategy_id.as_bytes());
    update_hash_field(
        &mut hasher,
        "token_in",
        intent.token_in.to_ascii_lowercase().as_bytes(),
    );
    update_hash_field(
        &mut hasher,
        "token_out",
        intent.token_out.to_ascii_lowercase().as_bytes(),
    );
    update_hash_field(
        &mut hasher,
        "amount_in",
        intent.amount_in.normalize().to_string().as_bytes(),
    );
    update_hash_field(
        &mut hasher,
        "min_amount_out",
        intent.min_amount_out.normalize().to_string().as_bytes(),
    );
    update_hash_field(
        &mut hasher,
        "target_protocol",
        intent.target_protocol.to_ascii_lowercase().as_bytes(),
    );
    update_hash_field(&mut hasher, "chain_id", &intent.chain_id.to_be_bytes());
    update_hash_field(
        &mut hasher,
        "deadline",
        intent.deadline.timestamp().to_string().as_bytes(),
    );
    let metadata = serde_json::to_vec(&canonical_json_value(&intent.metadata)).unwrap_or_default();
    update_hash_field(&mut hasher, "metadata", &metadata);
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

    #[test]
    fn test_hash_intent_same_fields_same_hash_across_rebuilds() {
        let deadline = chrono::DateTime::<Utc>::from_timestamp(1_999_999_999, 0).unwrap();
        let metadata_a = serde_json::json!({"b": 2, "a": {"y": true, "x": "same"}});
        let metadata_b = serde_json::json!({"a": {"x": "same", "y": true}, "b": 2});

        let mut intent_a = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(1000, 1))
            .min_amount_out(Decimal::new(990, 1))
            .target_protocol("Uniswap_V3")
            .chain_id(42161)
            .metadata(metadata_a)
            .build()
            .unwrap();
        let mut intent_b = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xa")
            .token_out("0xb")
            .amount_in(Decimal::new(100, 0))
            .min_amount_out(Decimal::new(99, 0))
            .target_protocol("uniswap_v3")
            .chain_id(42161)
            .metadata(metadata_b)
            .build()
            .unwrap();
        intent_a.deadline = deadline;
        intent_b.deadline = deadline;

        assert_ne!(intent_a.id, intent_b.id);
        assert_ne!(intent_a.created_at, intent_b.created_at);
        assert_eq!(hash_intent(&intent_a), hash_intent(&intent_b));
    }

    #[test]
    fn test_hash_intent_changes_when_deadline_changes() {
        let deadline = chrono::DateTime::<Utc>::from_timestamp(1_999_999_999, 0).unwrap();
        let mut intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();
        intent.deadline = deadline;
        let mut changed = intent.clone();
        changed.deadline = deadline + chrono::Duration::seconds(1);

        assert_ne!(hash_intent(&intent), hash_intent(&changed));
    }
}
