//! In-process strategy evolution — a population-based search over the
//! `HarnessConfig` space, driven entirely by the platform primitives.
//!
//! This is the same loop the production `/evolution/self-improve` route
//! runs on a sidecar, but with no HTTP boundary, no LLM call per
//! generation, and no Docker — the evolver IS the agent for this demo.
//! Mutation + crossover are deterministic given a seed; fitness is the
//! composite of (Sharpe, OOS robustness, drawdown, trade count) computed
//! through the existing `BacktestEngine` and `analytics::*` modules.
//!
//! Three submodules:
//!   * [`mutator`] — pure-Rust mutations of HarnessConfig fields.
//!   * [`fitness`] — composite scoring of a `BacktestResult` against the
//!     promotion gate the playbook uses (Sharpe + OOS gap + DD bound).
//!   * [`evolver`] — population loop: evaluate → elitism + tournament +
//!     mutate → next generation. Records best-of-generation and the
//!     genealogy of the final top-K.

pub mod evolver;
pub mod fitness;
pub mod mutator;

pub use evolver::{EvolutionConfig, EvolutionRun, GenerationStats, evolve};
pub use fitness::{Fitness, evaluate as evaluate_fitness};
pub use mutator::{mutate, random_seed_population};
