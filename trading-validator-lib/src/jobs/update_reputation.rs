use crate::context;
use crate::tangle::extract::{Caller, TangleArg, TangleResult};
use crate::{JsonResponse, ReputationUpdate};

/// Handle JOB_UPDATE_REPUTATION (job 0).
///
/// Each operator periodically reports its validation metrics.  The result
/// is ABI-encoded as `(uint256 validationCount, int256 reputationDelta)`
/// so the on-chain `onJobResult` can update the contract state.
pub async fn handle_update_reputation(
    Caller(_caller): Caller,
    TangleArg(update): TangleArg<ReputationUpdate>,
) -> Result<TangleResult<JsonResponse>, String> {
    tracing::info!("Updating reputation for: {:?}", update.validator_address);

    // Get this operator's metrics
    let operator_addr = if let Some(ctx) = context::operator_context() {
        format!("{}", ctx.operator_address)
    } else {
        update.validator_address.to_string()
    };

    let metrics = crate::get_validator_metrics(&operator_addr)?;

    // Compute reputation delta from recent performance
    // Positive delta for good scores, negative for poor performance
    let delta: i64 = if metrics.validations_completed > 0 {
        let score_factor = (metrics.average_score - 50.0) / 50.0; // -1.0 to 1.0
        let failure_penalty = metrics.ai_scoring_failures as f64 * 0.5;
        ((score_factor * 5.0) - failure_penalty).round() as i64
    } else {
        0
    };

    // Update local state
    if let Ok(Some(mut state)) = crate::get_validator_state(&operator_addr) {
        state.reputation = (state.reputation + delta).clamp(-100, 1000);
        crate::set_validator_state(state)?;
    }

    // Return ABI-encoded output that the contract can decode
    let response = serde_json::json!({
        "status": "reputation_updated",
        "operator": operator_addr,
        "validation_count": metrics.validations_completed,
        "reputation_delta": delta,
        "average_score": metrics.average_score,
    });

    Ok(TangleResult(JsonResponse {
        json: response.to_string(),
    }))
}
