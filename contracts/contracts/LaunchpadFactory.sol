// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Launchpad.sol";
import "./FeeRouter.sol";

/// @title LaunchpadFactory
/// @notice Permissionless factory: anyone can create their own branded launchpad with its own
///         immutable economic preset and its own dedicated fee router.
///
/// @dev PRIVILEGED CAPABILITIES: none. No owner, no admin, no pause, no allowlist, no fee switch,
///      no upgrade path. `protocolTreasury` and `reserveReceiver` are immutable and identical for
///      every launchpad this factory creates; changing either requires deploying a new factory.
///
/// @dev CONFIGURATION FOOTGUN: if `reserveReceiver` is the zero address, this factory can still
///      create Standard launchpads but every `NvdaReserve` creation reverts (FeeRouter rejects a
///      zero reserve receiver). Check `supportsNvdaReserve()` after deployment.
///
/// @dev `reserveReceiver` MUST NOT be a `ReserveVault`. The vault holds the reserve ERC-20 and
///      rejects native currency by design. The reserve receiver is the (not yet written) buyer
///      module that converts native fees into canonical NVDA and deposits it into the vault.
contract LaunchpadFactory {
    address public immutable protocolTreasury;
    address public immutable reserveReceiver;

    address[] public launchpads;
    mapping(address => bool) public isLaunchpad;
    mapping(address => address[]) private _launchpadsByOwner;

    event LaunchpadCreated(
        address indexed launchpad,
        address indexed owner,
        address feeRouter,
        FeeRouter.Preset preset,
        string name,
        string metadataURI
    );

    error ZeroAddress();

    constructor(address protocolTreasury_, address reserveReceiver_) {
        if (protocolTreasury_ == address(0)) revert ZeroAddress();
        protocolTreasury = protocolTreasury_;
        reserveReceiver = reserveReceiver_;
    }

    /// @notice True when this factory is able to create `NvdaReserve` launchpads.
    function supportsNvdaReserve() external view returns (bool) {
        return reserveReceiver != address(0);
    }

    /// @notice Create a launchpad owned by the caller, plus its dedicated fee router.
    /// @dev Metadata bounds are enforced by the `Launchpad` constructor.
    function createLaunchpad(string calldata name, string calldata metadataURI, FeeRouter.Preset preset)
        external
        returns (address pad, address router)
    {
        FeeRouter feeRouter = new FeeRouter(msg.sender, protocolTreasury, reserveReceiver, preset);
        Launchpad launchpad = new Launchpad(msg.sender, name, metadataURI, address(feeRouter), preset);

        pad = address(launchpad);
        router = address(feeRouter);

        launchpads.push(pad);
        isLaunchpad[pad] = true;
        _launchpadsByOwner[msg.sender].push(pad);

        emit LaunchpadCreated(pad, msg.sender, router, preset, name, metadataURI);
    }

    function count() external view returns (uint256) {
        return launchpads.length;
    }

    function ownerLaunchpadCount(address owner) external view returns (uint256) {
        return _launchpadsByOwner[owner].length;
    }

    function launchpadsOf(address owner) external view returns (address[] memory) {
        return _launchpadsByOwner[owner];
    }

    /// @notice Paginated listing, so indexers never need an unbounded call on a growing array.
    function launchpadsPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = launchpads.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = launchpads[i];
        }
    }
}
