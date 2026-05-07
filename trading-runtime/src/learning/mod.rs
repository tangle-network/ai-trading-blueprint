//! Strategy-level self-improvement primitives.
//!
//! This module contains two cooperating online learners:
//!
//! - [`StrategyBandit`] — a UCB1 multi-arm bandit over strategy variants. The
//!   agent runs each arm, records realised reward (P&L or sharpe), and the
//!   bandit allocates exploitation budget to the best performer.
//! - [`SlippageLearner`] — a p95+headroom recommender for `max_slippage_bps`
//!   per token-pair, with a failure backoff that loosens caps when fills fail.
//!
//! Both structures are pure data + algorithmic helpers; persistence is
//! handled by `trading-http-api::learning_store` and re-exported through
//! `trading-blueprint-lib::state::learning_store`.

pub mod bandit;
pub mod slippage;

pub use bandit::{BanditArm, StrategyBandit};
pub use slippage::{PairKey, PairStats, SlippageLearner};

use serde::{Deserialize, Serialize};

/// Combined learning state for a single bot — the on-disk wire format shared
/// across the HTTP API and the blueprint lib.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct BotLearningState {
    #[serde(default)]
    pub bandit: StrategyBandit,
    #[serde(default)]
    pub slippage: SlippageLearner,
}
