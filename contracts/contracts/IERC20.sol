// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice Subset of ERC-8056 ("Scaled UI Amount") implemented by Robinhood Stock Tokens.
/// @dev Stock tokens carry a `uiMultiplier` that scales the raw base-unit balance into the
///      amount a user is meant to see. `balanceOf` alone therefore UNDERSTATES or OVERSTATES the
///      displayed holding. Any UI that reports a reserve size must read the multiplier too.
interface IScaledUIERC20 {
    function uiMultiplier() external view returns (uint256);
    function balanceOfUI(address account) external view returns (uint256);
}
