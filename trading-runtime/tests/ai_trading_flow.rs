//! End-to-end AI trading flow integration test.
//!
//! 1. Calls GLM-5 (Zhipu AI) acting as the sidecar trading agent to generate
//!    trade recommendations from market data.
//! 2. Parses the LLM output into `TradeIntent`s.
//! 3. Fans out to 3 validator HTTP servers — each uses GLM-5 for AI risk
//!    scoring + EIP-712 signing.
//! 4. Submits 2-of-3 signatures to on-chain `TradeValidator` contract.
//! 5. Verifies on-chain approval.
//!
//! Requires:
//! - `ZAI_API_KEY` set (via `.env` or environment)
//! - `forge build` to have been run (reads bytecode from contracts/out/)
//! - Anvil available in PATH

use alloy::node_bindings::Anvil;
use alloy::primitives::{Address, Bytes, FixedBytes, TxKind, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::network::EthereumWallet;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use trading_runtime::validator_client::ValidatorClient;
use trading_runtime::intent::TradeIntentBuilder;
use trading_runtime::Action;
use trading_validator_lib::risk_evaluator::AiProvider;

// ── Solidity bindings ────────────────────────────────────────────────────────

sol! {
    #[sol(rpc)]
    interface TradeValidator {
        function configureVault(address vault, address[] calldata signers, uint256 requiredSigs) external;
        function validateWithSignatures(
            bytes32 intentHash, address vault, bytes[] calldata signatures,
            uint256[] calldata scores, uint256 deadline
        ) external view returns (bool approved, uint256 validCount);
        function getRequiredSignatures(address vault) external view returns (uint256);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn load_bytecode(contract_name: &str) -> Vec<u8> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let out_dir = format!("{manifest_dir}/../contracts/out");
    let primary = format!("{out_dir}/{contract_name}.sol/{contract_name}.json");
    let fallback = format!("{out_dir}/Setup.sol/{contract_name}.json");

    let path = if std::path::Path::new(&primary).exists() {
        primary
    } else if std::path::Path::new(&fallback).exists() {
        fallback
    } else {
        panic!("Cannot find artifact for {contract_name} in {out_dir}. Run `forge build` first.");
    };

    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let bytecode_hex = json["bytecode"]["object"]
        .as_str()
        .expect("bytecode.object missing")
        .strip_prefix("0x")
        .expect("bytecode should start with 0x");
    hex::decode(bytecode_hex).expect("invalid bytecode hex")
}

async fn deploy_contract(
    provider: &impl Provider,
    bytecode: Vec<u8>,
    constructor_args: Vec<u8>,
) -> Address {
    let mut deploy_data = bytecode;
    deploy_data.extend_from_slice(&constructor_args);
    let mut tx = alloy::rpc::types::TransactionRequest::default()
        .input(alloy::rpc::types::TransactionInput::both(Bytes::from(deploy_data)));
    tx.to = Some(TxKind::Create);
    let pending = provider.send_transaction(tx).await.expect("deploy tx send failed");
    let receipt = pending.get_receipt().await.expect("deploy tx receipt failed");
    receipt.contract_address.expect("no contract address in receipt")
}

/// Call an OpenAI-compatible LLM API (Zhipu GLM-5).
async fn call_llm(api_key: &str, endpoint: &str, model: &str, system: &str, user: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "temperature": 0.3,
            "max_tokens": 8192,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ]
        }))
        .send()
        .await
        .map_err(|e| format!("LLM API call failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("LLM API returned {status}: {body}"));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse LLM response: {e}"))?;

    let message = &body["choices"][0]["message"];
    let content = message["content"].as_str().unwrap_or("");
    if !content.is_empty() {
        return Ok(content.to_string());
    }
    let has_reasoning = message["reasoning_content"].as_str().map_or(false, |r| !r.is_empty());
    if has_reasoning {
        return Err("Model exhausted tokens on thinking — increase max_tokens".into());
    }
    Err(format!("Empty LLM response. Full body: {body}"))
}

/// Extract JSON array from a string (handles markdown fences).
fn extract_json_array(s: &str) -> &str {
    if let Some(start) = s.find("```json") {
        let after = &s[start + 7..];
        if let Some(end) = after.find("```") {
            return after[..end].trim();
        }
    }
    if let Some(start) = s.find("```") {
        let after = &s[start + 3..];
        if let Some(end) = after.find("```") {
            return after[..end].trim();
        }
    }
    if let Some(start) = s.find('[') {
        if let Some(end) = s.rfind(']') {
            return &s[start..=end];
        }
    }
    s.trim()
}

// ── Main test ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_ai_trading_flow() {
    // Load .env
    dotenv::dotenv().ok();

    let api_key = match std::env::var("ZAI_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => {
            eprintln!("SKIPPING test_ai_trading_flow: ZAI_API_KEY not set");
            return;
        }
    };

    let endpoint = std::env::var("AI_API_ENDPOINT")
        .unwrap_or_else(|_| "https://api.z.ai/api/coding/paas/v4".to_string());
    let model = std::env::var("AI_MODEL")
        .unwrap_or_else(|_| "glm-4.7".to_string());

    println!("\n============================================================");
    println!("  AI TRADING FLOW — End-to-End Integration Test");
    println!("  Provider: Zhipu AI | Model: {model}");
    println!("============================================================\n");

    // ── 1. Start Anvil + deploy TradeValidator ───────────────────────────────
    println!("[1/6] Starting Anvil and deploying TradeValidator...");
    let anvil = Anvil::new().try_spawn().expect("Failed to spawn Anvil");
    let rpc_url = anvil.endpoint();

    let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
    let deployer_wallet = EthereumWallet::from(deployer_key.clone());
    let deployer_provider = ProviderBuilder::new()
        .wallet(deployer_wallet)
        .connect_http(rpc_url.parse().unwrap());

    let tv_addr = deploy_contract(&deployer_provider, load_bytecode("TradeValidator"), vec![]).await;
    println!("       TradeValidator deployed at: {tv_addr}");

    // 3 validator keys from Anvil
    let val_keys: Vec<PrivateKeySigner> = (3..6)
        .map(|i| anvil.keys()[i].clone().into())
        .collect();
    let val_addrs: Vec<Address> = val_keys.iter().map(|k| k.address()).collect();

    let mock_vault = Address::from([0xAA; 20]);
    let tv = TradeValidator::new(tv_addr, &deployer_provider);
    tv.configureVault(mock_vault, val_addrs.clone(), U256::from(2))
        .send().await.unwrap()
        .get_receipt().await.unwrap();
    println!("       Vault configured: 2-of-3 multisig");

    // ── 2. Start 3 validator HTTP servers ────────────────────────────────────
    println!("[2/6] Starting 3 validator HTTP servers with AI scoring...");

    let ai_provider = AiProvider::Zai {
        api_key: api_key.clone(),
        model: model.clone(),
        endpoint: endpoint.clone(),
    };

    let mut validator_endpoints = Vec::new();
    for (i, _key) in val_keys.iter().enumerate() {
        let key_hex = hex::encode(anvil.keys()[i + 3].to_bytes());
        let server = trading_validator_lib::server::ValidatorServer::new(0)
            .with_ai_provider(ai_provider.clone())
            .with_signer(&key_hex, 31337, tv_addr)
            .expect("Signer creation should succeed");

        let router = server.router();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        validator_endpoints.push(format!("http://127.0.0.1:{port}"));
        println!("       Validator {} at port {port} ({})", i + 1, val_addrs[i]);

        tokio::spawn(async move {
            axum::serve(listener, router).await.ok();
        });
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // ── 3. Call GLM-5 as the trading agent ───────────────────────────────────
    println!("[3/6] Calling {model} to generate trading recommendations...\n");

    let system_prompt = "\
You are a DeFi trading analyst. Given market data, generate trade recommendations.
Each recommendation must be a JSON object with these exact fields:
- action: one of \"swap\", \"supply\", \"borrow\"
- token_in: token address or symbol being sent
- token_out: token address or symbol being received
- amount_in: numeric amount as a string (e.g. \"500\")
- min_amount_out: minimum expected output as a string
- target_protocol: one of \"uniswap_v3\", \"aave_v3\"
- reasoning: brief explanation

Respond with a JSON array of 1-2 recommendations. No extra text outside the JSON.";

    let user_prompt = "\
Current market data:
- ETH: $2,500.00
- BTC: $65,000.00
- USDC: $1.00
- WBTC: $64,950.00

Available protocols: uniswap_v3 (swaps), aave_v3 (lending/borrowing)
Chain: Ethereum (chain_id: 1)
Vault balance: 10,000 USDC

Analyze the market and generate trade recommendations.";

    let llm_response = match call_llm(&api_key, &endpoint, &model, system_prompt, user_prompt).await {
        Ok(resp) => resp,
        Err(e) if e.contains("429") || e.contains("Insufficient balance") || e.contains("quota") => {
            eprintln!("SKIPPING test_ai_trading_flow: Z.ai API quota/balance issue: {e}");
            eprintln!("Please recharge your ZAI account at https://open.bigmodel.cn");
            return;
        }
        Err(e) => panic!("LLM call failed: {e}"),
    };

    println!("  --- GLM-5 Raw Response ---");
    println!("  {}", llm_response.replace('\n', "\n  "));
    println!();

    // ── 4. Parse LLM output into TradeIntents ────────────────────────────────
    println!("[4/6] Parsing AI recommendations into TradeIntents...\n");

    let json_str = extract_json_array(&llm_response);
    let recommendations: Vec<serde_json::Value> = serde_json::from_str(json_str)
        .unwrap_or_else(|e| panic!("Failed to parse LLM JSON: {e}\nRaw: {json_str}"));

    assert!(!recommendations.is_empty(), "LLM should generate at least 1 recommendation");

    let mut intents = Vec::new();
    for (i, rec) in recommendations.iter().enumerate() {
        let action_str = rec["action"].as_str().unwrap_or("swap");
        let action = match action_str {
            "swap" => Action::Swap,
            "supply" => Action::Supply,
            "borrow" => Action::Borrow,
            "withdraw" => Action::Withdraw,
            other => {
                println!("  Skipping unknown action: {other}");
                continue;
            }
        };

        let amount_str = rec["amount_in"].as_str().unwrap_or("100");
        let amount: rust_decimal::Decimal = amount_str.parse().unwrap_or(rust_decimal::Decimal::new(100, 0));
        let min_out_str = rec["min_amount_out"].as_str().unwrap_or("0");
        let min_out: rust_decimal::Decimal = min_out_str.parse().unwrap_or(rust_decimal::Decimal::ZERO);

        let intent = TradeIntentBuilder::new()
            .strategy_id("ai-glm5-dex")
            .action(action)
            .token_in(rec["token_in"].as_str().unwrap_or("USDC"))
            .token_out(rec["token_out"].as_str().unwrap_or("ETH"))
            .amount_in(amount)
            .min_amount_out(min_out)
            .target_protocol(rec["target_protocol"].as_str().unwrap_or("uniswap_v3"))
            .build()
            .unwrap();

        let reasoning = rec["reasoning"].as_str().unwrap_or("N/A");
        println!("  Intent {}: {:?} {} {} → {} on {}",
            i + 1, intent.action, intent.amount_in, intent.token_in, intent.token_out, intent.target_protocol);
        println!("    AI reasoning: {reasoning}");

        intents.push(intent);
    }
    println!();

    assert!(!intents.is_empty(), "Should have parsed at least 1 intent");

    // ── 5. Fan out to validators for scoring + signing ───────────────────────
    println!("[5/6] Sending intents to validators for AI scoring + signing...\n");

    let client = ValidatorClient::new(validator_endpoints, 50)
        .with_timeout(std::time::Duration::from_secs(120));

    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;

    // Process the first intent through the full flow
    let intent = &intents[0];

    let result = client
        .validate(intent, &format!("{mock_vault}"), deadline)
        .await
        .expect("Validation should succeed");

    assert_eq!(result.validator_responses.len(), 3, "All 3 validators should respond");

    for (i, resp) in result.validator_responses.iter().enumerate() {
        println!("  Validator {}: score={}, reasoning=\"{}\"",
            i + 1, resp.score, resp.reasoning);
        assert!(resp.signature.starts_with("0x"), "Signature should be hex");
        let zero_sig = format!("0x{}", "00".repeat(65));
        assert_ne!(resp.signature, zero_sig, "Signature should not be all zeros");
    }
    println!("\n  Aggregate: approved={}, average_score={}\n",
        result.approved, result.aggregate_score);

    // ── 6. On-chain verification ─────────────────────────────────────────────
    println!("[6/6] Submitting signatures to on-chain TradeValidator...\n");

    let intent_hash_hex = &result.intent_hash;
    let intent_hash_stripped = intent_hash_hex.strip_prefix("0x").unwrap_or(intent_hash_hex);
    let intent_hash_bytes = hex::decode(intent_hash_stripped).unwrap();
    let mut intent_hash = [0u8; 32];
    intent_hash.copy_from_slice(&intent_hash_bytes);
    let intent_hash_fixed = FixedBytes::<32>::from(intent_hash);

    // Take first 2 signatures (2-of-3)
    let mut signatures = Vec::new();
    let mut scores = Vec::new();
    for resp in result.validator_responses.iter().take(2) {
        let sig_hex = resp.signature.strip_prefix("0x").unwrap_or(&resp.signature);
        signatures.push(Bytes::from(hex::decode(sig_hex).unwrap()));
        scores.push(U256::from(resp.score));
    }

    let on_chain = tv
        .validateWithSignatures(
            intent_hash_fixed,
            mock_vault,
            signatures,
            scores,
            U256::from(deadline),
        )
        .call()
        .await
        .unwrap();

    println!("  Intent hash: {intent_hash_hex}");
    println!("  Signatures submitted: 2 of 3");
    println!("  On-chain result: approved={}, validCount={}", on_chain.approved, on_chain.validCount);

    assert!(on_chain.approved, "On-chain validation should pass with 2-of-3 sigs");
    assert_eq!(on_chain.validCount, U256::from(2), "Should have 2 valid signatures");

    println!("\n============================================================");
    println!("  PASS — Full AI trading flow completed successfully");
    println!("  Model: {model} | Validators: 3 (2-of-3 multisig)");
    println!("============================================================\n");
}
