//! Binary-level and Manager-level E2E tests.
//!
//! Two test flows:
//!
//! **Flow A** — Direct binary (`test_blueprint_binary_full_pipeline`):
//!   1. Start Tangle testnet (Anvil + contracts)
//!   2. Deploy TradeValidator, start validators
//!   3. Launch `trading-blueprint` binary as a child process
//!   4. Submit JOB_PROVISION on-chain → binary provisions bot
//!   5. Session auth → configure secrets → bot activated
//!   6. POST /validate → validator fan-out → signatures
//!   7. Verify on-chain 2-of-3 multisig
//!   8. POST /execute → paper trade stored
//!   9. Verify trade via operator API
//!
//! **Flow B** — Through Blueprint Manager (`test_blueprint_manager_full_pipeline`):
//!   Same trade pipeline but the binary is spawned by `cargo tangle blueprint deploy`
//!   (the Manager), not directly by the test. Tests the full production deployment path.
//!
//! Gate: `SIDECAR_E2E=1` + Docker + forge artifacts + TNT artifacts + compiled binary.
//!
//! ```bash
//! cargo build -p trading-blueprint-bin
//! SIDECAR_E2E=1 cargo test -p trading-blueprint-lib --test tangle_binary_e2e -- --nocapture
//! ```

mod common;

use alloy::network::EthereumWallet;
use alloy::primitives::{Address, U256};
use alloy::providers::ProviderBuilder;
use alloy::signers::Signer;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolValue;
use anyhow::{Context, Result};
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::contract_deployer;
use common::e2e_helpers;
use common::validators;

use trading_blueprint_lib::{JOB_PROVISION, TradingProvisionRequest};

/// Well-known Blueprint SDK Anvil keys.
const SERVICE_OWNER_KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OPERATOR_KEY: &str = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/// Deterministic contract addresses from the Blueprint SDK Anvil snapshot.
const TANGLE_CONTRACT: &str = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
const RESTAKING_CONTRACT: &str = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const STATUS_REGISTRY_CONTRACT: &str = "0xdC64a140Aa3E981100a9BecA4E685f962f0CF6C9";

// ── Reusable process output capture ─────────────────────────────────────

/// Captures stdout + stderr from a child process into an mpsc channel.
/// Stores all captured lines for later searching.
struct ProcessOutput {
    rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    /// All lines captured so far (shared with reader threads).
    history: Arc<Mutex<Vec<String>>>,
}

impl ProcessOutput {
    /// Take stdout/stderr from a child and spawn reader threads.
    fn capture(child: &mut Child, label: &str) -> Self {
        let stderr = child.stderr.take().expect("child stderr not available");
        let stdout = child.stdout.take().expect("child stdout not available");

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let history = Arc::new(Mutex::new(Vec::new()));

        let tx_out = tx.clone();
        let label_out = format!("{label}:out");
        let history_out = history.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        eprintln!("  [{label_out}] {l}");
                        history_out.lock().unwrap().push(l.clone());
                        let _ = tx_out.send(l);
                    }
                    Err(_) => break,
                }
            }
        });

        let label_err = format!("{label}:err");
        let history_err = history.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        eprintln!("  [{label_err}] {l}");
                        history_err.lock().unwrap().push(l.clone());
                        let _ = tx.send(l);
                    }
                    Err(_) => break,
                }
            }
        });

        Self { rx, history }
    }

    /// Wait for a line containing `pattern`. Returns the matched line.
    async fn wait_for(&mut self, pattern: &str, timeout_secs: u64) -> Result<String> {
        // First check history for lines already captured
        {
            let hist = self.history.lock().unwrap();
            for line in hist.iter() {
                if line.contains(pattern) {
                    return Ok(line.clone());
                }
            }
        }

        // Then wait for new lines
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(line)) => {
                    if line.contains(pattern) {
                        return Ok(line.clone());
                    }
                }
                Ok(None) => {
                    anyhow::bail!("Process exited before '{pattern}' appeared");
                }
                Err(_) => {
                    anyhow::bail!("Timeout ({timeout_secs}s) waiting for '{pattern}'");
                }
            }
        }
    }

    /// Search all captured lines for a pattern and extract content.
    fn find_in_history(&self, pattern: &str) -> Option<String> {
        let hist = self.history.lock().unwrap();
        hist.iter().find(|l| l.contains(pattern)).cloned()
    }
}

// ── Binary / process helpers ────────────────────────────────────────────

/// Find the compiled binary.
fn find_binary() -> Option<String> {
    let workspace_root = env!("CARGO_MANIFEST_DIR").trim_end_matches("/trading-blueprint-lib");
    for profile in &["debug", "release"] {
        let path = format!("{workspace_root}/target/{profile}/trading-blueprint");
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }
    None
}

/// Start the binary as a child process.
#[allow(clippy::too_many_arguments)]
fn start_binary(
    binary_path: &str,
    rpc_url: &str,
    ws_url: &str,
    state_dir: &str,
    operator_api_port: u16,
    trading_api_port: u16,
    keystore_path: &str,
    validator_endpoints: &str,
) -> Result<Child> {
    let operator_key: PrivateKeySigner = OPERATOR_KEY.parse().expect("valid operator key");
    let operator_address = format!("{:#x}", operator_key.address());

    let child = Command::new(binary_path)
        .arg("run")
        .arg("--http-rpc-url")
        .arg(rpc_url)
        .arg("--ws-rpc-url")
        .arg(ws_url)
        .arg("--keystore-uri")
        .arg(keystore_path)
        .arg("--data-dir")
        .arg(state_dir)
        .arg("--protocol")
        .arg("tangle")
        .arg("-t")
        .env("RUST_LOG", "info,tangle=debug,trading=debug")
        .env("BLUEPRINT_ID", "0")
        .env("SERVICE_ID", "0")
        .env("OPERATOR_ADDRESS", &operator_address)
        .env("PRIVATE_KEY", OPERATOR_KEY)
        .env("TANGLE_CONTRACT", TANGLE_CONTRACT)
        .env("RESTAKING_CONTRACT", RESTAKING_CONTRACT)
        .env("STATUS_REGISTRY_CONTRACT", STATUS_REGISTRY_CONTRACT)
        .env("SIDECAR_IMAGE", "tangle-sidecar:local")
        .env("SIDECAR_PULL_IMAGE", "false")
        .env("SIDECAR_PUBLIC_HOST", "127.0.0.1")
        .env("OPERATOR_API_PORT", operator_api_port.to_string())
        .env("TRADING_API_PORT", trading_api_port.to_string())
        .env("BLUEPRINT_STATE_DIR", state_dir)
        .env("VALIDATOR_ENDPOINTS", validator_endpoints)
        .env("WORKFLOW_CRON_SCHEDULE", "0 0 1 1 * *")
        .env("FEE_SETTLEMENT_INTERVAL_SECS", "999999")
        .env("BILLING_INTERVAL_SECS", "999999")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Failed to spawn binary")?;

    Ok(child)
}

/// Submit a job to the Tangle contract using alloy.
async fn submit_job_onchain(
    rpc_url: &str,
    private_key: &str,
    service_id: u64,
    job_index: u8,
    encoded_payload: &[u8],
) -> Result<()> {
    use alloy::primitives::Bytes;
    use alloy::sol;

    sol! {
        #[sol(rpc)]
        interface Tangle {
            function submitJob(uint64 serviceId, uint8 jobIndex, bytes calldata payload) external;
        }
    }

    let signer: PrivateKeySigner = private_key.parse().context("parse private key")?;
    let wallet = EthereumWallet::from(signer);
    let provider = ProviderBuilder::new()
        .wallet(wallet)
        .connect_http(rpc_url.parse().context("parse rpc url")?);

    let tangle_addr: Address = TANGLE_CONTRACT.parse().context("parse tangle contract")?;
    let tangle = Tangle::new(tangle_addr, &provider);

    tangle
        .submitJob(service_id, job_index, Bytes::from(encoded_payload.to_vec()))
        .send()
        .await
        .context("submitJob send failed")?
        .get_receipt()
        .await
        .context("submitJob receipt failed")?;

    Ok(())
}

/// Create a keystore directory with the operator key imported.
fn setup_keystore(dir: &std::path::Path) -> Result<()> {
    blueprint_anvil_testing_utils::seed_operator_key(dir)?;
    Ok(())
}

/// Session auth (EIP-191 challenge-response) → returns session token.
async fn do_session_auth(
    client: &reqwest::Client,
    operator_api_url: &str,
    signer_key: &str,
) -> Result<String> {
    let challenge_resp = client
        .post(format!("{operator_api_url}/api/auth/challenge"))
        .send()
        .await
        .context("POST /api/auth/challenge")?;
    assert!(
        challenge_resp.status().is_success(),
        "Challenge should succeed"
    );
    let challenge: serde_json::Value = challenge_resp.json().await?;
    let nonce = challenge["nonce"]
        .as_str()
        .context("missing nonce")?
        .to_string();
    let message = challenge["message"]
        .as_str()
        .context("missing message")?
        .to_string();

    let signer: PrivateKeySigner = signer_key.parse().unwrap();
    let signature = signer.sign_message(message.as_bytes()).await?;
    let sig_hex = format!("0x{}", hex::encode(signature.as_bytes()));

    let session_resp = client
        .post(format!("{operator_api_url}/api/auth/session"))
        .json(&serde_json::json!({
            "nonce": nonce,
            "signature": sig_hex
        }))
        .send()
        .await
        .context("POST /api/auth/session")?;
    assert!(
        session_resp.status().is_success(),
        "Session exchange should succeed"
    );
    let session: serde_json::Value = session_resp.json().await?;
    session["token"]
        .as_str()
        .map(String::from)
        .context("missing session token")
}

/// Validator keys (Anvil accounts 3, 4, 5).
fn validator_keys() -> Vec<Vec<u8>> {
    [
        "8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
        "92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
        "4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    ]
    .iter()
    .map(|k| hex::decode(k).unwrap())
    .collect()
}

fn validator_addresses(keys: &[Vec<u8>]) -> Vec<Address> {
    keys.iter()
        .map(|k| {
            let key: PrivateKeySigner = hex::encode(k).parse().unwrap();
            key.address()
        })
        .collect()
}

/// Extract a URL from a log line like "Anvil HTTP endpoint: http://localhost:34161/"
fn extract_url_from_log(line: &str) -> Option<String> {
    let idx = line.find("http://")?;
    let rest = &line[idx..];
    // Take until whitespace or end
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    // Trim trailing slash for consistency
    Some(rest[..end].trim_end_matches('/').to_string())
}

/// Extract a port number from a log line like "Operator API listening on 0.0.0.0:36239"
fn extract_port_from_log(line: &str) -> Option<u16> {
    // Find the last colon followed by digits
    let colon_idx = line.rfind(':')?;
    let port_str = &line[colon_idx + 1..];
    // Take digits only
    let digits: String = port_str
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

// ── Shared trade pipeline assertions ────────────────────────────────────

/// Run the full trade pipeline: provision → activate → validate → execute → verify.
///
/// Shared between binary and Manager tests. Requires:
/// - Binary already running with Operator API and Trading API
/// - Anvil running with Tangle contracts
/// - Validators running
///
/// When `verify_onchain` is false, the on-chain multisig verification step is
/// skipped. This is needed for the Manager test where validators are started
/// before the TradeValidator is deployed (chicken-and-egg: validators need the
/// contract address for EIP-712 domain, but we don't have the Anvil URL until
/// Manager starts). Flow A already covers on-chain verification.
#[allow(clippy::too_many_arguments)]
async fn run_trade_pipeline(
    http_client: &reqwest::Client,
    rpc_url: &str,
    operator_api_url: &str,
    trading_api_url: &str,
    deployer_provider: &impl alloy::providers::Provider,
    tv_addr: Address,
    vault_addr: Address,
    val_addrs: Vec<Address>,
    verify_onchain: bool,
) -> Result<()> {
    // ── Submit JOB_PROVISION ──────────────────────────────────────────
    eprintln!("        Submitting JOB_PROVISION on-chain...");

    submit_provision_job_onchain(
        rpc_url,
        vault_addr,
        val_addrs.clone(),
        r#"{"max_slippage":0.5}"#,
    )
    .await?;
    eprintln!("        Job submitted");

    // ── Session auth (needed for all operator API calls) ──────────────
    eprintln!("        Authenticating with operator API...");
    let session_token = do_session_auth(http_client, operator_api_url, SERVICE_OWNER_KEY).await?;

    // ── Poll for bot ─────────────────────────────────────────────────
    eprintln!("        Polling for provisioned bot...");
    let mut bot_id = String::new();
    for attempt in 0..60 {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if let Ok(resp) = http_client
            .get(format!("{operator_api_url}/api/bots"))
            .header("Authorization", format!("Bearer {session_token}"))
            .send()
            .await
        {
            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.unwrap_or_default();
                if let Some(bots) = body["bots"].as_array() {
                    if let Some(first) = bots.first() {
                        bot_id = first["id"].as_str().unwrap_or("").to_string();
                        eprintln!("        Found bot: {bot_id} (attempt {attempt})");
                        break;
                    }
                }
            }
        }
        if attempt % 10 == 0 {
            eprintln!("        Still waiting... (attempt {attempt}/60)");
        }
    }
    assert!(!bot_id.is_empty(), "Bot should appear in operator API");

    // ── Verify pre-activation state ──────────────────────────────────
    let bot_detail: serde_json::Value = http_client
        .get(format!("{operator_api_url}/api/bots/{bot_id}"))
        .header("Authorization", format!("Bearer {session_token}"))
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(bot_detail["trading_active"].as_bool(), Some(false));
    assert_eq!(bot_detail["secrets_configured"].as_bool(), Some(false));
    eprintln!("        Pre-activation state verified");

    // ── Configure secrets ────────────────────────────────────────────
    eprintln!("        Configuring secrets...");

    let secrets_resp = http_client
        .post(format!("{operator_api_url}/api/bots/{bot_id}/secrets"))
        .header("Authorization", format!("Bearer {session_token}"))
        .json(&serde_json::json!({
            "env_json": { "ANTHROPIC_API_KEY": "test-key-e2e" }
        }))
        .send()
        .await
        .context("POST /api/bots/{id}/secrets")?;

    let secrets_status = secrets_resp.status();
    let secrets_text = secrets_resp.text().await.unwrap_or_default();
    eprintln!("        Secrets response ({secrets_status}): {secrets_text}");
    let secrets_body: serde_json::Value = serde_json::from_str(&secrets_text).unwrap_or_default();

    if !secrets_status.is_success() {
        anyhow::bail!("Secrets configuration failed: {secrets_status} — {secrets_body}");
    }

    let api_token = secrets_body["trading_api_token"]
        .as_str()
        .context("secrets response should include trading_api_token")?;
    eprintln!("        Bot activated. Got trading API token.");

    tokio::time::sleep(Duration::from_secs(2)).await;

    // Verify activation
    let bot_active: serde_json::Value = http_client
        .get(format!("{operator_api_url}/api/bots/{bot_id}"))
        .header("Authorization", format!("Bearer {session_token}"))
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(bot_active["trading_active"].as_bool(), Some(true));
    eprintln!("        trading_active=true confirmed");

    // ── POST /validate ───────────────────────────────────────────────
    eprintln!("        POST /validate (WETH → USDC swap)...");
    let validate_resp =
        e2e_helpers::validate_trade(http_client, trading_api_url, api_token).await?;

    let approved = validate_resp["approved"].as_bool().unwrap_or(false);
    let score = validate_resp["aggregate_score"].as_u64().unwrap_or(0);
    let num_validators = validate_resp["validator_responses"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    assert!(approved, "Trade should be approved");
    assert!(score > 0, "Score should be positive");
    assert_eq!(num_validators, 3, "Should have 3 validator responses");
    eprintln!("        approved={approved}, score={score}, validators={num_validators}");

    // ── Verify on-chain signatures ───────────────────────────────────
    if verify_onchain {
        eprintln!("        Verifying on-chain 2-of-3 multisig...");
        let (on_chain_approved, valid_count) = e2e_helpers::verify_on_chain_signatures(
            deployer_provider,
            tv_addr,
            vault_addr,
            &validate_resp,
            2,
        )
        .await?;
        assert!(on_chain_approved, "On-chain multisig should approve");
        assert_eq!(valid_count, 2, "Should have 2 valid signatures");
        eprintln!("        On-chain: approved={on_chain_approved}, validCount={valid_count}");
    } else {
        eprintln!(
            "        Skipping on-chain multisig (validators started with mock contract address)"
        );
    }

    // ── POST /execute ────────────────────────────────────────────────
    eprintln!("        POST /execute (paper trade)...");
    let execute_resp =
        e2e_helpers::execute_trade(http_client, trading_api_url, api_token, &validate_resp).await?;

    let tx_hash = execute_resp["tx_hash"].as_str().unwrap_or("");
    let paper = execute_resp["paper_trade"].as_bool().unwrap_or(false);
    assert!(tx_hash.starts_with("0xpaper_"), "Should be paper trade tx");
    assert!(paper, "paper_trade flag should be true");
    eprintln!("        tx_hash={tx_hash}, paper_trade={paper}");

    // ── Verify trade via Trading HTTP API ────────────────────────────
    // Trades are stored in PersistentStore (sled) by the execute handler,
    // so we query through the same API — GET /trades with bearer token.
    eprintln!("        Verifying trade via Trading HTTP API...");
    let trades_resp: serde_json::Value = http_client
        .get(format!("{trading_api_url}/trades"))
        .header("Authorization", format!("Bearer {api_token}"))
        .send()
        .await
        .context("GET /trades on Trading HTTP API")?
        .json()
        .await?;

    let trades = trades_resp["trades"]
        .as_array()
        .context("trades response should have 'trades' array")?;
    assert!(!trades.is_empty(), "Should have at least 1 trade");
    assert_eq!(trades[0]["paper_trade"].as_bool(), Some(true));
    assert_eq!(trades[0]["action"].as_str(), Some("swap"));
    assert_eq!(trades[0]["token_in"].as_str(), Some(e2e_helpers::WETH));
    eprintln!(
        "        {} trade(s) verified (total={})",
        trades.len(),
        trades_resp["total"].as_u64().unwrap_or(0)
    );

    // ── Verify provision progress ────────────────────────────────────
    let provisions: serde_json::Value = http_client
        .get(format!("{operator_api_url}/api/provisions"))
        .send()
        .await?
        .json()
        .await?;
    if let Some(provs) = provisions["provisions"].as_array() {
        assert!(!provs.is_empty(), "Should have at least 1 provision");
        eprintln!(
            "        Provision: phase={}, progress={}%",
            provs[0]["phase"], provs[0]["progress_pct"]
        );
    }

    Ok(())
}

async fn submit_provision_job_onchain(
    rpc_url: &str,
    vault_addr: Address,
    val_addrs: Vec<Address>,
    strategy_config_json: &str,
) -> Result<()> {
    let provision_payload = TradingProvisionRequest {
        name: "e2e-bot".to_string(),
        strategy_type: "dex".to_string(),
        strategy_config_json: strategy_config_json.to_string(),
        risk_params_json: r#"{"max_drawdown_pct":5.0}"#.to_string(),
        factory_address: vault_addr,
        asset_token: Address::from([0xCC; 20]),
        signers: val_addrs,
        required_signatures: U256::from(2),
        chain_id: U256::from(31337),
        rpc_url: rpc_url.to_string(),
        trading_loop_cron: "0 */5 * * * *".to_string(),
        cpu_cores: 2,
        memory_mb: 4096,
        max_lifetime_days: 30,
        validator_service_ids: vec![],
        max_collateral_bps: U256::from(0),
    }
    .abi_encode();

    submit_job_onchain(
        rpc_url,
        SERVICE_OWNER_KEY,
        0,
        JOB_PROVISION,
        &provision_payload,
    )
    .await
}

async fn snapshot_provision_call_ids(
    client: &reqwest::Client,
    operator_api_url: &str,
) -> Result<HashSet<u64>> {
    let resp = client
        .get(format!("{operator_api_url}/api/provisions"))
        .send()
        .await
        .context("GET /api/provisions (snapshot)")?;
    if !resp.status().is_success() {
        return Ok(HashSet::new());
    }

    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let mut ids = HashSet::new();
    if let Some(items) = body["provisions"].as_array() {
        for item in items {
            if let Some(call_id) = item["call_id"].as_u64() {
                ids.insert(call_id);
            }
        }
    }
    Ok(ids)
}

async fn assert_firecracker_provision_failed(
    client: &reqwest::Client,
    operator_api_url: &str,
    session_token: &str,
    existing_call_ids: &HashSet<u64>,
) -> Result<u64> {
    let mut last_body = serde_json::Value::Null;
    let mut new_call_ids = HashSet::new();

    for _ in 0..60 {
        tokio::time::sleep(Duration::from_secs(2)).await;

        let resp = client
            .get(format!("{operator_api_url}/api/provisions"))
            .send()
            .await
            .context("GET /api/provisions")?;

        if !resp.status().is_success() {
            continue;
        }

        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        last_body = body.clone();

        if let Some(items) = body["provisions"].as_array() {
            for item in items {
                let Some(call_id) = item["call_id"].as_u64() else {
                    continue;
                };
                if existing_call_ids.contains(&call_id) {
                    continue;
                }
                new_call_ids.insert(call_id);

                let phase = item["phase"].as_str().unwrap_or_default();
                let message = item["message"].as_str().unwrap_or_default();
                if phase == "failed" && message.to_ascii_lowercase().contains("firecracker") {
                    let bots_resp = client
                        .get(format!("{operator_api_url}/api/bots?call_id={call_id}"))
                        .header("Authorization", format!("Bearer {session_token}"))
                        .send()
                        .await
                        .context("GET /api/bots after failed firecracker provision")?;
                    if bots_resp.status().is_success() {
                        let bots_body: serde_json::Value =
                            bots_resp.json().await.unwrap_or_default();
                        let count = bots_body["total"]
                            .as_u64()
                            .or_else(|| bots_body["bots"].as_array().map(|b| b.len() as u64))
                            .unwrap_or(0);
                        if count == 0 {
                            return Ok(call_id);
                        }
                        anyhow::bail!(
                            "firecracker provision failed for call_id={call_id}, but /api/bots?call_id={call_id} returned {count} bot(s): {bots_body}"
                        );
                    }
                }
            }
        }
    }

    anyhow::bail!(
        "did not observe failed firecracker provision for a newly submitted call; observed_new_call_ids={new_call_ids:?}; last /api/provisions body: {last_body}"
    );
}

// ═══════════════════════════════════════════════════════════════════════
//  Flow A: Direct binary test — full trade pipeline
// ═══════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_blueprint_binary_full_pipeline() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    let binary_path = match find_binary() {
        Some(p) => p,
        None => {
            eprintln!("Skipping: binary not built. Run `cargo build -p trading-blueprint-bin`");
            return Ok(());
        }
    };
    eprintln!("Using binary: {binary_path}");

    common::setup_log();

    let result = tokio::time::timeout(Duration::from_secs(600), async {
        eprintln!("\n[1/3] Setting up infrastructure...");

        let tangle_harness = match blueprint_anvil_testing_utils::TangleHarness::start(true).await {
            Ok(h) => h,
            Err(e) => {
                if blueprint_anvil_testing_utils::missing_tnt_core_artifacts(&e) {
                    eprintln!("Skipping: TNT core artifacts not found: {e}");
                    return Ok(());
                }
                return Err(e);
            }
        };

        let rpc_url = tangle_harness.http_endpoint().to_string();
        let ws_url = tangle_harness.ws_endpoint().to_string();
        eprintln!("        Anvil RPC: {rpc_url}");

        let deployer_key: PrivateKeySigner = SERVICE_OWNER_KEY.parse().unwrap();
        let deployer_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer_key))
            .connect_http(rpc_url.parse().unwrap());

        let val_keys = validator_keys();
        let val_addrs = validator_addresses(&val_keys);

        let (tv_addr, vault_addr) =
            contract_deployer::deploy_trade_validator(&deployer_provider, val_addrs.clone(), 2)
                .await;
        eprintln!("        TradeValidator: {tv_addr}, Vault: {vault_addr}");

        let cluster =
            validators::start_validator_cluster(&val_keys, tv_addr, vault_addr, None).await;
        let validator_endpoints_str = cluster.endpoints.join(",");
        eprintln!("        {} validators running", cluster.endpoints.len());

        eprintln!("[2/3] Starting binary...");

        let state_dir = tempfile::tempdir().context("create state dir")?;
        let keystore_dir = tempfile::tempdir().context("create keystore dir")?;
        setup_keystore(keystore_dir.path())?;

        let op_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let op_port = op_listener.local_addr()?.port();
        drop(op_listener);

        let trade_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let trade_port = trade_listener.local_addr()?.port();
        drop(trade_listener);

        let mut child = start_binary(
            &binary_path,
            &rpc_url,
            &ws_url,
            state_dir.path().to_str().unwrap(),
            op_port,
            trade_port,
            keystore_dir.path().to_str().unwrap(),
            &validator_endpoints_str,
        )?;

        let mut output = ProcessOutput::capture(&mut child, "binary");
        output.wait_for("Operator API listening", 30).await?;
        eprintln!("        Binary started. Operator API :{op_port}, Trading API :{trade_port}");

        let operator_api_url = format!("http://127.0.0.1:{op_port}");
        let trading_api_url = format!("http://127.0.0.1:{trade_port}");
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;

        eprintln!("[3/3] Running full trade pipeline...");

        let pipeline_result = run_trade_pipeline(
            &http_client,
            &rpc_url,
            &operator_api_url,
            &trading_api_url,
            &deployer_provider,
            tv_addr,
            vault_addr,
            val_addrs,
            true, // verify on-chain — validators have real contract address
        )
        .await;

        let _ = child.kill();
        let _ = child.wait();

        pipeline_result?;

        eprintln!("\n════════════════════════════════════════════");
        eprintln!("  BINARY E2E FULL TRADE PIPELINE: PASSED  ");
        eprintln!("════════════════════════════════════════════");
        Ok(())
    })
    .await;

    result.context("test timed out")?
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_blueprint_binary_firecracker_provision_fails_cleanly() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    let binary_path = match find_binary() {
        Some(p) => p,
        None => {
            eprintln!("Skipping: binary not built. Run `cargo build -p trading-blueprint-bin`");
            return Ok(());
        }
    };

    common::setup_log();

    let result = tokio::time::timeout(Duration::from_secs(300), async {
        let tangle_harness = match blueprint_anvil_testing_utils::TangleHarness::start(true).await {
            Ok(h) => h,
            Err(e) => {
                if blueprint_anvil_testing_utils::missing_tnt_core_artifacts(&e) {
                    eprintln!("Skipping: TNT core artifacts not found: {e}");
                    return Ok(());
                }
                return Err(e);
            }
        };

        let rpc_url = tangle_harness.http_endpoint().to_string();
        let ws_url = tangle_harness.ws_endpoint().to_string();

        let state_dir = tempfile::tempdir().context("create state dir")?;
        let keystore_dir = tempfile::tempdir().context("create keystore dir")?;
        setup_keystore(keystore_dir.path())?;

        let op_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let op_port = op_listener.local_addr()?.port();
        drop(op_listener);

        let trade_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let trade_port = trade_listener.local_addr()?.port();
        drop(trade_listener);

        let mut child = start_binary(
            &binary_path,
            &rpc_url,
            &ws_url,
            state_dir.path().to_str().unwrap(),
            op_port,
            trade_port,
            keystore_dir.path().to_str().unwrap(),
            "",
        )?;

        let mut output = ProcessOutput::capture(&mut child, "binary-firecracker");
        output.wait_for("Operator API listening", 30).await?;

        let operator_api_url = format!("http://127.0.0.1:{op_port}");
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()?;

        let session_token =
            do_session_auth(&http_client, &operator_api_url, SERVICE_OWNER_KEY).await?;
        let existing_call_ids =
            snapshot_provision_call_ids(&http_client, &operator_api_url).await?;

        submit_provision_job_onchain(
            &rpc_url,
            Address::from([0xAA; 20]),
            validator_addresses(&validator_keys()),
            r#"{"runtime_backend":"firecracker"}"#,
        )
        .await?;

        let check = assert_firecracker_provision_failed(
            &http_client,
            &operator_api_url,
            &session_token,
            &existing_call_ids,
        )
        .await
        .map(|call_id| {
            eprintln!("        Observed firecracker failure for call_id={call_id}");
        });

        let _ = child.kill();
        let _ = child.wait();

        check
    })
    .await;

    result.context("test timed out")?
}

// ═══════════════════════════════════════════════════════════════════════
//  Flow B: Through Blueprint Manager — cargo tangle blueprint deploy
// ═══════════════════════════════════════════════════════════════════════
//
// Known limitation: The Blueprint Manager (`cargo tangle blueprint deploy`)
// starts its own Anvil and deploys contracts, but the binary spawn mechanism
// doesn't reliably work in test environments — the Manager enters a block
// polling loop without spawning the binary. This test requires MANAGER_E2E=1
// to opt in, separate from SIDECAR_E2E, because it depends on the Manager
// correctly detecting ServiceActivated events and spawning the binary.
//
// When the Manager does work, this test exercises the full production
// deployment path: Manager spawns binary → on-chain provision → secrets →
// validate → execute → trade verified.

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_blueprint_manager_full_pipeline() -> Result<()> {
    if std::env::var("MANAGER_E2E").ok().as_deref() != Some("1") {
        eprintln!(
            "Skipping: set MANAGER_E2E=1 to run (requires cargo-tangle CLI + working Manager binary spawn)"
        );
        return Ok(());
    }

    let cargo_tangle_exists = Command::new("cargo-tangle")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !cargo_tangle_exists {
        eprintln!("Skipping: cargo-tangle CLI not installed");
        return Ok(());
    }

    if find_binary().is_none() {
        eprintln!("Skipping: binary not built. Run `cargo build -p trading-blueprint-bin`");
        return Ok(());
    }

    common::setup_log();

    let result = tokio::time::timeout(Duration::from_secs(600), async {
        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  1. Start validators (need to be running before Manager)       ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("\n[1/4] Starting validator servers...");

        let val_keys = validator_keys();
        let val_addrs = validator_addresses(&val_keys);

        // Mock addresses — we'll deploy TradeValidator after we discover the Anvil URL
        let mock_tv = Address::ZERO;
        let mock_vault = Address::from([0xAA; 20]);
        let cluster =
            validators::start_validator_cluster(&val_keys, mock_tv, mock_vault, None).await;
        let validator_endpoints_str = cluster.endpoints.join(",");
        eprintln!(
            "        {} validators running: {validator_endpoints_str}",
            cluster.endpoints.len()
        );

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  2. Launch cargo tangle blueprint deploy                       ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[2/4] Launching Blueprint Manager...");

        let op_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let op_port = op_listener.local_addr()?.port();
        drop(op_listener);

        let trade_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let trade_port = trade_listener.local_addr()?.port();
        drop(trade_listener);

        let workspace_root = env!("CARGO_MANIFEST_DIR").trim_end_matches("/trading-blueprint-lib");

        let mut manager = Command::new("cargo-tangle")
            .current_dir(workspace_root)
            .args([
                "tangle",
                "blueprint",
                "deploy",
                "tangle",
                "--network",
                "devnet",
                "--spawn-method",
                "native",
                "--exit-after-seconds",
                "300",
            ])
            .env("OPERATOR_API_PORT", op_port.to_string())
            .env("TRADING_API_PORT", trade_port.to_string())
            .env("VALIDATOR_ENDPOINTS", &validator_endpoints_str)
            .env("SIDECAR_IMAGE", "tangle-sidecar:local")
            .env("SIDECAR_PULL_IMAGE", "false")
            .env("SIDECAR_PUBLIC_HOST", "127.0.0.1")
            .env("WORKFLOW_CRON_SCHEDULE", "0 0 1 1 * *")
            .env("FEE_SETTLEMENT_INTERVAL_SECS", "999999")
            .env("BILLING_INTERVAL_SECS", "999999")
            .env("BLUEPRINT_CARGO_BIN", "trading-blueprint")
            .env(
                "RUST_LOG",
                "info,tangle=debug,trading=debug,blueprint_manager=debug",
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to spawn cargo-tangle")?;

        let mut mgr_output = ProcessOutput::capture(&mut manager, "manager");

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  3. Wait for binary to be ready                                ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[3/4] Waiting for Manager to spawn binary...");

        // Wait for binary to start and extract actual ports from log output.
        // The Manager spawns the binary without forwarding our env vars, so
        // the binary may use different ports than what we pre-allocated.
        let op_line = match mgr_output
            .wait_for("Operator API listening", 180)
            .await
        {
            Ok(line) => line,
            Err(e) => {
                // Dump captured log history for debugging
                eprintln!("\n        ── Manager output history (last 50 lines) ──");
                let hist = mgr_output.history.lock().unwrap();
                let start = hist.len().saturating_sub(50);
                for line in &hist[start..] {
                    let clean: String = line.chars().filter(|c| !c.is_control() || *c == '\n').collect();
                    eprintln!("        | {clean}");
                }
                eprintln!("        ── end of history ({} lines total) ──", hist.len());

                let _ = manager.kill();
                let _ = manager.wait();
                return Err(anyhow::anyhow!("Binary never started via Manager: {e}"));
            }
        };

        // Extract actual ports from binary's log lines
        let actual_op_port = extract_port_from_log(&op_line)
            .context("Could not extract operator API port from log line")?;

        // Trading API log may already be in history or arrive shortly
        let trade_line = mgr_output
            .wait_for("Trading HTTP API listening", 10)
            .await
            .unwrap_or_else(|_| {
                mgr_output
                    .find_in_history("Trading HTTP API listening")
                    .unwrap_or_default()
            });
        let actual_trade_port = extract_port_from_log(&trade_line)
            .unwrap_or(actual_op_port + 1); // fallback if we can't parse

        eprintln!(
            "        Binary spawned by Manager. Operator API :{actual_op_port}, Trading API :{actual_trade_port}"
        );

        tokio::time::sleep(Duration::from_secs(1)).await;

        let operator_api_url = format!("http://127.0.0.1:{actual_op_port}");
        let trading_api_url = format!("http://127.0.0.1:{actual_trade_port}");
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;

        // Verify binary is responsive (auth challenge is unauthenticated — tests connectivity)
        let health = http_client
            .post(format!("{operator_api_url}/api/auth/challenge"))
            .send()
            .await;
        assert!(
            health.is_ok() && health.unwrap().status().is_success(),
            "Operator API should be responsive"
        );

        // Extract Anvil URL from Manager logs
        let anvil_line = mgr_output
            .find_in_history("Anvil HTTP endpoint")
            .context("Manager should have logged Anvil HTTP endpoint")?;
        let rpc_url = extract_url_from_log(&anvil_line)
            .context("Could not extract URL from Anvil log line")?;
        eprintln!("        Anvil RPC: {rpc_url}");

        // Deploy TradeValidator on the Manager's Anvil
        let deployer_key: PrivateKeySigner = SERVICE_OWNER_KEY.parse().unwrap();
        let deployer_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer_key))
            .connect_http(rpc_url.parse().unwrap());

        let (tv_addr, vault_addr) =
            contract_deployer::deploy_trade_validator(&deployer_provider, val_addrs.clone(), 2)
                .await;
        eprintln!("        TradeValidator: {tv_addr}, Vault: {vault_addr}");

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  4. Run the full trade pipeline                                ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[4/4] Running full trade pipeline through Manager...");

        let pipeline_result = run_trade_pipeline(
            &http_client,
            &rpc_url,
            &operator_api_url,
            &trading_api_url,
            &deployer_provider,
            tv_addr,
            vault_addr,
            val_addrs,
            false, // skip on-chain — validators started with mock contract address
        )
        .await;

        let _ = manager.kill();
        let _ = manager.wait();

        pipeline_result?;

        eprintln!("\n══════════════════════════════════════════════════");
        eprintln!("  MANAGER E2E FULL TRADE PIPELINE: PASSED  ");
        eprintln!("══════════════════════════════════════════════════");
        Ok(())
    })
    .await;

    result.context("test timed out")?
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_blueprint_manager_firecracker_provision_fails_cleanly() -> Result<()> {
    if std::env::var("MANAGER_E2E").ok().as_deref() != Some("1") {
        eprintln!(
            "Skipping: set MANAGER_E2E=1 to run (requires cargo-tangle CLI + working Manager binary spawn)"
        );
        return Ok(());
    }

    let cargo_tangle_exists = Command::new("cargo-tangle")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !cargo_tangle_exists {
        eprintln!("Skipping: cargo-tangle CLI not installed");
        return Ok(());
    }

    if find_binary().is_none() {
        eprintln!("Skipping: binary not built. Run `cargo build -p trading-blueprint-bin`");
        return Ok(());
    }

    common::setup_log();

    let result = tokio::time::timeout(Duration::from_secs(360), async {
        let op_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let op_port = op_listener.local_addr()?.port();
        drop(op_listener);

        let trade_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let trade_port = trade_listener.local_addr()?.port();
        drop(trade_listener);

        let workspace_root = env!("CARGO_MANIFEST_DIR").trim_end_matches("/trading-blueprint-lib");

        let mut manager = Command::new("cargo-tangle")
            .current_dir(workspace_root)
            .args([
                "tangle",
                "blueprint",
                "deploy",
                "tangle",
                "--network",
                "devnet",
                "--spawn-method",
                "native",
                "--exit-after-seconds",
                "300",
            ])
            .env("OPERATOR_API_PORT", op_port.to_string())
            .env("TRADING_API_PORT", trade_port.to_string())
            .env("VALIDATOR_ENDPOINTS", "")
            .env("SIDECAR_IMAGE", "tangle-sidecar:local")
            .env("SIDECAR_PULL_IMAGE", "false")
            .env("SIDECAR_PUBLIC_HOST", "127.0.0.1")
            .env("WORKFLOW_CRON_SCHEDULE", "0 0 1 1 * *")
            .env("FEE_SETTLEMENT_INTERVAL_SECS", "999999")
            .env("BILLING_INTERVAL_SECS", "999999")
            .env("BLUEPRINT_CARGO_BIN", "trading-blueprint")
            .env(
                "RUST_LOG",
                "info,tangle=debug,trading=debug,blueprint_manager=debug",
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to spawn cargo-tangle")?;

        let mut mgr_output = ProcessOutput::capture(&mut manager, "manager-firecracker");
        let op_line = mgr_output.wait_for("Operator API listening", 180).await?;
        let actual_op_port = extract_port_from_log(&op_line)
            .context("Could not extract operator API port from manager log line")?;
        let operator_api_url = format!("http://127.0.0.1:{actual_op_port}");

        let anvil_line = mgr_output
            .find_in_history("Anvil HTTP endpoint")
            .context("Manager should have logged Anvil HTTP endpoint")?;
        let rpc_url = extract_url_from_log(&anvil_line)
            .context("Could not extract URL from Anvil log line")?;

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()?;
        let session_token =
            do_session_auth(&http_client, &operator_api_url, SERVICE_OWNER_KEY).await?;
        let existing_call_ids =
            snapshot_provision_call_ids(&http_client, &operator_api_url).await?;

        submit_provision_job_onchain(
            &rpc_url,
            Address::from([0xAA; 20]),
            validator_addresses(&validator_keys()),
            r#"{"runtime_backend":"firecracker"}"#,
        )
        .await?;

        let check = assert_firecracker_provision_failed(
            &http_client,
            &operator_api_url,
            &session_token,
            &existing_call_ids,
        )
        .await
        .map(|call_id| {
            eprintln!("        Observed firecracker failure for call_id={call_id}");
        });

        let _ = manager.kill();
        let _ = manager.wait();

        check
    })
    .await;

    result.context("test timed out")?
}
