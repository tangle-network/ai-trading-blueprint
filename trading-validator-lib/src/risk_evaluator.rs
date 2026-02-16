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

fn build_prompt(intent: &TradeIntent) -> String {
    format!(
        "Evaluate this trade intent for risk (0-100, higher=safer):\n\
         Action: {:?}\n\
         Token In: {}\n\
         Token Out: {}\n\
         Amount: {}\n\
         Min Output: {}\n\
         Protocol: {}\n\
         Chain: {}\n\n\
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
) -> Result<ScoringResult, String> {
    let prompt = build_prompt(intent);

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
