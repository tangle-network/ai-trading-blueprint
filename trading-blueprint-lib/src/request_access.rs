use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

const MODE_ENV: &str = "TRADING_REQUESTER_ACCESS_MODE";
const ALLOWLIST_ENV: &str = "TRADING_REQUESTER_ALLOWLIST";
const LEGACY_ALLOWLIST_ENV: &str = "TRADING_BOT_REQUESTER_ALLOWLIST";
const POLICY_FILE: &str = "request-access-policy.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestAccessMode {
    Allowlist,
    Public,
}

impl RequestAccessMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allowlist => "allowlist",
            Self::Public => "public",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestAccessPolicy {
    pub mode: RequestAccessMode,
    #[serde(default)]
    pub allowed_requesters: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RequestAccessSummary {
    pub mode: &'static str,
    pub allowed_requester_count: usize,
    pub operator_address: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RequestAccessUpdate {
    pub mode: Option<RequestAccessMode>,
    pub allowed_requesters: Option<Vec<String>>,
}

impl Default for RequestAccessPolicy {
    fn default() -> Self {
        Self {
            mode: RequestAccessMode::Allowlist,
            allowed_requesters: Vec::new(),
        }
    }
}

impl RequestAccessPolicy {
    pub fn summary(&self) -> RequestAccessSummary {
        RequestAccessSummary {
            mode: self.mode.as_str(),
            allowed_requester_count: self.allowed_requesters.len(),
            operator_address: operator_address(),
        }
    }

    pub fn allows(&self, requester: &str) -> bool {
        if self.mode == RequestAccessMode::Public {
            return true;
        }
        let Some(requester) = normalize_address(requester) else {
            return false;
        };
        if operator_address()
            .as_deref()
            .and_then(normalize_address)
            .is_some_and(|operator| operator == requester)
        {
            return true;
        }
        self.allowed_requesters
            .iter()
            .any(|allowed| normalize_address(allowed).is_some_and(|allowed| allowed == requester))
    }
}

pub fn operator_address() -> Option<String> {
    std::env::var("OPERATOR_ADDRESS")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn caller_is_operator_admin(caller: &str) -> bool {
    operator_address()
        .as_deref()
        .and_then(normalize_address)
        .zip(normalize_address(caller))
        .is_some_and(|(operator, caller)| operator == caller)
}

pub fn normalize_address(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let body = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))?;
    if body.len() != 40 || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("0x{}", body.to_ascii_lowercase()))
}

pub fn load_request_access_policy() -> RequestAccessPolicy {
    match read_policy_file() {
        Ok(Some(policy)) => policy,
        Ok(None) => env_policy(),
        Err(error) => {
            tracing::warn!(%error, "failed to read requester access policy; falling back to env");
            env_policy()
        }
    }
}

pub fn save_request_access_policy(
    update: RequestAccessUpdate,
) -> Result<RequestAccessPolicy, String> {
    let mut policy = load_request_access_policy();
    if let Some(mode) = update.mode {
        policy.mode = mode;
    }
    if let Some(allowed) = update.allowed_requesters {
        policy.allowed_requesters = normalize_allowlist(allowed.iter().map(String::as_str));
    }

    let path = policy_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&policy).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())?;
    Ok(policy)
}

pub fn ensure_requester_allowed(requester: &str) -> Result<(), String> {
    let policy = load_request_access_policy();
    if policy.allows(requester) {
        return Ok(());
    }
    Err(format!(
        "Requester {requester} is not allowed by this operator. Ask the operator to add the wallet to {ALLOWLIST_ENV}, or set {MODE_ENV}=public when ready for open access."
    ))
}

fn env_policy() -> RequestAccessPolicy {
    let mode = std::env::var(MODE_ENV)
        .ok()
        .as_deref()
        .and_then(parse_mode)
        .unwrap_or(RequestAccessMode::Allowlist);

    let allowlist = std::env::var(ALLOWLIST_ENV)
        .ok()
        .or_else(|| std::env::var(LEGACY_ALLOWLIST_ENV).ok())
        .map(|value| {
            normalize_allowlist(value.split(|c: char| c == ',' || c == '\n' || c.is_whitespace()))
        })
        .unwrap_or_default();

    RequestAccessPolicy {
        mode,
        allowed_requesters: allowlist,
    }
}

fn parse_mode(value: &str) -> Option<RequestAccessMode> {
    match value.trim().to_ascii_lowercase().as_str() {
        "public" | "open" | "anyone" => Some(RequestAccessMode::Public),
        "allowlist" | "whitelist" | "private" | "restricted" => Some(RequestAccessMode::Allowlist),
        _ => None,
    }
}

fn normalize_allowlist<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    values
        .filter_map(normalize_address)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn policy_path() -> PathBuf {
    sandbox_runtime::store::state_dir().join(POLICY_FILE)
}

fn read_policy_file() -> Result<Option<RequestAccessPolicy>, String> {
    let path = policy_path();
    if !path.exists() {
        return Ok(None);
    }
    let body = fs::read(path).map_err(|e| e.to_string())?;
    let mut policy: RequestAccessPolicy =
        serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    policy.allowed_requesters =
        normalize_allowlist(policy.allowed_requesters.iter().map(String::as_str));
    Ok(Some(policy))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_policy_allows_operator_and_configured_requesters() {
        unsafe {
            std::env::set_var(
                "OPERATOR_ADDRESS",
                "0x1111111111111111111111111111111111111111",
            );
        }
        let policy = RequestAccessPolicy {
            mode: RequestAccessMode::Allowlist,
            allowed_requesters: vec!["0x2222222222222222222222222222222222222222".to_string()],
        };

        assert!(policy.allows("0x1111111111111111111111111111111111111111"));
        assert!(policy.allows("0x2222222222222222222222222222222222222222"));
        assert!(!policy.allows("0x3333333333333333333333333333333333333333"));
        unsafe {
            std::env::remove_var("OPERATOR_ADDRESS");
        }
    }

    #[test]
    fn public_policy_allows_any_valid_session_address() {
        let policy = RequestAccessPolicy {
            mode: RequestAccessMode::Public,
            allowed_requesters: Vec::new(),
        };

        assert!(policy.allows("0x3333333333333333333333333333333333333333"));
    }
}
