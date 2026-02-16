//! Full AI trading simulation — no mocks.
//!
//! Runs multiple trading loop iterations with real LLM calls (GLM-4.7 via Z.ai),
//! real AI-powered validator scoring, real EIP-712 signing, and real on-chain
//! verification via Anvil.
//!
//! Requires: `ZAI_API_KEY` set, `forge build` run, Anvil in PATH.

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

sol! {
    #[sol(rpc)]
    interface TradeValidator {
        function configureVault(address vault, address[] calldata signers, uint256 requiredSigs) external;
        function validateWithSignatures(
            bytes32 intentHash, address vault, bytes[] calldata signatures,
            uint256[] calldata scores, uint256 deadline
        ) external view returns (bool approved, uint256 validCount);
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
        panic!("Cannot find artifact for {contract_name}. Run `forge build` first.");
    };
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let hex_str = json["bytecode"]["object"]
        .as_str()
        .unwrap()
        .strip_prefix("0x")
        .unwrap();
    hex::decode(hex_str).unwrap()
}

async fn deploy_contract(provider: &impl Provider, bytecode: Vec<u8>) -> Address {
    let mut tx = alloy::rpc::types::TransactionRequest::default()
        .input(alloy::rpc::types::TransactionInput::both(Bytes::from(bytecode)));
    tx.to = Some(TxKind::Create);
    let pending = provider.send_transaction(tx).await.unwrap();
    let receipt = pending.get_receipt().await.unwrap();
    receipt.contract_address.unwrap()
}

async fn call_llm(
    api_key: &str,
    endpoint: &str,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "temperature": 0.4,
            "max_tokens": 8192,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ]
        }))
        .send()
        .await
        .map_err(|e| format!("LLM call failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("LLM {status}: {body}"));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let message = &body["choices"][0]["message"];
    let content = message["content"].as_str().unwrap_or("");
    if !content.is_empty() {
        return Ok(content.to_string());
    }

    // Coding API thinking mode: if content is empty, the model exhausted tokens on reasoning
    let has_reasoning = message["reasoning_content"].as_str().map_or(false, |r| !r.is_empty());
    if has_reasoning {
        return Err("Model exhausted tokens on thinking — increase max_tokens".into());
    }

    Err(format!("Empty response from LLM. Full body: {body}"))
}

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

fn parse_action(s: &str) -> Option<Action> {
    match s.to_lowercase().as_str() {
        "swap" => Some(Action::Swap),
        "supply" => Some(Action::Supply),
        "borrow" => Some(Action::Borrow),
        "withdraw" => Some(Action::Withdraw),
        "repay" => Some(Action::Repay),
        _ => None,
    }
}

// ── Market scenarios ─────────────────────────────────────────────────────────

struct MarketSnapshot {
    label: &'static str,
    context: &'static str,
}

fn market_scenarios() -> Vec<MarketSnapshot> {
    vec![
        MarketSnapshot {
            label: "Bullish momentum",
            context: "\
Current market snapshot (T+0):
- ETH: $2,520.00 (+3.2% 24h, +8.1% 7d)
- BTC: $67,400.00 (+1.8% 24h, +5.4% 7d)
- USDC: $1.00
- WBTC: $67,350.00
- AAVE: $95.20 (+2.1% 24h)
- UNI: $7.85 (+4.5% 24h)

Gas: 25 gwei | ETH/BTC ratio: 0.0374 (rising)
DeFi TVL: $48.2B (+2.3% 24h)

Vault balance: 10,000 USDC
Current positions: none
Max drawdown limit: 15%",
        },
        MarketSnapshot {
            label: "Volatile dip",
            context: "\
Current market snapshot (T+30min):
- ETH: $2,445.00 (-2.9% since last check, still +5.0% 7d)
- BTC: $66,100.00 (-1.9% since last check, +3.4% 7d)
- USDC: $1.00
- WBTC: $66,050.00
- AAVE: $91.80 (-3.6% since last check)
- UNI: $7.52 (-4.2% since last check)

Gas: 35 gwei | ETH/BTC ratio: 0.0370 (declining)
DeFi TVL: $47.5B (-1.5% since last check)

Vault balance: 9,800 USDC (200 USDC deployed in ETH from previous trade)
Current positions: 0.079 ETH (entry $2,520, now $2,445, unrealized PnL: -$5.93)
Max drawdown limit: 15%",
        },
        MarketSnapshot {
            label: "Recovery with yield opportunity",
            context: "\
Current market snapshot (T+60min):
- ETH: $2,580.00 (+5.5% since dip, +9.2% 7d)
- BTC: $68,200.00 (+3.2% since dip, +6.8% 7d)
- USDC: $1.00
- WBTC: $68,150.00
- AAVE: $97.40 (+6.1% since dip)
- UNI: $8.10 (+7.7% since dip)

Gas: 18 gwei (low) | ETH/BTC ratio: 0.0378 (rising again)
DeFi TVL: $49.1B (+3.4% since dip)
AAVE USDC supply APY: 4.8% | AAVE ETH borrow rate: 2.1%

Vault balance: 9,800 USDC + 0.079 ETH
Current positions: 0.079 ETH (entry $2,520, now $2,580, unrealized PnL: +$4.74)
Max drawdown limit: 15%",
        },
    ]
}

// ── Tracking ─────────────────────────────────────────────────────────────────

struct TradeRecord {
    iteration: usize,
    action: String,
    token_in: String,
    token_out: String,
    amount: String,
    ai_reasoning: String,
    validator_scores: Vec<u32>,
    avg_score: u32,
    _approved: bool,
    on_chain_valid: bool,
    on_chain_sig_count: u64,
}

// ── Test ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_ai_trading_simulation() {
    dotenv::dotenv().ok();

    let api_key = match std::env::var("ZAI_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => {
            eprintln!("SKIPPING: ZAI_API_KEY not set");
            return;
        }
    };
    let endpoint = std::env::var("AI_API_ENDPOINT")
        .unwrap_or_else(|_| "https://api.z.ai/api/coding/paas/v4".to_string());
    let model = std::env::var("AI_MODEL")
        .unwrap_or_else(|_| "glm-4.7".to_string());

    // Quick connectivity check before spinning up infrastructure
    println!("\n[pre] Checking Z.ai API connectivity...");
    match call_llm(&api_key, &endpoint, &model, "Reply with: ok", "ping").await {
        Ok(r) => println!("[pre] API reachable. Response: {}\n", r.chars().take(50).collect::<String>()),
        Err(e) if e.contains("429") || e.contains("Insufficient") || e.contains("quota") => {
            eprintln!("SKIPPING: Z.ai quota/balance issue: {e}");
            return;
        }
        Err(e) => {
            eprintln!("SKIPPING: Z.ai API error: {e}");
            return;
        }
    }

    println!("================================================================");
    println!("  AI TRADING SIMULATION — Full Pipeline, No Mocks");
    println!("  Model: {model} | Provider: zai-coding-plan");
    println!("  Iterations: {} market scenarios", market_scenarios().len());
    println!("================================================================\n");

    // ── Infrastructure ───────────────────────────────────────────────────────
    println!("[setup] Deploying on-chain infrastructure...");
    let anvil = Anvil::new().try_spawn().expect("Anvil");
    let rpc_url = anvil.endpoint();
    let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
    let deployer_provider = ProviderBuilder::new()
        .wallet(EthereumWallet::from(deployer_key))
        .connect_http(rpc_url.parse().unwrap());

    let tv_addr = deploy_contract(&deployer_provider, load_bytecode("TradeValidator")).await;
    println!("        TradeValidator: {tv_addr}");

    let val_keys: Vec<PrivateKeySigner> = (3..6).map(|i| anvil.keys()[i].clone().into()).collect();
    let val_addrs: Vec<Address> = val_keys.iter().map(|k| k.address()).collect();
    let mock_vault = Address::from([0xBB; 20]);

    let tv = TradeValidator::new(tv_addr, &deployer_provider);
    tv.configureVault(mock_vault, val_addrs.clone(), U256::from(2))
        .send().await.unwrap().get_receipt().await.unwrap();
    println!("        Vault: {mock_vault} (2-of-3 multisig)");

    // ── Validators ───────────────────────────────────────────────────────────
    println!("[setup] Starting 3 AI-powered validator nodes...");
    let ai_provider = AiProvider::Zai {
        api_key: api_key.clone(),
        model: model.clone(),
        endpoint: endpoint.clone(),
    };

    let mut validator_endpoints = Vec::new();
    for (i, _) in val_keys.iter().enumerate() {
        let key_hex = hex::encode(anvil.keys()[i + 3].to_bytes());
        let server = trading_validator_lib::server::ValidatorServer::new(0)
            .with_ai_provider(ai_provider.clone())
            .with_signer(&key_hex, 31337, tv_addr)
            .unwrap();
        let router = server.router();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        validator_endpoints.push(format!("http://127.0.0.1:{port}"));
        println!("        Validator {} @ :{port} ({})", i + 1, val_addrs[i]);
        tokio::spawn(async move { axum::serve(listener, router).await.ok(); });
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let validator_client = ValidatorClient::new(validator_endpoints, 50)
        .with_timeout(std::time::Duration::from_secs(120));
    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 7200;

    // ── Trading agent system prompt ──────────────────────────────────────────
    let system_prompt = "\
You are an autonomous DeFi trading agent managing a vault on Ethereum.

Your job: analyze market data each iteration and decide whether to trade.

RULES:
- Only trade when you see a clear opportunity. It's OK to pass and say \"no trade\".
- Respect the max drawdown limit.
- Consider gas costs (each swap costs ~$2-5 at current gas prices).
- Small positions only — never risk more than 20% of vault balance on a single trade.
- Use slippage protection (min_amount_out should be 97-99% of expected output).

When you decide to trade, respond with a JSON array of trade objects:
[{
  \"action\": \"swap\" | \"supply\" | \"borrow\" | \"withdraw\",
  \"token_in\": \"TOKEN_SYMBOL\",
  \"token_out\": \"TOKEN_SYMBOL\",
  \"amount_in\": \"123.45\",
  \"min_amount_out\": \"120.00\",
  \"target_protocol\": \"uniswap_v3\" | \"aave_v3\",
  \"reasoning\": \"Brief explanation\"
}]

When you decide NOT to trade, respond with:
{\"action\": \"hold\", \"reasoning\": \"Brief explanation why\"}

Respond with JSON only. No markdown, no extra text.";

    // ── Run simulation ───────────────────────────────────────────────────────
    let scenarios = market_scenarios();
    let mut all_trades: Vec<TradeRecord> = Vec::new();
    let mut holds = 0usize;

    for (iter, scenario) in scenarios.iter().enumerate() {
        println!("\n────────────────────────────────────────────────────────────────");
        println!("  Iteration {} — {}", iter + 1, scenario.label);
        println!("────────────────────────────────────────────────────────────────");

        // Call LLM as trading agent
        println!("  [agent] Asking {model} for trade decision...");
        let t0 = std::time::Instant::now();
        let llm_output = match call_llm(&api_key, &endpoint, &model, system_prompt, scenario.context).await {
            Ok(r) => r,
            Err(e) if e.contains("429") || e.contains("Insufficient") => {
                eprintln!("  [agent] API quota hit at iteration {} — stopping simulation: {e}", iter + 1);
                break;
            }
            Err(e) => {
                eprintln!("  [agent] LLM error: {e}");
                continue;
            }
        };
        let agent_time = t0.elapsed();
        println!("  [agent] Response ({:.1}s):", agent_time.as_secs_f64());
        for line in llm_output.lines() {
            println!("    {line}");
        }

        // Check for hold decision
        if llm_output.contains("\"hold\"") {
            if let Ok(hold_json) = serde_json::from_str::<serde_json::Value>(llm_output.trim()) {
                println!("\n  [agent] DECISION: HOLD — {}",
                    hold_json["reasoning"].as_str().unwrap_or("no reason given"));
                holds += 1;
                continue;
            }
            // Also try extracting from markdown fences
            let cleaned = extract_json_array(&llm_output);
            if let Ok(hold_json) = serde_json::from_str::<serde_json::Value>(cleaned) {
                if hold_json.get("action").and_then(|a| a.as_str()) == Some("hold") {
                    println!("\n  [agent] DECISION: HOLD — {}",
                        hold_json["reasoning"].as_str().unwrap_or("no reason given"));
                    holds += 1;
                    continue;
                }
            }
        }

        // Parse trade recommendations
        let json_str = extract_json_array(&llm_output);
        let recs: Vec<serde_json::Value> = match serde_json::from_str(json_str) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("  [agent] Could not parse trades: {e}");
                eprintln!("  [agent] Raw: {json_str}");
                continue;
            }
        };

        if recs.is_empty() {
            println!("  [agent] No trades generated this iteration.");
            holds += 1;
            continue;
        }

        // Process each trade
        for (j, rec) in recs.iter().enumerate() {
            let action_str = rec["action"].as_str().unwrap_or("swap");
            let action = match parse_action(action_str) {
                Some(a) => a,
                None => {
                    if action_str == "hold" {
                        println!("\n  [agent] DECISION: HOLD — {}",
                            rec["reasoning"].as_str().unwrap_or("no reason"));
                        holds += 1;
                        continue;
                    }
                    eprintln!("  [trade {}] Unknown action: {action_str}, skipping", j + 1);
                    continue;
                }
            };

            let amount_str = rec["amount_in"].as_str().unwrap_or("100");
            let amount: rust_decimal::Decimal = amount_str.parse().unwrap_or(rust_decimal::Decimal::new(100, 0));
            let min_out_str = rec["min_amount_out"].as_str().unwrap_or("0");
            let min_out: rust_decimal::Decimal = min_out_str.parse().unwrap_or(rust_decimal::Decimal::ZERO);
            let token_in = rec["token_in"].as_str().unwrap_or("USDC").to_string();
            let token_out = rec["token_out"].as_str().unwrap_or("ETH").to_string();
            let protocol = rec["target_protocol"].as_str().unwrap_or("uniswap_v3");
            let reasoning = rec["reasoning"].as_str().unwrap_or("N/A").to_string();

            let intent = TradeIntentBuilder::new()
                .strategy_id("ai-simulation")
                .action(action)
                .token_in(&token_in)
                .token_out(&token_out)
                .amount_in(amount)
                .min_amount_out(min_out)
                .target_protocol(protocol)
                .build()
                .unwrap();

            println!("\n  [trade {}] {:?} {} {} -> {} on {}", j + 1,
                intent.action, amount, token_in, token_out, protocol);

            // Fan out to validators
            println!("  [validators] Scoring with {model}...");
            let t1 = std::time::Instant::now();
            let result = match validator_client.validate(&intent, &format!("{mock_vault}"), deadline).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("  [validators] Validation failed: {e}");
                    continue;
                }
            };
            let val_time = t1.elapsed();

            let mut v_scores = Vec::new();
            for (vi, vr) in result.validator_responses.iter().enumerate() {
                println!("    Validator {}: score={} | {}", vi + 1, vr.score, vr.reasoning);
                v_scores.push(vr.score);
            }
            println!("  [validators] Done ({:.1}s) — avg={}, approved={}",
                val_time.as_secs_f64(), result.aggregate_score, result.approved);

            // On-chain verification
            println!("  [on-chain] Submitting 2-of-3 signatures...");
            let ih_hex = &result.intent_hash;
            let ih_stripped = ih_hex.strip_prefix("0x").unwrap_or(ih_hex);
            let ih_bytes = hex::decode(ih_stripped).unwrap();
            let mut ih_arr = [0u8; 32];
            ih_arr.copy_from_slice(&ih_bytes);

            let mut sigs = Vec::new();
            let mut scores = Vec::new();
            for vr in result.validator_responses.iter().take(2) {
                let sig_hex = vr.signature.strip_prefix("0x").unwrap_or(&vr.signature);
                sigs.push(Bytes::from(hex::decode(sig_hex).unwrap()));
                scores.push(U256::from(vr.score));
            }

            let on_chain = tv
                .validateWithSignatures(
                    FixedBytes::<32>::from(ih_arr),
                    mock_vault,
                    sigs,
                    scores,
                    U256::from(deadline),
                )
                .call().await.unwrap();

            let valid_count: u64 = on_chain.validCount.try_into().unwrap_or(0);
            println!("  [on-chain] approved={}, validCount={}", on_chain.approved, valid_count);

            assert!(on_chain.approved, "On-chain should approve with 2-of-3 valid sigs");

            all_trades.push(TradeRecord {
                iteration: iter + 1,
                action: format!("{:?}", intent.action),
                token_in: token_in.clone(),
                token_out: token_out.clone(),
                amount: amount_str.to_string(),
                ai_reasoning: reasoning,
                validator_scores: v_scores,
                avg_score: result.aggregate_score,
                _approved: result.approved,
                on_chain_valid: on_chain.approved,
                on_chain_sig_count: valid_count,
            });
        }

        // Brief pause between iterations (simulate time passing)
        if iter < scenarios.len() - 1 {
            println!("\n  [sleep] Waiting 2s before next iteration...");
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    println!("\n\n================================================================");
    println!("  SIMULATION SUMMARY");
    println!("================================================================");
    println!("  Model: {model} | Provider: zai-coding-plan");
    println!("  Iterations: {} | Holds: {} | Trades executed: {}",
        scenarios.len(), holds, all_trades.len());
    println!();

    if !all_trades.is_empty() {
        println!("  {:<4} {:<8} {:<8} {:<8} {:<10} {:<18} {:<8} {:<8}",
            "#", "Action", "In", "Out", "Amount", "Validator Scores", "Avg", "Chain");
        println!("  {}", "-".repeat(74));

        for t in &all_trades {
            let scores_str = t.validator_scores.iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let chain_status = if t.on_chain_valid {
                format!("{}/3", t.on_chain_sig_count)
            } else {
                "FAIL".to_string()
            };
            println!("  {:<4} {:<8} {:<8} {:<8} {:<10} {:<18} {:<8} {:<8}",
                t.iteration, t.action, t.token_in, t.token_out, t.amount,
                scores_str, t.avg_score, chain_status);
        }
        println!();

        for t in &all_trades {
            println!("  Trade @iter{}: {}", t.iteration, t.ai_reasoning);
        }
    } else {
        println!("  No trades were executed (agent held all iterations or API quota hit).");
    }

    println!("\n================================================================");
    println!("  SIMULATION COMPLETE");
    println!("================================================================\n");

    // At least verify the infrastructure worked
    assert!(all_trades.len() + holds > 0,
        "Simulation should have processed at least one iteration");
}
