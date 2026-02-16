//! Provider-modular trading architecture.
//!
//! Each protocol (Polymarket, Uniswap, Aave, …) is encapsulated as a
//! [`TradingProvider`] that contributes expert prompts, setup commands, env var
//! requirements, and event-specific prompt builders.  Strategy packs compose
//! multiple providers instead of hard-coding giant prompt strings.

pub mod aave;
pub mod coingecko;
pub mod gmx;
pub mod hyperliquid;
pub mod morpho;
pub mod polymarket;
pub mod uniswap;
pub mod vertex;

use std::collections::HashMap;
use std::sync::OnceLock;

/// A data endpoint that a provider uses.
#[derive(Debug, Clone)]
pub struct DataEndpoint {
    pub name: &'static str,
    pub url: &'static str,
    pub description: &'static str,
    pub auth: &'static str,
}

/// Context passed to [`TradingProvider::build_event_prompt`].
pub struct EventContext<'a> {
    pub event_type: &'a str,
    pub data: &'a serde_json::Value,
    pub strategy_config: &'a serde_json::Value,
    pub risk_params: &'a serde_json::Value,
}

/// Trait implemented by each protocol/data provider.
///
/// Providers are zero-size structs that return `&'static str` constants.  Adding
/// a new protocol is as simple as implementing this trait and registering the
/// provider in [`ProviderRegistry::with_builtins`].
pub trait TradingProvider: Send + Sync {
    /// Short identifier, e.g. `"polymarket"`.
    fn id(&self) -> &'static str;

    /// Human-readable name, e.g. `"Polymarket Prediction Markets"`.
    fn name(&self) -> &'static str;

    /// Protocol adapter IDs this provider maps to (e.g. `["uniswap_v3"]`).
    fn protocol_adapters(&self) -> &[&'static str];

    /// Full expert prompt with API URLs, contract addresses, methodology.
    fn expert_prompt(&self) -> &'static str;

    /// 1-4 line summary for generic profile strategy fragments.
    fn strategy_fragment(&self) -> &'static str;

    /// Data API endpoints this provider uses.
    fn data_endpoints(&self) -> &[DataEndpoint];

    /// Provider-specific setup commands (e.g. `pip install py-clob-client`).
    fn setup_commands(&self) -> Vec<String>;

    /// Env vars this provider needs.
    fn required_env_vars(&self) -> &[&'static str];

    /// Event types this provider can handle.
    fn handled_event_types(&self) -> &[&'static str];

    /// Build an event-specific prompt.  Returns `None` for unhandled events.
    fn build_event_prompt(&self, ctx: &EventContext) -> Option<String>;
}

/// Registry of all known trading providers.
pub struct ProviderRegistry {
    providers: HashMap<&'static str, Box<dyn TradingProvider>>,
}

impl ProviderRegistry {
    fn new() -> Self {
        Self {
            providers: HashMap::new(),
        }
    }

    /// Register a provider.  Panics on duplicate IDs (programming error).
    pub fn register(&mut self, provider: Box<dyn TradingProvider>) {
        let id = provider.id();
        if self.providers.contains_key(id) {
            panic!("Duplicate provider ID: {id}");
        }
        self.providers.insert(id, provider);
    }

    /// Look up a provider by ID.
    pub fn get(&self, id: &str) -> Option<&dyn TradingProvider> {
        self.providers.get(id).map(|b| b.as_ref())
    }

    /// All provider IDs.
    pub fn ids(&self) -> Vec<&'static str> {
        let mut ids: Vec<_> = self.providers.keys().copied().collect();
        ids.sort();
        ids
    }

    /// All providers.
    pub fn all(&self) -> Vec<&dyn TradingProvider> {
        self.providers.values().map(|b| b.as_ref()).collect()
    }

    /// Find all providers that handle a given event type.
    pub fn providers_for_event(&self, event_type: &str) -> Vec<&dyn TradingProvider> {
        self.providers
            .values()
            .filter(|p| p.handled_event_types().contains(&event_type))
            .map(|b| b.as_ref())
            .collect()
    }

    /// Build a registry with all built-in providers.
    fn with_builtins() -> Self {
        let mut reg = Self::new();
        reg.register(Box::new(polymarket::PolymarketProvider));
        reg.register(Box::new(uniswap::UniswapV3Provider));
        reg.register(Box::new(aave::AaveV3Provider));
        reg.register(Box::new(morpho::MorphoProvider));
        reg.register(Box::new(gmx::GmxV2Provider));
        reg.register(Box::new(hyperliquid::HyperliquidProvider));
        reg.register(Box::new(vertex::VertexProvider));
        reg.register(Box::new(coingecko::CoinGeckoProvider));
        reg
    }
}

static REGISTRY: OnceLock<ProviderRegistry> = OnceLock::new();

/// Get the global provider registry (lazily initialized with all built-in
/// providers on first access).
pub fn registry() -> &'static ProviderRegistry {
    REGISTRY.get_or_init(ProviderRegistry::with_builtins)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_has_all_builtin_providers() {
        let reg = registry();
        let ids = reg.ids();
        for expected in &[
            "polymarket",
            "uniswap_v3",
            "aave_v3",
            "morpho",
            "gmx_v2",
            "hyperliquid",
            "vertex",
            "coingecko",
        ] {
            assert!(ids.contains(expected), "missing provider: {expected}");
        }
        assert_eq!(ids.len(), 8, "expected exactly 8 built-in providers");
    }

    #[test]
    fn test_provider_ids_are_unique() {
        let reg = registry();
        let ids = reg.ids();
        let mut seen = std::collections::HashSet::new();
        for id in &ids {
            assert!(seen.insert(id), "duplicate provider ID: {id}");
        }
    }

    #[test]
    fn test_each_provider_has_expert_prompt() {
        let reg = registry();
        for p in reg.all() {
            assert!(
                !p.expert_prompt().is_empty(),
                "provider {} has empty expert_prompt",
                p.id()
            );
        }
    }

    #[test]
    fn test_each_provider_has_strategy_fragment() {
        let reg = registry();
        for p in reg.all() {
            assert!(
                !p.strategy_fragment().is_empty(),
                "provider {} has empty strategy_fragment",
                p.id()
            );
        }
    }

    #[test]
    fn test_providers_for_event_routing() {
        let reg = registry();
        let price_move = reg.providers_for_event("price_move");
        let ids: Vec<_> = price_move.iter().map(|p| p.id()).collect();
        assert!(
            ids.contains(&"polymarket"),
            "polymarket should handle price_move events"
        );
    }

    #[test]
    fn test_provider_protocol_adapters_non_empty() {
        let reg = registry();
        for p in reg.all() {
            // coingecko is a data provider, not a protocol adapter
            if p.id() != "coingecko" {
                assert!(
                    !p.protocol_adapters().is_empty(),
                    "provider {} has no protocol adapters",
                    p.id()
                );
            }
        }
    }
}
