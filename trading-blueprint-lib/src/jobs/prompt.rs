use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use ai_agent_sandbox_blueprint_lib::{SandboxPromptRequest, SandboxPromptResponse};

/// Send a prompt to a trading bot's sidecar. Thin wrapper around the sandbox
/// blueprint's prompt handler.
pub async fn prompt(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<SandboxPromptRequest>,
) -> Result<TangleResult<SandboxPromptResponse>, String> {
    let record = sandbox_runtime::runtime::get_sandbox_by_url(&request.sidecar_url)
        .map_err(|e| e.to_string())?;

    let response = ai_agent_sandbox_blueprint_lib::run_prompt_request(&request, &record.token).await?;
    Ok(TangleResult(response))
}
