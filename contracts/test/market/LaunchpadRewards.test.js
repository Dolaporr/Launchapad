const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

const SUPPLY = ethers.parseEther('1000000000');
const POLICY = { OWNER_ONLY: 0, OPEN: 1 };
const PRESET = { STANDARD: 0 };

/**
 * Production integration tests for the Milestone 2 contracts, using local doubles for Uniswap.
 * The real-integration counterpart lives in test/fork/, which runs against the actual mainnet
 * Liquidity Launchpad.
 *
 * The 50/30/20 split is fixed in bytecode and is a share of the Uniswap CREATOR-FEE STREAM only —
 * not of swap volume and not of total LP fees.
 */
async function deployStack() {
  const [deployer, padOwner, creator, protocol, stranger, keeper] = await ethers.getSigners();

  const launchpadFactory = await (await ethers.getContractFactory('LaunchpadFactory'))
    .deploy(protocol.address, stranger.address);
  const vault = await (await ethers.getContractFactory('MockUniswapBeneficiaryVault')).deploy();
  const positionManager = await (await ethers.getContractFactory('MockPositionManager')).deploy();
  const strategy = await (await ethers.getContractFactory('MockInstantLaunchStrategy'))
    .deploy(await vault.getAddress(), await positionManager.getAddress());
  const liquidityLauncher = await (await ethers.getContractFactory('MockLiquidityLauncher')).deploy();

  // Deployment order is forced: the launcher first (rewards requires a contract registrar),
  // pointing at the address rewards will occupy.
  const deployerNonce = await ethers.provider.getTransactionCount(deployer.address);
  const predictedRewards = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 1 });

  const launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
    await launchpadFactory.getAddress(),
    await liquidityLauncher.getAddress(),
    await strategy.getAddress(),
    await vault.getAddress(),
    await positionManager.getAddress(),
    predictedRewards,
  );
  const rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
    .deploy(await vault.getAddress(), await launcher.getAddress(), protocol.address);

  expect(await rewards.getAddress()).to.equal(predictedRewards);

  const padTx = await launchpadFactory.connect(padOwner)
    .createLaunchpad('Open Pad', '', PRESET.STANDARD, POLICY.OPEN);
  const padReceipt = await padTx.wait();
  const created = padReceipt.logs
    .map((l) => { try { return launchpadFactory.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === 'LaunchpadCreated');
  const openPad = await ethers.getContractAt('Launchpad', created.args.launchpad);

  await launchpadFactory.connect(padOwner)
    .createLaunchpad('Closed Pad', '', PRESET.STANDARD, POLICY.OWNER_ONLY);
  const closedPad = await ethers.getContractAt('Launchpad', await launchpadFactory.launchpads(1));

  return {
    deployer, padOwner, creator, protocol, stranger, keeper,
    launchpadFactory, vault, positionManager, strategy, liquidityLauncher, launcher, rewards,
    openPad, closedPad,
  };
}

describe('Milestone 2 — LaunchpadRewards + LaunchpadFamilyLauncher', () => {
  describe('wiring and immutability', () => {
    it('reports correct wiring between launcher and rewards', async () => {
      const { launcher, rewards } = await loadFixture(deployStack);
      expect(await launcher.isCorrectlyWired()).to.equal(true);
      expect(await rewards.registrar()).to.equal(await launcher.getAddress());
    });

    it('REJECTS an EOA registrar — the registrar must be the launcher contract', async () => {
      const { vault, protocol, stranger } = await loadFixture(deployStack);
      const Rewards = await ethers.getContractFactory('LaunchpadRewards');
      await expect(Rewards.deploy(await vault.getAddress(), stranger.address, protocol.address))
        .to.be.revertedWithCustomError(Rewards, 'RegistrarMustBeContract');
    });

    it('fixes the split at 50 / 30 / 20 in bytecode', async () => {
      const { rewards } = await loadFixture(deployStack);
      expect(await rewards.CREATOR_BPS()).to.equal(5000);
      expect(await rewards.PAD_OWNER_BPS()).to.equal(3000);
      expect(await rewards.PROTOCOL_BPS()).to.equal(2000);
    });

    it('exposes no way to change the split, treasury, registrar or vault', async () => {
      const { rewards } = await loadFixture(deployStack);
      const names = rewards.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
      expect(names.filter((n) => /^set|transferOwnership|upgrade|initialize|pause|renounce/i.test(n)))
        .to.deep.equal([]);
      for (const immutableView of ['registrar', 'protocolTreasury', 'beneficiaryVault']) {
        expect(rewards.interface.getFunction(immutableView).stateMutability).to.equal('view');
      }
    });

    it('rejects zero addresses at construction', async () => {
      const { vault, launcher, protocol } = await loadFixture(deployStack);
      const Rewards = await ethers.getContractFactory('LaunchpadRewards');
      await expect(Rewards.deploy(ethers.ZeroAddress, await launcher.getAddress(), protocol.address))
        .to.be.revertedWithCustomError(Rewards, 'ZeroAddress');
      await expect(Rewards.deploy(await vault.getAddress(), await launcher.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Rewards, 'ZeroAddress');
    });
  });

  describe('launching through a pad into Uniswap', () => {
    it('launches, locks the whole supply in the pool and attributes the stream', async () => {
      const { launcher, rewards, openPad, creator, padOwner, vault } = await loadFixture(deployStack);

      const tx = await launcher.connect(creator).launch(await openPad.getAddress(), 'Genesis', 'GEN');
      const receipt = await tx.wait();
      const event = receipt.logs
        .map((l) => { try { return launcher.interface.parseLog(l); } catch { return null; } })
        .find((p) => p && p.name === 'TokenLaunchedToUniswap');

      const token = await ethers.getContractAt('LaunchToken', event.args.token);
      const tokenId = event.args.positionTokenId;

      // The creator holds NO tokens: the entire supply went into the pool.
      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await token.balanceOf(creator.address)).to.equal(0n);
      expect(await token.balanceOf(padOwner.address)).to.equal(0n);
      expect(await token.balanceOf(await launcher.getAddress())).to.equal(0n);

      // The beneficiary claim landed on the rewards splitter, not on any person.
      expect(await vault.ownerOf(tokenId)).to.equal(await rewards.getAddress());

      const attribution = await rewards.attributionOf(tokenId);
      expect(attribution.tokenCreator).to.equal(creator.address);
      expect(attribution.launchpadOwner).to.equal(padOwner.address);
      expect(attribution.launchpad).to.equal(await openPad.getAddress());
      expect(attribution.token).to.equal(event.args.token);
      expect(attribution.registered).to.equal(true);
    });

    it('records the launch permanently on the launcher', async () => {
      const { launcher, openPad, creator, padOwner } = await loadFixture(deployStack);
      await launcher.connect(creator).launch(await openPad.getAddress(), 'Genesis', 'GEN');
      const token = await launcher.allTokens(0);

      const record = await launcher.launchOf(token);
      expect(record.tokenCreator).to.equal(creator.address);
      expect(record.launchpadOwner).to.equal(padOwner.address);
      expect(record.launchpad).to.equal(await openPad.getAddress());
      expect(await launcher.tokenCount()).to.equal(1);
      expect(await launcher.tokensOfLaunchpad(await openPad.getAddress())).to.deep.equal([token]);
    });

    it('passes our rewards contract as the Uniswap feeBeneficiary', async () => {
      const { launcher, rewards, openPad, creator, liquidityLauncher } = await loadFixture(deployStack);
      await launcher.connect(creator).launch(await openPad.getAddress(), 'Genesis', 'GEN');
      expect(await liquidityLauncher.lastFeeBeneficiary()).to.equal(await rewards.getAddress());
    });

    it('uses the creator-fees strategy, never the no-creator-fees one', async () => {
      const { launcher, strategy, openPad, creator, liquidityLauncher } = await loadFixture(deployStack);
      await launcher.connect(creator).launch(await openPad.getAddress(), 'Genesis', 'GEN');
      expect(await liquidityLauncher.lastStrategy()).to.equal(await strategy.getAddress());
      expect(await launcher.instantLaunchStrategy()).to.equal(await strategy.getAddress());
    });
  });

  describe('launch policy is preserved from Milestone 1', () => {
    it('OPEN pad: a non-owner can launch and is recorded as the creator', async () => {
      const { launcher, openPad, creator, padOwner, rewards } = await loadFixture(deployStack);
      await expect(launcher.connect(creator).launch(await openPad.getAddress(), 'A', 'A')).to.not.be.reverted;
      const attribution = await rewards.attributionOf(await launcher.launchOf(await launcher.allTokens(0)).then((r) => r.positionTokenId));
      expect(attribution.tokenCreator).to.equal(creator.address);
      expect(attribution.launchpadOwner).to.equal(padOwner.address);
    });

    it('OWNER_ONLY pad: a non-owner is rejected', async () => {
      const { launcher, closedPad, creator } = await loadFixture(deployStack);
      await expect(launcher.connect(creator).launch(await closedPad.getAddress(), 'A', 'A'))
        .to.be.revertedWithCustomError(launcher, 'NotAllowedToLaunch');
    });

    it('OWNER_ONLY pad: the owner can still launch', async () => {
      const { launcher, closedPad, padOwner } = await loadFixture(deployStack);
      await expect(launcher.connect(padOwner).launch(await closedPad.getAddress(), 'A', 'A')).to.not.be.reverted;
    });
  });

  describe('the three-way split of the creator-fee stream', () => {
    async function launched() {
      const base = await deployStack();
      await base.launcher.connect(base.creator).launch(await base.openPad.getAddress(), 'Genesis', 'GEN');
      const token = await base.launcher.allTokens(0);
      const record = await base.launcher.launchOf(token);
      return { ...base, token, tokenId: record.positionTokenId };
    }

    it('splits 50 / 30 / 20 between creator, pad owner and protocol', async () => {
      const { rewards, vault, tokenId, creator, padOwner, protocol, keeper } = await loadFixture(launched);
      await vault.fund(tokenId, { value: ethers.parseEther('1') });

      await expect(rewards.connect(keeper).collectAndSplit(tokenId))
        .to.emit(rewards, 'RewardsSplit')
        .withArgs(tokenId, ethers.parseEther('1'), ethers.parseEther('0.5'), ethers.parseEther('0.3'), ethers.parseEther('0.2'));

      expect(await rewards.pending(creator.address)).to.equal(ethers.parseEther('0.5'));
      expect(await rewards.pending(padOwner.address)).to.equal(ethers.parseEther('0.3'));
      expect(await rewards.pending(protocol.address)).to.equal(ethers.parseEther('0.2'));
      // The keeper who triggered it earns nothing.
      expect(await rewards.pending(keeper.address)).to.equal(0n);
    });

    it('conserves every wei across adversarial amounts', async () => {
      const { rewards, vault, tokenId, creator, padOwner, protocol } = await loadFixture(launched);
      const amounts = [1n, 2n, 3n, 7n, 9n, 99n, 101n, 9999n, 1n, 123456789n, 10n ** 18n + 7n];
      let total = 0n;
      for (const amount of amounts) {
        await vault.fund(tokenId, { value: amount });
        await rewards.collectAndSplit(tokenId);
        total += amount;
      }
      const sum = (await rewards.pending(creator.address))
        + (await rewards.pending(padOwner.address))
        + (await rewards.pending(protocol.address));
      expect(sum).to.equal(total);
      expect(await rewards.totalPending()).to.equal(total);
      expect(await ethers.provider.getBalance(await rewards.getAddress())).to.equal(total);
      expect(await rewards.unaccountedBalance()).to.equal(0n);
      expect(await rewards.lifetimeDistributed(tokenId)).to.equal(total);
    });

    it('rounding can only ever favour the protocol leg, never lose a wei', async () => {
      const { rewards } = await loadFixture(launched);
      for (const amount of [1n, 3n, 7n, 11n, 13n, 9n]) {
        const [c, p, t] = await rewards.previewSplit(amount);
        expect(c + p + t).to.equal(amount);
        expect(c).to.equal((amount * 5000n) / 10000n);
        expect(p).to.equal((amount * 3000n) / 10000n);
      }
    });

    it('one rewards contract serves many pools with separate accounting', async () => {
      const base = await loadFixture(deployStack);
      const { launcher, rewards, vault, openPad, protocol } = base;
      const creators = (await ethers.getSigners()).slice(6, 10);

      for (const [i, c] of creators.entries()) {
        await launcher.connect(c).launch(await openPad.getAddress(), `Token ${i}`, `T${i}`);
        const token = await launcher.allTokens(i);
        const record = await launcher.launchOf(token);
        await vault.fund(record.positionTokenId, { value: ethers.parseEther('1') });
        await rewards.collectAndSplit(record.positionTokenId);
      }

      for (const c of creators) {
        expect(await rewards.pending(c.address)).to.equal(ethers.parseEther('0.5'));
      }
      // 4 pools x 0.2, accumulated in one place from one deployment.
      expect(await rewards.pending(protocol.address)).to.equal(ethers.parseEther('0.8'));
      expect(await launcher.tokenCount()).to.equal(4);
    });
  });

  describe('pull-based payouts', () => {
    async function fundedLaunch() {
      const base = await deployStack();
      await base.launcher.connect(base.creator).launch(await base.openPad.getAddress(), 'G', 'G');
      const record = await base.launcher.launchOf(await base.launcher.allTokens(0));
      await base.vault.fund(record.positionTokenId, { value: ethers.parseEther('1') });
      await base.rewards.collectAndSplit(record.positionTokenId);
      return { ...base, tokenId: record.positionTokenId };
    }

    it('lets each party withdraw its own share', async () => {
      const { rewards, creator } = await loadFixture(fundedLaunch);
      await expect(rewards.connect(creator).withdraw())
        .to.changeEtherBalance(creator, ethers.parseEther('0.5'));
      await expect(rewards.connect(creator).withdraw())
        .to.be.revertedWithCustomError(rewards, 'NothingPending');
    });

    it('lets anyone push a party its share without gaining anything', async () => {
      const { rewards, padOwner, stranger } = await loadFixture(fundedLaunch);
      await expect(rewards.connect(stranger).withdrawFor(padOwner.address))
        .to.changeEtherBalances([padOwner, stranger], [ethers.parseEther('0.3'), 0n]);
    });
  });
});
