// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./UniswapRobinhood.sol";

/// @title LaunchpadRewards
/// @notice Singleton holder of every Launchpad.family launch's Uniswap creator-fee claim, and the
///         immutable three-way splitter of that stream.
///
/// @dev WHAT STREAM THIS SPLITS — read this before quoting any percentage.
///      Uniswap's launch pool charges a 25 bps LP fee. Uniswap's own `FeeSplitter` then sends
///      40% of the ETH side (and 0% of the token side) to the beneficiary vault; the remaining
///      60% of ETH and 100% of the token side go to Uniswap. THIS CONTRACT SPLITS ONLY THE PART
///      THAT REACHES THE VAULT. The 50/30/20 below are shares of that stream — NOT of swap
///      volume, NOT of total LP fees.
///
/// @dev PRIVILEGED CAPABILITIES: none that can move value. `registrar` may record an attribution
///      once per position and can never change one. There is no owner, no pause, no upgrade path,
///      no setter, and no function that can redirect an existing stream — not for the pad owner,
///      not for the creator, not for the protocol.
///
/// @dev PAYOUTS ARE PULL-BASED. A recipient that reverts on receiving native currency can only
///      block its own withdrawal, never the other two parties'.
contract LaunchpadRewards {
    // --- Economics (fixed for v1, immutable in bytecode) -------------------------------------

    /// @notice Share of the Uniswap creator-fee stream paid to the individual token creator.
    uint256 public constant CREATOR_BPS = 5000; // 50%
    /// @notice Share paid to the owner of the launchpad the token was launched through.
    uint256 public constant PAD_OWNER_BPS = 3000; // 30%
    /// @notice Share paid to the Launchpad.family protocol treasury.
    uint256 public constant PROTOCOL_BPS = 2000; // 20%
    uint256 private constant BPS_DENOMINATOR = 10_000;

    // --- Wiring (immutable) ------------------------------------------------------------------

    /// @notice Uniswap's beneficiary vault. Pinned on Robinhood Chain mainnet.
    IBeneficiaryVaultLike public immutable beneficiaryVault;
    /// @notice The ONLY address that may attribute a launch. This is the
    ///         `LaunchpadFamilyLauncher` contract — never an EOA, enforced at construction.
    address public immutable registrar;
    /// @notice Launchpad.family revenue address.
    address public immutable protocolTreasury;

    // --- State -------------------------------------------------------------------------------

    /// @notice Who earns from a given launch position. Written exactly once, never mutated.
    struct Attribution {
        address tokenCreator;
        address launchpadOwner;
        address launchpad;
        address token;
        bool registered;
    }

    /// @notice Launch position / beneficiary NFT id => attribution.
    mapping(uint256 => Attribution) public attributionOf;
    /// @notice Native currency owed to each party.
    mapping(address => uint256) public pending;
    /// @notice Sum of all `pending`. Invariant: totalPending <= address(this).balance.
    uint256 public totalPending;
    /// @notice Lifetime native currency split for a position, for analytics and proof.
    mapping(uint256 => uint256) public lifetimeDistributed;
    /// @notice Guards `collectAndSplit` against re-entrancy through the vault's payout.
    uint256 private _locked = 1;

    event LaunchAttributed(
        uint256 indexed tokenId,
        address indexed tokenCreator,
        address indexed launchpadOwner,
        address launchpad,
        address token
    );
    event RewardsSplit(
        uint256 indexed tokenId, uint256 total, uint256 toCreator, uint256 toLaunchpadOwner, uint256 toProtocol
    );
    event Withdrawn(address indexed party, uint256 amount);

    error NotRegistrar();
    error AlreadyAttributed();
    error NotAttributed();
    error ZeroAddress();
    error RegistrarMustBeContract();
    error UnofficialUniswapAddress();
    error NothingPending();
    error NothingClaimed();
    error TransferFailed();
    error OnlyVaultNfts();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @param beneficiaryVault_ Uniswap's vault. On Robinhood Chain mainnet this MUST be the
    ///        official pinned address; anywhere else (tests, forks with doubles) it is free.
    /// @param registrar_ The launcher contract. Must have code — an EOA registrar is rejected,
    ///        so attribution can only ever happen inside a launch transaction.
    constructor(IBeneficiaryVaultLike beneficiaryVault_, address registrar_, address protocolTreasury_) {
        if (address(beneficiaryVault_) == address(0) || registrar_ == address(0) || protocolTreasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (registrar_.code.length == 0) revert RegistrarMustBeContract();
        if (
            block.chainid == UniswapRobinhood.ROBINHOOD_MAINNET
                && address(beneficiaryVault_) != UniswapRobinhood.BENEFICIARY_VAULT
        ) revert UnofficialUniswapAddress();

        // A wrong split here would be unfixable, so assert it in bytecode rather than trusting review.
        assert(CREATOR_BPS + PAD_OWNER_BPS + PROTOCOL_BPS == BPS_DENOMINATOR);

        beneficiaryVault = beneficiaryVault_;
        registrar = registrar_;
        protocolTreasury = protocolTreasury_;
    }

    // --- Attribution --------------------------------------------------------------------------

    /// @notice Record who earns from a launch. Called by the launcher inside the launch tx.
    /// @dev Write-once. There is deliberately no update path: once a position is attributed, no
    ///      party — including the protocol — can redirect its stream.
    function attributeLaunch(
        uint256 tokenId,
        address tokenCreator,
        address launchpadOwner,
        address launchpad,
        address token
    ) external {
        if (msg.sender != registrar) revert NotRegistrar();
        if (attributionOf[tokenId].registered) revert AlreadyAttributed();
        if (tokenCreator == address(0) || launchpadOwner == address(0)) revert ZeroAddress();
        if (launchpad == address(0) || token == address(0)) revert ZeroAddress();

        attributionOf[tokenId] = Attribution({
            tokenCreator: tokenCreator,
            launchpadOwner: launchpadOwner,
            launchpad: launchpad,
            token: token,
            registered: true
        });

        emit LaunchAttributed(tokenId, tokenCreator, launchpadOwner, launchpad, token);
    }

    // --- Collection ---------------------------------------------------------------------------

    /// @notice Claim a launch's accrued creator fees from Uniswap and split them three ways.
    /// @dev Permissionless. The caller receives nothing; value only moves into `pending` for the
    ///      attributed parties, so anyone (keeper, creator, pad owner) may trigger it.
    function collectAndSplit(uint256 tokenId) external nonReentrant returns (uint256 claimed) {
        Attribution memory attribution = attributionOf[tokenId];
        if (!attribution.registered) revert NotAttributed();

        uint256 balanceBefore = address(this).balance;
        // Pays the beneficiary-NFT holder, which is this contract.
        beneficiaryVault.claim(tokenId, 0, 0);
        claimed = address(this).balance - balanceBefore;
        if (claimed == 0) revert NothingClaimed();

        // Truncation can only favour the protocol leg, by at most 2 wei per collection.
        uint256 toCreator = (claimed * CREATOR_BPS) / BPS_DENOMINATOR;
        uint256 toPadOwner = (claimed * PAD_OWNER_BPS) / BPS_DENOMINATOR;
        uint256 toProtocol = claimed - toCreator - toPadOwner;

        _credit(attribution.tokenCreator, toCreator);
        _credit(attribution.launchpadOwner, toPadOwner);
        _credit(protocolTreasury, toProtocol);

        lifetimeDistributed[tokenId] += claimed;
        emit RewardsSplit(tokenId, claimed, toCreator, toPadOwner, toProtocol);
    }

    function _credit(address party, uint256 amount) private {
        if (amount == 0) return;
        pending[party] += amount;
        totalPending += amount;
    }

    // --- Withdrawal ---------------------------------------------------------------------------

    /// @notice Withdraw your own accrued rewards.
    function withdraw() external returns (uint256 amount) {
        return _withdrawTo(msg.sender);
    }

    /// @notice Push a party's accrued rewards to them. Callable by anyone; no discretion is gained.
    function withdrawFor(address party) external returns (uint256 amount) {
        return _withdrawTo(party);
    }

    function _withdrawTo(address party) private returns (uint256 amount) {
        amount = pending[party];
        if (amount == 0) revert NothingPending();
        // Checks-effects-interactions: settled before the external call.
        pending[party] = 0;
        totalPending -= amount;
        (bool ok,) = payable(party).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(party, amount);
    }

    // --- Views --------------------------------------------------------------------------------

    /// @notice Preview how a given amount would split, for UIs and for off-chain modelling.
    function previewSplit(uint256 amount)
        external
        pure
        returns (uint256 toCreator, uint256 toLaunchpadOwner, uint256 toProtocol)
    {
        toCreator = (amount * CREATOR_BPS) / BPS_DENOMINATOR;
        toLaunchpadOwner = (amount * PAD_OWNER_BPS) / BPS_DENOMINATOR;
        toProtocol = amount - toCreator - toLaunchpadOwner;
    }

    /// @notice Native currency held here that is not owed to anybody. Should always be zero;
    ///         a non-zero value means someone force-sent ETH.
    function unaccountedBalance() external view returns (uint256) {
        uint256 balance = address(this).balance;
        return balance > totalPending ? balance - totalPending : 0;
    }

    // --- Receiving ----------------------------------------------------------------------------

    /// @notice Accepts the beneficiary NFT, and only from Uniswap's vault.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(beneficiaryVault)) revert OnlyVaultNfts();
        return this.onERC721Received.selector;
    }

    /// @notice Native currency arrives from the vault's claim payout.
    receive() external payable {}
}
