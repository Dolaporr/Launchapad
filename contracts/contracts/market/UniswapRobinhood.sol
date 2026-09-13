// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title UniswapRobinhood
/// @notice Pinned addresses and minimal interfaces for Uniswap's Liquidity Launchpad as deployed
///         on Robinhood Chain mainnet (chain id 4663).
///
/// @dev SOURCE OF THESE ADDRESSES. Taken from Uniswap's machine-readable deployment registry
///      (`https://developers.uniswap.org/deployments.json`) on 2026-09-12, and independently
///      confirmed by reading live bytecode and state from `https://rpc.mainnet.chain.robinhood.com`.
///      They are `constant`, not configuration: nothing at transaction time can substitute a
///      different launchpad, strategy, splitter or vault on mainnet.
library UniswapRobinhood {
    /// @notice Robinhood Chain mainnet. The only chain where the pinned addresses are enforced.
    uint256 internal constant ROBINHOOD_MAINNET = 4663;

    /// @notice Permissionless entry point. No owner, no allowlist, no pause.
    address internal constant LIQUIDITY_LAUNCHER = 0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0;
    /// @notice The creator-fees variant. v1 always uses this one; the no-creator-fees variant
    ///         (0xAD44D55E7f8337C3cE113fBb591486E85be104b2) is deliberately NOT referenced.
    address internal constant INSTANT_LAUNCH_STRATEGY = 0x23f8209572b4a1C2AD88A42749E830791Fb027f1;
    /// @notice Terminal custodian of every launch LP position. Immutable splits.
    address internal constant FEE_SPLITTER = 0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf;
    /// @notice Holds the transferable ERC-721 claim on each position's creator-fee stream.
    address internal constant BENEFICIARY_VAULT = 0xd35E9CA72F64C7F93BE30fad67524323396B36D7;
    /// @notice v4 position manager; its `nextTokenId()` is the id the launch position will take.
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    /// @notice v4 pool manager.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    /// @notice Supply every InstantLaunch token must have. Enforced by Uniswap, not by us.
    uint256 internal constant REQUIRED_TOTAL_SUPPLY = 1_000_000_000e18;
    /// @notice Static LP fee of the launch pool, in hundredths of a bip. 2500 == 25 bps.
    uint24 internal constant LP_FEE = 2500;
}

/// @notice One distribution instruction for `LiquidityLauncher.distributeToken`.
/// @dev Field order and types transcribed from the verified source; `amount` is uint128.
struct Distribution {
    address strategy;
    uint128 amount;
    bytes configData;
}

/// @notice The launch configuration `InstantLaunchStrategy` decodes from `Distribution.configData`.
/// @dev This single address is the ONLY per-launch degree of freedom Uniswap exposes, which is
///      why Launchpad.family needs its own splitter behind it.
struct InstantLaunchConfig {
    address feeBeneficiary;
}

interface ILiquidityLauncher {
    function distributeToken(address token, Distribution calldata distribution, bytes32 salt) external payable;
}

interface IPositionManagerLike {
    /// @notice The id the next minted position will take. Read before the launch to learn the
    ///         launch position's id, which is also the beneficiary NFT id.
    function nextTokenId() external view returns (uint256);
}

interface IBeneficiaryVaultLike {
    /// @notice Holder of the transferable claim on a position's attributed fees.
    function ownerOf(uint256 tokenId) external view returns (address);
    /// @notice Pays the current claim holder. Anyone may call it.
    function claim(uint256 tokenId, uint256 minCurrency0Amount, uint256 minCurrency1Amount) external;
}
