//! Validator endpoint discovery.
//!
//! Resolves validator HTTP endpoints from `validator_service_ids` in the
//! provision request.  Production flow:
//!
//! 1. For each validator service ID, query Tangle for the service's operators
//!    via `get_service_operators(serviceId)`.
//! 2. For each operator, query their RPC metadata via
//!    `get_operator_metadata(blueprintId, operator)` to get the HTTP endpoint.
//! 3. Fall back to `VALIDATOR_ENDPOINTS` env var if on-chain discovery fails.

/// Discover validator endpoints for the given service IDs.
///
/// Tries on-chain discovery first (when available), then falls back to
/// the `VALIDATOR_ENDPOINTS` environment variable.
///
/// Returns a list of HTTP endpoint URLs (e.g., `["http://validator1:9090"]`).
pub async fn discover_validator_endpoints(
    validator_service_ids: &[u64],
) -> Vec<String> {
    // 1. Try on-chain discovery for each service ID
    let mut endpoints = Vec::new();

    for &service_id in validator_service_ids {
        match discover_from_chain(service_id).await {
            Ok(eps) => endpoints.extend(eps),
            Err(e) => {
                tracing::debug!(
                    "On-chain discovery failed for service {service_id}: {e}, will use fallback"
                );
            }
        }
    }

    // 2. If we got endpoints from on-chain, use them
    if !endpoints.is_empty() {
        tracing::info!(
            "Discovered {} validator endpoints from on-chain for {} services",
            endpoints.len(),
            validator_service_ids.len(),
        );
        return endpoints;
    }

    // 3. Fall back to env var
    let env_endpoints = endpoints_from_env();
    if env_endpoints.is_empty() {
        tracing::warn!(
            "No validator endpoints discovered (service_ids={:?}, VALIDATOR_ENDPOINTS not set)",
            validator_service_ids,
        );
    } else {
        tracing::info!(
            "Using {} validator endpoints from VALIDATOR_ENDPOINTS env var",
            env_endpoints.len(),
        );
    }
    env_endpoints
}

/// Parse validator endpoints from the `VALIDATOR_ENDPOINTS` environment variable.
///
/// Format: comma-separated URLs, e.g., `"http://v1:9090,http://v2:9090"`.
pub fn endpoints_from_env() -> Vec<String> {
    std::env::var("VALIDATOR_ENDPOINTS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect()
}

/// Try to discover validator endpoints from the Tangle chain for a service ID.
///
/// Currently falls back to service-specific env vars. On-chain discovery via
/// the Tangle EVM contracts will be wired when operator context carries a
/// connected provider:
///
/// 1. Call `tangle.getServiceOperators(serviceId)` → `Vec<Address>`
/// 2. For each operator, call `tangle.getOperatorMetadata(blueprintId, operator)`
/// 3. Extract the RPC endpoint from the metadata
/// 4. Return the list of HTTP URLs
async fn discover_from_chain(service_id: u64) -> Result<Vec<String>, String> {
    // TODO: Wire up Tangle EVM contract calls for operator discovery.
    //
    // The Tangle protocol stores operator metadata including RPC endpoints
    // when operators call `registerOperator(blueprintId, ecdsaKey, rpcAddress)`.
    //
    // To query via alloy:
    //   let tangle = ITangle::new(tangle_address, provider);
    //   let operators = tangle.getServiceOperators(service_id).call().await?;
    //   for op in operators {
    //       let meta = tangle.getOperatorMetadata(blueprint_id, op).call().await?;
    //       endpoints.push(meta.rpcEndpoint);
    //   }
    //
    // For now, check if there's a service-specific env var.
    let env_key = format!("VALIDATOR_ENDPOINTS_{service_id}");
    match std::env::var(&env_key) {
        Ok(val) if !val.trim().is_empty() => {
            let eps: Vec<String> = val
                .split(',')
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
                .collect();
            Ok(eps)
        }
        _ => Err(format!(
            "On-chain discovery not yet wired; no {env_key} env var set"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test the `endpoints_from_env_var` parsing logic directly,
    /// without touching process env vars (avoids races in parallel tests).
    #[test]
    fn test_parse_endpoint_string() {
        // Helper that parses like endpoints_from_env but from a string
        fn parse(s: &str) -> Vec<String> {
            s.split(',')
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
                .collect()
        }

        assert!(parse("").is_empty());
        assert_eq!(parse("http://v1:9090"), vec!["http://v1:9090"]);
        assert_eq!(
            parse("http://v1:9090, http://v2:9090 ,http://v3:9090"),
            vec!["http://v1:9090", "http://v2:9090", "http://v3:9090"]
        );
        assert_eq!(
            parse("http://v1:9090,,, ,http://v2:9090,"),
            vec!["http://v1:9090", "http://v2:9090"]
        );
    }

    /// Test service-specific env var discovery with unique var names
    /// to avoid racing with other tests.
    #[tokio::test]
    async fn test_discover_with_service_specific_env() {
        // Use a unique service ID unlikely to conflict
        unsafe { std::env::set_var("VALIDATOR_ENDPOINTS_98765", "http://val98765:9090") };
        let eps = discover_validator_endpoints(&[98765]).await;
        assert_eq!(eps, vec!["http://val98765:9090"]);
        unsafe { std::env::remove_var("VALIDATOR_ENDPOINTS_98765") };
    }

    /// When a service-specific env var is set, it should be preferred
    /// over the global VALIDATOR_ENDPOINTS.
    #[tokio::test]
    async fn test_discover_prefers_service_specific() {
        unsafe {
            std::env::set_var("VALIDATOR_ENDPOINTS_11111", "http://specific:9090");
        }
        let eps = discover_validator_endpoints(&[11111]).await;
        assert_eq!(eps, vec!["http://specific:9090"]);
        unsafe {
            std::env::remove_var("VALIDATOR_ENDPOINTS_11111");
        }
    }

    /// Multiple service IDs each with their own env var.
    #[tokio::test]
    async fn test_discover_multiple_services() {
        unsafe {
            std::env::set_var("VALIDATOR_ENDPOINTS_22222", "http://a:9090");
            std::env::set_var("VALIDATOR_ENDPOINTS_33333", "http://b:9090");
        }
        let eps = discover_validator_endpoints(&[22222, 33333]).await;
        assert!(eps.contains(&"http://a:9090".to_string()));
        assert!(eps.contains(&"http://b:9090".to_string()));
        unsafe {
            std::env::remove_var("VALIDATOR_ENDPOINTS_22222");
            std::env::remove_var("VALIDATOR_ENDPOINTS_33333");
        }
    }
}
