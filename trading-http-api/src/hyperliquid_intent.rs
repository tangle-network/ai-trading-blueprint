use rust_decimal::Decimal;
use serde_json::Value;
use trading_runtime::hyperliquid::AssetId;

const HYPERLIQUID_OUTCOME_ASSET_OFFSET: u32 = 100_000_000;

pub fn order_size(metadata: &Value, fallback: &Decimal) -> Result<Decimal, String> {
    let raw = ["asset_size", "sz", "size", "base_size"]
        .into_iter()
        .find_map(|key| metadata_decimal_string(metadata, key))
        .unwrap_or_else(|| fallback.to_string());
    let size = raw
        .parse::<Decimal>()
        .map_err(|e| format!("Invalid Hyperliquid asset_size '{raw}': {e}"))?;
    if size <= Decimal::ZERO {
        return Err("Hyperliquid asset_size must be greater than zero".to_string());
    }
    Ok(size)
}

pub fn order_size_string(metadata: &Value, fallback: &Decimal) -> Result<String, String> {
    order_size(metadata, fallback).map(|size| size.normalize().to_string())
}

pub fn asset_from_metadata(metadata: &Value, fallback_symbol: &str) -> Result<AssetId, String> {
    if let Some(index) = outcome_asset_index(metadata)? {
        return Ok(AssetId::Index(index));
    }

    for key in ["asset_id", "hyperliquid_asset_id"] {
        if let Some(index) = metadata_u32(metadata, key) {
            return Ok(AssetId::Index(index));
        }
    }

    match metadata.get("asset") {
        Some(Value::Number(value)) => {
            let index = value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "Hyperliquid asset index is out of range".to_string())?;
            Ok(AssetId::Index(index))
        }
        Some(Value::String(value)) => parse_asset_string(value)
            .map(Ok)
            .unwrap_or_else(|| Ok(AssetId::Symbol(value.trim().to_string()))),
        _ => parse_asset_string(fallback_symbol)
            .map(Ok)
            .unwrap_or_else(|| Ok(AssetId::Symbol(fallback_symbol.to_string()))),
    }
}

pub fn asset_label(asset: &AssetId) -> String {
    match asset {
        AssetId::Index(index) if *index >= HYPERLIQUID_OUTCOME_ASSET_OFFSET => {
            format!("#{}", index - HYPERLIQUID_OUTCOME_ASSET_OFFSET)
        }
        AssetId::Index(index) => index.to_string(),
        AssetId::Symbol(symbol) => symbol.clone(),
    }
}

pub fn asset_index(asset: &AssetId) -> Option<u32> {
    match asset {
        AssetId::Index(index) => Some(*index),
        AssetId::Symbol(symbol) => parse_asset_string(symbol).and_then(|asset| asset_index(&asset)),
    }
}

pub fn is_outcome_metadata(metadata: &Value) -> bool {
    normalized_metadata(metadata, "hyperliquid_market_type").is_some_and(|value| {
        matches!(
            value.as_str(),
            "outcome" | "outcomes" | "hyperp" | "hyperps" | "prediction" | "prediction_market"
        )
    }) || normalized_metadata(metadata, "market_type").is_some_and(|value| {
        value.contains("prediction") || value.contains("outcome") || value.contains("hyperp")
    }) || normalized_metadata(metadata, "instrument_type").is_some_and(|value| {
        value.contains("binary") || value.contains("prediction") || value.contains("outcome")
    }) || metadata.get("outcome_id").is_some()
        || metadata.get("outcome_asset_id").is_some()
        || metadata.get("outcome_side").is_some()
        || metadata.get("market_question").is_some()
        || metadata.get("resolution_source").is_some()
        || metadata_string(metadata, "asset")
            .as_deref()
            .and_then(parse_asset_string)
            .is_some_and(|asset| matches!(asset, AssetId::Index(index) if index >= HYPERLIQUID_OUTCOME_ASSET_OFFSET))
}

pub fn metadata_decimal(metadata: &Value, key: &str) -> Option<Decimal> {
    metadata_decimal_string(metadata, key).and_then(|value| value.parse::<Decimal>().ok())
}

pub fn metadata_decimal_any(metadata: &Value, keys: &[&str]) -> Option<Decimal> {
    keys.iter().find_map(|key| metadata_decimal(metadata, key))
}

pub fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    match metadata.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.trim().to_string()),
        _ => None,
    }
}

fn metadata_decimal_string(metadata: &Value, key: &str) -> Option<String> {
    match metadata.get(key) {
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.trim().to_string()),
        _ => None,
    }
}

fn metadata_u32(metadata: &Value, key: &str) -> Option<u32> {
    match metadata.get(key) {
        Some(Value::Number(value)) => value.as_u64().and_then(|value| u32::try_from(value).ok()),
        Some(Value::String(value)) if !value.trim().is_empty() => value.trim().parse().ok(),
        _ => None,
    }
}

fn metadata_u8(metadata: &Value, key: &str) -> Option<u8> {
    match metadata.get(key) {
        Some(Value::Number(value)) => value.as_u64().and_then(|value| u8::try_from(value).ok()),
        Some(Value::String(value)) if !value.trim().is_empty() => value.trim().parse().ok(),
        _ => None,
    }
}

fn normalized_metadata(metadata: &Value, key: &str) -> Option<String> {
    metadata_string(metadata, key).map(|value| normalize(&value))
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase().replace('-', "_")
}

fn parse_asset_string(value: &str) -> Option<AssetId> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(encoding) = trimmed
        .strip_prefix('#')
        .or_else(|| trimmed.strip_prefix('+'))
    {
        let encoding = encoding.parse::<u32>().ok()?;
        return HYPERLIQUID_OUTCOME_ASSET_OFFSET
            .checked_add(encoding)
            .map(AssetId::Index);
    }
    trimmed.parse::<u32>().ok().map(AssetId::Index)
}

fn outcome_asset_index(metadata: &Value) -> Result<Option<u32>, String> {
    if let Some(index) = metadata_u32(metadata, "outcome_asset_id") {
        return Ok(Some(index));
    }
    let Some(outcome_id) = metadata_u32(metadata, "outcome_id") else {
        return Ok(None);
    };
    let side = metadata_u8(metadata, "outcome_side")
        .or_else(|| metadata_u8(metadata, "side"))
        .or_else(|| metadata_u8(metadata, "outcome_index"))
        .ok_or_else(|| {
            "Hyperliquid outcome_id requires numeric outcome_side, side, or outcome_index"
                .to_string()
        })?;
    if side > 9 {
        return Err("Hyperliquid outcome side must be 0..9".to_string());
    }
    let encoding = outcome_id
        .checked_mul(10)
        .and_then(|value| value.checked_add(side as u32))
        .ok_or_else(|| "Hyperliquid outcome asset encoding overflow".to_string())?;
    HYPERLIQUID_OUTCOME_ASSET_OFFSET
        .checked_add(encoding)
        .map(Some)
        .ok_or_else(|| "Hyperliquid outcome asset id overflow".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_hash_outcome_coin_to_hypercore_asset_index() {
        let asset = asset_from_metadata(&json!({ "asset": "#17" }), "USDC").unwrap();
        assert!(matches!(asset, AssetId::Index(100_000_017)));
        assert_eq!(asset_label(&asset), "#17");
    }

    #[test]
    fn builds_outcome_asset_index_from_id_and_side() {
        let asset = asset_from_metadata(
            &json!({
                "hyperliquid_market_type": "hyperp",
                "outcome_id": 12,
                "outcome_side": 1
            }),
            "USDC",
        )
        .unwrap();
        assert!(matches!(asset, AssetId::Index(100_000_121)));
    }

    #[test]
    fn detects_outcome_metadata_without_polymarket_fields() {
        assert!(is_outcome_metadata(&json!({
            "market_type": "prediction_market",
            "asset": "#22"
        })));
    }
}
