use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A trade intent — the primary unit of trading activity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeIntent {
    pub id: Uuid,
    pub strategy_id: String,
    pub action: Action,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: Decimal,
    pub min_amount_out: Decimal,
    pub target_protocol: String,
    pub chain_id: u64,
    pub deadline: DateTime<Utc>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

/// Action types for trade intents
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Swap,
    Supply,
    Withdraw,
    Borrow,
    Repay,
    OpenLong,
    OpenShort,
    CloseLong,
    CloseShort,
    Buy,
    Sell,
    Redeem,
}

/// Portfolio state
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortfolioState {
    pub positions: Vec<Position>,
    pub total_value_usd: Decimal,
    pub unrealized_pnl: Decimal,
    pub realized_pnl: Decimal,
    pub high_water_mark: Decimal,
    pub max_drawdown_pct: Decimal,
    pub last_updated: Option<DateTime<Utc>>,
}

/// Individual position
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub token: String,
    pub amount: Decimal,
    pub entry_price: Decimal,
    pub current_price: Decimal,
    pub unrealized_pnl: Decimal,
    pub protocol: String,
    pub position_type: PositionType,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PositionType {
    Spot,
    Lending,
    Borrowing,
    LongPerp,
    ShortPerp,
    ConditionalToken,
}

/// Strategy definition — supports NL, config, or code
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyDefinition {
    pub id: String,
    pub name: String,
    pub strategy_type: StrategyType,
    pub variant: StrategyVariant,
    pub risk_params: RiskParams,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StrategyType {
    DefiYield,
    DexTrading,
    PredictionMarket,
    PerpTrading,
    MultiStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StrategyVariant {
    NaturalLanguage { prompt: String },
    Config { params: serde_json::Value },
    Code { source: String, language: String },
}

/// Risk parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskParams {
    pub max_position_size_usd: Decimal,
    pub max_drawdown_pct: Decimal,
    pub max_leverage: Decimal,
    pub max_slippage_bps: u32,
    pub max_trades_per_hour: u32,
    pub allowed_tokens: Vec<String>,
    pub allowed_protocols: Vec<String>,
}

impl Default for RiskParams {
    fn default() -> Self {
        Self {
            max_position_size_usd: Decimal::new(10000, 0),
            max_drawdown_pct: Decimal::new(10, 0),
            max_leverage: Decimal::new(1, 0),
            max_slippage_bps: 100,
            max_trades_per_hour: 10,
            allowed_tokens: Vec::new(),
            allowed_protocols: Vec::new(),
        }
    }
}

/// Validation result from validators
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub approved: bool,
    pub aggregate_score: u32,
    pub validator_responses: Vec<ValidatorResponse>,
    pub intent_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorResponse {
    pub validator: String,
    pub score: u32,
    pub signature: String,
    pub reasoning: String,
    /// Chain ID from the EIP-712 domain (if signer was configured)
    #[serde(default)]
    pub chain_id: Option<u64>,
    /// TradeValidator contract address from the EIP-712 domain
    #[serde(default)]
    pub verifying_contract: Option<String>,
    /// ISO 8601 timestamp of when the validator produced this response
    #[serde(default)]
    pub validated_at: Option<String>,
}

/// Market data types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceData {
    pub token: String,
    pub price_usd: Decimal,
    pub source: String,
    pub timestamp: DateTime<Utc>,
}

/// Fee calculation result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeeBreakdown {
    pub performance_fee: Decimal,
    pub management_fee: Decimal,
    pub validator_share: Decimal,
    pub total: Decimal,
}
