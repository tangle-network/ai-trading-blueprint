use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use ai_agent_sandbox_blueprint_lib::{SandboxPromptRequest, SandboxPromptResponse};

/// Send a prompt to a trading bot's sidecar. Thin wrapper around the sandbox
/// blueprint's prompt handler.
pub async fn prompt(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<SandboxPromptRequest>,
) -> Result<TangleResult<SandboxPromptResponse>, String> {
    let token = sandbox_runtime::auth::require_sidecar_token(&request.sidecar_token)
        .map_err(|e| e.to_string())?;
    sandbox_runtime::runtime::require_sidecar_auth(&request.sidecar_url, &token)
        .map_err(|e| e.to_string())?;

    let mut request = request;
    request.sidecar_token = token;
    let response = ai_agent_sandbox_blueprint_lib::run_prompt_request(&request).await?;
    Ok(TangleResult(response))
}
