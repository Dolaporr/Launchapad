const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

/**
 * Milestone 2 proof-of-concept.
 *
 * Validates the one architectural assumption the memo rests on: that Uniswap's single
 * `feeBeneficiary` slot can be pointed at ONE Launchpad.family contract which then services many
 * pools and splits each pool's creator-fee stream three ways (token creator / launchpad owner /
 * protocol) — with no change to any Uniswap contract and no v4 hook.
 *
 * The bps below are PLACEHOLDERS chosen to make arithmetic legible. They are not a proposed
 * economic model; percentages are a product decision requiring approval.
 */
const CREATOR_BPS = 5000;   // placeholder
const PAD_BPS = 3000;       // placeholder
const PROTOCOL_BPS = 2000;  // placeholder

describe('PoC: LaunchpadRewards over Uniswap Liquidity Launchpad', () => {
  async function deploy() {
    const [deployer, registrar, protocol, creatorA, padOwnerA, creatorB, padOwnerB, keeper] =
      await ethers.getSigners();

    const vault = await (await ethers.getContractFactory('MockBeneficiaryVault')).deploy();
    const rewards = await (await ethers.getContractFactory('LaunchpadRewardsPoC')).deploy(
      await vault.getAddress(), registrar.address, protocol.address,
      CREATOR_BPS, PAD_BPS, PROTOCOL_BPS,
    );
    return { vault, rewards, deployer, registrar, protocol, creatorA, padOwnerA, creatorB, padOwnerB, keeper };
  }

  describe('construction', () => {
    it('requires the split to sum to exactly 100%', async () => {
      const { vault, registrar, protocol } = await loadFixture(deploy);
      const Rewards = await ethers.getContractFactory('LaunchpadRewardsPoC');
      await expect(Rewards.deploy(await vault.getAddress(), registrar.address, protocol.address, 5000, 3000, 1999))
        .to.be.revertedWithCustomError(Rewards, 'InvalidBps');
      await expect(Rewards.deploy(await vault.getAddress(), registrar.address, protocol.address, 5000, 3000, 2001))
        .to.be.revertedWithCustomError(Rewards, 'InvalidBps');
    });

    it('exposes no setter for the split or the treasury', async () => {
      const { rewards } = await loadFixture(deploy);
      const names = rewards.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
      expect(names.filter((n) => /^set|transferOwnership|upgrade|initialize|pause/i.test(n))).to.deep.equal([]);
    });
  });

  describe('the three-party split', () => {
    it('splits one pool\'s creator-fee stream between creator, pad owner and protocol', async () => {
      const { vault, rewards, registrar, protocol, creatorA, padOwnerA, keeper } = await loadFixture(deploy);
      const tokenId = 1n;

      await rewards.connect(registrar).attributeLaunch(tokenId, creatorA.address, padOwnerA.address);
      await vault.mintTo(await rewards.getAddress(), tokenId);
      await vault.fund(tokenId, { value: ethers.parseEther('1') });

      // Anyone can trigger the collection — here a keeper with no stake in the outcome.
      await expect(rewards.connect(keeper).collectAndSplit(tokenId))
        .to.emit(rewards, 'RewardsSplit')
        .withArgs(tokenId, ethers.parseEther('1'), ethers.parseEther('0.5'), ethers.parseEther('0.3'), ethers.parseEther('0.2'));

      expect(await rewards.pending(creatorA.address)).to.equal(ethers.parseEther('0.5'));
      expect(await rewards.pending(padOwnerA.address)).to.equal(ethers.parseEther('0.3'));
      expect(await rewards.pending(protocol.address)).to.equal(ethers.parseEther('0.2'));
      expect(await rewards.pending(keeper.address)).to.equal(0n);
    });

    it('conserves every wei across awkward amounts', async () => {
      const { vault, rewards, registrar, protocol, creatorA, padOwnerA } = await loadFixture(deploy);
      const tokenId = 7n;
      await rewards.connect(registrar).attributeLaunch(tokenId, creatorA.address, padOwnerA.address);
      await vault.mintTo(await rewards.getAddress(), tokenId);

      let total = 0n;
      for (const amount of [1n, 3n, 7n, 999n, 1_000_003n, 123_456_789n]) {
        await vault.fund(tokenId, { value: amount });
        await rewards.collectAndSplit(tokenId);
        total += amount;
      }

      const sum = (await rewards.pending(creatorA.address))
        + (await rewards.pending(padOwnerA.address))
        + (await rewards.pending(protocol.address));
      expect(sum).to.equal(total);
      expect(await rewards.totalPending()).to.equal(total);
      expect(await ethers.provider.getBalance(await rewards.getAddress())).to.equal(total);
      expect(await rewards.lifetimeDistributed(tokenId)).to.equal(total);
    });
  });

  describe('ONE contract services MANY pools', () => {
    it('keeps separate attribution and separate accounting per pool', async () => {
      const { vault, rewards, registrar, protocol, creatorA, padOwnerA, creatorB, padOwnerB } =
        await loadFixture(deploy);

      await rewards.connect(registrar).attributeLaunch(1n, creatorA.address, padOwnerA.address);
      await rewards.connect(registrar).attributeLaunch(2n, creatorB.address, padOwnerB.address);
      await vault.mintTo(await rewards.getAddress(), 1n);
      await vault.mintTo(await rewards.getAddress(), 2n);

      await vault.fund(1n, { value: ethers.parseEther('1') });
      await vault.fund(2n, { value: ethers.parseEther('10') });
      await rewards.collectAndSplit(1n);
      await rewards.collectAndSplit(2n);

      expect(await rewards.pending(creatorA.address)).to.equal(ethers.parseEther('0.5'));
      expect(await rewards.pending(creatorB.address)).to.equal(ethers.parseEther('5'));
      expect(await rewards.pending(padOwnerA.address)).to.equal(ethers.parseEther('0.3'));
      expect(await rewards.pending(padOwnerB.address)).to.equal(ethers.parseEther('3'));
      // Protocol accrues from both pools into one balance.
      expect(await rewards.pending(protocol.address)).to.equal(ethers.parseEther('2.2'));
    });

    it('scales to many pools without redeploying anything', async () => {
      const { vault, rewards, registrar, protocol } = await loadFixture(deploy);

      for (let i = 1; i <= 12; i += 1) {
        // Fresh addresses per pool, so none of them collides with the protocol treasury and
        // inflates its balance — the bug this assertion originally tripped over.
        const creator = ethers.Wallet.createRandom();
        const padOwner = ethers.Wallet.createRandom();
        await rewards.connect(registrar).attributeLaunch(BigInt(i), creator.address, padOwner.address);
        await vault.mintTo(await rewards.getAddress(), BigInt(i));
        await vault.fund(BigInt(i), { value: ethers.parseEther('1') });
        await rewards.collectAndSplit(BigInt(i));
      }

      // 12 pools x 0.2 ETH protocol share, from a single deployed contract.
      expect(await rewards.pending(protocol.address)).to.equal(ethers.parseEther('2.4'));
      expect(await ethers.provider.getBalance(await rewards.getAddress())).to.equal(ethers.parseEther('12'));
    });
  });

  describe('attribution safety', () => {
    it('only the registrar can attribute a launch', async () => {
      const { rewards, creatorA, padOwnerA } = await loadFixture(deploy);
      await expect(rewards.connect(creatorA).attributeLaunch(1n, creatorA.address, padOwnerA.address))
        .to.be.revertedWithCustomError(rewards, 'NotRegistrar');
    });

    it('attribution is write-once: a pad owner can never redirect a creator\'s stream', async () => {
      const { rewards, registrar, creatorA, padOwnerA, padOwnerB } = await loadFixture(deploy);
      await rewards.connect(registrar).attributeLaunch(1n, creatorA.address, padOwnerA.address);
      await expect(rewards.connect(registrar).attributeLaunch(1n, padOwnerB.address, padOwnerB.address))
        .to.be.revertedWithCustomError(rewards, 'AlreadyRegistered');

      const attribution = await rewards.attributionOf(1n);
      expect(attribution.tokenCreator).to.equal(creatorA.address);
    });

    it('refuses to collect for an unattributed pool', async () => {
      const { rewards } = await loadFixture(deploy);
      await expect(rewards.collectAndSplit(99n)).to.be.revertedWithCustomError(rewards, 'NotRegistered');
    });

    it('rejects beneficiary NFTs from anywhere but the vault', async () => {
      const { rewards, creatorA } = await loadFixture(deploy);
      await expect(
        rewards.connect(creatorA).onERC721Received(creatorA.address, creatorA.address, 1n, '0x'),
      ).to.be.revertedWithCustomError(rewards, 'OnlyVaultNfts');
    });
  });

  describe('payouts', () => {
    it('lets each party withdraw its own share', async () => {
      const { vault, rewards, registrar, creatorA, padOwnerA } = await loadFixture(deploy);
      await rewards.connect(registrar).attributeLaunch(1n, creatorA.address, padOwnerA.address);
      await vault.mintTo(await rewards.getAddress(), 1n);
      await vault.fund(1n, { value: ethers.parseEther('1') });
      await rewards.collectAndSplit(1n);

      await expect(rewards.connect(creatorA).withdraw())
        .to.changeEtherBalance(creatorA, ethers.parseEther('0.5'));
      expect(await rewards.pending(creatorA.address)).to.equal(0n);
      await expect(rewards.connect(creatorA).withdraw())
        .to.be.revertedWithCustomError(rewards, 'NothingPending');
    });

    it('a party that cannot receive ETH cannot block the others', async () => {
      const { vault, rewards, registrar, protocol, padOwnerA } = await loadFixture(deploy);
      const rejecting = await (await ethers.getContractFactory('RejectingBeneficiary')).deploy();

      await rewards.connect(registrar).attributeLaunch(1n, await rejecting.getAddress(), padOwnerA.address);
      await vault.mintTo(await rewards.getAddress(), 1n);
      await vault.fund(1n, { value: ethers.parseEther('1') });
      await rewards.collectAndSplit(1n);

      // The healthy parties are unaffected.
      await expect(rewards.withdrawFor(padOwnerA.address))
        .to.changeEtherBalance(padOwnerA, ethers.parseEther('0.3'));
      await expect(rewards.withdrawFor(protocol.address))
        .to.changeEtherBalance(protocol, ethers.parseEther('0.2'));
      // Only the broken one fails, and its funds stay credited rather than being lost.
      await expect(rewards.withdrawFor(await rejecting.getAddress()))
        .to.be.revertedWithCustomError(rewards, 'TransferFailed');
      expect(await rewards.pending(await rejecting.getAddress())).to.equal(ethers.parseEther('0.5'));
    });
  });

  describe('what this does NOT prove', () => {
    it('uses a test double for the vault, so real integration remains unverified', async () => {
      const { vault } = await loadFixture(deploy);
      // Guard against the mock being mistaken for the real thing: it has a `fund` helper that
      // Uniswap's vault does not, which is the marker that this is a simulation.
      expect(vault.interface.fragments.map((f) => f.name)).to.include('fund');
    });
  });
});
