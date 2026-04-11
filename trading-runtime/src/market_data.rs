use crate::error::TradingError;
use crate::types::PriceData;
use chrono::Utc;
use rust_decimal::Decimal;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct MarketDataClient {
    base_url: String,
    client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct PriceResponse {
    price: f64,
    #[allow(dead_code)]
    symbol: String,
}

fn normalize_base_url(base_url: &str) -> &str {
    base_url.trim_end_matches('/')
}

fn should_try_coingecko_fallback(base_url: &str) -> bool {
    base_url.contains("coingecko.com") || normalize_base_url(base_url).ends_with("/api/v3")
}

fn normalize_token_key(token: &str) -> String {
    token.trim().to_ascii_lowercase()
}

fn coingecko_id_for_address(chain_id: u64, token: &str) -> Option<&'static str> {
    let token = normalize_token_key(token);
    match chain_id {
        // Local execution fork reuses Ethereum mainnet token addresses.
        1 | 31339 => match token.as_str() {
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" => Some("ethereum"),
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" => Some("usd-coin"),
            "0xdac17f958d2ee523a2206206994597c13d831ec7" => Some("tether"),
            "0x6b175474e89094c44da98b954eedeac495271d0f" => Some("dai"),
            "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" => Some("bitcoin"),
            _ => None,
        },
        _ => None,
    }
}

fn coingecko_id_for_symbol(token: &str) -> Option<&'static str> {
    match token.to_ascii_uppercase().as_str() {
        "ETH" | "WETH" => Some("ethereum"),
        "BTC" | "WBTC" => Some("bitcoin"),
        "USDC" => Some("usd-coin"),
        "USDT" => Some("tether"),
        "DAI" => Some("dai"),
        "ARB" => Some("arbitrum"),
        "OP" => Some("optimism"),
        "MATIC" | "POL" => Some("matic-network"),
        "SOL" => Some("solana"),
        _ => None,
    }
}

fn coingecko_id_for_token(chain_id: Option<u64>, token: &str) -> Option<&'static str> {
    chain_id
        .and_then(|chain_id| coingecko_id_for_address(chain_id, token))
        .or_else(|| coingecko_id_for_address(1, token))
        .or_else(|| coingecko_id_for_symbol(token))
}

#[derive(Debug, Deserialize)]
struct CoinGeckoQuote {
    usd: f64,
}

impl MarketDataClient {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: reqwest::Client::builder()
                .user_agent("TradingBlueprint/1.0 (+https://github.com/tangle-network)")
                .build()
                .expect("market data client"),
        }
    }

    /// Fetch price for a single token
    pub async fn get_price(&self, token: &str) -> Result<PriceData, TradingError> {
        self.get_price_for_chain(None, token).await
    }

    pub async fn get_price_for_chain(
        &self,
        chain_id: Option<u64>,
        token: &str,
    ) -> Result<PriceData, TradingError> {
        let url = format!("{}/price/{}", normalize_base_url(&self.base_url), token);
        let response = self.client.get(&url).send().await?;

        if response.status().is_success() {
            let resp: PriceResponse = response
                .json()
                .await
                .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?;

            return Ok(PriceData {
                token: token.to_string(),
                price_usd: Decimal::try_from(resp.price)
                    .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?,
                source: self.base_url.clone(),
                timestamp: Utc::now(),
            });
        }

        if should_try_coingecko_fallback(&self.base_url) {
            return self.get_price_from_coingecko(chain_id, token).await;
        }

        Err(TradingError::MarketDataUnavailable(format!(
            "market data provider returned {} for token {}",
            response.status(),
            token
        )))
    }

    async fn get_price_from_coingecko(
        &self,
        chain_id: Option<u64>,
        token: &str,
    ) -> Result<PriceData, TradingError> {
        self.get_prices_from_coingecko(chain_id, &[token.to_string()])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| {
                TradingError::MarketDataUnavailable(format!(
                    "CoinGecko response missing usd quote for token {token}"
                ))
            })
    }

    async fn get_prices_from_coingecko(
        &self,
        chain_id: Option<u64>,
        tokens: &[String],
    ) -> Result<Vec<PriceData>, TradingError> {
        let mut token_pairs = Vec::new();
        for token in tokens {
            let coin_id = coingecko_id_for_token(chain_id, token).ok_or_else(|| {
                TradingError::MarketDataUnavailable(format!(
                    "unsupported CoinGecko token mapping for token {token} on chain {:?}",
                    chain_id
                ))
            })?;
            token_pairs.push((token.clone(), coin_id));
        }

        let ids = token_pairs
            .iter()
            .map(|(_, coin_id)| *coin_id)
            .collect::<Vec<_>>()
            .join(",");
        let url = format!("{}/simple/price", normalize_base_url(&self.base_url));
        let response = self
            .client
            .get(&url)
            .query(&[("ids", ids.as_str()), ("vs_currencies", "usd")])
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(TradingError::MarketDataUnavailable(format!(
                "CoinGecko request failed with status {status} for tokens {}",
                tokens.join(",")
            )));
        }

        let body: HashMap<String, CoinGeckoQuote> = response
            .json()
            .await
            .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?;
        let timestamp = Utc::now();
        let mut prices = Vec::new();
        for (token, coin_id) in token_pairs {
            let quote = body.get(coin_id).ok_or_else(|| {
                TradingError::MarketDataUnavailable(format!(
                    "CoinGecko response missing usd quote for token {token}"
                ))
            })?;
            prices.push(PriceData {
                token,
                price_usd: Decimal::try_from(quote.usd)
                    .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?,
                source: url.clone(),
                timestamp,
            });
        }

        Ok(prices)
    }

    /// Fetch prices for multiple tokens
    pub async fn get_prices(&self, tokens: &[String]) -> Result<Vec<PriceData>, TradingError> {
        self.get_prices_for_chain(None, tokens).await
    }

    pub async fn get_prices_for_chain(
        &self,
        chain_id: Option<u64>,
        tokens: &[String],
    ) -> Result<Vec<PriceData>, TradingError> {
        if should_try_coingecko_fallback(&self.base_url) {
            return self.get_prices_from_coingecko(chain_id, tokens).await;
        }

        let futures: Vec<_> = tokens
            .iter()
            .map(|t| self.get_price_for_chain(chain_id, t))
            .collect();
        let results = futures::future::join_all(futures).await;

        let mut prices = Vec::new();
        for result in results {
            match result {
                Ok(price) => prices.push(price),
                Err(e) => {
                    eprintln!("Failed to fetch price: {e}");
                }
            }
        }
        Ok(prices)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn test_get_price() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/price/ETH"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "price": 2500.50,
                "symbol": "ETH"
            })))
            .mount(&mock_server)
            .await;

        let client = MarketDataClient::new(mock_server.uri());
        let price = client.get_price("ETH").await.unwrap();

        assert_eq!(price.token, "ETH");
        assert!(price.price_usd > Decimal::ZERO);
    }

    #[tokio::test]
    async fn test_get_price_falls_back_to_coingecko_simple_price() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/v3/simple/price"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ethereum": { "usd": 2500.50 }
            })))
            .mount(&mock_server)
            .await;

        let client = MarketDataClient::new(format!("{}/api/v3", mock_server.uri()));
        let price = client.get_price("WETH").await.unwrap();

        assert_eq!(price.token, "WETH");
        assert!(price.price_usd > Decimal::ZERO);
        assert!(price.source.ends_with("/simple/price"));
    }

    #[tokio::test]
    async fn test_get_prices_batches_coingecko_lookup() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/v3/simple/price"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ethereum": { "usd": 2500.50 },
                "usd-coin": { "usd": 1.0 }
            })))
            .mount(&mock_server)
            .await;

        let client = MarketDataClient::new(format!("{}/api/v3", mock_server.uri()));
        let prices = client
            .get_prices(&["WETH".to_string(), "USDC".to_string()])
            .await
            .unwrap();

        assert_eq!(prices.len(), 2);
        assert_eq!(prices[0].token, "WETH");
        assert_eq!(prices[1].token, "USDC");
    }

    #[tokio::test]
    async fn test_get_price_falls_back_to_coingecko_for_known_mainnet_token_address() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/v3/simple/price"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "usd-coin": { "usd": 1.0 }
            })))
            .mount(&mock_server)
            .await;

        let client = MarketDataClient::new(format!("{}/api/v3", mock_server.uri()));
        let price = client
            .get_price_for_chain(Some(31339), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
            .await
            .unwrap();

        assert_eq!(price.token, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
        assert_eq!(price.price_usd, Decimal::ONE);
        assert!(price.source.ends_with("/simple/price"));
    }

    #[tokio::test]
    async fn test_get_price_falls_back_to_coingecko_for_known_address_without_chain_id() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/v3/simple/price"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ethereum": { "usd": 2500.50 }
            })))
            .mount(&mock_server)
            .await;

        let client = MarketDataClient::new(format!("{}/api/v3", mock_server.uri()));
        let price = client
            .get_price("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
            .await
            .unwrap();

        assert_eq!(price.token, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
        assert_eq!(price.price_usd.to_string(), "2500.5");
        assert!(price.source.ends_with("/simple/price"));
    }
}
