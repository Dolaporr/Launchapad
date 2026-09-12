// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IERC20.sol";

/// @title ReserveVault
/// @notice "Glass vault": the configured reserve asset can enter but can never leave.
///
/// @dev WHAT IS ACTUALLY GUARANTEED ON CHAIN:
///      - `reserveToken` is immutable and can never be changed.
///      - This contract contains no code path that can move `reserveToken` out. Not by the owner,
///        not by anyone. `sweepNonReserve` reverts when asked to touch it.
///      - There is no `delegatecall`, no upgrade path, no proxy, and no `selfdestruct`.
///
/// @dev PRIVILEGED CAPABILITY (exactly one): `owner` may call `sweepNonReserve` to recover any
///      ERC-20 that is NOT the reserve token. This exists so tokens sent here by mistake are not
///      bricked. It is a real power over non-reserve assets and is deliberately the only one.
///      `owner` is immutable — it cannot be transferred, and if the key is lost the sweep is
///      simply gone forever (the reserve lock is unaffected).
///
/// @dev NATIVE CURRENCY IS REJECTED BY DESIGN. This vault holds the reserve ERC-20 only. Sending
///      native value here reverts, because native value trapped in a contract with no withdrawal
///      path is a permanent loss, not a reserve. The fee router therefore must NOT be pointed at
///      this address: it accrues the native reserve leg and waits for a real buyer module.
///
/// @dev THIS VAULT DOES NOT PROVE AN NVDA PURCHASE. It proves custody of whatever
///      `reserveToken` was set to. Verifying that `reserveToken` is the canonical NVDA token is an
///      off-chain step that must be done against Robinhood's live asset registry at deploy time.
contract ReserveVault {
    /// @notice Holder of the single privileged capability (`sweepNonReserve`). Immutable.
    address public immutable owner;
    /// @notice The permanently locked asset. Immutable.
    address public immutable reserveToken;

    event JunkSwept(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotOwner();
    error ReserveLocked();
    error NothingToSweep();
    error TransferFailed();
    error NativeNotAccepted();

    constructor(address owner_, address reserveToken_) {
        if (owner_ == address(0) || reserveToken_ == address(0)) revert ZeroAddress();
        owner = owner_;
        reserveToken = reserveToken_;
    }

    /// @notice Raw base-unit balance of the reserve asset actually held here.
    /// @dev For an ERC-8056 stock token this is NOT the figure a user should be shown. Scale it by
    ///      `reserveUIMultiplier()` before display. See `IScaledUIERC20`.
    function reserveBalance() external view returns (uint256) {
        return IERC20(reserveToken).balanceOf(address(this));
    }

    /// @notice Reads the reserve token's ERC-8056 UI multiplier, if it has one.
    /// @return supported True when the token exposes `uiMultiplier()`.
    /// @return multiplier The raw multiplier value (18 decimals for Robinhood Stock Tokens).
    /// @dev Uses a low-level staticcall so a plain ERC-20 reserve asset does not break this view.
    function reserveUIMultiplier() external view returns (bool supported, uint256 multiplier) {
        (bool ok, bytes memory data) =
            reserveToken.staticcall(abi.encodeWithSelector(IScaledUIERC20.uiMultiplier.selector));
        if (ok && data.length == 32) {
            return (true, abi.decode(data, (uint256)));
        }
        return (false, 0);
    }

    /// @notice Recover a non-reserve ERC-20 sent here by mistake. Owner-only. Cannot touch the reserve.
    function sweepNonReserve(address token, address to) external returns (uint256 amount) {
        if (msg.sender != owner) revert NotOwner();
        if (token == reserveToken) revert ReserveLocked();
        if (token == address(0) || to == address(0)) revert ZeroAddress();

        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();

        // Tolerates tokens that return no data as well as those returning a bool.
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();

        emit JunkSwept(token, to, amount);
    }

    receive() external payable {
        revert NativeNotAccepted();
    }

    fallback() external payable {
        revert NativeNotAccepted();
    }
}
