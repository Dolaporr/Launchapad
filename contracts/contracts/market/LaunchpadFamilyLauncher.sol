// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./UniswapRobinhood.sol";
import "./LaunchpadRewards.sol";
import "../Launchpad.sol";
import "../LaunchpadFactory.sol";
import "../LaunchToken.sol";

/// @title LaunchpadFamilyLauncher
/// @notice Launches a token through a Launchpad.family pad into a real Uniswap v4 pool, in one
///         atomic transaction, and permanently records who earns from it.
///
/// @dev WHY ONE TRANSACTION MATTERS. `LiquidityLauncher` is permissionless and holds tokens
///      between `deposit` and `distribute`. Doing both inside a single call of this contract means
///      no other transaction can interleave and hijack the launch by supplying its own
///      `feeBeneficiary`. Splitting these steps across transactions would be exploitable.
///
/// @dev PRIVILEGED CAPABILITIES: none. No owner, no pause, no allowlist, no upgrade path, no
///      setter. Who may launch is decided entirely by the pad's own immutable launch policy.
///
/// @dev WIRING. `LaunchpadRewards` requires its registrar to be a contract, so deployment order is
///      forced: deploy this launcher first (pointing at the rewards address it will have), then
///      deploy rewards with `registrar = address(this)`. A mis-wired pair cannot silently operate:
///      the first `launch` reverts inside `attributeLaunch` with `NotRegistrar`. `isCorrectlyWired`
///      lets an operator confirm it without spending a launch.
contract LaunchpadFamilyLauncher {
    /// @notice The Launchpad.family factory whose pads this launcher will serve. Pads from any
    ///         other factory are rejected, so a fake "launchpad" cannot be used to spoof an owner.
    LaunchpadFactory public immutable launchpadFactory;
    /// @notice Uniswap's permissionless launch entry point.
    ILiquidityLauncher public immutable liquidityLauncher;
    /// @notice Uniswap's InstantLaunchStrategy — the creator-fees variant.
    address public immutable instantLaunchStrategy;
    /// @notice Uniswap's beneficiary vault, used to prove the claim NFT landed where intended.
    IBeneficiaryVaultLike public immutable beneficiaryVault;
    /// @notice Uniswap's v4 position manager, read for the id the launch position will take.
    IPositionManagerLike public immutable positionManager;
    /// @notice The singleton splitter that receives every launch's creator-fee claim.
    LaunchpadRewards public immutable rewards;

    /// @notice Permanent record of a launch.
    struct Launch {
        address token;
        address tokenCreator;
        address launchpadOwner;
        address launchpad;
        uint256 positionTokenId;
    }

    /// @notice token => launch record. Write-once.
    mapping(address => Launch) public launchOf;
    /// @notice launchpad => tokens launched through it via Uniswap.
    mapping(address => address[]) private _tokensByLaunchpad;
    /// @notice Every token launched by this launcher, in order.
    address[] public allTokens;

    event TokenLaunchedToUniswap(
        address indexed token,
        address indexed tokenCreator,
        address indexed launchpad,
        address launchpadOwner,
        uint256 positionTokenId
    );

    error ZeroAddress();
    error UnofficialUniswapAddress();
    error UnknownLaunchpad(address launchpad);
    error NotAllowedToLaunch(address launchpad, address caller);
    error DuplicateToken(address token);
    error InvalidMetadata();
    error UnexpectedSupply(uint256 actual, uint256 expected);
    error BeneficiaryNotRewards(uint256 tokenId, address actualHolder);

    /// @dev On Robinhood Chain mainnet every Uniswap address is checked against the pinned
    ///      constants, so a production deployment cannot point at anything but the official
    ///      launchpad. On other chains (unit tests, forks using doubles) injection is allowed.
    constructor(
        LaunchpadFactory launchpadFactory_,
        ILiquidityLauncher liquidityLauncher_,
        address instantLaunchStrategy_,
        IBeneficiaryVaultLike beneficiaryVault_,
        IPositionManagerLike positionManager_,
        LaunchpadRewards rewards_
    ) {
        if (
            address(launchpadFactory_) == address(0) || address(liquidityLauncher_) == address(0)
                || instantLaunchStrategy_ == address(0) || address(beneficiaryVault_) == address(0)
                || address(positionManager_) == address(0) || address(rewards_) == address(0)
        ) revert ZeroAddress();

        if (block.chainid == UniswapRobinhood.ROBINHOOD_MAINNET) {
            if (
                address(liquidityLauncher_) != UniswapRobinhood.LIQUIDITY_LAUNCHER
                    || instantLaunchStrategy_ != UniswapRobinhood.INSTANT_LAUNCH_STRATEGY
                    || address(beneficiaryVault_) != UniswapRobinhood.BENEFICIARY_VAULT
                    || address(positionManager_) != UniswapRobinhood.POSITION_MANAGER
            ) revert UnofficialUniswapAddress();
        }

        launchpadFactory = launchpadFactory_;
        liquidityLauncher = liquidityLauncher_;
        instantLaunchStrategy = instantLaunchStrategy_;
        beneficiaryVault = beneficiaryVault_;
        positionManager = positionManager_;
        rewards = rewards_;
    }

    /// @notice Launch a token through `launchpad` into a Uniswap v4 pool.
    /// @dev The caller is the token creator and receives no supply: the entire 1,000,000,000 goes
    ///      into the pool as permanently locked liquidity. What the creator receives instead is
    ///      50% of the pool's creator-fee stream, for the life of the pool.
    function launch(address launchpad, string calldata name, string calldata symbol)
        external
        returns (address token, uint256 positionTokenId)
    {
        // 1. The pad must be one of ours. Rejects a hand-rolled contract claiming a pad owner.
        if (!launchpadFactory.isLaunchpad(launchpad)) revert UnknownLaunchpad(launchpad);

        Launchpad pad = Launchpad(launchpad);
        // 2. The pad's own immutable OPEN / OWNER_ONLY policy decides who may launch. Unchanged
        //    from Milestone 1 — this launcher adds no permission of its own.
        if (!pad.canLaunch(msg.sender)) revert NotAllowedToLaunch(launchpad, msg.sender);

        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert InvalidMetadata();

        address launchpadOwner = pad.owner();

        // 3. Mint the whole fixed supply to this contract so it can be handed to Uniswap.
        // Bind the token to this launcher at construction. Combined with the `launchOf` record
        // written below, that is a two-way binding no third party can forge.
        token = address(new LaunchToken(name, symbol, address(this), address(this)));
        if (launchOf[token].token != address(0)) revert DuplicateToken(token);

        uint256 supply = LaunchToken(token).totalSupply();
        if (supply != UniswapRobinhood.REQUIRED_TOTAL_SUPPLY) {
            revert UnexpectedSupply(supply, UniswapRobinhood.REQUIRED_TOTAL_SUPPLY);
        }

        // 4. The id the launch position (and therefore the beneficiary NFT) will take.
        positionTokenId = positionManager.nextTokenId();

        // 5. Hand the supply over and launch, atomically, so nobody can interleave a hijack.
        LaunchToken(token).transfer(address(liquidityLauncher), supply);
        liquidityLauncher.distributeToken(
            token,
            Distribution({
                strategy: instantLaunchStrategy,
                amount: uint128(supply),
                configData: abi.encode(InstantLaunchConfig({feeBeneficiary: address(rewards)}))
            }),
            keccak256(abi.encode(launchpad, token, msg.sender))
        );

        // 6. Prove the claim actually landed on our splitter rather than trusting step 5.
        address holder = beneficiaryVault.ownerOf(positionTokenId);
        if (holder != address(rewards)) revert BeneficiaryNotRewards(positionTokenId, holder);

        // 7. Record who earns, permanently and write-once.
        rewards.attributeLaunch(positionTokenId, msg.sender, launchpadOwner, launchpad, token);

        launchOf[token] = Launch({
            token: token,
            tokenCreator: msg.sender,
            launchpadOwner: launchpadOwner,
            launchpad: launchpad,
            positionTokenId: positionTokenId
        });
        _tokensByLaunchpad[launchpad].push(token);
        allTokens.push(token);

        emit TokenLaunchedToUniswap(token, msg.sender, launchpad, launchpadOwner, positionTokenId);
    }

    /// @notice The canonical check that a token is a genuine Launchpad.family market launch.
    ///
    /// @dev Verifies BOTH directions of the binding, which is what makes it unforgeable:
    ///        - the token names this launcher, and
    ///        - this launcher's own record names that token and carries a real position id.
    ///      Anyone can deploy an ERC-20 that names this launcher, but only a real launch through
    ///      `launch()` writes the record — and that only happens after the pool was created and
    ///      the beneficiary NFT was confirmed to be held by `LaunchpadRewards`.
    ///
    ///      Indexers and frontends MUST gate on this. A token-only deployment from
    ///      `Launchpad.launchToken` returns false.
    function verifyMarketLaunch(address token) public view returns (bool) {
        Launch memory record = launchOf[token];
        if (record.token != token || record.positionTokenId == 0) return false;
        // A non-contract, or a contract without the getter, is not a market launch.
        try LaunchToken(token).marketLauncher() returns (address claimed) {
            return claimed == address(this);
        } catch {
            return false;
        }
    }

    /// @notice The launch record, but only for a token that passes `verifyMarketLaunch`.
    function verifiedLaunchOf(address token)
        external
        view
        returns (bool verified, address tokenCreator, address launchpadOwner, address launchpad, uint256 positionTokenId)
    {
        verified = verifyMarketLaunch(token);
        if (!verified) return (false, address(0), address(0), address(0), 0);
        Launch memory record = launchOf[token];
        return (true, record.tokenCreator, record.launchpadOwner, record.launchpad, record.positionTokenId);
    }

    // --- Views ---------------------------------------------------------------------------------

    /// @notice True when `rewards` accepts this launcher as its registrar. Operators should check
    ///         this after deployment; a false result means the pair is mis-wired and no launch
    ///         will succeed.
    function isCorrectlyWired() external view returns (bool) {
        return rewards.registrar() == address(this);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function tokensOfLaunchpad(address launchpad) external view returns (address[] memory) {
        return _tokensByLaunchpad[launchpad];
    }

    function tokenCountOfLaunchpad(address launchpad) external view returns (uint256) {
        return _tokensByLaunchpad[launchpad].length;
    }

    /// @notice Paginated listing so indexers never need an unbounded call.
    function tokensPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = allTokens.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = allTokens[i];
        }
    }
}
