use crate::context;
use crate::tangle::extract::{Caller, TangleArg, TangleResult};
use crate::{JsonResponse, LivenessProof};

/// Handle JOB_LIVENESS (job 2).
///
/// Every operator must submit a heartbeat.  The on-chain contract requires
/// ALL operators to respond (getRequiredResultCount returns operator count).
///
/// After updating our own heartbeat, checks for peer liveness violations
/// and proposes slashes if any are detected.
pub async fn handle_liveness(
    Caller(_caller): Caller,
    TangleArg(proof): TangleArg<LivenessProof>,
) -> Result<TangleResult<JsonResponse>, String> {
    let operator_addr = if let Some(ctx) = context::operator_context() {
        format!("{}", ctx.operator_address)
    } else {
        "unknown".to_string()
    };

    tracing::info!("Liveness heartbeat from operator {operator_addr} at timestamp: {}", proof.timestamp);

    // Update local state
    if let Ok(Some(mut state)) = crate::get_validator_state(&operator_addr) {
        state.last_heartbeat = proof.timestamp;
        crate::set_validator_state(state)?;
    }

    let metrics = crate::get_validator_metrics(&operator_addr)?;

    // Check for peer liveness violations and propose slashes
    let service_id = context::operator_context()
        .map(|ctx| ctx.service_id)
        .unwrap_or(0);

    let heartbeat_interval: u64 = std::env::var("HEARTBEAT_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);

    let violations = crate::slashing::check_liveness_violations(
        service_id,
        proof.timestamp,
        heartbeat_interval,
    );

    for proposal in &violations {
        tracing::warn!(
            "Liveness violation detected: offender={} missed={} heartbeats",
            proposal.offender,
            match &proposal.condition {
                crate::slashing::SlashCondition::LivenessFailure { missed_count, .. } =>
                    *missed_count,
                _ => 0,
            },
        );
        if let Err(e) = crate::slashing::propose_slash(proposal).await {
            tracing::error!("Failed to propose slash: {e}");
        }
    }

    Ok(TangleResult(JsonResponse {
        json: serde_json::json!({
            "status": "alive",
            "operator": operator_addr,
            "timestamp": proof.timestamp,
            "validations_completed": metrics.validations_completed,
            "average_score": metrics.average_score,
            "liveness_violations_detected": violations.len(),
        })
        .to_string(),
    }))
}
