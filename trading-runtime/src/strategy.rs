use crate::error::TradingError;
use crate::types::{RiskParams, StrategyDefinition, StrategyType, StrategyVariant};

impl StrategyDefinition {
    /// Create a new NL-based strategy
    pub fn natural_language(
        name: impl Into<String>,
        strategy_type: StrategyType,
        prompt: impl Into<String>,
        risk_params: RiskParams,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            strategy_type,
            variant: StrategyVariant::NaturalLanguage {
                prompt: prompt.into(),
            },
            risk_params,
        }
    }

    /// Create a config-based strategy
    pub fn config(
        name: impl Into<String>,
        strategy_type: StrategyType,
        params: serde_json::Value,
        risk_params: RiskParams,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            strategy_type,
            variant: StrategyVariant::Config { params },
            risk_params,
        }
    }

    /// Create a code-based strategy
    pub fn code(
        name: impl Into<String>,
        strategy_type: StrategyType,
        source: impl Into<String>,
        language: impl Into<String>,
        risk_params: RiskParams,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            strategy_type,
            variant: StrategyVariant::Code {
                source: source.into(),
                language: language.into(),
            },
            risk_params,
        }
    }

    /// Validate strategy configuration
    pub fn validate(&self) -> Result<(), TradingError> {
        if self.name.is_empty() {
            return Err(TradingError::ConfigError(
                "Strategy name cannot be empty".into(),
            ));
        }

        match &self.variant {
            StrategyVariant::NaturalLanguage { prompt } => {
                if prompt.is_empty() {
                    return Err(TradingError::ConfigError(
                        "NL prompt cannot be empty".into(),
                    ));
                }
            }
            StrategyVariant::Config { params } => {
                if params.is_null() {
                    return Err(TradingError::ConfigError(
                        "Config params cannot be null".into(),
                    ));
                }
            }
            StrategyVariant::Code { source, language } => {
                if source.is_empty() || language.is_empty() {
                    return Err(TradingError::ConfigError(
                        "Code source and language required".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nl_strategy() {
        let strategy = StrategyDefinition::natural_language(
            "ETH Momentum",
            StrategyType::DexTrading,
            "Buy ETH when RSI < 30, sell when RSI > 70",
            RiskParams::default(),
        );
        assert!(strategy.validate().is_ok());
        assert_eq!(strategy.strategy_type, StrategyType::DexTrading);
    }

    #[test]
    fn test_config_strategy() {
        let strategy = StrategyDefinition::config(
            "Yield Optimizer",
            StrategyType::DefiYield,
            serde_json::json!({
                "min_apy": 5.0,
                "protocols": ["aave", "morpho"],
                "rebalance_threshold_pct": 2.0
            }),
            RiskParams::default(),
        );
        assert!(strategy.validate().is_ok());
    }

    #[test]
    fn test_empty_name_fails() {
        let strategy = StrategyDefinition::natural_language(
            "",
            StrategyType::DexTrading,
            "some prompt",
            RiskParams::default(),
        );
        assert!(strategy.validate().is_err());
    }
}
