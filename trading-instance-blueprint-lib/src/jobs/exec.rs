use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use crate::{InstanceExecRequest, InstanceExecResponse, require_instance_bot};

/// Execute a terminal command in the singleton bot's sidecar.
///
/// Instance-scoped: no sidecar_url in request — resolved from singleton.
pub async fn instance_exec(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<InstanceExecRequest>,
) -> Result<TangleResult<InstanceExecResponse>, String> {
    let bot = require_instance_bot()?;
    let record = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map_err(|e| format!("Sandbox not found: {e}"))?;

    let sandbox_request = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: record.sidecar_url.clone(),
        command: request.command.clone(),
        cwd: request.cwd.clone(),
        env_json: request.env_json.clone(),
        timeout_ms: request.timeout_ms,
    };

    let resp =
        ai_agent_sandbox_blueprint_lib::run_exec_request(&sandbox_request, &record.token).await?;

    Ok(TangleResult(InstanceExecResponse {
        exit_code: resp.exit_code,
        stdout: resp.stdout,
        stderr: resp.stderr,
    }))
}
