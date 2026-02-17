use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use ai_agent_sandbox_blueprint_lib::{SandboxTaskRequest, SandboxTaskResponse};

/// Run a multi-turn task against a trading bot's sidecar. Thin wrapper around
/// the sandbox blueprint's task handler.
pub async fn task(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<SandboxTaskRequest>,
) -> Result<TangleResult<SandboxTaskResponse>, String> {
    let record = sandbox_runtime::runtime::get_sandbox_by_url(&request.sidecar_url)
        .map_err(|e| e.to_string())?;

    let response = ai_agent_sandbox_blueprint_lib::run_task_request(&request, &record.token).await?;
    Ok(TangleResult(response))
}
