// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title V4TestSwapRouter
/// @notice TEST-ONLY router that executes real Uniswap v4 swaps against a real PoolManager.
///         NEVER DEPLOY THIS TO PRODUCTION — it has no slippage protection, no deadline, and no
///         access control. It exists so fork tests can generate GENUINE trading fees rather than
///         injecting synthetic ones.
///
/// @dev v4 swaps go through the lock/unlock pattern: call `poolManager.unlock(data)`, and the
///      manager calls back into `unlockCallback`. Inside the callback the swap runs and the
///      resulting deltas are settled — pay what we owe, take what we are owed.

type Currency is address;
type BalanceDelta is int256;

struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerLike {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (BalanceDelta swapDelta);
    function sync(Currency currency) external;
    function take(Currency currency, address to, uint256 amount) external;
    function settle() external payable returns (uint256 paid);
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract V4TestSwapRouter {
    /// @dev Bounds from TickMath. A swap is allowed to move the price as far as it likes.
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    IPoolManagerLike public immutable poolManager;

    struct CallbackData {
        PoolKey key;
        SwapParams params;
        address payer;
        address recipient;
    }

    error NotPoolManager();

    constructor(IPoolManagerLike poolManager_) {
        poolManager = poolManager_;
    }

    /// @notice Buy the pool's token with native ETH (currency0 -> currency1).
    /// @param amountIn Exact ETH to spend. The pool takes its LP fee out of this.
    function buyExactIn(PoolKey calldata key, uint256 amountIn, address recipient)
        external
        payable
        returns (int128 amount0, int128 amount1)
    {
        return _swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn), // negative == exact input
                sqrtPriceLimitX96: MIN_SQRT_PRICE + 1
            }),
            msg.sender,
            recipient
        );
    }

    /// @notice Sell the pool's token back for native ETH (currency1 -> currency0).
    /// @dev The caller must have approved this router for `amountIn` of the token.
    function sellExactIn(PoolKey calldata key, uint256 amountIn, address recipient)
        external
        returns (int128 amount0, int128 amount1)
    {
        return _swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: MAX_SQRT_PRICE - 1
            }),
            msg.sender,
            recipient
        );
    }

    function _swap(PoolKey calldata key, SwapParams memory params, address payer, address recipient)
        private
        returns (int128 amount0, int128 amount1)
    {
        bytes memory result = poolManager.unlock(
            abi.encode(CallbackData({key: key, params: params, payer: payer, recipient: recipient}))
        );
        (amount0, amount1) = abi.decode(result, (int128, int128));
    }

    /// @notice Called back by the PoolManager once the lock is acquired.
    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory data = abi.decode(rawData, (CallbackData));

        BalanceDelta delta = poolManager.swap(data.key, data.params, "");
        int128 amount0 = int128(BalanceDelta.unwrap(delta) >> 128);
        int128 amount1 = int128(int256(BalanceDelta.unwrap(delta)));

        // A negative delta is what we OWE the pool; a positive delta is what we are OWED.
        if (amount0 < 0) _settle(data.key.currency0, data.payer, uint256(uint128(-amount0)));
        if (amount1 < 0) _settle(data.key.currency1, data.payer, uint256(uint128(-amount1)));
        if (amount0 > 0) poolManager.take(data.key.currency0, data.recipient, uint256(uint128(amount0)));
        if (amount1 > 0) poolManager.take(data.key.currency1, data.recipient, uint256(uint128(amount1)));

        return abi.encode(amount0, amount1);
    }

    function _settle(Currency currency, address payer, uint256 amount) private {
        address token = Currency.unwrap(currency);
        if (token == address(0)) {
            // Native: forward the value the caller sent with the swap.
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20Minimal(token).transferFrom(payer, address(poolManager), amount);
            poolManager.settle();
        }
    }

    receive() external payable {}
}
