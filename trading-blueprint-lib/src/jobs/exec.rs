use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use ai_agent_sandbox_blueprint_lib::{SandboxExecRequest, SandboxExecResponse};

/// Execute a terminal command in a trading bot's sidecar. Thin wrapper around
/// the sandbox blueprint's exec handler.
pub async fn exec(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<SandboxExecRequest>,
) -> Result<TangleResult<SandboxExecResponse>, String> {
    let record = sandbox_runtime::runtime::get_sandbox_by_url(&request.sidecar_url)
        .map_err(|e| e.to_string())?;

    let response = ai_agent_sandbox_blueprint_lib::run_exec_request(&request, &record.token).await?;
    Ok(TangleResult(response))
}
