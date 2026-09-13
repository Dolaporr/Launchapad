// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./UniswapLaunchpadInterfaces.sol";

/// @notice TEST DOUBLE for Uniswap's `UERC20BeneficiaryVault`. Never deploy this.
/// @dev Models only the behaviour the adapter depends on:
///        - registration mints a transferable ERC-721 claim keyed by the position tokenId,
///        - `claim` pays the CURRENT NFT holder the position's attributed native fees.
///      It is deliberately minimal; it is not a faithful reimplementation, and the real vault is
///      the source of truth. Its purpose is to let the adapter's logic be tested in isolation.
contract MockBeneficiaryVault is IBeneficiaryVault {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => uint256) public attributed;

    error AlreadyRegistered();
    error NotHolder();
    error TransferFailed();

    /// @notice Simulates fees arriving from the FeeSplitter for a position.
    function fund(uint256 tokenId) external payable {
        attributed[tokenId] += msg.value;
    }

    function registerBeneficiary(uint256 tokenId, address beneficiary) external override {
        if (ownerOf[tokenId] != address(0)) revert AlreadyRegistered();
        ownerOf[tokenId] = beneficiary;
        // The real vault mints an ERC-721 here; the adapter's onERC721Received is exercised
        // separately by `mintTo`.
    }

    /// @notice Exercises the adapter's ERC-721 receive hook the way the real vault's mint does.
    function mintTo(address to, uint256 tokenId) external {
        ownerOf[tokenId] = to;
        (bool ok, bytes memory ret) = to.call(
            abi.encodeWithSignature("onERC721Received(address,address,uint256,bytes)", msg.sender, address(0), tokenId, "")
        );
        require(ok && abi.decode(ret, (bytes4)) == 0x150b7a02, "receiver rejected");
    }

    /// @notice Pays the current NFT holder, exactly as the real vault's transfer policy does.
    function claim(uint256 tokenId, uint256, uint256) external override {
        address holder = ownerOf[tokenId];
        uint256 amount = attributed[tokenId];
        attributed[tokenId] = 0;
        if (amount == 0) return;
        (bool ok,) = payable(holder).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice The claim is transferable — the property the adapter's design depends on.
    function transferClaim(uint256 tokenId, address to) external {
        if (msg.sender != ownerOf[tokenId]) revert NotHolder();
        ownerOf[tokenId] = to;
    }
}
