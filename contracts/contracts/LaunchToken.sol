// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LaunchToken
/// @notice Minimal fixed-supply ERC-20 deployed by a `Launchpad`.
///
/// @dev PRIVILEGED CAPABILITIES: none, at the token level. No owner, no minter, no pause, no
///      blacklist, no transfer hook, no fee-on-transfer, no upgrade path. `totalSupply` is set
///      once in the constructor and no code path can ever change it.
///
/// @dev SUPPLY IS FIXED AT 1,000,000,000 x 18 DECIMALS AND IS NOT CONFIGURABLE.
///      This is not a preference: Uniswap's `InstantLaunchStrategy` reverts unless the token it is
///      given has exactly this supply and exactly 18 decimals. Rather than keep a supply argument
///      that the live launch path can never honour, the choice is removed from the type entirely.
///
/// @dev DISTRIBUTION DEPENDS ON THE LAUNCH PATH. The constructor mints the whole supply to one
///      recipient. Launched through `LaunchpadFamilyLauncher`, that recipient is the launcher,
///      which immediately hands the supply to Uniswap as permanently locked liquidity — so no
///      person ever holds it. Launched directly through `Launchpad.launchToken`, the recipient is
///      the caller, and holder concentration at launch is 100%.
contract LaunchToken {
    /// @notice The only supply this token can ever have, in base units.
    /// @dev Must equal `InstantLaunchStrategy.TOTAL_SUPPLY` or a launch reverts.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;
    /// @notice The contract that deployed this token (i.e. the constructor caller).
    address public immutable launchpad;

    /// @notice The `LaunchpadFamilyLauncher` that launched this token into a real Uniswap market,
    ///         or `address(0)` if this is a token-only deployment with no market.
    ///
    /// @dev THIS IS HALF OF A TWO-WAY BINDING, and half is not enough on its own. Anyone can
    ///      deploy an ERC-20 that names a launcher here. A token is only a genuine Launchpad.family
    ///      market launch when BOTH hold:
    ///        1. `token.marketLauncher()` points at the launcher, AND
    ///        2. that launcher's `launchOf(token)` points back at this token.
    ///      Only the launcher can write (2), and it does so only after verifying that the pool was
    ///      created and the beneficiary NFT landed on LaunchpadRewards. Use
    ///      `LaunchpadFamilyLauncher.verifyMarketLaunch(token)`, which checks both directions.
    address public immutable marketLauncher;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();

    /// @param marketLauncher_ The market launcher, or `address(0)` for a token-only deployment.
    constructor(string memory name_, string memory symbol_, address recipient_, address marketLauncher_) {
        if (recipient_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        launchpad = msg.sender;
        marketLauncher = marketLauncher_;
        totalSupply = TOTAL_SUPPLY;
        balanceOf[recipient_] = TOTAL_SUPPLY;
        emit Transfer(address(0), recipient_, TOTAL_SUPPLY);
    }

    /// @notice True when this token claims to have been launched into a real market.
    /// @dev A CLAIM, not a proof — see `marketLauncher`. Verify with the launcher before trusting.
    function isMarketLaunch() external view returns (bool) {
        return marketLauncher != address(0);
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
