// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FeeRouter
/// @notice Deterministic native-currency fee accounting primitive for alpha launchpads.
///
/// @dev HONESTY BOUNDARY — READ BEFORE BELIEVING ANY "NVDA" CLAIM:
///      This contract does NOT buy NVDA. It does not touch a DEX. It does not hold NVDA.
///      Under the `NvdaReserve` preset it only *accounts* for the reserve leg of the fee and
///      credits it to `reserveReceiver`. Turning that credit into real, verifiable NVDA requires
///      a separate, constrained buyer module (swap into the canonical NVDA token, enforce a
///      minimum output, deposit into `ReserveVault`) which does not exist in this repository yet.
///
/// @dev PAYOUT MODEL — PULL, NOT PUSH:
///      Fees are credited to `pending[beneficiary]` and withdrawn by the beneficiary.
///      An earlier revision pushed native value with `call` and `require(ok)`, which meant a
///      single beneficiary that rejects native value (a contract with no `receive`, or one that
///      reverts) permanently bricked every fee route through that launchpad. Accrual removes that
///      denial-of-service surface and keeps the split arithmetic verifiable on chain.
///
/// @dev PRIVILEGED CAPABILITIES: none. There is no owner, no admin, no pause, no upgrade path,
///      and no setter. Every address and the preset are immutable, fixed at construction.
contract FeeRouter {
    enum Preset {
        Standard,
        NvdaReserve
    }

    /// @notice Beneficiary of the Standard preset's owner leg.
    address public immutable padOwner;
    /// @notice Beneficiary of the protocol/execution leg under both presets.
    address public immutable protocolTreasury;
    /// @notice Beneficiary of the NvdaReserve preset's reserve leg.
    /// @dev MUST eventually be an audited buyer module that can only output canonical NVDA into
    ///      `ReserveVault`. It is NOT the vault itself: the vault deliberately rejects native value.
    address public immutable reserveReceiver;
    /// @notice The immutable economic template this router enforces.
    Preset public immutable preset;

    /// @notice Reserve leg of the NvdaReserve preset, in basis points of the routed fee.
    /// @dev 8000 bps of the mandatory 1.00% trade fee == 0.80% of trade notional.
    uint256 public constant NVDA_RESERVE_BPS = 8000;
    /// @dev Standard preset keeps exact sixths: 1/6 protocol, 5/6 owner. Applied to a 0.60%
    ///      upstream trade fee that is 0.50% owner / 0.10% protocol of trade notional.
    uint256 public constant STANDARD_PROTOCOL_DIVISOR = 6;

    /// @notice Native value credited to, and not yet withdrawn by, each beneficiary.
    mapping(address => uint256) public pending;
    /// @notice Sum of all outstanding `pending` balances. Invariant: <= address(this).balance.
    uint256 public totalPending;

    /// @notice Lifetime gross fees routed through this launchpad.
    uint256 public totalRoutedGross;
    /// @notice Lifetime amounts credited per leg. These are accounting totals, not proof of NVDA.
    uint256 public totalOwnerAccrued;
    uint256 public totalProtocolAccrued;
    uint256 public totalReserveAccrued;

    event FeeRouted(uint256 gross, uint256 ownerAmount, uint256 protocolAmount, uint256 reserveAmount);
    event FeeAccrued(address indexed beneficiary, uint256 amount);
    event FeeWithdrawn(address indexed beneficiary, uint256 amount, address indexed caller);
    event UnaccountedSwept(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NothingPending();
    error TransferFailed();

    constructor(address padOwner_, address protocolTreasury_, address reserveReceiver_, Preset preset_) {
        if (padOwner_ == address(0) || protocolTreasury_ == address(0)) revert ZeroAddress();
        if (preset_ == Preset.NvdaReserve && reserveReceiver_ == address(0)) revert ZeroAddress();
        padOwner = padOwner_;
        protocolTreasury = protocolTreasury_;
        reserveReceiver = reserveReceiver_;
        preset = preset_;
    }

    receive() external payable {
        _route(msg.value);
    }

    /// @notice Route a native-currency fee through this launchpad's economic template.
    function route() external payable {
        _route(msg.value);
    }

    function _route(uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        totalRoutedGross += amount;

        if (preset == Preset.NvdaReserve) {
            // Truncation favours the execution/protocol leg by at most 1 wei.
            uint256 reserveAmount = (amount * NVDA_RESERVE_BPS) / 10_000;
            uint256 protocolAmount = amount - reserveAmount;
            totalReserveAccrued += reserveAmount;
            totalProtocolAccrued += protocolAmount;
            _credit(reserveReceiver, reserveAmount);
            _credit(protocolTreasury, protocolAmount);
            emit FeeRouted(amount, 0, protocolAmount, reserveAmount);
        } else {
            // Truncation favours the pad owner by at most 1 wei.
            uint256 protocolAmount = amount / STANDARD_PROTOCOL_DIVISOR;
            uint256 ownerAmount = amount - protocolAmount;
            totalOwnerAccrued += ownerAmount;
            totalProtocolAccrued += protocolAmount;
            _credit(padOwner, ownerAmount);
            _credit(protocolTreasury, protocolAmount);
            emit FeeRouted(amount, ownerAmount, protocolAmount, 0);
        }
    }

    function _credit(address beneficiary, uint256 amount) private {
        if (amount == 0) return;
        pending[beneficiary] += amount;
        totalPending += amount;
        emit FeeAccrued(beneficiary, amount);
    }

    /// @notice Withdraw the caller's own accrued fees.
    function withdraw() external returns (uint256 amount) {
        return _withdrawTo(msg.sender);
    }

    /// @notice Push a beneficiary's accrued fees to them. Callable by anyone (keeper-friendly).
    /// @dev Value can only ever move to the beneficiary, so this grants no discretion to the caller.
    function withdrawFor(address beneficiary) external returns (uint256 amount) {
        return _withdrawTo(beneficiary);
    }

    function _withdrawTo(address beneficiary) private returns (uint256 amount) {
        amount = pending[beneficiary];
        if (amount == 0) revert NothingPending();
        // Checks-effects-interactions: state is settled before the external call.
        pending[beneficiary] = 0;
        totalPending -= amount;
        (bool ok,) = payable(beneficiary).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeeWithdrawn(beneficiary, amount, msg.sender);
    }

    /// @notice Native value held here but not owed to any beneficiary (e.g. forced in by
    ///         `selfdestruct` or a coinbase payout). Can only ever be sent to `protocolTreasury`.
    function unaccountedBalance() public view returns (uint256) {
        uint256 balance = address(this).balance;
        return balance > totalPending ? balance - totalPending : 0;
    }

    function sweepUnaccounted() external returns (uint256 amount) {
        amount = unaccountedBalance();
        if (amount == 0) revert ZeroAmount();
        (bool ok,) = payable(protocolTreasury).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit UnaccountedSwept(protocolTreasury, amount);
    }
}
