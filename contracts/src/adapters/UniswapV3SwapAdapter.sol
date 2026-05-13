// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IEnvelopeAdapter.sol";
import "../TradeValidator.sol";

/// @title UniswapV3SwapAdapter
/// @notice Reference adapter for the UniswapV3Swap envelope variant.
///
/// @dev MIGRATION-CRITICAL HASH STABILITY
///      `enforcementHash(blob)` MUST equal the legacy
///      `TradeValidator._hashUniswapV3Swap(...)` for the SAME enforcement
///      values. The proof is in `contracts/test/EnvelopeRegistry.t.sol`,
///      which constructs an enforcement struct, hashes it via the legacy
///      `tradeValidator.hashUniswapV3Swap(enf)` AND via this adapter's
///      `enforcementHash(abi.encode(enf))`, and asserts equality.
///
/// @dev SHAPE
///      UniswapV3 swap (`exactInputSingle`) consumes input token, produces
///      output token. Maps to `ExecShape.Trade` (post-condition: output-token
///      balance gain >= params.minOutput).
///
/// @dev DECODE INVARIANTS
///      The decode + cross-check logic is a verbatim port of
///      `TradingVault.executeUniswapV3SwapEnvelope` lines around the
///      `EnvelopeCheckFailed` revert — same selector, same field-by-field
///      compare against the enforcement struct. Any drift would let an
///      operator slip a malicious calldata past the signed envelope.
contract UniswapV3SwapAdapter is IEnvelopeAdapter {
    /// @notice keccak256("UniswapV3Swap") — must match the off-chain Rust
    ///         `EnvelopeEnforcement::UniswapV3Swap` registry key.
    bytes32 public constant ENVELOPE_KIND = keccak256("UniswapV3Swap");

    /// @notice Same TYPEHASH the validator uses, so hashes line up. Public so
    ///         off-chain tooling can read it without binding to TradeValidator.
    bytes32 public constant UNISWAP_V3_SWAP_TYPEHASH = keccak256(
        "UniswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
    );

    bytes4 private constant SELECTOR_UNI_V3_EXACT_INPUT_SINGLE = 0x414bf389;

    error EnvelopeCheckFailed();
    error EnvelopeWrongSelector();
    error EnvelopeRateTooLow(uint256 actualMinOutput, uint256 requiredMinOutput);

    /// @dev Same struct shape as TradingVault's internal decoder.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint256 sqrtPriceLimitX96; // upcast from uint160 for decode safety
    }

    /// @dev Local minimal struct so we don't import VaultTypes.ExecuteParams.
    ///      Layout MUST match VaultTypes.ExecuteParams exactly.
    struct ExecuteParams {
        address target;
        bytes data;
        uint256 value;
        uint256 minOutput;
        address outputToken;
        bytes32 intentHash;
        uint256 deadline;
    }

    function envelopeKind() external pure returns (bytes32) {
        return ENVELOPE_KIND;
    }

    function name() external pure returns (string memory) {
        return "UniswapV3Swap";
    }

    /// @inheritdoc IEnvelopeAdapter
    function enforcementHash(bytes calldata enforcementBlob) external pure returns (bytes32) {
        TradeValidator.UniswapV3SwapEnforcement memory e =
            abi.decode(enforcementBlob, (TradeValidator.UniswapV3SwapEnforcement));
        // MUST mirror TradeValidator._hashUniswapV3Swap exactly.
        return keccak256(
            abi.encode(
                UNISWAP_V3_SWAP_TYPEHASH,
                e.feeTier,
                e.maxSingleAmountIn,
                e.maxTotalAmountIn,
                e.maxValue,
                e.minOutputPerInput,
                e.router,
                e.tokenIn,
                e.tokenOut,
                uint256(e.sqrtPriceLimitX96)
            )
        );
    }

    /// @inheritdoc IEnvelopeAdapter
    function preCallCheck(bytes calldata params, bytes calldata enforcementBlob, TradeValidator.Envelope calldata)
        external
        pure
        returns (PreCallReport memory report)
    {
        ExecuteParams memory p = abi.decode(params, (ExecuteParams));
        TradeValidator.UniswapV3SwapEnforcement memory enf =
            abi.decode(enforcementBlob, (TradeValidator.UniswapV3SwapEnforcement));

        // Decode the inner exactInputSingle calldata.
        if (p.data.length < 4 || bytes4(_first4(p.data)) != SELECTOR_UNI_V3_EXACT_INPUT_SINGLE) {
            revert EnvelopeWrongSelector();
        }
        ExactInputSingleParams memory s = _decodeExactInputSingle(p.data);

        // Mirror TradingVault.executeUniswapV3SwapEnvelope cross-checks.
        if (
            p.target != enf.router || s.tokenIn != enf.tokenIn || s.tokenOut != enf.tokenOut
                || uint256(s.fee) != enf.feeTier || p.outputToken != enf.tokenOut
                || s.sqrtPriceLimitX96 != uint256(enf.sqrtPriceLimitX96) || p.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        // Note: time-window and recipient/this checks happen in the vault layer
        // (the adapter is pure; it can't know address(this) of the vault). The
        // vault layer is expected to enforce `s.recipient == address(vault)`,
        // `s.deadline >= block.timestamp`, and `p.deadline >= block.timestamp`
        // before calling the adapter. See `EnvelopeRegistry.t.sol` for the
        // gate's contract-level coverage.

        uint256 reqMinOut = (s.amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (s.amountOutMinimum < reqMinOut || p.minOutput < reqMinOut) {
            revert EnvelopeRateTooLow(s.amountOutMinimum, reqMinOut);
        }

        report.enforcementHash = keccak256(
            abi.encode(
                UNISWAP_V3_SWAP_TYPEHASH,
                enf.feeTier,
                enf.maxSingleAmountIn,
                enf.maxTotalAmountIn,
                enf.maxValue,
                enf.minOutputPerInput,
                enf.router,
                enf.tokenIn,
                enf.tokenOut,
                uint256(enf.sqrtPriceLimitX96)
            )
        );
        report.consumeAmount = s.amountIn;
        report.maxSingleAmount = enf.maxSingleAmountIn;
        report.maxTotalAmount = enf.maxTotalAmountIn;
        report.shape = ExecShape.Trade;
        report.approvals = new ApprovalSpec[](1);
        report.approvals[0] = ApprovalSpec({token: s.tokenIn, spender: p.target, amount: s.amountIn});
    }

    /// @inheritdoc IEnvelopeAdapter
    function validateSignatures(
        TradeValidator tradeValidator,
        TradeValidator.Envelope calldata env,
        bytes calldata enforcementBlob,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool ok) {
        TradeValidator.UniswapV3SwapEnforcement memory enf =
            abi.decode(enforcementBlob, (TradeValidator.UniswapV3SwapEnforcement));
        // Reuse the legacy public validator function so the validator contract
        // and its EIP-712 typehash binding stay the single source of truth for
        // signature verification.
        (ok,) = tradeValidator.validateUniswapV3SwapEnvelope(env, enf, approvalSigners, signatures, scores);
    }

    // ── internal helpers ──

    function _first4(bytes memory data) private pure returns (bytes4 sel) {
        assembly {
            sel := mload(add(data, 32))
        }
    }

    function _decodeExactInputSingle(bytes memory data) private pure returns (ExactInputSingleParams memory p) {
        // Skip the 4-byte selector then ABI-decode.
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i = 0; i < body.length; ++i) {
            body[i] = data[i + 4];
        }
        // The on-chain decoder uses uint160 for sqrtPriceLimitX96; we upcast
        // to uint256 for ergonomic comparison and cast back where needed.
        (
            address tokenIn,
            address tokenOut,
            uint24 fee,
            address recipient,
            uint256 deadline,
            uint256 amountIn,
            uint256 amountOutMinimum,
            uint160 sqrtPriceLimitX96
        ) = abi.decode(body, (address, address, uint24, address, uint256, uint256, uint256, uint160));
        p = ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: recipient,
            deadline: deadline,
            amountIn: amountIn,
            amountOutMinimum: amountOutMinimum,
            sqrtPriceLimitX96: uint256(sqrtPriceLimitX96)
        });
    }
}
