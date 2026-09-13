// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Uniswap Liquidity Launchpad interfaces — TRANSCRIBED FOR PROOF-OF-CONCEPT ONLY
///
/// @dev These are hand-transcribed from the verified source of Uniswap's Liquidity Launchpad as
///      deployed on Robinhood Chain, read on 2026-09-12:
///        LiquidityLauncher              0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0  (chain 4663)
///        InstantLaunchStrategy#creator  0x23f8209572b4a1C2AD88A42749E830791Fb027f1  (chain 4663)
///        FeeSplitter#creator-fees       0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf  (chain 4663)
///        UERC20BeneficiaryVault         0xd35E9CA72F64C7F93BE30fad67524323396B36D7  (chain 4663)
///
///      They exist so the PoC can compile and be tested locally. They are NOT a substitute for
///      integrating against the real ABIs, and the real contracts are the source of truth.
///      Nothing here is deployed by this repository.

/// @notice The launch configuration passed to InstantLaunchStrategy via
///         `LiquidityLauncher.distributeToken(token, Distribution{...configData}, salt)`.
/// @dev This single address is the ONLY per-launch degree of freedom the strategy exposes.
struct InstantLaunchConfig {
    address feeBeneficiary;
}

/// @notice Subset of Uniswap's `IClaimableRecipient`, implemented by `UERC20BeneficiaryVault`.
interface IClaimableRecipient {
    /// @notice Claims a position's attributed fees. Pays the beneficiary-NFT holder.
    function claim(uint256 tokenId, uint256 minCurrency0Amount, uint256 minCurrency1Amount) external;
}

/// @notice Subset of Uniswap's `IBeneficiaryVault`.
/// @dev The vault is an ERC-721: the claim on a position's fee stream is a TRANSFERABLE NFT.
///      That transferability is what lets a third-party contract become the creator-fee recipient.
interface IBeneficiaryVault is IClaimableRecipient {
    function registerBeneficiary(uint256 tokenId, address beneficiary) external;
}
