use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use ai_agent_sandbox_blueprint_lib::{SandboxTaskRequest, SandboxTaskResponse};

/// Run a multi-turn task against a trading bot's sidecar. Thin wrapper around
/// the sandbox blueprint's task handler.
pub async fn task(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<SandboxTaskRequest>,
) -> Result<TangleResult<SandboxTaskResponse>, String> {
    let token = sandbox_runtime::auth::require_sidecar_token(&request.sidecar_token)
        .map_err(|e| e.to_string())?;
    sandbox_runtime::runtime::require_sidecar_auth(&request.sidecar_url, &token)
        .map_err(|e| e.to_string())?;

    let mut request = request;
    request.sidecar_token = token;
    let response = ai_agent_sandbox_blueprint_lib::run_task_request(&request).await?;
    Ok(TangleResult(response))
}
