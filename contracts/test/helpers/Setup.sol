// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../src/TradingVault.sol";
import "../../src/VaultShare.sol";
import "../../src/VaultFactory.sol";
import "../../src/PolicyEngine.sol";
import "../../src/TradeValidator.sol";
import "../../src/FeeDistributor.sol";
import "../../src/StrategyRegistry.sol";
import "../../src/interfaces/IOracleAdapter.sol";

/// @title MockERC20
/// @notice Simple ERC20 with public mint for testing
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

/// @title MockTarget
/// @notice Mock contract that acts as a trade execution target for testing
contract MockTarget {
    MockERC20 public outputToken;

    constructor(MockERC20 _outputToken) {
        outputToken = _outputToken;
    }

    /// @notice Simulates a swap: caller sends ETH or tokens, this mints output tokens to caller
    function swap(address to, uint256 outputAmount) external payable {
        outputToken.mint(to, outputAmount);
    }

    /// @notice A function that always reverts
    function failingSwap() external pure {
        revert("swap failed");
    }

    receive() external payable {}
}

/// @title MockOracle
/// @notice Mock oracle adapter for multi-asset NAV tests
contract MockOracle is IOracleAdapter {
    mapping(address => uint256) public prices;
    mapping(address => uint8) public priceDecimals;

    function setPrice(address token, uint256 price, uint8 dec) external {
        prices[token] = price;
        priceDecimals[token] = dec;
    }

    function getPrice(address token) external view override returns (uint256 price, uint8 dec) {
        price = prices[token];
        dec = priceDecimals[token];
    }
}

/// @title Setup
/// @notice Base test setup that deploys mock tokens, core contracts, and test accounts
abstract contract Setup is Test {
    // ═══════════════════════════════════════════════════════════════════════════
    // TEST ACCOUNTS
    // ═══════════════════════════════════════════════════════════════════════════

    address public owner;
    address public user;
    address public operator;
    address public validator1;
    uint256 public validator1Key;
    address public validator2;
    uint256 public validator2Key;
    address public validator3;
    uint256 public validator3Key;

    // ═══════════════════════════════════════════════════════════════════════════
    // MOCK TOKENS
    // ═══════════════════════════════════════════════════════════════════════════

    MockERC20 public tokenA;
    MockERC20 public tokenB;

    // ═══════════════════════════════════════════════════════════════════════════
    // CORE CONTRACTS
    // ═══════════════════════════════════════════════════════════════════════════

    VaultFactory public vaultFactory;
    PolicyEngine public policyEngine;
    TradeValidator public tradeValidator;
    FeeDistributor public feeDistributor;
    StrategyRegistry public strategyRegistry;

    // ═══════════════════════════════════════════════════════════════════════════
    // SETUP
    // ═══════════════════════════════════════════════════════════════════════════

    function setUp() public virtual {
        // Create test accounts
        owner = makeAddr("owner");
        user = makeAddr("user");
        operator = makeAddr("operator");
        (validator1, validator1Key) = makeAddrAndKey("validator1");
        (validator2, validator2Key) = makeAddrAndKey("validator2");
        (validator3, validator3Key) = makeAddrAndKey("validator3");

        // Deploy mock tokens
        tokenA = new MockERC20("Token A", "TKA", 18);
        tokenB = new MockERC20("Token B", "TKB", 18);

        // Mint tokens to test accounts
        tokenA.mint(owner, 1_000_000 ether);
        tokenA.mint(user, 1_000_000 ether);
        tokenA.mint(operator, 1_000_000 ether);
        tokenB.mint(owner, 1_000_000 ether);
        tokenB.mint(user, 1_000_000 ether);

        // Deploy core contracts (deployed by this test contract, which is msg.sender)
        // PolicyEngine and TradeValidator are Ownable2Step, so initially owned by this contract
        policyEngine = new PolicyEngine();
        tradeValidator = new TradeValidator();
        feeDistributor = new FeeDistributor(owner);
        vaultFactory = new VaultFactory(policyEngine, tradeValidator, feeDistributor);

        // Transfer ownership of PolicyEngine and TradeValidator to VaultFactory
        // (since factory calls their onlyOwner functions: configureVault, initializeVault)
        policyEngine.transferOwnership(address(vaultFactory));
        vm.prank(address(vaultFactory));
        policyEngine.acceptOwnership();

        tradeValidator.transferOwnership(address(vaultFactory));
        vm.prank(address(vaultFactory));
        tradeValidator.acceptOwnership();

        // Deploy StrategyRegistry (owned by owner)
        strategyRegistry = new StrategyRegistry(owner);

        // Give ETH to test accounts
        vm.deal(owner, 100 ether);
        vm.deal(user, 100 ether);
        vm.deal(operator, 100 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPER: Create a test vault via the factory
    // ═══════════════════════════════════════════════════════════════════════════

    function _createTestVault() internal returns (address vault, address shareAddr) {
        return _createTestVaultWithId(1);
    }

    function _createTestVaultWithId(uint64 serviceId) internal returns (address vault, address shareAddr) {
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (vault, shareAddr) = vaultFactory.createVault(
            serviceId,
            address(tokenA),
            owner,
            operator,
            signers,
            2, // 2-of-3
            "Test Vault Shares",
            "tvSHARE",
            bytes32("test-salt")
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPER: EIP-712 signature for TradeValidator
    // ═══════════════════════════════════════════════════════════════════════════

    function _signValidation(
        uint256 privateKey,
        bytes32 intentHash,
        address vault,
        uint256 score,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = tradeValidator.computeDigest(intentHash, vault, score, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
