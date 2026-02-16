use crate::error::TradingError;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// A token pair for statistical arbitrage
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatArbPair {
    pub token_a: String,
    pub token_b: String,
    pub correlation: Decimal,
    pub spread_mean: Decimal,
    pub spread_std: Decimal,
    pub half_life_hours: Decimal,
}

/// Signal from the stat arb model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatArbSignal {
    pub pair: StatArbPair,
    pub z_score: Decimal,
    pub direction: StatArbDirection,
    pub confidence: Decimal,
    pub suggested_size_pct: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StatArbDirection {
    /// Spread is above mean — short A, long B
    LongSpread,
    /// Spread is below mean — long A, short B
    ShortSpread,
    /// No trade — spread near mean
    Neutral,
}

/// Statistical arbitrage engine for pair detection and signal generation
pub struct StatArbEngine {
    /// Z-score threshold to enter a position
    entry_threshold: Decimal,
    /// Z-score threshold to exit a position
    exit_threshold: Decimal,
    /// Minimum correlation for a pair to be considered
    min_correlation: Decimal,
    /// Maximum half-life in hours for mean reversion
    max_half_life_hours: Decimal,
}

impl StatArbEngine {
    pub fn new(
        entry_threshold: Decimal,
        exit_threshold: Decimal,
        min_correlation: Decimal,
        max_half_life_hours: Decimal,
    ) -> Self {
        Self {
            entry_threshold,
            exit_threshold,
            min_correlation,
            max_half_life_hours,
        }
    }

    /// Evaluate whether a pair qualifies for stat arb
    pub fn qualify_pair(&self, pair: &StatArbPair) -> bool {
        pair.correlation.abs() >= self.min_correlation
            && pair.half_life_hours <= self.max_half_life_hours
            && pair.spread_std > Decimal::ZERO
    }

    /// Generate a trading signal from current spread data
    pub fn generate_signal(
        &self,
        pair: &StatArbPair,
        current_spread: Decimal,
    ) -> Result<StatArbSignal, TradingError> {
        if pair.spread_std == Decimal::ZERO {
            return Err(TradingError::ConfigError(
                "Spread standard deviation cannot be zero".into(),
            ));
        }

        let z_score = (current_spread - pair.spread_mean) / pair.spread_std;

        let direction = if z_score >= self.entry_threshold {
            StatArbDirection::LongSpread
        } else if z_score <= -self.entry_threshold {
            StatArbDirection::ShortSpread
        } else if z_score.abs() <= self.exit_threshold {
            StatArbDirection::Neutral
        } else {
            StatArbDirection::Neutral
        };

        // Confidence scales with z-score magnitude (capped at 1.0)
        let confidence = (z_score.abs() / self.entry_threshold)
            .min(Decimal::new(1, 0));

        // Suggested size: proportional to z-score, capped at 100%
        let suggested_size_pct = (z_score.abs() * Decimal::new(25, 0))
            .min(Decimal::new(100, 0));

        Ok(StatArbSignal {
            pair: pair.clone(),
            z_score,
            direction,
            confidence,
            suggested_size_pct,
        })
    }

    /// Detect pairs from a set of price series correlations
    pub fn detect_pairs(
        &self,
        tokens: &[String],
        correlations: &[(usize, usize, Decimal)],
        spread_stats: &[(usize, usize, Decimal, Decimal, Decimal)], // (i, j, mean, std, half_life)
    ) -> Vec<StatArbPair> {
        let mut pairs = Vec::new();

        for &(i, j, corr) in correlations {
            if i >= tokens.len() || j >= tokens.len() {
                continue;
            }

            // Find matching spread stats
            if let Some(&(_, _, mean, std, half_life)) = spread_stats
                .iter()
                .find(|&&(si, sj, _, _, _)| si == i && sj == j)
            {
                let pair = StatArbPair {
                    token_a: tokens[i].clone(),
                    token_b: tokens[j].clone(),
                    correlation: corr,
                    spread_mean: mean,
                    spread_std: std,
                    half_life_hours: half_life,
                };

                if self.qualify_pair(&pair) {
                    pairs.push(pair);
                }
            }
        }

        pairs
    }
}

impl Default for StatArbEngine {
    fn default() -> Self {
        Self {
            entry_threshold: Decimal::new(2, 0),     // 2.0 sigma
            exit_threshold: Decimal::new(5, 1),      // 0.5 sigma
            min_correlation: Decimal::new(7, 1),     // 0.7
            max_half_life_hours: Decimal::new(72, 0), // 72 hours
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pair() -> StatArbPair {
        StatArbPair {
            token_a: "ETH".into(),
            token_b: "BTC".into(),
            correlation: Decimal::new(85, 2), // 0.85
            spread_mean: Decimal::new(1, 1),  // 0.1
            spread_std: Decimal::new(5, 2),   // 0.05
            half_life_hours: Decimal::new(24, 0),
        }
    }

    #[test]
    fn test_qualify_pair_passes() {
        let engine = StatArbEngine::default();
        let pair = make_pair();
        assert!(engine.qualify_pair(&pair));
    }

    #[test]
    fn test_qualify_pair_low_correlation() {
        let engine = StatArbEngine::default();
        let mut pair = make_pair();
        pair.correlation = Decimal::new(3, 1); // 0.3
        assert!(!engine.qualify_pair(&pair));
    }

    #[test]
    fn test_signal_long_spread() {
        let engine = StatArbEngine::default();
        let pair = make_pair();
        // Current spread is 0.1 + 2.5 * 0.05 = 0.225 (z = 2.5, above entry of 2.0)
        let signal = engine
            .generate_signal(&pair, Decimal::new(225, 3))
            .unwrap();
        assert_eq!(signal.direction, StatArbDirection::LongSpread);
        assert!(signal.z_score > Decimal::new(2, 0));
    }

    #[test]
    fn test_signal_short_spread() {
        let engine = StatArbEngine::default();
        let pair = make_pair();
        // Current spread is 0.1 - 2.5 * 0.05 = -0.025 (z = -2.5)
        let signal = engine
            .generate_signal(&pair, Decimal::new(-25, 3))
            .unwrap();
        assert_eq!(signal.direction, StatArbDirection::ShortSpread);
    }

    #[test]
    fn test_signal_neutral() {
        let engine = StatArbEngine::default();
        let pair = make_pair();
        // Current spread is near mean (z ~ 0)
        let signal = engine
            .generate_signal(&pair, Decimal::new(1, 1))
            .unwrap();
        assert_eq!(signal.direction, StatArbDirection::Neutral);
    }

    #[test]
    fn test_detect_pairs() {
        let engine = StatArbEngine::default();
        let tokens = vec!["ETH".into(), "BTC".into(), "DOGE".into()];
        let correlations = vec![
            (0, 1, Decimal::new(85, 2)), // ETH-BTC: 0.85
            (0, 2, Decimal::new(3, 1)),  // ETH-DOGE: 0.3 (below threshold)
        ];
        let spread_stats = vec![
            (0, 1, Decimal::new(1, 1), Decimal::new(5, 2), Decimal::new(24, 0)),
            (0, 2, Decimal::new(5, 1), Decimal::new(2, 1), Decimal::new(48, 0)),
        ];

        let pairs = engine.detect_pairs(&tokens, &correlations, &spread_stats);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].token_a, "ETH");
        assert_eq!(pairs[0].token_b, "BTC");
    }
}
