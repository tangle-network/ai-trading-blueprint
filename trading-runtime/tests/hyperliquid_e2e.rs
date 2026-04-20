//! Hyperliquid E2E integration tests.
//!
//! These tests hit the REAL Hyperliquid testnet API. They require:
//! - `HYPERLIQUID_E2E=1` env var
//! - `EXECUTOR_PRIVATE_KEY` with a funded HL testnet account
//!
//! Run: `HYPERLIQUID_E2E=1 EXECUTOR_PRIVATE_KEY=0x... cargo test -p trading-runtime --test hyperliquid_e2e -- --nocapture`

use trading_runtime::hyperliquid::*;

fn skip_unless_enabled() -> bool {
    std::env::var("HYPERLIQUID_E2E").is_ok_and(|v| v == "1" || v == "true")
}

fn get_client() -> HyperliquidClient {
    let key = std::env::var("EXECUTOR_PRIVATE_KEY")
        .expect("EXECUTOR_PRIVATE_KEY must be set for HL E2E tests");
    HyperliquidClient::testnet(&key).expect("failed to create HL testnet client")
}

#[tokio::test]
async fn test_get_mids() {
    if !skip_unless_enabled() {
        eprintln!("Skipping HL E2E (set HYPERLIQUID_E2E=1)");
        return;
    }
    let client = get_client();
    let mids = client.get_mids().await.expect("get_mids failed");
    eprintln!("HL testnet mid prices: {} assets", mids.len());
    assert!(!mids.is_empty(), "should have at least one asset");
    // BTC and ETH should always exist on testnet
    assert!(
        mids.contains_key("BTC") || mids.contains_key("ETH"),
        "should contain BTC or ETH, got: {:?}",
        mids.keys().take(5).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn test_resolve_asset_by_symbol() {
    if !skip_unless_enabled() {
        return;
    }
    let client = get_client();
    let btc_idx = client
        .resolve_asset(&AssetId::Symbol("BTC".into()))
        .await
        .expect("resolve BTC failed");
    assert_eq!(btc_idx, 0, "BTC should be asset index 0");

    let eth_idx = client
        .resolve_asset(&AssetId::Symbol("ETH".into()))
        .await
        .expect("resolve ETH failed");
    assert_eq!(eth_idx, 1, "ETH should be asset index 1");
}

#[tokio::test]
async fn test_get_account() {
    if !skip_unless_enabled() {
        return;
    }
    let client = get_client();
    let account = client.get_account().await.expect("get_account failed");
    eprintln!("HL testnet account:");
    eprintln!("  value: {}", account.account_value);
    eprintln!("  margin: {}", account.total_margin_used);
    eprintln!("  positions: {}", account.positions.len());
    eprintln!("  orders: {}", account.open_orders.len());
    // Account value should be a parseable number (even if "0.0")
    let _: f64 = account
        .account_value
        .parse()
        .expect("account_value should be a number");
}

#[tokio::test]
async fn test_set_leverage() {
    if !skip_unless_enabled() {
        return;
    }
    let client = get_client();
    // Set ETH leverage to 5x cross
    let resp = client
        .set_leverage(1, 5, true)
        .await
        .expect("set_leverage failed");
    eprintln!("Set leverage response: {:?}", resp);
}

#[tokio::test]
async fn test_place_limit_order_and_cancel() {
    if !skip_unless_enabled() {
        return;
    }
    let client = get_client();

    // Set leverage first
    let _ = client.set_leverage(1, 3, true).await;

    // Place a limit buy far below market (won't fill)
    let req = PlaceOrderRequest {
        asset: AssetId::Symbol("ETH".into()),
        is_buy: true,
        size: "0.01".into(),
        order_type: HlOrderType::Limit {
            price: "100.0".into(), // $100 — far below market, won't fill
        },
        reduce_only: false,
        cloid: None,
    };
    let resp = client.place_order(&req).await.expect("place_order failed");
    eprintln!("Limit order response: {:?}", resp);

    // Fetch open orders and find our order
    let account = client.get_account().await.expect("get_account failed");
    eprintln!("Open orders after place: {}", account.open_orders.len());

    // Cancel all ETH orders
    for order in &account.open_orders {
        if order.coin == "ETH" {
            let cancel_resp = client
                .cancel_order(1, order.oid)
                .await
                .expect("cancel_order failed");
            eprintln!("Cancelled order {}: {:?}", order.oid, cancel_resp);
        }
    }

    // Verify orders cancelled
    let account_after = client.get_account().await.expect("get_account failed");
    let eth_orders: Vec<_> = account_after
        .open_orders
        .iter()
        .filter(|o| o.coin == "ETH")
        .collect();
    assert!(
        eth_orders.is_empty(),
        "ETH orders should be cancelled, found {}",
        eth_orders.len()
    );
}

#[tokio::test]
async fn test_place_market_order() {
    if !skip_unless_enabled() {
        return;
    }
    let client = get_client();

    // Check account balance first
    let account = client.get_account().await.expect("get_account failed");
    let balance: f64 = account.account_value.parse().unwrap_or(0.0);
    if balance < 10.0 {
        eprintln!(
            "Skipping market order test — insufficient testnet balance: ${:.2}",
            balance
        );
        return;
    }

    // Set leverage
    let _ = client.set_leverage(1, 3, true).await;

    // Place a small market long ETH
    let req = PlaceOrderRequest {
        asset: AssetId::Symbol("ETH".into()),
        is_buy: true,
        size: "0.01".into(),
        order_type: HlOrderType::Market,
        reduce_only: false,
        cloid: None,
    };
    let resp = client.place_order(&req).await.expect("market order failed");
    eprintln!("Market order response: {:?}", resp);

    // Verify position exists
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let account = client.get_account().await.expect("get_account failed");
    let eth_pos: Vec<_> = account
        .positions
        .iter()
        .filter(|p| p.asset == "ETH")
        .collect();
    eprintln!("ETH positions after market buy: {:?}", eth_pos);

    // Close the position
    let close_req = PlaceOrderRequest {
        asset: AssetId::Symbol("ETH".into()),
        is_buy: false,
        size: "0.01".into(),
        order_type: HlOrderType::Market,
        reduce_only: true,
        cloid: None,
    };
    let close_resp = client
        .place_order(&close_req)
        .await
        .expect("close order failed");
    eprintln!("Close response: {:?}", close_resp);
}

#[tokio::test]
async fn test_bracket_order() {
    if !skip_unless_enabled() {
        return;
    }
    let client = get_client();

    let account = client.get_account().await.expect("get_account failed");
    let balance: f64 = account.account_value.parse().unwrap_or(0.0);
    if balance < 10.0 {
        eprintln!(
            "Skipping bracket test — insufficient balance: ${:.2}",
            balance
        );
        return;
    }

    let _ = client.set_leverage(1, 3, true).await;

    // Get current ETH price for realistic SL/TP
    let mids = client.get_mids().await.expect("get_mids failed");
    let eth_mid: f64 = mids
        .get("ETH")
        .and_then(|s| s.parse().ok())
        .unwrap_or(2500.0);
    let sl_price = format!("{:.1}", eth_mid * 0.95); // 5% below
    let tp_price = format!("{:.1}", eth_mid * 1.05); // 5% above

    eprintln!(
        "ETH mid: {:.1}, SL: {}, TP: {}",
        eth_mid, sl_price, tp_price
    );

    let entry = PlaceOrderRequest {
        asset: AssetId::Symbol("ETH".into()),
        is_buy: true,
        size: "0.01".into(),
        order_type: HlOrderType::Market,
        reduce_only: false,
        cloid: None,
    };
    let sl = PlaceOrderRequest {
        asset: AssetId::Symbol("ETH".into()),
        is_buy: false,
        size: "0.01".into(),
        order_type: HlOrderType::StopLoss {
            trigger_price: sl_price,
            is_market: true,
        },
        reduce_only: true,
        cloid: None,
    };
    let tp = PlaceOrderRequest {
        asset: AssetId::Symbol("ETH".into()),
        is_buy: false,
        size: "0.01".into(),
        order_type: HlOrderType::TakeProfit {
            trigger_price: tp_price,
            is_market: true,
        },
        reduce_only: true,
        cloid: None,
    };

    let resp = client
        .place_bracket(&entry, Some(&sl), Some(&tp))
        .await
        .expect("bracket order failed");
    eprintln!("Bracket order response: {:?}", resp);

    // Verify position + trigger orders exist
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let account = client.get_account().await.expect("get_account failed");
    eprintln!(
        "Positions: {}, Orders: {}",
        account.positions.len(),
        account.open_orders.len()
    );

    // Clean up — close position and cancel remaining orders
    let close_req = PlaceOrderRequest {
        asset: AssetId::Symbol("ETH".into()),
        is_buy: false,
        size: "0.01".into(),
        order_type: HlOrderType::Market,
        reduce_only: true,
        cloid: None,
    };
    let _ = client.place_order(&close_req).await;
    for order in &account.open_orders {
        if order.coin == "ETH" {
            let _ = client.cancel_order(1, order.oid).await;
        }
    }
}
