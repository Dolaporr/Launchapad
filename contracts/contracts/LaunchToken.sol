// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LaunchToken
/// @notice Minimal fixed-supply ERC-20 deployed by a `Launchpad`.
///
/// @dev PRIVILEGED CAPABILITIES: none, at the token level. No owner, no minter, no pause, no
///      blacklist, no transfer hook, no fee-on-transfer, no upgrade path. `totalSupply` is set
///      once in the constructor and no code path can ever change it.
///
/// @dev BUT NOTE THE DISTRIBUTION: the constructor mints the entire supply to a single recipient
///      (the pad owner). Absolute holder concentration at launch is 100%. Nothing here prevents
///      that holder from selling everything. `launchpad` records which Launchpad deployed this
///      token so provenance is checkable on chain.
///
/// @dev `decimals` is fixed at 18. Supply is passed in base units by `Launchpad`.
contract LaunchToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    /// @notice The Launchpad that deployed this token (i.e. the constructor caller).
    address public immutable launchpad;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ZeroAddress();
    error ZeroSupply();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(string memory name_, string memory symbol_, uint256 supply_, address recipient_) {
        if (recipient_ == address(0)) revert ZeroAddress();
        if (supply_ == 0) revert ZeroSupply();
        name = name_;
        symbol = symbol_;
        launchpad = msg.sender;
        totalSupply = supply_;
        balanceOf[recipient_] = supply_;
        emit Transfer(address(0), recipient_, supply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // An allowance of uint256.max is treated as infinite and is not decremented.
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
