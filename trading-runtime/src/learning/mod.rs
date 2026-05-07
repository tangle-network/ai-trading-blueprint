//! Strategy-level self-improvement primitives.
//!
//! This module contains two cooperating online learners:
//!
//! - [`StrategyBandit`] — a UCB1 multi-arm bandit over strategy variants. The
//!   agent runs each arm, records realised reward (P&L or sharpe), and the
//!   bandit allocates exploitation budget to the best performer.
//! - [`SlippageLearner`] — an EWMA + p95-based recommender for `max_slippage_bps`
//!   per token-pair, with a failure backoff that loosens caps when fills fail.
//!
//! Both structures are pure data + algorithmic helpers; persistence is
//! delegated to `trading-blueprint-lib::state::learning_store`.

pub mod bandit;
pub mod slippage;

pub use bandit::{BanditArm, StrategyBandit};
pub use slippage::{PairKey, PairStats, SlippageLearner};
