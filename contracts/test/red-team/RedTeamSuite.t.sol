// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

// Force-import every Attack_*.t.sol so `forge test --match-contract RedTeam`
// pulls in the entire suite. Each Attack_* contract inherits from Setup and
// runs its own scenarios; this file exists to give the suite a stable pivot
// point and to provide a top-level "smoke" assertion that the suite is wired
// in.
import "./Attack_A1_ReentrantRouter.t.sol";
import "./Attack_A2_ReentrantCurve.t.sol";
import "./Attack_A3_CrossProtocolConfusion.t.sol";
import "./Attack_A4_SignerSetSpoofing.t.sol";
import "./Attack_A5_CalldataCorruptionRecipient.t.sol";
import "./Attack_A6_CalldataCorruptionFeeTier.t.sol";
import "./Attack_A7_MinOutputBypass.t.sol";
import "./Attack_A8_SqrtPriceLimitCorruption.t.sol";
import "./Attack_A9_ParamsValueDrain.t.sol";
import "./Attack_A10_ApprovalResidue.t.sol";
import "./Attack_A11_VaultReplay.t.sol";
import "./Attack_A12_ChainReplay.t.sol";
import "./Attack_A13_FutureIssuedAt.t.sol";
import "./Attack_A14_ScoreSaturation.t.sol";
import "./Attack_A15_DrainedEnvelopeReplay.t.sol";
import "./Attack_A16_DecoyApprovalSigners.t.sol";
import "./Attack_A17_ForgedDigest.t.sol";
import "./Attack_A18_V4UnlockReentrancy.t.sol";
import "./Attack_A19_URCommandBufferManipulation.t.sol";
import "./Attack_A20_V4ActionsOutOfOrder.t.sol";

/// @title RedTeamSuite
/// @notice Top-level pivot for the v3-envelope red-team suite. The actual attacks
///         live in `Attack_<id>.t.sol` files in this directory. Forge discovers
///         them by `--match-contract "RedTeamSuite|Attack_"`.
contract RedTeamSuite is Test {
    /// @notice Sentinel test so `--match-contract RedTeamSuite` always has at
    ///         least one passing assertion. Real attack tests are in the
    ///         Attack_* contracts.
    function test_redTeamSuite_loaded() public pure {
        assertTrue(true, "red-team suite loaded");
    }
}
