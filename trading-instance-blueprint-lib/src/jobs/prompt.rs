use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use crate::{InstancePromptRequest, InstancePromptResponse, require_instance_bot};

/// Send a prompt to the singleton bot's sidecar agent.
///
/// Instance-scoped: no sidecar_url in request — resolved from singleton.
pub async fn instance_prompt(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<InstancePromptRequest>,
) -> Result<TangleResult<InstancePromptResponse>, String> {
    let bot = require_instance_bot()?;
    let record = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map_err(|e| format!("Sandbox not found: {e}"))?;

    let sandbox_request = ai_agent_sandbox_blueprint_lib::SandboxPromptRequest {
        sidecar_url: record.sidecar_url.clone(),
        message: request.message.clone(),
        session_id: request.session_id.clone(),
        model: request.model.clone(),
        context_json: request.context_json.clone(),
        timeout_ms: request.timeout_ms,
    };

    let resp =
        ai_agent_sandbox_blueprint_lib::run_prompt_request(&sandbox_request, &record.token)
            .await?;

    Ok(TangleResult(InstancePromptResponse {
        success: resp.success,
        response: resp.response,
        error: resp.error,
        trace_id: resp.trace_id,
        duration_ms: resp.duration_ms,
        input_tokens: resp.input_tokens,
        output_tokens: resp.output_tokens,
    }))
}
