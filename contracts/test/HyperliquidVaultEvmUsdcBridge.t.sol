// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/HyperliquidTradeValidator.sol";
import "../src/HyperliquidVault.sol";
import "../src/HyperliquidVaultDeployer.sol";
import "../src/HyperliquidVaultFactory.sol";
import "../src/VaultShareDeployer.sol";
import "./helpers/Setup.sol";

contract HyperliquidVaultEvmUsdcBridgeTest is Test {
    uint256 private constant ACTION_KIND_HYPERLIQUID_FUND_MOVEMENT = 4;
    uint24 private constant ACTION_EVM_USDC_TO_CORE = 0x00ffffff;
    address private constant CORE_DEPOSIT_WALLET = 0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206;

    MockERC20 internal usdc;
    HyperliquidTradeValidator internal tradeValidator;
    HyperliquidVaultFactory internal factory;
    HyperliquidVaultDeployer internal vaultDeployer;
    VaultShareDeployer internal shareDeployer;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal validator1;
    address internal validator2;
    address internal validator3;
    uint256 internal validator1Key;
    uint256 internal validator2Key;

    function setUp() public {
        vm.chainId(998);
        (validator1, validator1Key) = makeAddrAndKey("validator1");
        (validator2, validator2Key) = makeAddrAndKey("validator2");
        validator3 = makeAddr("validator3");

        usdc = new MockERC20("USD Coin", "USDC", 6);
        HyperliquidVault implementation = new HyperliquidVault();
        tradeValidator = new HyperliquidTradeValidator();
        factory = new HyperliquidVaultFactory(tradeValidator);
        vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        shareDeployer = new VaultShareDeployer(address(factory));
        tradeValidator.transferOwnership(address(factory));
        factory.acceptDependencyOwnership();
        factory.setVaultDeployers(vaultDeployer, shareDeployer);
    }

    function test_validQuorumApprovalPermitsIdleEvmUsdcDepositThroughCoreDepositWallet() public {
        (address vaultAddr,) = _createBotVault();
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        MockCoreDepositWallet depositWallet = new MockCoreDepositWallet(usdc);
        vm.etch(CORE_DEPOSIT_WALLET, address(depositWallet).code);

        uint256 amount = 10e6;
        usdc.mint(vaultAddr, amount);

        bytes memory action = abi.encodeWithSelector(
            bytes4(keccak256("depositFor(address,uint256,uint32)")), vaultAddr, amount, uint32(0)
        );
        HyperliquidVault.FundMovementAuthorization memory approval = _authorization(
            vault,
            ACTION_EVM_USDC_TO_CORE,
            CORE_DEPOSIT_WALLET,
            0,
            uint64(amount),
            true,
            31,
            block.timestamp + 1 hours,
            action
        );

        vm.prank(operator);
        vault.returnSpotLiquidity(CORE_DEPOSIT_WALLET, 0, uint64(amount), approval);

        assertEq(usdc.balanceOf(vaultAddr), 0);
        assertEq(usdc.balanceOf(CORE_DEPOSIT_WALLET), amount);
        assertEq(MockCoreDepositWallet(CORE_DEPOSIT_WALLET).lastRecipient(), vaultAddr);
        assertEq(usdc.allowance(vaultAddr, CORE_DEPOSIT_WALLET), 0);
    }

    function test_directSystemUsdcReturnRequiresOperatorPath() public {
        (address vaultAddr,) = _createBotVault();
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        uint256 amount = 10e6;
        usdc.mint(vaultAddr, amount);

        HyperliquidVault.FundMovementAuthorization memory approval;
        bytes32 operatorRole = vault.OPERATOR_ROLE();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(HyperliquidVault.AccessControlUnauthorizedAccount.selector, admin, operatorRole)
        );
        vault.returnSpotLiquidity(CORE_DEPOSIT_WALLET, 0, uint64(amount), approval);
    }

    function test_idleEvmUsdcDepositRejectsMismatchedCoreDepositApproval() public {
        (address vaultAddr,) = _createBotVault();
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        MockCoreDepositWallet depositWallet = new MockCoreDepositWallet(usdc);
        vm.etch(CORE_DEPOSIT_WALLET, address(depositWallet).code);

        uint256 amount = 10e6;
        usdc.mint(vaultAddr, amount);

        address wrongSystemAddress = makeAddr("wrong-system-address");
        HyperliquidVault.FundMovementAuthorization memory wrongApproval = _authorization(
            vault,
            ACTION_EVM_USDC_TO_CORE,
            wrongSystemAddress,
            0,
            uint64(amount),
            true,
            32,
            block.timestamp + 1 hours,
            abi.encodeWithSelector(
                bytes4(keccak256("depositFor(address,uint256,uint32)")), vaultAddr, amount, uint32(0)
            )
        );
        vm.prank(operator);
        vm.expectRevert(HyperliquidVault.ValidatorApprovalRejected.selector);
        vault.returnSpotLiquidity(CORE_DEPOSIT_WALLET, 0, uint64(amount), wrongApproval);
    }

    function _createBotVault() internal returns (address vault, address share) {
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;
        (vault, share) = factory.createBotVault(
            1,
            address(usdc),
            admin,
            operator,
            signers,
            2,
            "Hyperliquid Bot Shares",
            "hlSHARE",
            bytes32("evm-usdc-to-core-salt"),
            HyperliquidVaultFactory.PolicyConfig({leverageCap: 50_000, maxTradesPerHour: 100, maxSlippageBps: 500}),
            HyperliquidVaultFactory.FeeConfig({
                performanceFeeBps: 2_000, managementFeeBps: 200, validatorFeeShareBps: 3_000
            })
        );
    }

    function _authorization(
        HyperliquidVault vault,
        uint24 actionType,
        address destination,
        uint64 token,
        uint64 amount,
        bool direction,
        uint256 nonce,
        uint256 deadline,
        bytes memory action
    ) internal view returns (HyperliquidVault.FundMovementAuthorization memory authorization) {
        authorization.nonce = nonce;
        authorization.deadline = deadline;
        authorization.signatures = new bytes[](2);
        authorization.scores = new uint256[](2);
        authorization.scores[0] = 80;
        authorization.scores[1] = 75;
        (bytes32 intentHash, bytes32 executionHash) =
            vault.computeFundMovementHashes(actionType, destination, token, amount, direction, nonce, deadline, action);
        authorization.signatures[0] = _signValidation(
            validator1Key,
            intentHash,
            executionHash,
            address(vault),
            authorization.scores[0],
            deadline,
            ACTION_KIND_HYPERLIQUID_FUND_MOVEMENT
        );
        authorization.signatures[1] = _signValidation(
            validator2Key,
            intentHash,
            executionHash,
            address(vault),
            authorization.scores[1],
            deadline,
            ACTION_KIND_HYPERLIQUID_FUND_MOVEMENT
        );
    }

    function _signValidation(
        uint256 privateKey,
        bytes32 intentHash,
        bytes32 executionHash,
        address vault,
        uint256 score,
        uint256 deadline,
        uint256 actionKind
    ) internal view returns (bytes memory) {
        bytes32 digest = tradeValidator.computeDigest(intentHash, executionHash, vault, score, deadline, actionKind);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract MockCoreDepositWallet {
    MockERC20 private immutable usdc;
    address public lastRecipient;

    constructor(MockERC20 _usdc) {
        usdc = _usdc;
    }

    function depositFor(address recipient, uint256 amount, uint32 destination) external {
        lastRecipient = recipient;
        require(destination == 0, "unexpected destination");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer failed");
    }
}
