use crate::tangle::extract::{Caller, TangleArg, TangleResult};
use crate::{ConfigUpdate, JsonResponse};

/// Handle JOB_UPDATE_CONFIG (job 1).
pub async fn handle_update_config(
    Caller(_caller): Caller,
    TangleArg(config): TangleArg<ConfigUpdate>,
) -> Result<TangleResult<JsonResponse>, String> {
    tracing::info!(
        "Updating config: threshold={}, min_stake={}",
        config.threshold,
        config.min_stake,
    );

    Ok(TangleResult(JsonResponse {
        json: serde_json::json!({
            "status": "config_updated",
            "threshold": config.threshold.to_string(),
            "min_stake": config.min_stake.to_string(),
        })
        .to_string(),
    }))
}
