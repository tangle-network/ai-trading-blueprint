//! Deterministic pure-Rust mutations on `HarnessConfig`. Each mutation is
//! a small, semantically-meaningful tweak (one EMA period, one threshold,
//! one stop-loss %) — large jumps are rare so the search behaves more like
//! local-then-global than wholly random. Every mutation produces a config
//! that passes `HarnessConfig::validate()`; invalid offspring would be
//! filtered out by the evolver, but mutating into invalid territory in
//! the first place is just wasted work.

use crate::analytics::Xorshift64;
use crate::backtest::{
    EntryCondition, EntryRule, ExitRule, HarnessConfig, PositionSizing, SignalType,
};

/// Probability weights of each mutation kind. Keep them in this order;
/// `pick_mutation` indexes into the cumulative sum.
const MUTATION_WEIGHTS: &[(MutationKind, u32)] = &[
    (MutationKind::TweakRsiPeriod, 10),
    (MutationKind::TweakRsiThreshold, 15),
    (MutationKind::TweakEmaPeriods, 15),
    (MutationKind::TweakStopLoss, 10),
    (MutationKind::TweakTakeProfit, 10),
    (MutationKind::TweakEntryThreshold, 8),
    (MutationKind::TweakRuleWeight, 10),
    (MutationKind::TweakPositionSize, 5),
    (MutationKind::AddRule, 5),
    (MutationKind::DropRule, 5),
    (MutationKind::FlipCondition, 5),
    (MutationKind::TweakMaxPositions, 2),
];

#[derive(Debug, Clone, Copy)]
enum MutationKind {
    TweakRsiPeriod,
    TweakRsiThreshold,
    TweakEmaPeriods,
    TweakStopLoss,
    TweakTakeProfit,
    TweakEntryThreshold,
    TweakRuleWeight,
    TweakPositionSize,
    AddRule,
    DropRule,
    FlipCondition,
    TweakMaxPositions,
}

fn pick_mutation(rng: &mut Xorshift64) -> MutationKind {
    let total: u32 = MUTATION_WEIGHTS.iter().map(|(_, w)| w).sum();
    let mut roll = (rng.next() as u32) % total;
    for (kind, w) in MUTATION_WEIGHTS {
        if roll < *w {
            return *kind;
        }
        roll -= *w;
    }
    MUTATION_WEIGHTS[0].0
}

/// Mutate `parent` once and return the offspring. Pure function modulo `rng`.
pub fn mutate(parent: &HarnessConfig, rng: &mut Xorshift64) -> HarnessConfig {
    let mut child = parent.clone();
    child.version = parent.version.saturating_add(1);
    apply(&mut child, pick_mutation(rng), rng);
    // Guarantee invariants: at least one entry rule, at least one exit rule,
    // entry_threshold in [0.05, 0.95], max_positions in [1, 10].
    if child.entry_rules.is_empty() {
        child.entry_rules.push(default_entry_rule());
    }
    if child.exit_rules.is_empty() {
        child.exit_rules.push(ExitRule::StopLoss { pct: 5.0 });
    }
    child.entry_threshold = child.entry_threshold.clamp(0.05, 0.95);
    child.max_positions = child.max_positions.clamp(1, 10);
    child
}

fn apply(c: &mut HarnessConfig, kind: MutationKind, rng: &mut Xorshift64) {
    match kind {
        MutationKind::TweakRsiPeriod => {
            for rule in c.entry_rules.iter_mut() {
                if let SignalType::Rsi { period } = &mut rule.signal {
                    *period = clamp_usize(*period as i64 + jitter(rng, 4), 5, 50);
                    return;
                }
            }
        }
        MutationKind::TweakRsiThreshold => {
            for rule in c.entry_rules.iter_mut() {
                if matches!(rule.signal, SignalType::Rsi { .. }) {
                    match &mut rule.condition {
                        EntryCondition::Below { threshold } => {
                            *threshold = (*threshold + jitter_f(rng, 8.0)).clamp(5.0, 45.0);
                        }
                        EntryCondition::Above { threshold } => {
                            *threshold = (*threshold + jitter_f(rng, 8.0)).clamp(55.0, 95.0);
                        }
                        _ => {}
                    }
                    return;
                }
            }
        }
        MutationKind::TweakEmaPeriods => {
            for rule in c.entry_rules.iter_mut() {
                if let SignalType::EmaCross { short_period, long_period } = &mut rule.signal {
                    let new_short = clamp_usize(*short_period as i64 + jitter(rng, 3), 3, 50);
                    let new_long = clamp_usize(*long_period as i64 + jitter(rng, 5), 10, 200);
                    if new_short < new_long {
                        *short_period = new_short;
                        *long_period = new_long;
                    }
                    return;
                }
            }
        }
        MutationKind::TweakStopLoss => {
            for rule in c.exit_rules.iter_mut() {
                if let ExitRule::StopLoss { pct } = rule {
                    *pct = (*pct + jitter_f(rng, 2.0)).clamp(1.0, 15.0);
                    return;
                }
            }
        }
        MutationKind::TweakTakeProfit => {
            for rule in c.exit_rules.iter_mut() {
                if let ExitRule::TakeProfit { pct } = rule {
                    *pct = (*pct + jitter_f(rng, 4.0)).clamp(2.0, 30.0);
                    return;
                }
            }
        }
        MutationKind::TweakEntryThreshold => {
            c.entry_threshold = (c.entry_threshold + jitter_f(rng, 0.2)).clamp(0.05, 0.95);
        }
        MutationKind::TweakRuleWeight => {
            if let Some(idx) = pick_index(c.entry_rules.len(), rng) {
                let rule = &mut c.entry_rules[idx];
                rule.weight = (rule.weight + jitter_f(rng, 0.3)).clamp(0.05, 1.0);
            }
        }
        MutationKind::TweakPositionSize => {
            if let PositionSizing::FixedFraction { fraction } = &mut c.position_sizing {
                *fraction = (*fraction + jitter_f(rng, 0.04)).clamp(0.02, 0.4);
            }
        }
        MutationKind::AddRule => {
            if c.entry_rules.len() < 5 {
                let rule = random_entry_rule(rng);
                c.entry_rules.push(rule);
            }
        }
        MutationKind::DropRule => {
            if c.entry_rules.len() > 1 {
                let idx = pick_index(c.entry_rules.len(), rng).unwrap_or(0);
                c.entry_rules.remove(idx);
            }
        }
        MutationKind::FlipCondition => {
            for rule in c.entry_rules.iter_mut() {
                match &mut rule.condition {
                    EntryCondition::CrossAbove => {
                        rule.condition = EntryCondition::CrossBelow;
                        return;
                    }
                    EntryCondition::CrossBelow => {
                        rule.condition = EntryCondition::CrossAbove;
                        return;
                    }
                    EntryCondition::Below { threshold } => {
                        // Flip to "Above" with the symmetric threshold around 50.
                        let t = 100.0 - *threshold;
                        rule.condition = EntryCondition::Above { threshold: t };
                        return;
                    }
                    EntryCondition::Above { threshold } => {
                        let t = 100.0 - *threshold;
                        rule.condition = EntryCondition::Below { threshold: t };
                        return;
                    }
                    _ => {}
                }
            }
        }
        MutationKind::TweakMaxPositions => {
            let delta = jitter(rng, 2);
            c.max_positions = clamp_usize(c.max_positions as i64 + delta, 1, 10);
        }
    }
}

fn default_entry_rule() -> EntryRule {
    EntryRule {
        signal: SignalType::Rsi { period: 14 },
        condition: EntryCondition::Below { threshold: 30.0 },
        weight: 0.5,
        tokens: vec![],
    }
}

fn random_entry_rule(rng: &mut Xorshift64) -> EntryRule {
    let kind = (rng.next() % 4) as u8;
    let signal = match kind {
        0 => SignalType::Rsi {
            period: 10 + (rng.next() as usize) % 16,
        },
        1 => SignalType::EmaCross {
            short_period: 5 + (rng.next() as usize) % 15,
            long_period: 20 + (rng.next() as usize) % 60,
        },
        2 => SignalType::PriceMomentum {
            lookback_candles: 5 + (rng.next() as usize) % 20,
        },
        _ => SignalType::AtrBreakout {
            period: 10 + (rng.next() as usize) % 8,
            multiplier: 1.0 + (rng.next() % 30) as f64 / 10.0,
        },
    };
    let condition = if matches!(signal, SignalType::EmaCross { .. }) {
        EntryCondition::CrossAbove
    } else if matches!(signal, SignalType::Rsi { .. }) {
        EntryCondition::Below {
            threshold: 20.0 + (rng.next() % 20) as f64,
        }
    } else {
        EntryCondition::Positive
    };
    EntryRule {
        signal,
        condition,
        weight: 0.2 + (rng.next() % 8) as f64 / 10.0,
        tokens: vec![],
    }
}

fn jitter(rng: &mut Xorshift64, range: i64) -> i64 {
    // Uniform in [-range, +range].
    (rng.next() as i64).rem_euclid(2 * range + 1) - range
}

fn jitter_f(rng: &mut Xorshift64, range: f64) -> f64 {
    // Uniform in [-range, +range].
    let u = (rng.next() as f64) / (u64::MAX as f64);
    (u * 2.0 - 1.0) * range
}

fn pick_index(len: usize, rng: &mut Xorshift64) -> Option<usize> {
    if len == 0 { None } else { Some((rng.next() as usize) % len) }
}

fn clamp_usize(v: i64, lo: i64, hi: i64) -> usize {
    v.clamp(lo, hi) as usize
}

/// Build a seed population by taking each `seed` config and applying a
/// random walk of `mutations_per_member` mutations to copies of it. The
/// resulting `population_size` configs are deterministic given the seed.
pub fn random_seed_population(
    seeds: &[HarnessConfig],
    population_size: usize,
    mutations_per_member: usize,
    rng_seed: u64,
) -> Vec<HarnessConfig> {
    let mut rng = Xorshift64::from_seed(rng_seed);
    let mut out = Vec::with_capacity(population_size);
    // Include the seeds verbatim first — never lose the hand-tuned baseline.
    for s in seeds {
        if out.len() >= population_size {
            break;
        }
        out.push(s.clone());
    }
    while out.len() < population_size {
        let base = &seeds[(rng.next() as usize) % seeds.len()];
        let mut mutant = base.clone();
        for _ in 0..mutations_per_member {
            mutant = mutate(&mutant, &mut rng);
        }
        out.push(mutant);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn baseline() -> HarnessConfig {
        HarnessConfig::default()
    }

    #[test]
    fn mutate_preserves_invariants() {
        let mut rng = Xorshift64::from_seed(1);
        let mut current = baseline();
        for _ in 0..500 {
            current = mutate(&current, &mut rng);
            assert!(!current.entry_rules.is_empty(), "entry rules empty");
            assert!(!current.exit_rules.is_empty(), "exit rules empty");
            assert!(current.entry_threshold >= 0.05 && current.entry_threshold <= 0.95);
            assert!(current.max_positions >= 1 && current.max_positions <= 10);
            // The config must always validate — `validate` is what the
            // backtest engine checks before running.
            assert!(
                current.validate().is_ok(),
                "invalid mutant: {:?}",
                current.validate().err()
            );
        }
    }

    #[test]
    fn mutate_is_deterministic_with_seed() {
        let mut rng_a = Xorshift64::from_seed(42);
        let mut rng_b = Xorshift64::from_seed(42);
        let p = baseline();
        let a = mutate(&p, &mut rng_a);
        let b = mutate(&p, &mut rng_b);
        // Serde-compare for equality.
        let a_json = serde_json::to_string(&a).unwrap();
        let b_json = serde_json::to_string(&b).unwrap();
        assert_eq!(a_json, b_json);
    }

    #[test]
    fn random_seed_population_includes_seeds_verbatim() {
        let seeds = vec![baseline()];
        let pop = random_seed_population(&seeds, 8, 3, 7);
        assert_eq!(pop.len(), 8);
        // First element is the seed unchanged.
        let seed_json = serde_json::to_string(&seeds[0]).unwrap();
        let first_json = serde_json::to_string(&pop[0]).unwrap();
        assert_eq!(seed_json, first_json);
    }

    #[test]
    fn random_seed_population_produces_diverse_offspring() {
        let seeds = vec![baseline()];
        let pop = random_seed_population(&seeds, 20, 5, 11);
        let unique: std::collections::HashSet<String> = pop
            .iter()
            .map(|c| serde_json::to_string(c).unwrap())
            .collect();
        // With 5 mutations per member and 20 members, expect heavy diversity.
        assert!(unique.len() >= 10, "only {} unique configs", unique.len());
    }
}
