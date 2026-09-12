// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./LaunchToken.sol";
import "./FeeRouter.sol";

/// @title Launchpad
/// @notice One branded launchpad. Owns its economic preset and deploys fixed-supply tokens.
///
/// @dev PRIVILEGED CAPABILITIES:
///      - `owner` is the only address that may call `launchToken`.
///      - `owner` is IMMUTABLE. There is no transfer, no renounce, no admin, no pause, no upgrade.
///        If the owner key is lost, this launchpad can never launch another token. That is the
///        deliberate alpha trade-off: no privileged key can ever be rotated into someone else's hands.
///
/// @dev WHAT IS IMMUTABLE, LITERALLY:
///      `owner`, `feeRouter` and `preset` are Solidity `immutable` — baked into bytecode.
///      `name` and `metadataURI` are set once in the constructor and have NO setter, so they are
///      also fixed for the life of the contract. Re-branding is expected to happen by re-publishing
///      the *content* behind `metadataURI` (e.g. an IPFS directory or a hosted JSON document),
///      not by mutating on-chain state.
///
/// @dev TOKEN SUPPLY CAVEAT — READ THIS:
///      `launchToken` mints 100% of the fixed supply to the caller (the pad owner). There is no
///      bonding curve, no liquidity bootstrapping, no vesting and no lock. A token launched this
///      way is fully rug-capable by its creator by construction. It is a deployment primitive, not
///      a fair-launch market. The market/trading path is a later milestone.
///
/// @dev FEE CAVEAT: `feeRouter` is recorded here, but nothing in this contract or in `LaunchToken`
///      forces a trade to pay it. The "mandatory 1% fee" is currently a property of an economic
///      template that has no on-chain enforcement point yet, because there is no on-chain market.
contract Launchpad {
    uint256 public constant MAX_NAME_LENGTH = 64;
    uint256 public constant MAX_METADATA_URI_LENGTH = 256;
    uint256 public constant MAX_TOKEN_NAME_LENGTH = 64;
    uint256 public constant MAX_TOKEN_SYMBOL_LENGTH = 11;
    /// @notice Upper bound on whole tokens per launch (before 18-decimal scaling).
    uint256 public constant MAX_WHOLE_TOKEN_SUPPLY = 1_000_000_000_000;

    address public immutable owner;
    address public immutable feeRouter;
    FeeRouter.Preset public immutable preset;

    string public name;
    string public metadataURI;
    address[] public tokens;

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
        FeeRouter.Preset preset_
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
    }

    /// @notice Deploy a fixed-supply ERC-20 under this launchpad. Entire supply goes to the owner.
    function launchToken(string calldata tokenName, string calldata symbol, uint256 wholeTokenSupply)
        external
        returns (address token)
    {
        if (msg.sender != owner) revert NotOwner();

        uint256 nameLength = bytes(tokenName).length;
        uint256 symbolLength = bytes(symbol).length;
        if (nameLength == 0 || nameLength > MAX_TOKEN_NAME_LENGTH) revert InvalidMetadata();
        if (symbolLength == 0 || symbolLength > MAX_TOKEN_SYMBOL_LENGTH) revert InvalidMetadata();
        if (wholeTokenSupply == 0 || wholeTokenSupply > MAX_WHOLE_TOKEN_SUPPLY) revert InvalidSupply();

        uint256 supply = wholeTokenSupply * 1e18;
        token = address(new LaunchToken(tokenName, symbol, supply, msg.sender));
        tokens.push(token);

        emit TokenLaunched(token, msg.sender, tokenName, symbol, supply);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
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
