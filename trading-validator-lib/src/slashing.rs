//! Slash proposal logic for the trading validator system.
//!
//! Validators can propose slashes against peers for three conditions:
//!
//! | Condition           | Severity | Slash % | Evidence                                    |
//! |---------------------|----------|---------|---------------------------------------------|
//! | Liveness failure    | Light    | 5%      | 3+ consecutive missed heartbeats            |
//! | Invalid approval    | Heavy    | 20%     | Signed validation for a policy-violating trade |
//! | Validation timeout  | Light    | 5%      | No response within validation deadline      |
//!
//! The flow: detect violation → encode evidence → call `proposeSlash()` on Tangle →
//! dispute window opens → if not disputed, `onSlash` hook fires on-chain.

use alloy::primitives::{keccak256, Address, B256};
use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Slash conditions
// ─────────────────────────────────────────────────────────────────────────────

/// Slash percentage basis points for each condition.
pub const SLASH_BPS_LIVENESS: u16 = 500; // 5%
pub const SLASH_BPS_INVALID_APPROVAL: u16 = 2000; // 20%
pub const SLASH_BPS_TIMEOUT: u16 = 500; // 5%

/// Maximum missed heartbeats before a liveness slash can be proposed.
pub const MAX_MISSED_HEARTBEATS: u32 = 3;

/// The type of slashing condition detected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SlashCondition {
    /// Validator missed 3+ consecutive heartbeats.
    LivenessFailure {
        missed_count: u32,
        last_heartbeat_block: u64,
        current_block: u64,
    },
    /// Validator signed approval for a trade that violated policy.
    InvalidApproval {
        /// The EIP-712 signature the validator produced
        signature_hex: String,
        /// The intent hash they signed
        intent_hash: B256,
        /// What policy was violated
        violation: String,
    },
    /// Validator accepted a validation request but didn't respond in time.
    ValidationTimeout {
        /// When the request was sent (unix timestamp)
        request_timestamp: u64,
        /// The configured deadline (unix timestamp)
        deadline: u64,
    },
}

impl SlashCondition {
    /// Slash percentage in basis points for this condition.
    pub fn slash_bps(&self) -> u16 {
        match self {
            SlashCondition::LivenessFailure { .. } => SLASH_BPS_LIVENESS,
            SlashCondition::InvalidApproval { .. } => SLASH_BPS_INVALID_APPROVAL,
            SlashCondition::ValidationTimeout { .. } => SLASH_BPS_TIMEOUT,
        }
    }

    /// Human-readable label for this condition.
    pub fn label(&self) -> &'static str {
        match self {
            SlashCondition::LivenessFailure { .. } => "liveness_failure",
            SlashCondition::InvalidApproval { .. } => "invalid_approval",
            SlashCondition::ValidationTimeout { .. } => "validation_timeout",
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence encoding
// ─────────────────────────────────────────────────────────────────────────────

/// A prepared slash proposal ready for on-chain submission.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashProposal {
    /// The service ID on Tangle
    pub service_id: u64,
    /// The offending validator's address
    pub offender: Address,
    /// Slash percentage in basis points
    pub slash_bps: u16,
    /// keccak256 hash of the evidence
    pub evidence_hash: B256,
    /// JSON-serialized evidence for off-chain verification
    pub evidence_json: String,
    /// The condition that triggered this proposal
    pub condition: SlashCondition,
}

/// Encode a slash condition into an evidence hash for on-chain submission.
///
/// The evidence hash is `keccak256(abi.encodePacked(condition_label, offender, service_id, evidence_data))`.
pub fn encode_evidence(
    condition: &SlashCondition,
    offender: Address,
    service_id: u64,
) -> B256 {
    let mut data = Vec::new();
    data.extend_from_slice(condition.label().as_bytes());
    data.extend_from_slice(offender.as_slice());
    data.extend_from_slice(&service_id.to_be_bytes());

    match condition {
        SlashCondition::LivenessFailure {
            missed_count,
            last_heartbeat_block,
            current_block,
        } => {
            data.extend_from_slice(&missed_count.to_be_bytes());
            data.extend_from_slice(&last_heartbeat_block.to_be_bytes());
            data.extend_from_slice(&current_block.to_be_bytes());
        }
        SlashCondition::InvalidApproval {
            signature_hex,
            intent_hash,
            violation,
        } => {
            data.extend_from_slice(signature_hex.as_bytes());
            data.extend_from_slice(intent_hash.as_slice());
            data.extend_from_slice(violation.as_bytes());
        }
        SlashCondition::ValidationTimeout {
            request_timestamp,
            deadline,
        } => {
            data.extend_from_slice(&request_timestamp.to_be_bytes());
            data.extend_from_slice(&deadline.to_be_bytes());
        }
    }

    keccak256(&data)
}

/// Build a complete slash proposal from a detected condition.
pub fn build_proposal(
    service_id: u64,
    offender: Address,
    condition: SlashCondition,
) -> SlashProposal {
    let evidence_hash = encode_evidence(&condition, offender, service_id);
    let evidence_json =
        serde_json::to_string(&condition).unwrap_or_else(|_| "{}".to_string());

    SlashProposal {
        service_id,
        offender,
        slash_bps: condition.slash_bps(),
        evidence_hash,
        evidence_json,
        condition,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Liveness violation detection
// ─────────────────────────────────────────────────────────────────────────────

/// Check all registered validators for liveness violations.
///
/// Returns a list of slash proposals for validators that have missed
/// more than `MAX_MISSED_HEARTBEATS` consecutive heartbeats.
///
/// `current_timestamp`: Current unix timestamp.
/// `heartbeat_interval_secs`: Expected interval between heartbeats.
pub fn check_liveness_violations(
    service_id: u64,
    current_timestamp: u64,
    heartbeat_interval_secs: u64,
) -> Vec<SlashProposal> {
    let mut proposals = Vec::new();

    let validators = match crate::get_all_validators() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("Failed to get validators for liveness check: {e}");
            return proposals;
        }
    };

    // Get our own address to skip self-checking
    let my_address = crate::context::operator_context()
        .map(|ctx| format!("{}", ctx.operator_address))
        .unwrap_or_default();

    for (addr, state) in &validators {
        // Don't propose slashes against ourselves
        if addr == &my_address {
            continue;
        }

        if !state.active {
            continue;
        }

        // Calculate how many heartbeats have been missed
        if state.last_heartbeat == 0 || heartbeat_interval_secs == 0 {
            continue;
        }

        let elapsed = current_timestamp.saturating_sub(state.last_heartbeat);
        let missed = (elapsed / heartbeat_interval_secs).saturating_sub(1) as u32;

        if missed >= MAX_MISSED_HEARTBEATS {
            let offender: Address = addr.parse().unwrap_or(Address::ZERO);
            let condition = SlashCondition::LivenessFailure {
                missed_count: missed,
                last_heartbeat_block: state.last_heartbeat,
                current_block: current_timestamp,
            };
            proposals.push(build_proposal(service_id, offender, condition));
        }
    }

    proposals
}

/// Submit a slash proposal to the Tangle network.
///
/// Currently logs the proposal and returns it. On-chain submission via
/// `proposeSlash()` on the Tangle contract will be wired when operator
/// context carries a connected provider instance.
pub async fn propose_slash(proposal: &SlashProposal) -> Result<(), String> {
    tracing::warn!(
        "SLASH PROPOSAL: service={} offender={} condition={} bps={} evidence_hash={}",
        proposal.service_id,
        proposal.offender,
        proposal.condition.label(),
        proposal.slash_bps,
        proposal.evidence_hash,
    );

    // TODO: Call proposeSlash() on the Tangle contract via alloy provider:
    //   let tangle = ITangle::new(tangle_address, provider);
    //   tangle.proposeSlash(
    //       proposal.service_id,
    //       proposal.offender,
    //       (proposal.slash_bps / 100) as u8,
    //       proposal.evidence_hash,
    //   ).send().await?;
    //
    // The Tangle protocol will then:
    // 1. Open a dispute window (configurable, e.g., 7 days)
    // 2. If not disputed, execute the slash
    // 3. Call onSlash() on the ValidatorBlueprint contract
    // 4. Contract updates validatorReputation[serviceId][offender]

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_liveness_slash_condition() {
        let condition = SlashCondition::LivenessFailure {
            missed_count: 5,
            last_heartbeat_block: 100,
            current_block: 200,
        };
        assert_eq!(condition.slash_bps(), SLASH_BPS_LIVENESS);
        assert_eq!(condition.label(), "liveness_failure");
    }

    #[test]
    fn test_invalid_approval_slash_condition() {
        let condition = SlashCondition::InvalidApproval {
            signature_hex: "0xdead".to_string(),
            intent_hash: B256::ZERO,
            violation: "max_position_pct exceeded".to_string(),
        };
        assert_eq!(condition.slash_bps(), SLASH_BPS_INVALID_APPROVAL);
        assert_eq!(condition.label(), "invalid_approval");
    }

    #[test]
    fn test_timeout_slash_condition() {
        let condition = SlashCondition::ValidationTimeout {
            request_timestamp: 1000,
            deadline: 2000,
        };
        assert_eq!(condition.slash_bps(), SLASH_BPS_TIMEOUT);
        assert_eq!(condition.label(), "validation_timeout");
    }

    #[test]
    fn test_evidence_encoding_deterministic() {
        let condition = SlashCondition::LivenessFailure {
            missed_count: 3,
            last_heartbeat_block: 100,
            current_block: 500,
        };
        let offender: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
            .parse()
            .unwrap();

        let hash1 = encode_evidence(&condition, offender, 42);
        let hash2 = encode_evidence(&condition, offender, 42);
        assert_eq!(hash1, hash2, "Same inputs should produce same evidence hash");
    }

    #[test]
    fn test_evidence_encoding_different_for_different_offenders() {
        let condition = SlashCondition::LivenessFailure {
            missed_count: 3,
            last_heartbeat_block: 100,
            current_block: 500,
        };
        let offender_a: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
            .parse()
            .unwrap();
        let offender_b: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
            .parse()
            .unwrap();

        let hash_a = encode_evidence(&condition, offender_a, 42);
        let hash_b = encode_evidence(&condition, offender_b, 42);
        assert_ne!(hash_a, hash_b);
    }

    #[test]
    fn test_evidence_encoding_different_for_different_services() {
        let condition = SlashCondition::LivenessFailure {
            missed_count: 3,
            last_heartbeat_block: 100,
            current_block: 500,
        };
        let offender: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
            .parse()
            .unwrap();

        let hash1 = encode_evidence(&condition, offender, 1);
        let hash2 = encode_evidence(&condition, offender, 2);
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn test_build_proposal() {
        let offender: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
            .parse()
            .unwrap();
        let condition = SlashCondition::LivenessFailure {
            missed_count: 4,
            last_heartbeat_block: 100,
            current_block: 600,
        };

        let proposal = build_proposal(42, offender, condition.clone());
        assert_eq!(proposal.service_id, 42);
        assert_eq!(proposal.offender, offender);
        assert_eq!(proposal.slash_bps, 500);
        assert_eq!(proposal.condition, condition);
        assert!(!proposal.evidence_json.is_empty());
    }

    #[test]
    fn test_check_liveness_violations_detects_stale_validators() {
        // Seed a validator with an old heartbeat
        let stale_addr = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
        let state = crate::ValidatorState {
            address: stale_addr.to_string(),
            endpoint: "http://stale:9090".to_string(),
            reputation: 100,
            active: true,
            last_heartbeat: 1000, // Very old
        };
        crate::set_validator_state(state).unwrap();

        // Check with current_timestamp far ahead, interval = 100s
        let proposals = check_liveness_violations(42, 2000, 100);

        // Should detect the stale validator (elapsed=1000, interval=100, missed=9)
        assert!(
            proposals.iter().any(|p| p.offender == stale_addr.parse::<Address>().unwrap()),
            "Should detect stale validator"
        );

        // Clean up
        crate::remove_validator_state(stale_addr).unwrap();
    }

    #[test]
    fn test_check_liveness_violations_skips_active_validators() {
        let fresh_addr = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
        let state = crate::ValidatorState {
            address: fresh_addr.to_string(),
            endpoint: "http://fresh:9090".to_string(),
            reputation: 100,
            active: true,
            last_heartbeat: 1900, // Recent
        };
        crate::set_validator_state(state).unwrap();

        // Check with current_timestamp=2000, interval=100s
        // elapsed=100, missed=0 (< MAX_MISSED_HEARTBEATS)
        let proposals = check_liveness_violations(42, 2000, 100);

        assert!(
            !proposals.iter().any(|p| p.offender == fresh_addr.parse::<Address>().unwrap()),
            "Should not propose slash for fresh validator"
        );

        // Clean up
        crate::remove_validator_state(fresh_addr).unwrap();
    }

    #[test]
    fn test_check_liveness_violations_skips_inactive() {
        let inactive_addr = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
        let state = crate::ValidatorState {
            address: inactive_addr.to_string(),
            endpoint: "http://inactive:9090".to_string(),
            reputation: 100,
            active: false, // Inactive
            last_heartbeat: 100,
        };
        crate::set_validator_state(state).unwrap();

        let proposals = check_liveness_violations(42, 2000, 100);

        assert!(
            !proposals.iter().any(|p| p.offender == inactive_addr.parse::<Address>().unwrap()),
            "Should not propose slash for inactive validator"
        );

        // Clean up
        crate::remove_validator_state(inactive_addr).unwrap();
    }

    #[tokio::test]
    async fn test_propose_slash_logs_without_error() {
        let proposal = build_proposal(
            1,
            Address::ZERO,
            SlashCondition::LivenessFailure {
                missed_count: 5,
                last_heartbeat_block: 0,
                current_block: 1000,
            },
        );
        // Should not error (just logs for now)
        assert!(propose_slash(&proposal).await.is_ok());
    }
}
