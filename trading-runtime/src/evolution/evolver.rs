//! Population-based evolution loop. Standard generational GA: evaluate →
//! sort → elitism + tournament selection + mutation → next generation.
//! No crossover (HarnessConfig mixing is tricky to do without breaking
//! semantic coherence; mutation alone explores the neighborhood well on
//! the time budgets we work within).
//!
//! Determinism: given the same seeds, candles, and config, two runs
//! produce bit-identical results. Tested.

use std::time::Instant;

use crate::analytics::Xorshift64;
use crate::backtest::{Candle, HarnessConfig};

use super::fitness::{Fitness, evaluate};
use super::mutator::mutate;

#[derive(Debug, Clone, Copy)]
pub struct EvolutionConfig {
    pub population_size: usize,
    pub generations: usize,
    /// Top-K individuals copied verbatim into the next generation.
    pub elitism: usize,
    /// Tournament size for parent selection.
    pub tournament_size: usize,
    /// PRNG seed — the only source of non-determinism.
    pub seed: u64,
    /// When `true`, the evolver computes the bootstrap-Sharpe-lower-bound
    /// fitness component each generation. ~30× slower but more honest;
    /// turn off during hot search and re-enable for the final top-K.
    pub bootstrap_during_search: bool,
}

impl Default for EvolutionConfig {
    fn default() -> Self {
        Self {
            population_size: 32,
            generations: 12,
            elitism: 4,
            tournament_size: 3,
            seed: 0xC0FFEE,
            bootstrap_during_search: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationStats {
    pub generation: usize,
    pub best_score: f64,
    pub median_score: f64,
    pub worst_score: f64,
    pub best_sharpe: f64,
    pub best_oos_sharpe: f64,
    pub best_n_trades: usize,
    pub valid_count: usize,
    pub eval_seconds: f64,
}

#[derive(Debug, Clone)]
pub struct EvolutionRun {
    pub bot_label: String,
    pub config: EvolutionConfig,
    pub generations: Vec<GenerationStats>,
    /// Final population sorted by composite_score descending.
    pub final_top_k: Vec<(HarnessConfig, Fitness)>,
    pub total_evaluations: usize,
    pub total_wall_seconds: f64,
}

/// Run population-based evolution against `candles` for `cfg.generations`
/// generations. Returns the per-generation stats + the final top-K
/// configs ranked by composite fitness.
pub fn evolve(
    bot_label: impl Into<String>,
    seed_population: Vec<HarnessConfig>,
    candles: &[Candle],
    fee_protocol: &str,
    cfg: EvolutionConfig,
) -> EvolutionRun {
    let started = Instant::now();
    let bot_label = bot_label.into();
    let mut rng = Xorshift64::from_seed(cfg.seed);

    let mut population = seed_population;
    if population.len() < cfg.population_size {
        // Pad with copies of the last seed so the search has a full population.
        let pad = cfg.population_size - population.len();
        let last = population
            .last()
            .cloned()
            .unwrap_or_else(HarnessConfig::default);
        for _ in 0..pad {
            population.push(mutate(&last, &mut rng));
        }
    } else {
        population.truncate(cfg.population_size);
    }

    let mut generations = Vec::with_capacity(cfg.generations);
    let mut total_evals = 0;

    let mut current_fitness: Vec<Fitness> = Vec::with_capacity(cfg.population_size);

    for gen_idx in 0..cfg.generations {
        let t0 = Instant::now();
        current_fitness.clear();
        for h in &population {
            current_fitness.push(evaluate(h, candles, fee_protocol, cfg.bootstrap_during_search));
            total_evals += 1;
        }

        // Build (index, score) for sorting; preserves indices so we can
        // pair configs with their fitness without cloning HarnessConfig.
        let mut order: Vec<usize> = (0..population.len()).collect();
        order.sort_by(|&a, &b| {
            current_fitness[b]
                .composite_score
                .partial_cmp(&current_fitness[a].composite_score)
                .unwrap()
        });

        let scores: Vec<f64> = order.iter().map(|i| current_fitness[*i].composite_score).collect();
        let valid_count = current_fitness.iter().filter(|f| f.n_trades >= 5).count();
        let median = if scores.is_empty() { 0.0 } else { scores[scores.len() / 2] };

        let best_idx = order[0];
        generations.push(GenerationStats {
            generation: gen_idx,
            best_score: current_fitness[best_idx].composite_score,
            median_score: median,
            worst_score: *scores.last().unwrap_or(&0.0),
            best_sharpe: current_fitness[best_idx].sharpe,
            best_oos_sharpe: current_fitness[best_idx].oos_sharpe,
            best_n_trades: current_fitness[best_idx].n_trades,
            valid_count,
            eval_seconds: t0.elapsed().as_secs_f64(),
        });

        // Build next generation, except for the last one (where we want to
        // return the EVALUATED top-K, not their offspring).
        if gen_idx + 1 < cfg.generations {
            let mut next: Vec<HarnessConfig> = Vec::with_capacity(cfg.population_size);
            // Elitism — copy top-K verbatim.
            for i in 0..cfg.elitism.min(order.len()) {
                next.push(population[order[i]].clone());
            }
            // Fill rest by tournament + mutate.
            while next.len() < cfg.population_size {
                let parent = tournament_select(&population, &current_fitness, cfg.tournament_size, &mut rng);
                next.push(mutate(&parent, &mut rng));
            }
            population = next;
        } else {
            // Last gen — reorder population so [0..population_size] is in
            // descending fitness order, then truncate to top-K below.
            population = order.iter().map(|&i| population[i].clone()).collect();
        }
    }

    // Re-evaluate top-K with bootstrap-on regardless of cfg.bootstrap_during_search,
    // so the returned top-K always carry honest CIs.
    let k = cfg.elitism.max(8).min(population.len());
    let mut top_k = Vec::with_capacity(k);
    for h in population.iter().take(k) {
        let f = evaluate(h, candles, fee_protocol, true);
        total_evals += 1;
        top_k.push((h.clone(), f));
    }
    top_k.sort_by(|a, b| b.1.composite_score.partial_cmp(&a.1.composite_score).unwrap());

    EvolutionRun {
        bot_label,
        config: cfg,
        generations,
        final_top_k: top_k,
        total_evaluations: total_evals,
        total_wall_seconds: started.elapsed().as_secs_f64(),
    }
}

/// Pick a parent by k-tournament: sample k random individuals, return the
/// best of them. Larger k = stronger selection pressure.
fn tournament_select(
    population: &[HarnessConfig],
    fitness: &[Fitness],
    k: usize,
    rng: &mut Xorshift64,
) -> HarnessConfig {
    let n = population.len();
    let mut best_idx = (rng.next() as usize) % n;
    let mut best_score = fitness[best_idx].composite_score;
    for _ in 1..k {
        let candidate = (rng.next() as usize) % n;
        if fitness[candidate].composite_score > best_score {
            best_idx = candidate;
            best_score = fitness[candidate].composite_score;
        }
    }
    population[best_idx].clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backtest::HarnessConfig;
    use rust_decimal::Decimal;

    fn synth_candles(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let p = 100.0 + (i as f64) * 0.2 + ((i as f64 * 0.5).sin()) * 1.0;
                Candle {
                    timestamp: 1_700_000_000 + (i as i64) * 3600,
                    token: "T".into(),
                    open: Decimal::from_f64_retain(p).unwrap(),
                    high: Decimal::from_f64_retain(p * 1.01).unwrap(),
                    low: Decimal::from_f64_retain(p * 0.99).unwrap(),
                    close: Decimal::from_f64_retain(p).unwrap(),
                    volume: Decimal::from_f64_retain(50.0).unwrap(),
                }
            })
            .collect()
    }

    #[test]
    fn evolve_runs_and_returns_top_k() {
        let candles = synth_candles(500);
        let cfg = EvolutionConfig {
            population_size: 8,
            generations: 3,
            elitism: 2,
            tournament_size: 2,
            seed: 1,
            bootstrap_during_search: false,
        };
        let seeds = vec![HarnessConfig::default()];
        let run = evolve("test-bot", seeds, &candles, "binance", cfg);
        assert_eq!(run.generations.len(), 3);
        assert!(!run.final_top_k.is_empty());
        assert!(run.total_evaluations >= 8 * 3);
    }

    #[test]
    fn evolve_is_deterministic_with_seed() {
        let candles = synth_candles(500);
        let cfg = EvolutionConfig {
            population_size: 8,
            generations: 3,
            elitism: 2,
            tournament_size: 2,
            seed: 42,
            bootstrap_during_search: false,
        };
        let seeds = vec![HarnessConfig::default()];
        let a = evolve("t", seeds.clone(), &candles, "binance", cfg);
        let b = evolve("t", seeds, &candles, "binance", cfg);
        // Best score after generation 0 should be identical.
        assert_eq!(a.generations[0].best_score, b.generations[0].best_score);
        assert_eq!(a.generations[2].best_score, b.generations[2].best_score);
    }

    #[test]
    fn evolve_improves_best_score_in_expectation() {
        // Run for more generations on the synthetic trending series. The
        // best-of-generation score should be non-decreasing thanks to elitism.
        let candles = synth_candles(800);
        let cfg = EvolutionConfig {
            population_size: 12,
            generations: 5,
            elitism: 3,
            tournament_size: 3,
            seed: 7,
            bootstrap_during_search: false,
        };
        let seeds = vec![HarnessConfig::default()];
        let run = evolve("t", seeds, &candles, "binance", cfg);
        let scores: Vec<f64> = run.generations.iter().map(|g| g.best_score).collect();
        // Elitism guarantees monotonic non-decrease in best_score.
        for w in scores.windows(2) {
            assert!(w[1] >= w[0] - 1e-9, "best score regressed: {scores:?}");
        }
    }
}
