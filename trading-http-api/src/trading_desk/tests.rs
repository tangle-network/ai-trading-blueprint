use super::trading::{plan_order, settlement_from_observation};

use super::*;

fn dec(value: &str) -> Decimal {
    value.parse().expect("decimal")
}

struct TestInstrument {
    spec: InstrumentSpec,
}

impl TestInstrument {
    fn new(base_decimals: u8, quote_decimals: u8) -> Self {
        Self {
            spec: InstrumentSpec {
                name: "WETH-USDC".to_string(),
                base: InstrumentLeg {
                    symbol: "WETH".to_string(),
                    address: "0xbase".to_string(),
                    decimals: base_decimals,
                },
                quote: InstrumentLeg {
                    symbol: "USDC".to_string(),
                    address: "0xquote".to_string(),
                    decimals: quote_decimals,
                },
            },
        }
    }
}

#[test]
fn buy_spend_is_quantity_times_price() {
    let instrument = TestInstrument::new(18, 6);
    let planned = plan_order(&instrument.spec, "buy", dec("1.5"), dec("2500.25")).expect("plan");
    assert_eq!(planned.amount_in, "3750.375");
    assert_eq!(planned.min_amount_out, "1.5");
    assert_eq!(planned.token_in, "0xquote");
    assert_eq!(planned.token_out, "0xbase");
}

#[test]
fn sell_spend_is_quantity_min_out_is_proceeds() {
    let instrument = TestInstrument::new(18, 6);
    let planned = plan_order(&instrument.spec, "sell", dec("2"), dec("3000.5")).expect("plan");
    assert_eq!(planned.amount_in, "2");
    assert_eq!(planned.min_amount_out, "6001");
    assert_eq!(planned.token_in, "0xbase");
    assert_eq!(planned.token_out, "0xquote");
}

#[test]
fn quantity_precision_beyond_base_decimals_is_rejected() {
    let instrument = TestInstrument::new(18, 6);
    let planned = plan_order(
        &instrument.spec,
        "buy",
        dec("0.0000000000000000001"),
        dec("100"),
    );
    assert!(planned.is_err());
}

#[test]
fn spend_precision_beyond_quote_decimals_is_rejected() {
    // 0.000001 × 0.0000005 = 0.0000000000000005 → below USDC's 6 dp.
    let instrument = TestInstrument::new(18, 6);
    let planned = plan_order(&instrument.spec, "buy", dec("0.000001"), dec("0.0000005"));
    assert!(planned.is_err());
}

#[test]
fn sell_proceeds_precision_beyond_quote_decimals_is_rejected() {
    let instrument = TestInstrument::new(18, 6);
    let planned = plan_order(&instrument.spec, "sell", dec("0.000001"), dec("0.0000005"));
    assert!(planned.is_err());
}

#[test]
fn non_positive_orders_are_rejected() {
    let instrument = TestInstrument::new(18, 6);
    assert!(plan_order(&instrument.spec, "buy", dec("0"), dec("1")).is_err());
    assert!(plan_order(&instrument.spec, "buy", dec("1"), dec("0")).is_err());
    assert!(plan_order(&instrument.spec, "short", dec("1"), dec("1")).is_err());
}

#[test]
fn pkce_s256_matches_rfc7636_vector() {
    // RFC 7636 appendix B.
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert_eq!(
        pkce_s256(verifier),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn verifier_validation_follows_rfc7636() {
    assert!(valid_code_verifier(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    ));
    assert!(!valid_code_verifier("short"));
    assert!(!valid_code_verifier(&"x".repeat(129)));
    assert!(!valid_code_verifier(
        "has spaces in it which are not allowed at all ok"
    ));
}

#[test]
fn challenge_validation_requires_43_b64url_chars() {
    assert!(valid_code_challenge(
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    ));
    assert!(!valid_code_challenge("too-short"));
    assert!(!valid_code_challenge(
        "has invalid chars like + and / in the mix??"
    ));
}

#[test]
fn b64url_has_no_padding() {
    assert_eq!(b64url(&[0xff]), "_w");
    assert_eq!(b64url(&[0xff, 0xff]), "__8");
    assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
}

#[test]
fn network_mapping_defaults_and_overrides() {
    // Env overrides are process-wide; restore to keep other tests sane.
    // SAFETY: single-threaded test process; no concurrent reader of these
    // env vars races this removal.
    unsafe {
        std::env::remove_var("TRADING_DESK_TEST_CHAIN_ID");
        std::env::remove_var("TRADING_DESK_LIVE_CHAIN_ID");
    }
    assert_eq!(network_chain_id("test"), Some(998));
    assert_eq!(network_chain_id("live"), Some(999));
    assert_eq!(network_chain_id("staging"), None);
}

#[test]
fn enrollment_requires_v3_deployment_manifest() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Empty deployments dir: nothing is desk-capable.
    assert!(envelope_stack_chains_in(dir.path()).is_empty());
    // Missing dir entirely: same refusal, no panic.
    assert!(envelope_stack_chains_in(&dir.path().join("nope")).is_empty());

    // A verified envelope-stack chain (runbook §7 deploy record).
    let enrolled = dir.path().join("31337");
    std::fs::create_dir_all(&enrolled).expect("mkdir");
    std::fs::write(
        enrolled.join("v3.json"),
        r#"{"chainId": 31337, "vaultFactory": "0x1", "sampleVault": "0x2"}"#,
    )
    .expect("manifest");
    // A HyperCore-only manifest: different file name, must not enroll.
    let hyper = dir.path().join("998");
    std::fs::create_dir_all(&hyper).expect("mkdir");
    std::fs::write(hyper.join("hyperliquid-vault.json"), r#"{"chainId": 998}"#).expect("manifest");
    // Malformed / chainId-less v3.json manifests are skipped, not fatal.
    let broken = dir.path().join("42");
    std::fs::create_dir_all(&broken).expect("mkdir");
    std::fs::write(broken.join("v3.json"), "{ nope").expect("manifest");
    let drift = dir.path().join("77");
    std::fs::create_dir_all(&drift).expect("mkdir");
    std::fs::write(drift.join("v3.json"), r#"{"vaultFactory": "0x2"}"#).expect("manifest");

    assert_eq!(
        envelope_stack_chains_in(dir.path()),
        vec![31337],
        "only the chain with a verified v3.json envelope-stack manifest is enrolled"
    );
}

#[test]
fn grant_activity_requires_active_phase_and_freshness() {
    let now = now_secs();
    let mut grant = DeskGrant {
        grant_id: "g".to_string(),
        owner_address: "0xowner".to_string(),
        bot_id: "b".to_string(),
        network: "test".to_string(),
        chain_id: 998,
        vault_address: "0xvault".to_string(),
        redirect_uri: DEFAULT_REDIRECT_URI.to_string(),
        issued_at: now,
        expires_at: now + 100,
        revoked_at: None,
        last_used_at: None,
        phase: GrantPhase::Active {
            token_hash: "h".to_string(),
        },
    };
    assert!(grant.is_active());
    grant.revoked_at = Some(now);
    assert!(!grant.is_active());
    grant.revoked_at = None;
    grant.expires_at = now - 1;
    assert!(!grant.is_active());
}

#[test]
fn raw_units_to_decimal_matches_consumer_canonicalization() {
    assert_eq!(
        raw_units_to_decimal("1500000000000000000", 18).as_deref(),
        Some("1.5")
    );
    assert_eq!(
        raw_units_to_decimal("6001000000", 6).as_deref(),
        Some("6001")
    );
    assert_eq!(raw_units_to_decimal("1", 6).as_deref(), Some("0.000001"));
    assert_eq!(raw_units_to_decimal("0", 18).as_deref(), Some("0"));
    assert_eq!(
        raw_units_to_decimal("000000000001", 0).as_deref(),
        Some("1")
    );
    // 40 significant digits — beyond rust_decimal's 28-digit range.
    assert_eq!(
        raw_units_to_decimal("1234567890123456789012345678901234567890", 0).as_deref(),
        Some("1234567890123456789012345678901234567890")
    );
    assert_eq!(raw_units_to_decimal("", 6), None);
    assert_eq!(raw_units_to_decimal("12ab", 6), None);
    assert_eq!(raw_units_to_decimal("-5", 6), None);
}

#[test]
fn tx_hash_validation_requires_0x_plus_64_hex() {
    assert!(valid_tx_hash(&format!("0x{}", "ab".repeat(32))));
    assert!(!valid_tx_hash("0xshort"));
    assert!(!valid_tx_hash(&format!("0x{}", "zz".repeat(32))));
    assert!(!valid_tx_hash(&format!("0X{}", "ab".repeat(32))));
}

#[test]
fn settlement_derives_from_observed_output_only() {
    let instrument = TestInstrument::new(18, 6);

    // buy: observed 1.5 base out, exact 3750.375 quote in.
    let buy = settlement_from_observation(
        &instrument.spec,
        "buy",
        "1.5",
        "3750.375",
        "1500000000000000000",
    )
    .expect("buy settlement");
    assert_eq!(buy.filled_quantity, "1.5");
    assert_eq!(buy.quote_amount, "3750.375");
    assert_eq!(buy.average_fill_price.as_deref(), Some("2500.25"));

    // sell: full 2 base in, observed 6001.000001 quote out.
    let sell = settlement_from_observation(&instrument.spec, "sell", "2", "2", "6001000001")
        .expect("sell settlement");
    assert_eq!(sell.filled_quantity, "2");
    assert_eq!(sell.quote_amount, "6001.000001");

    // Zero observed output or garbage raw never settles.
    assert!(settlement_from_observation(&instrument.spec, "buy", "1.5", "3750.375", "0").is_none());
    assert!(settlement_from_observation(&instrument.spec, "sell", "2", "2", "not-units").is_none());
}

#[test]
fn rfc3339_renders_parseable_timestamps() {
    assert_eq!(rfc3339(0), "1970-01-01T00:00:00+00:00");
    let rendered = rfc3339(1_760_000_000);
    assert!(rendered.ends_with("+00:00"));
    assert!(chrono::DateTime::parse_from_rfc3339(&rendered).is_ok());
}

#[test]
fn unknown_status_serializes_as_consumer_expects() {
    assert_eq!(DeskOrderStatus::Unknown.as_str(), "unknown");
    assert_eq!(
        serde_json::to_string(&DeskOrderStatus::Unknown).expect("serialize"),
        "\"unknown\""
    );
}
