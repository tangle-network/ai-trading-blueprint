use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::Url;

#[derive(Clone, Copy, Debug, Default)]
pub struct RpcUrlValidationOptions {
    pub allow_loopback: bool,
}

/// Validates that a URL is safe to use as an RPC endpoint.
/// Blocks internal/metadata addresses, non-HTTP schemes, and private networks.
pub fn validate_rpc_url(raw: &str) -> Result<String, String> {
    validate_rpc_url_with_options(raw, RpcUrlValidationOptions::default())
}

/// Variant of `validate_rpc_url` with narrow opt-ins for trusted local flows.
pub fn validate_rpc_url_with_options(
    raw: &str,
    options: RpcUrlValidationOptions,
) -> Result<String, String> {
    let parsed = Url::parse(raw).map_err(|e| format!("invalid URL: {e}"))?;

    // Scheme must be http or https
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("disallowed URL scheme: {scheme}")),
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;

    // Block cloud metadata endpoints
    if is_metadata_host(host) {
        return Err(format!("blocked metadata endpoint: {host}"));
    }

    // Try to parse as IP address and block private/internal ranges.
    // url::Url wraps IPv6 addresses in brackets (e.g., "[::1]"), strip them.
    let bare_host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare_host.parse::<IpAddr>()
        && is_blocked_ip(ip, options)
    {
        return Err(format!("blocked internal IP: {host}"));
    }

    // Block well-known internal hostnames
    let lower = host.to_lowercase();
    if is_blocked_hostname(&lower, options) {
        return Err(format!("blocked internal hostname: {host}"));
    }

    Ok(raw.to_string())
}

fn is_metadata_host(host: &str) -> bool {
    matches!(
        host,
        "169.254.169.254" | "metadata.google.internal" | "metadata.google.com" | "100.100.100.200"
    )
}

fn is_blocked_ip(ip: IpAddr, options: RpcUrlValidationOptions) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4, options),
        IpAddr::V6(v6) => is_blocked_ipv6(v6, options),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr, options: RpcUrlValidationOptions) -> bool {
    (ip.is_loopback() && !options.allow_loopback)
        || ip.is_link_local()          // 169.254.0.0/16
        || ip.is_broadcast()
        || ip.is_unspecified()
        || is_private_v4(ip)
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    // 10.0.0.0/8
    octets[0] == 10
    // 172.16.0.0/12
    || (octets[0] == 172 && (16..=31).contains(&octets[1]))
    // 192.168.0.0/16
    || (octets[0] == 192 && octets[1] == 168)
    // 100.64.0.0/10 (CGNAT)
    || (octets[0] == 100 && (64..=127).contains(&octets[1]))
}

fn is_blocked_ipv6(ip: Ipv6Addr, options: RpcUrlValidationOptions) -> bool {
    (ip.is_loopback() && !options.allow_loopback)
        || ip.is_unspecified()
        // IPv4-mapped IPv6 (::ffff:x.x.x.x)
        || ip.to_ipv4_mapped().is_some_and(|mapped| is_blocked_ipv4(mapped, options))
}

fn is_blocked_hostname(host: &str, options: RpcUrlValidationOptions) -> bool {
    (host == "localhost" && !options.allow_loopback)
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "host.docker.internal"
        || host == "kubernetes.default.svc"
        || host.ends_with(".svc.cluster.local")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_public_rpc() {
        assert!(validate_rpc_url("https://mainnet.infura.io/v3/abc").is_ok());
        assert!(validate_rpc_url("https://rpc.ankr.com/eth").is_ok());
        assert!(validate_rpc_url("http://88.99.1.2:8545").is_ok());
    }

    #[test]
    fn blocks_metadata_endpoints() {
        assert!(validate_rpc_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_rpc_url("http://metadata.google.internal/computeMetadata/v1/").is_err());
        assert!(validate_rpc_url("http://100.100.100.200/").is_err());
    }

    #[test]
    fn blocks_loopback() {
        assert!(validate_rpc_url("http://127.0.0.1:8545").is_err());
        assert!(validate_rpc_url("http://[::1]:8545").is_err());
        assert!(validate_rpc_url("http://localhost:8545").is_err());
    }

    #[test]
    fn allows_loopback_when_opted_in() {
        let options = RpcUrlValidationOptions {
            allow_loopback: true,
        };
        assert!(validate_rpc_url_with_options("http://127.0.0.1:8545", options).is_ok());
        assert!(validate_rpc_url_with_options("http://[::1]:8545", options).is_ok());
        assert!(validate_rpc_url_with_options("http://localhost:8545", options).is_ok());
    }

    #[test]
    fn still_blocks_private_networks_when_loopback_is_allowed() {
        let options = RpcUrlValidationOptions {
            allow_loopback: true,
        };
        assert!(validate_rpc_url_with_options("http://10.0.0.1:8545", options).is_err());
        assert!(validate_rpc_url_with_options("http://172.16.0.1:8545", options).is_err());
        assert!(validate_rpc_url_with_options("http://192.168.1.1:8545", options).is_err());
        assert!(
            validate_rpc_url_with_options("http://host.docker.internal:8545", options).is_err()
        );
    }

    #[test]
    fn blocks_private_networks() {
        assert!(validate_rpc_url("http://10.0.0.1:8545").is_err());
        assert!(validate_rpc_url("http://172.16.0.1:8545").is_err());
        assert!(validate_rpc_url("http://192.168.1.1:8545").is_err());
    }

    #[test]
    fn blocks_non_http_schemes() {
        assert!(validate_rpc_url("file:///etc/passwd").is_err());
        assert!(validate_rpc_url("gopher://evil.com").is_err());
        assert!(validate_rpc_url("ftp://evil.com").is_err());
    }

    #[test]
    fn blocks_internal_hostnames() {
        assert!(validate_rpc_url("http://host.docker.internal:8545").is_err());
        assert!(validate_rpc_url("http://kubernetes.default.svc:443").is_err());
        assert!(validate_rpc_url("http://myservice.default.svc.cluster.local:8080").is_err());
    }

    #[test]
    fn blocks_ipv4_mapped_ipv6() {
        assert!(validate_rpc_url("http://[::ffff:127.0.0.1]:8545").is_err());
        assert!(validate_rpc_url("http://[::ffff:169.254.169.254]/").is_err());
    }

    #[test]
    fn blocks_unspecified() {
        assert!(validate_rpc_url("http://0.0.0.0:8545").is_err());
    }

    #[test]
    fn blocks_cgnat() {
        assert!(validate_rpc_url("http://100.64.0.1:8545").is_err());
        assert!(validate_rpc_url("http://100.127.255.254:8545").is_err());
    }

    #[test]
    fn rejects_missing_host() {
        assert!(validate_rpc_url("http://").is_err());
    }
}
