// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../FeeRouter.sol";

/// @notice Beneficiary that refuses native currency. Used to prove the fee router cannot be
///         bricked by a recipient that reverts.
contract RejectingBeneficiary {
    error Nope();

    receive() external payable {
        revert Nope();
    }

    function route(address router) external payable {
        FeeRouter(payable(router)).route{value: msg.value}();
    }

    function withdraw(address router) external {
        FeeRouter(payable(router)).withdraw();
    }
}

/// @notice Beneficiary that re-enters `withdraw` to prove checks-effects-interactions holds.
contract ReentrantBeneficiary {
    FeeRouter public router;
    uint256 public reentryAttempts;
    bool public reentryReverted;

    function setRouter(address router_) external {
        router = FeeRouter(payable(router_));
    }

    function withdraw() external {
        router.withdraw();
    }

    receive() external payable {
        if (reentryAttempts == 0) {
            reentryAttempts = 1;
            try router.withdraw() {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
    }
}

/// @notice ERC-20 that returns no data from `transfer`, like some non-standard tokens.
contract NoReturnValueToken {
    mapping(address => uint256) public balanceOf;

    constructor(address holder, uint256 amount) {
        balanceOf[holder] = amount;
    }

    function transfer(address to, uint256 value) external {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
    }
}

/// @notice ERC-20 whose `transfer` returns false instead of reverting.
contract FalseReturningToken {
    mapping(address => uint256) public balanceOf;

    constructor(address holder, uint256 amount) {
        balanceOf[holder] = amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @notice Stand-in for a Robinhood Stock Token: ERC-20 plus the ERC-8056 scaled-UI multiplier.
/// @dev This is a MOCK. It is not NVDA and must never be presented as NVDA.
contract MockScaledUIToken {
    string public name = "MOCK NVIDIA Token (NOT REAL)";
    string public symbol = "mNVDA";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    uint256 public uiMultiplier;

    mapping(address => uint256) public balanceOf;

    constructor(address holder, uint256 amount, uint256 uiMultiplier_) {
        balanceOf[holder] = amount;
        totalSupply = amount;
        uiMultiplier = uiMultiplier_;
    }

    function balanceOfUI(address account) external view returns (uint256) {
        return (balanceOf[account] * uiMultiplier) / 1e18;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}
