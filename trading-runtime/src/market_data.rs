use crate::error::TradingError;
use crate::types::PriceData;
use chrono::Utc;
use rust_decimal::Decimal;
use serde::Deserialize;

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

impl MarketDataClient {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: reqwest::Client::new(),
        }
    }

    /// Fetch price for a single token
    pub async fn get_price(&self, token: &str) -> Result<PriceData, TradingError> {
        let url = format!("{}/price/{}", self.base_url, token);
        let resp: PriceResponse = self
            .client
            .get(&url)
            .send()
            .await?
            .json()
            .await
            .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?;

        Ok(PriceData {
            token: token.to_string(),
            price_usd: Decimal::try_from(resp.price)
                .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?,
            source: self.base_url.clone(),
            timestamp: Utc::now(),
        })
    }

    /// Fetch prices for multiple tokens
    pub async fn get_prices(&self, tokens: &[String]) -> Result<Vec<PriceData>, TradingError> {
        let futures: Vec<_> = tokens.iter().map(|t| self.get_price(t)).collect();
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
}
