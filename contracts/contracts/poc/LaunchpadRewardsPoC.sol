// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./UniswapLaunchpadInterfaces.sol";

/// @title LaunchpadRewardsPoC
/// @notice PROOF OF CONCEPT — not for deployment, not audited, percentages not chosen.
///
/// @dev THE PROBLEM THIS VALIDATES
///      Uniswap's InstantLaunchStrategy gives each launch exactly ONE degree of freedom: a single
///      `feeBeneficiary` address, which receives a transferable ERC-721 claim on that pool's
///      creator-fee stream. Launchpad.family needs THREE parties paid from that one stream:
///        1. the token creator      (varies per token)
///        2. the launchpad owner    (varies per launchpad)
///        3. Launchpad.family       (constant)
///
///      This contract is that adapter. It is named as the `feeBeneficiary` at launch, so it ends
///      up holding the beneficiary NFT for every token launched through Launchpad.family. It then
///      claims and sub-splits each stream three ways.
///
/// @dev WHAT THIS PROVES
///      - ONE deployed contract can service UNBOUNDEDLY MANY pools (state is keyed by tokenId).
///      - No Uniswap contract is modified, forked, or wrapped. No v4 hook is involved.
///      - The split is enforced on chain, not in a frontend.
///
/// @dev PERCENTAGES ARE PLACEHOLDERS. `creatorBps` / `padOwnerBps` / `protocolBps` are constructor
///      arguments precisely so this PoC does NOT bake in an economic decision. Choosing them is a
///      product decision requiring approval.
///
/// @dev PAYOUTS ARE PULL-BASED, deliberately. An earlier push-based design in this repo let a
///      single beneficiary that rejects native currency brick fee routing for everyone. Accrue,
///      then let each party withdraw.
contract LaunchpadRewardsPoC {
    /// @notice Uniswap's beneficiary vault. Immutable.
    IBeneficiaryVault public immutable beneficiaryVault;
    /// @notice The only address allowed to attribute a launch. In production this is the
    ///         Launchpad.family launch contract, which knows the creator and the pad owner.
    address public immutable registrar;
    /// @notice Launchpad.family's revenue address. Immutable.
    address public immutable protocolTreasury;

    /// @notice Placeholder split of the creator-fee stream. Sum MUST be 10_000.
    uint16 public immutable creatorBps;
    uint16 public immutable padOwnerBps;
    uint16 public immutable protocolBps;

    /// @notice Who is owed what for a given launch position.
    struct Attribution {
        address tokenCreator;
        address launchpadOwner;
        bool registered;
    }

    /// @notice tokenId (the v4 LP position / beneficiary NFT id) => who earns from it.
    mapping(uint256 => Attribution) public attributionOf;
    /// @notice Native currency owed to each party, withdrawable by them.
    mapping(address => uint256) public pending;
    /// @notice Sum of all `pending`. Invariant: <= address(this).balance.
    uint256 public totalPending;
    /// @notice Lifetime native distributed per launch, for analytics and proof.
    mapping(uint256 => uint256) public lifetimeDistributed;

    event LaunchAttributed(uint256 indexed tokenId, address indexed tokenCreator, address indexed launchpadOwner);
    event RewardsSplit(
        uint256 indexed tokenId, uint256 total, uint256 toCreator, uint256 toLaunchpadOwner, uint256 toProtocol
    );
    event Withdrawn(address indexed party, uint256 amount);

    error NotRegistrar();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAddress();
    error InvalidBps();
    error NothingPending();
    error TransferFailed();
    error NothingClaimed();
    error OnlyVaultNfts();

    constructor(
        IBeneficiaryVault beneficiaryVault_,
        address registrar_,
        address protocolTreasury_,
        uint16 creatorBps_,
        uint16 padOwnerBps_,
        uint16 protocolBps_
    ) {
        if (address(beneficiaryVault_) == address(0) || registrar_ == address(0) || protocolTreasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (uint256(creatorBps_) + padOwnerBps_ + protocolBps_ != 10_000) revert InvalidBps();

        beneficiaryVault = beneficiaryVault_;
        registrar = registrar_;
        protocolTreasury = protocolTreasury_;
        creatorBps = creatorBps_;
        padOwnerBps = padOwnerBps_;
        protocolBps = protocolBps_;
    }

    /// @notice Record who earns from a launch. Called by the Launchpad.family launch contract in
    ///         the same transaction as the launch itself.
    /// @dev Write-once per tokenId: an attribution can never be reassigned, so a pad owner can
    ///      never redirect a creator's stream after the fact.
    function attributeLaunch(uint256 tokenId, address tokenCreator, address launchpadOwner) external {
        if (msg.sender != registrar) revert NotRegistrar();
        if (attributionOf[tokenId].registered) revert AlreadyRegistered();
        if (tokenCreator == address(0) || launchpadOwner == address(0)) revert ZeroAddress();

        attributionOf[tokenId] =
            Attribution({tokenCreator: tokenCreator, launchpadOwner: launchpadOwner, registered: true});

        emit LaunchAttributed(tokenId, tokenCreator, launchpadOwner);
    }

    /// @notice Claim a launch's accrued creator fees from Uniswap and split them three ways.
    /// @dev Permissionless: anyone may trigger it (a keeper, or any of the three parties). The
    ///      caller gains nothing — value only ever moves into `pending` for the attributed parties.
    function collectAndSplit(uint256 tokenId) external returns (uint256 claimed) {
        Attribution memory attribution = attributionOf[tokenId];
        if (!attribution.registered) revert NotRegistered();

        uint256 before = address(this).balance;
        // Uniswap's vault pays the beneficiary-NFT holder, which is this contract.
        beneficiaryVault.claim(tokenId, 0, 0);
        claimed = address(this).balance - before;
        if (claimed == 0) revert NothingClaimed();

        // Truncation favours the protocol leg by at most 2 wei; no value is ever lost.
        uint256 toCreator = (claimed * creatorBps) / 10_000;
        uint256 toPadOwner = (claimed * padOwnerBps) / 10_000;
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

    /// @notice Withdraw your own accrued rewards.
    function withdraw() external returns (uint256 amount) {
        return _withdrawTo(msg.sender);
    }

    /// @notice Push a party's accrued rewards to them. Callable by anyone; grants no discretion.
    function withdrawFor(address party) external returns (uint256 amount) {
        return _withdrawTo(party);
    }

    function _withdrawTo(address party) private returns (uint256 amount) {
        amount = pending[party];
        if (amount == 0) revert NothingPending();
        // Checks-effects-interactions.
        pending[party] = 0;
        totalPending -= amount;
        (bool ok,) = payable(party).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(party, amount);
    }

    /// @notice Accepts the beneficiary NFT, but only from Uniswap's vault.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(beneficiaryVault)) revert OnlyVaultNfts();
        return this.onERC721Received.selector;
    }

    /// @notice Native currency arrives here from the vault's claim payout.
    receive() external payable {}
}
