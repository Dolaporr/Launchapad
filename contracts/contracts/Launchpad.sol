// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./LaunchToken.sol";
import "./FeeRouter.sol";

/// @title Launchpad
/// @notice One branded launchpad. Owns its economic preset and deploys fixed-supply tokens.
///
/// @dev LAUNCH POLICY — who may launch tokens here — is fixed at creation and IMMUTABLE:
///      - `OwnerOnly`: only `owner` may call `launchToken`.
///      - `Open`: ANY wallet may call `launchToken`, and the entire supply of the token it creates
///        belongs to that caller, not to the pad owner. This is the permissionless mode the
///        product is built around: you create a launchpad, other people launch tokens through it.
///      A pad owner cannot switch modes later, cannot close an open pad, and cannot seize a token
///      launched by someone else. Choosing `Open` is a one-way, irreversible decision.
///
/// @dev PRIVILEGED CAPABILITIES:
///      - Under `OwnerOnly`, `owner` is the only address that may call `launchToken`. Under `Open`,
///        `owner` has NO special power over launching at all.
///      - `owner` is IMMUTABLE. There is no transfer, no renounce, no admin, no pause, no upgrade.
///        If the owner key is lost, an `OwnerOnly` pad can never launch another token (an `Open`
///        pad is unaffected). That is the deliberate alpha trade-off: no privileged key can ever
///        be rotated into someone else's hands.
///
/// @dev SPAM IS THE COST OF `Open`. Anyone can launch anything under an open pad, including
///      offensive or impersonating names. There is no moderation hook on chain by design; curation
///      belongs in the indexer/frontend layer, not in an immutable contract.
///
/// @dev WHAT IS IMMUTABLE, LITERALLY:
///      `owner`, `feeRouter` and `preset` are Solidity `immutable` — baked into bytecode.
///      `name` and `metadataURI` are set once in the constructor and have NO setter, so they are
///      also fixed for the life of the contract. Re-branding is expected to happen by re-publishing
///      the *content* behind `metadataURI` (e.g. an IPFS directory or a hosted JSON document),
///      not by mutating on-chain state.
///
/// @dev TOKEN SUPPLY CAVEAT — READ THIS:
///      `launchToken` mints 100% of the fixed supply to the caller — the pad owner under
///      `OwnerOnly`, the token's own creator under `Open`. There is no
///      bonding curve, no liquidity bootstrapping, no vesting and no lock. A token launched this
///      way is fully rug-capable by its creator by construction. It is a deployment primitive, not
///      a fair-launch market. The market/trading path is a later milestone.
///
/// @dev FEE CAVEAT: `feeRouter` is recorded here, but nothing in this contract or in `LaunchToken`
///      forces a trade to pay it. The "mandatory 1% fee" is currently a property of an economic
///      template that has no on-chain enforcement point yet, because there is no on-chain market.
contract Launchpad {
    /// @notice Who may launch tokens through this launchpad. Fixed at creation, never changeable.
    enum LaunchPolicy {
        /// @notice Only the pad owner may launch. The pad is a private storefront.
        OwnerOnly,
        /// @notice Anybody may launch, and each token's supply belongs to whoever launched it.
        Open
    }

    uint256 public constant MAX_NAME_LENGTH = 64;
    uint256 public constant MAX_METADATA_URI_LENGTH = 256;
    uint256 public constant MAX_TOKEN_NAME_LENGTH = 64;
    uint256 public constant MAX_TOKEN_SYMBOL_LENGTH = 11;
    /// @notice Upper bound on whole tokens per launch (before 18-decimal scaling).
    uint256 public constant MAX_WHOLE_TOKEN_SUPPLY = 1_000_000_000_000;

    address public immutable owner;
    address public immutable feeRouter;
    FeeRouter.Preset public immutable preset;
    /// @notice Who may launch here. Immutable — a pad can never be opened or closed after creation.
    LaunchPolicy public immutable launchPolicy;

    string public name;
    string public metadataURI;
    address[] public tokens;

    /// @notice Tokens launched by a given creator, so an open pad can show "your launches".
    mapping(address => address[]) private _tokensByCreator;

    event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint256 supply);

    error ZeroAddress();
    error NotOwner();
    error InvalidMetadata();
    error InvalidSupply();

    constructor(
        address owner_,
        string memory name_,
        string memory metadataURI_,
        address feeRouter_,
        FeeRouter.Preset preset_,
        LaunchPolicy launchPolicy_
    ) {
        if (owner_ == address(0) || feeRouter_ == address(0)) revert ZeroAddress();
        uint256 nameLength = bytes(name_).length;
        if (nameLength == 0 || nameLength > MAX_NAME_LENGTH) revert InvalidMetadata();
        if (bytes(metadataURI_).length > MAX_METADATA_URI_LENGTH) revert InvalidMetadata();

        owner = owner_;
        name = name_;
        metadataURI = metadataURI_;
        feeRouter = feeRouter_;
        preset = preset_;
        launchPolicy = launchPolicy_;
    }

    /// @notice True when `account` is currently allowed to launch a token here.
    /// @dev Under `Open` this is true for every address, including the zero address, by design.
    function canLaunch(address account) public view returns (bool) {
        return launchPolicy == LaunchPolicy.Open || account == owner;
    }

    /// @notice Deploy a fixed-supply ERC-20 under this launchpad.
    /// @dev The entire supply is minted to `msg.sender`. Under `Open` that is the third-party
    ///      creator, not the pad owner: the pad owner receives no tokens and has no claim on them.
    function launchToken(string calldata tokenName, string calldata symbol, uint256 wholeTokenSupply)
        external
        returns (address token)
    {
        if (!canLaunch(msg.sender)) revert NotOwner();

        uint256 nameLength = bytes(tokenName).length;
        uint256 symbolLength = bytes(symbol).length;
        if (nameLength == 0 || nameLength > MAX_TOKEN_NAME_LENGTH) revert InvalidMetadata();
        if (symbolLength == 0 || symbolLength > MAX_TOKEN_SYMBOL_LENGTH) revert InvalidMetadata();
        if (wholeTokenSupply == 0 || wholeTokenSupply > MAX_WHOLE_TOKEN_SUPPLY) revert InvalidSupply();

        uint256 supply = wholeTokenSupply * 1e18;
        token = address(new LaunchToken(tokenName, symbol, supply, msg.sender));
        tokens.push(token);
        _tokensByCreator[msg.sender].push(token);

        emit TokenLaunched(token, msg.sender, tokenName, symbol, supply);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function tokensOf(address creator) external view returns (address[] memory) {
        return _tokensByCreator[creator];
    }

    function tokenCountOf(address creator) external view returns (uint256) {
        return _tokensByCreator[creator].length;
    }

    /// @notice Paginated token listing, so indexers and frontends never need an unbounded call.
    function tokensPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = tokens.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = tokens[i];
        }
    }
}
