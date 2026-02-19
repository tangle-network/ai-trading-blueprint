use crate::scoring::ScoringResult;
use trading_runtime::TradeIntent;

/// AI provider configuration for risk evaluation.
#[derive(Debug, Clone)]
pub enum AiProvider {
    /// Anthropic API (Claude models)
    Anthropic {
        api_key: String,
        model: String,
    },
    /// Zhipu AI / Z.ai (GLM models) — Z.ai PaaS API
    /// Provider ID: zai-coding-plan
    Zai {
        api_key: String,
        model: String,
        endpoint: String,
    },
}

impl AiProvider {
    pub fn model(&self) -> &str {
        match self {
            AiProvider::Anthropic { model, .. } => model,
            AiProvider::Zai { model, .. } => model,
        }
    }

    pub fn provider_id(&self) -> &str {
        match self {
            AiProvider::Anthropic { .. } => "anthropic",
            AiProvider::Zai { .. } => "zai-coding-plan",
        }
    }
}

/// Return a short strategy context string for known strategy types.
/// Injected into the AI scoring prompt to give the evaluator protocol awareness.
pub fn strategy_context_for(strategy_type: &str) -> Option<String> {
    match strategy_type {
        "prediction"
        | "prediction_politics"
        | "prediction_crypto"
        | "prediction_war"
        | "prediction_trending"
        | "prediction_celebrity" => Some(
            "Polymarket prediction market. Token should be USDC on Polygon. \
             Valid protocols: polymarket. Check condition_id and outcome_index in metadata."
                .to_string(),
        ),
        "dex" => Some(
            "DEX swap. Valid protocols: uniswap_v3. Check real ERC-20 token addresses. \
             Verify fee_tier in metadata. Slippage protection via min_amount_out is critical."
                .to_string(),
        ),
        "yield" => Some(
            "DeFi yield operation. Valid protocols: aave_v3, morpho. Check health factor \
             implications. Supply/withdraw/borrow/repay actions. Verify asset is a real token."
                .to_string(),
        ),
        "perp" => Some(
            "Perpetual futures trade. Valid protocols: gmx_v2, vertex. Max 3x leverage. \
             Must have stop_loss_price in metadata. Check acceptable_price bounds."
                .to_string(),
        ),
        _ => None,
    }
}

fn build_prompt(intent: &TradeIntent, strategy_context: Option<&str>) -> String {
    let context_section = strategy_context
        .map(|ctx| format!("\nStrategy Context: {ctx}\n"))
        .unwrap_or_default();

    format!(
        "Evaluate this trade intent for risk (0-100, higher=safer):\n\
         Action: {:?}\n\
         Token In: {}\n\
         Token Out: {}\n\
         Amount: {}\n\
         Min Output: {}\n\
         Protocol: {}\n\
         Chain: {}\n\
         {context_section}\n\
         Consider:\n\
         - Is the protocol legitimate for this action?\n\
         - Is slippage protection adequate (min_amount_out)?\n\
         - Are the amounts reasonable?\n\
         - Does the action make sense for the protocol?\n\n\
         Respond with JSON only: {{\"score\": <number>, \"reasoning\": \"<text>\"}}",
        intent.action,
        intent.token_in,
        intent.token_out,
        intent.amount_in,
        intent.min_amount_out,
        intent.target_protocol,
        intent.chain_id,
    )
}

fn parse_score_response(content: &str) -> ScoringResult {
    // Try to extract JSON from the response (LLM may wrap it in markdown)
    let json_str = extract_json(content);
    let parsed: serde_json::Value = serde_json::from_str(json_str)
        .unwrap_or(serde_json::json!({"score": 50, "reasoning": "Parse error"}));

    ScoringResult {
        score: parsed["score"].as_u64().unwrap_or(50) as u32,
        reasoning: parsed["reasoning"]
            .as_str()
            .unwrap_or("No reasoning")
            .to_string(),
    }
}

/// Extract JSON object from a string that may contain markdown fences.
fn extract_json(s: &str) -> &str {
    // Try to find ```json ... ``` block
    if let Some(start) = s.find("```json") {
        let after = &s[start + 7..];
        if let Some(end) = after.find("```") {
            return after[..end].trim();
        }
    }
    // Try to find ``` ... ``` block
    if let Some(start) = s.find("```") {
        let after = &s[start + 3..];
        if let Some(end) = after.find("```") {
            return after[..end].trim();
        }
    }
    // Try to find { ... } directly
    if let Some(start) = s.find('{') {
        if let Some(end) = s.rfind('}') {
            return &s[start..=end];
        }
    }
    s.trim()
}

/// Evaluate trade risk using an AI provider.
pub async fn evaluate_risk(
    intent: &TradeIntent,
    provider: &AiProvider,
    strategy_context: Option<&str>,
) -> Result<ScoringResult, String> {
    let prompt = build_prompt(intent, strategy_context);

    match provider {
        AiProvider::Anthropic { api_key, model } => {
            call_anthropic(&prompt, api_key, model).await
        }
        AiProvider::Zai {
            api_key,
            model,
            endpoint,
        } => call_zai(&prompt, api_key, model, endpoint).await,
    }
}

async fn call_anthropic(
    prompt: &str,
    api_key: &str,
    model: &str,
) -> Result<ScoringResult, String> {
    let client = reqwest::Client::new();

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": 200,
            "messages": [{"role": "user", "content": prompt}]
        }))
        .send()
        .await
        .map_err(|e| format!("Anthropic API call failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Anthropic API returned {status}: {body}"));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Anthropic response: {e}"))?;

    let content = body["content"][0]["text"]
        .as_str()
        .unwrap_or("{\"score\": 50, \"reasoning\": \"Could not parse AI response\"}");

    Ok(parse_score_response(content))
}

async fn call_zai(
    prompt: &str,
    api_key: &str,
    model: &str,
    endpoint: &str,
) -> Result<ScoringResult, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": 4096,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": "You are a DeFi trade risk evaluator. Respond with JSON only."},
                {"role": "user", "content": prompt}
            ]
        }))
        .send()
        .await
        .map_err(|e| format!("Z.ai API call failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Z.ai API returned {status}: {body}"));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Z.ai response: {e}"))?;

    let message = &body["choices"][0]["message"];
    let content = message["content"]
        .as_str()
        .unwrap_or("{\"score\": 50, \"reasoning\": \"Empty response from coding API\"}");

    Ok(parse_score_response(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strategy_context_for_known_types() {
        assert!(strategy_context_for("prediction").is_some());
        assert!(strategy_context_for("dex").is_some());
        assert!(strategy_context_for("yield").is_some());
        assert!(strategy_context_for("perp").is_some());

        let ctx = strategy_context_for("prediction").unwrap();
        assert!(ctx.contains("Polymarket"));
        assert!(ctx.contains("USDC"));

        let ctx = strategy_context_for("dex").unwrap();
        assert!(ctx.contains("uniswap_v3"));

        let ctx = strategy_context_for("yield").unwrap();
        assert!(ctx.contains("aave_v3"));
        assert!(ctx.contains("morpho"));

        let ctx = strategy_context_for("perp").unwrap();
        assert!(ctx.contains("gmx_v2"));
        assert!(ctx.contains("3x leverage"));
    }

    #[test]
    fn test_strategy_context_for_prediction_subtypes() {
        for subtype in &[
            "prediction_politics", "prediction_crypto", "prediction_war",
            "prediction_trending", "prediction_celebrity",
        ] {
            let ctx = strategy_context_for(subtype);
            assert!(ctx.is_some(), "{subtype} must return Some context");
            let ctx = ctx.unwrap();
            assert!(ctx.contains("Polymarket"), "{subtype} context must mention Polymarket");
            assert!(ctx.contains("USDC"), "{subtype} context must mention USDC");
        }
    }

    #[test]
    fn test_strategy_context_for_unknown() {
        assert!(strategy_context_for("unknown").is_none());
        assert!(strategy_context_for("multi").is_none());
        assert!(strategy_context_for("").is_none());
    }

    #[test]
    fn test_build_prompt_with_context() {
        use trading_runtime::intent::TradeIntentBuilder;
        use trading_runtime::Action;

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(rust_decimal::Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let prompt_without = build_prompt(&intent, None);
        assert!(!prompt_without.contains("Strategy Context:"));

        let prompt_with = build_prompt(&intent, Some("DEX swap context"));
        assert!(prompt_with.contains("Strategy Context: DEX swap context"));
        assert!(prompt_with.contains("Is the protocol legitimate"));
    }
}
