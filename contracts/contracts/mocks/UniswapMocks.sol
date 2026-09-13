// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../market/UniswapRobinhood.sol";

/// @notice TEST DOUBLES for Uniswap's Liquidity Launchpad. NEVER DEPLOY THESE.
/// @dev They model only the behaviour `LaunchpadFamilyLauncher` and `LaunchpadRewards` depend on,
///      transcribed from the verified mainnet source. They are not faithful reimplementations —
///      the fork tests in test/fork/ are what prove real integration.

interface IMinimalERC20 {
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice Mirrors `UERC20BeneficiaryVault`: a transferable ERC-721 claim on a position's fees.
contract MockUniswapBeneficiaryVault {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => uint256) public attributed;

    error AlreadyRegistered();
    error NotHolder();
    error TransferFailed();

    /// @notice Stands in for the FeeSplitter forwarding the creator-fee leg to this vault.
    function fund(uint256 tokenId) external payable {
        attributed[tokenId] += msg.value;
    }

    /// @notice The real vault mints the claim NFT to `beneficiary` and calls its receive hook.
    function registerBeneficiary(uint256 tokenId, address beneficiary) external {
        if (ownerOf[tokenId] != address(0)) revert AlreadyRegistered();
        ownerOf[tokenId] = beneficiary;
        if (beneficiary.code.length > 0) {
            (bool ok, bytes memory ret) = beneficiary.call(
                abi.encodeWithSignature(
                    "onERC721Received(address,address,uint256,bytes)", msg.sender, address(0), tokenId, ""
                )
            );
            require(ok && abi.decode(ret, (bytes4)) == 0x150b7a02, "receiver rejected");
        }
    }

    /// @notice Pays the current claim holder, as the real vault's transfer policy does.
    function claim(uint256 tokenId, uint256, uint256) external {
        address holder = ownerOf[tokenId];
        uint256 amount = attributed[tokenId];
        attributed[tokenId] = 0;
        if (amount == 0) return;
        (bool ok,) = payable(holder).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function transferClaim(uint256 tokenId, address to) external {
        if (msg.sender != ownerOf[tokenId]) revert NotHolder();
        ownerOf[tokenId] = to;
    }
}

/// @notice Mirrors the v4 `PositionManager`'s monotonically increasing position id.
contract MockPositionManager {
    uint256 public nextTokenId = 1;

    function bump() external {
        nextTokenId += 1;
    }
}

/// @notice Mirrors `InstantLaunchStrategy`: enforces supply/decimals, then registers the
///         beneficiary and would transfer the LP position to the fee splitter.
contract MockInstantLaunchStrategy {
    MockUniswapBeneficiaryVault public immutable beneficiaryVault;
    MockPositionManager public immutable positionManager;

    error InvalidSupply();
    error InvalidTokenDecimals();

    constructor(MockUniswapBeneficiaryVault vault_, MockPositionManager positionManager_) {
        beneficiaryVault = vault_;
        positionManager = positionManager_;
    }

    function initializeDistribution(address token, uint256 totalSupply, bytes calldata configData, bytes32)
        external
    {
        // The real strategy reverts on any supply but exactly 1e9 * 1e18, and on non-18 decimals.
        if (totalSupply != UniswapRobinhood.REQUIRED_TOTAL_SUPPLY) revert InvalidSupply();
        if (IMinimalERC20(token).totalSupply() != UniswapRobinhood.REQUIRED_TOTAL_SUPPLY) revert InvalidSupply();
        if (IMinimalERC20(token).decimals() != 18) revert InvalidTokenDecimals();

        InstantLaunchConfig memory config = abi.decode(configData, (InstantLaunchConfig));

        uint256 tokenId = positionManager.nextTokenId();
        // Pull the supply from the launcher, as the real strategy does, and lock it here
        // (the real one mints an LP position and hands it to the FeeSplitter forever).
        IMinimalERC20(token).transfer(address(0xdead), IMinimalERC20(token).balanceOf(address(this)));
        beneficiaryVault.registerBeneficiary(tokenId, config.feeBeneficiary);
        positionManager.bump();
    }
}

/// @notice Mirrors `LiquidityLauncher`: permissionless, holds the tokens, forwards to a strategy.
contract MockLiquidityLauncher {
    address public lastStrategy;
    address public lastFeeBeneficiary;
    address public lastToken;

    function distributeToken(address token, Distribution calldata distribution, bytes32 salt) external payable {
        lastStrategy = distribution.strategy;
        lastToken = token;
        lastFeeBeneficiary = abi.decode(distribution.configData, (InstantLaunchConfig)).feeBeneficiary;

        // The real launcher approves the strategy and the strategy pulls; here we push, which is
        // equivalent for the purposes of the launcher tests.
        IMinimalERC20(token).transfer(distribution.strategy, distribution.amount);
        MockInstantLaunchStrategy(distribution.strategy)
            .initializeDistribution(token, distribution.amount, distribution.configData, salt);
    }
}

/// @notice A launcher whose strategy never registers a beneficiary, to prove the launcher
///         refuses to record an attribution it could not verify.
contract MockLiquidityLauncherThatSkipsBeneficiary {
    function distributeToken(address, Distribution calldata, bytes32) external payable {
        // Deliberately does nothing: no pool, no beneficiary NFT.
    }
}

/// @notice A launcher that points the beneficiary at an attacker instead of our splitter.
contract MockLiquidityLauncherHijacker {
    MockUniswapBeneficiaryVault public immutable vault;
    MockPositionManager public immutable positionManager;
    address public immutable attacker;

    constructor(MockUniswapBeneficiaryVault vault_, MockPositionManager pm_, address attacker_) {
        vault = vault_;
        positionManager = pm_;
        attacker = attacker_;
    }

    function distributeToken(address, Distribution calldata, bytes32) external payable {
        vault.registerBeneficiary(positionManager.nextTokenId(), attacker);
        positionManager.bump();
    }
}

/// @notice Re-enters `collectAndSplit` from inside the claim payout.
contract ReentrantClaimAttacker {
    address public rewards;
    uint256 public tokenId;
    bool public reenterAttempted;
    bool public reenterReverted;

    function arm(address rewards_, uint256 tokenId_) external {
        rewards = rewards_;
        tokenId = tokenId_;
    }

    receive() external payable {
        if (rewards != address(0) && !reenterAttempted) {
            reenterAttempted = true;
            (bool ok,) = rewards.call(abi.encodeWithSignature("collectAndSplit(uint256)", tokenId));
            reenterReverted = !ok;
        }
    }
}

/// @notice A vault that re-enters the rewards contract while paying out a claim.
contract ReentrantVault {
    mapping(uint256 => uint256) public attributed;
    mapping(uint256 => address) public ownerOf;
    bool public reenterAttempted;
    bool public reenterReverted;

    function fund(uint256 tokenId) external payable {
        attributed[tokenId] += msg.value;
    }

    function registerBeneficiary(uint256 tokenId, address beneficiary) external {
        ownerOf[tokenId] = beneficiary;
    }

    function claim(uint256 tokenId, uint256, uint256) external {
        uint256 amount = attributed[tokenId];
        attributed[tokenId] = 0;
        if (!reenterAttempted) {
            reenterAttempted = true;
            (bool ok,) = msg.sender.call(abi.encodeWithSignature("collectAndSplit(uint256)", tokenId));
            reenterReverted = !ok;
        }
        (bool sent,) = payable(ownerOf[tokenId]).call{value: amount}("");
        require(sent, "pay failed");
    }
}

/// @notice A "launchpad" that is not from our factory but claims an owner, for spoof testing.
contract FakeLaunchpad {
    address public owner;
    uint8 public launchPolicy = 1;

    constructor(address owner_) {
        owner = owner_;
    }

    function canLaunch(address) external pure returns (bool) {
        return true;
    }
}
