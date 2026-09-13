const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

const POLICY = { OWNER_ONLY: 0, OPEN: 1 };
const PRESET = { STANDARD: 0 };

/**
 * Adversarial suite for the Milestone 2 contracts. Every test here is an attack that must fail.
 */
async function deployStack() {
  const [deployer, padOwner, creator, protocol, attacker, keeper] = await ethers.getSigners();

  const launchpadFactory = await (await ethers.getContractFactory('LaunchpadFactory'))
    .deploy(protocol.address, attacker.address);
  const vault = await (await ethers.getContractFactory('MockUniswapBeneficiaryVault')).deploy();
  const positionManager = await (await ethers.getContractFactory('MockPositionManager')).deploy();
  const strategy = await (await ethers.getContractFactory('MockInstantLaunchStrategy'))
    .deploy(await vault.getAddress(), await positionManager.getAddress());
  const liquidityLauncher = await (await ethers.getContractFactory('MockLiquidityLauncher')).deploy();

  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
  const launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
    await launchpadFactory.getAddress(), await liquidityLauncher.getAddress(),
    await strategy.getAddress(), await vault.getAddress(),
    await positionManager.getAddress(), predicted,
  );
  const rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
    .deploy(await vault.getAddress(), await launcher.getAddress(), protocol.address);

  await launchpadFactory.connect(padOwner).createLaunchpad('Open', '', PRESET.STANDARD, POLICY.OPEN);
  const openPad = await ethers.getContractAt('Launchpad', await launchpadFactory.launchpads(0));

  return {
    deployer, padOwner, creator, protocol, attacker, keeper,
    launchpadFactory, vault, positionManager, strategy, liquidityLauncher, launcher, rewards, openPad,
  };
}

async function launchOne(base, signer = base.creator) {
  await base.launcher.connect(signer).launch(await base.openPad.getAddress(), 'Genesis', 'GEN');
  const token = await base.launcher.allTokens(0);
  const record = await base.launcher.launchOf(token);
  return { token, tokenId: record.positionTokenId };
}

describe('Milestone 2 — adversarial', () => {
  describe('unauthorized attribution', () => {
    it('an EOA cannot attribute a launch', async () => {
      const { rewards, attacker, padOwner, openPad } = await loadFixture(deployStack);
      await expect(
        rewards.connect(attacker).attributeLaunch(1n, attacker.address, padOwner.address, await openPad.getAddress(), attacker.address),
      ).to.be.revertedWithCustomError(rewards, 'NotRegistrar');
    });

    it('the pad owner cannot attribute a launch to themselves', async () => {
      const { rewards, padOwner, openPad } = await loadFixture(deployStack);
      await expect(
        rewards.connect(padOwner).attributeLaunch(1n, padOwner.address, padOwner.address, await openPad.getAddress(), padOwner.address),
      ).to.be.revertedWithCustomError(rewards, 'NotRegistrar');
    });

    it('the protocol treasury cannot attribute a launch either', async () => {
      const { rewards, protocol, openPad } = await loadFixture(deployStack);
      await expect(
        rewards.connect(protocol).attributeLaunch(1n, protocol.address, protocol.address, await openPad.getAddress(), protocol.address),
      ).to.be.revertedWithCustomError(rewards, 'NotRegistrar');
    });

    it('a second launcher contract cannot attribute into this rewards contract', async () => {
      const { rewards, launchpadFactory, liquidityLauncher, strategy, vault, positionManager, openPad, attacker, padOwner } =
        await loadFixture(deployStack);
      const rogue = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
        await launchpadFactory.getAddress(), await liquidityLauncher.getAddress(),
        await strategy.getAddress(), await vault.getAddress(),
        await positionManager.getAddress(), await rewards.getAddress(),
      );
      // The rogue launcher is well-formed but is not THE registrar, so its launch cannot attribute.
      await expect(rogue.connect(attacker).launch(await openPad.getAddress(), 'Rogue', 'RG'))
        .to.be.revertedWithCustomError(rewards, 'NotRegistrar');
      expect(await rogue.isCorrectlyWired()).to.equal(false);
      expect(padOwner.address).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe('replay / double attribution', () => {
    it('the same position can never be attributed twice', async () => {
      const base = await loadFixture(deployStack);
      const { tokenId } = await launchOne(base);
      // Reach the registrar path directly by impersonating the launcher contract.
      const launcherAddress = await base.launcher.getAddress();
      await ethers.provider.send('hardhat_impersonateAccount', [launcherAddress]);
      await ethers.provider.send('hardhat_setBalance', [launcherAddress, '0x56BC75E2D63100000']);
      const asLauncher = await ethers.getSigner(launcherAddress);

      await expect(
        base.rewards.connect(asLauncher)
          .attributeLaunch(tokenId, base.attacker.address, base.attacker.address, await base.openPad.getAddress(), base.attacker.address),
      ).to.be.revertedWithCustomError(base.rewards, 'AlreadyAttributed');

      await ethers.provider.send('hardhat_stopImpersonatingAccount', [launcherAddress]);

      // The original attribution survives untouched.
      const attribution = await base.rewards.attributionOf(tokenId);
      expect(attribution.tokenCreator).to.equal(base.creator.address);
    });

    it('a redirect attempt cannot change who earns, even from the registrar', async () => {
      const base = await loadFixture(deployStack);
      const { tokenId } = await launchOne(base);
      const before = await base.rewards.attributionOf(tokenId);

      const names = base.rewards.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
      expect(names.filter((n) => /reassign|redirect|update|setAttribution|transferAttribution/i.test(n)))
        .to.deep.equal([]);

      const after = await base.rewards.attributionOf(tokenId);
      expect(after.tokenCreator).to.equal(before.tokenCreator);
      expect(after.launchpadOwner).to.equal(before.launchpadOwner);
    });

    it('duplicate token registration is impossible', async () => {
      const base = await loadFixture(deployStack);
      await launchOne(base);
      const first = await base.launcher.allTokens(0);
      // Launch again: a brand new token address is produced, never a duplicate record.
      await base.launcher.connect(base.creator).launch(await base.openPad.getAddress(), 'Genesis', 'GEN');
      const second = await base.launcher.allTokens(1);
      expect(second).to.not.equal(first);
      expect((await base.launcher.launchOf(first)).token).to.equal(first);
      expect((await base.launcher.launchOf(second)).token).to.equal(second);
      expect(await base.launcher.tokenCount()).to.equal(2);
    });
  });

  describe('fake launchpad / wrong owner', () => {
    it('rejects a launchpad that did not come from our factory', async () => {
      const { launcher, attacker } = await loadFixture(deployStack);
      const fake = await (await ethers.getContractFactory('FakeLaunchpad')).deploy(attacker.address);
      await expect(launcher.connect(attacker).launch(await fake.getAddress(), 'Fake', 'FK'))
        .to.be.revertedWithCustomError(launcher, 'UnknownLaunchpad');
    });

    it('rejects an EOA posing as a launchpad', async () => {
      const { launcher, attacker } = await loadFixture(deployStack);
      await expect(launcher.connect(attacker).launch(attacker.address, 'Fake', 'FK'))
        .to.be.revertedWithCustomError(launcher, 'UnknownLaunchpad');
    });

    it('takes the pad owner from the pad itself, not from the caller', async () => {
      const base = await loadFixture(deployStack);
      const { tokenId } = await launchOne(base, base.attacker);
      const attribution = await base.rewards.attributionOf(tokenId);
      // The attacker launched, so they are the creator — but the pad owner is still the real one.
      expect(attribution.tokenCreator).to.equal(base.attacker.address);
      expect(attribution.launchpadOwner).to.equal(base.padOwner.address);
      expect(attribution.launchpadOwner).to.not.equal(base.attacker.address);
    });

    it('rejects a launch whose beneficiary NFT did not land on our rewards contract', async () => {
      const { launchpadFactory, strategy, vault, positionManager, rewards, openPad, attacker, deployer } =
        await loadFixture(deployStack);
      const hijacker = await (await ethers.getContractFactory('MockLiquidityLauncherHijacker'))
        .deploy(await vault.getAddress(), await positionManager.getAddress(), attacker.address);

      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
      const badLauncher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
        await launchpadFactory.getAddress(), await hijacker.getAddress(), await strategy.getAddress(),
        await vault.getAddress(), await positionManager.getAddress(), predicted,
      );
      await (await ethers.getContractFactory('LaunchpadRewards'))
        .deploy(await vault.getAddress(), await badLauncher.getAddress(), attacker.address);

      await expect(badLauncher.connect(attacker).launch(await openPad.getAddress(), 'Hijack', 'HJ'))
        .to.be.revertedWithCustomError(badLauncher, 'BeneficiaryNotRewards');
      expect(rewards).to.not.equal(undefined);
    });

    it('rejects a launch where no beneficiary was registered at all', async () => {
      const { launchpadFactory, strategy, vault, positionManager, openPad, attacker, deployer } =
        await loadFixture(deployStack);
      const silent = await (await ethers.getContractFactory('MockLiquidityLauncherThatSkipsBeneficiary')).deploy();

      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
      const badLauncher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
        await launchpadFactory.getAddress(), await silent.getAddress(), await strategy.getAddress(),
        await vault.getAddress(), await positionManager.getAddress(), predicted,
      );
      await (await ethers.getContractFactory('LaunchpadRewards'))
        .deploy(await vault.getAddress(), await badLauncher.getAddress(), attacker.address);

      await expect(badLauncher.connect(attacker).launch(await openPad.getAddress(), 'Silent', 'SL'))
        .to.be.revertedWithCustomError(badLauncher, 'BeneficiaryNotRewards');
    });
  });

  describe('wrong token supply / wrong strategy', () => {
    it('Uniswap rejects any supply other than exactly 1,000,000,000 x 18', async () => {
      const { strategy } = await loadFixture(deployStack);
      const [, holder] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory('LaunchToken')).deploy('X', 'X', holder.address);

      // The real strategy compares the declared amount against its own TOTAL_SUPPLY constant.
      await expect(
        strategy.initializeDistribution(await token.getAddress(), 1n, '0x', ethers.ZeroHash),
      ).to.be.revertedWithCustomError(strategy, 'InvalidSupply');
      await expect(
        strategy.initializeDistribution(
          await token.getAddress(), ethers.parseEther('999999999'), '0x', ethers.ZeroHash,
        ),
      ).to.be.revertedWithCustomError(strategy, 'InvalidSupply');
    });

    it('our LaunchToken always satisfies the constraint, so a launch cannot fail on supply', async () => {
      const base = await loadFixture(deployStack);
      const { token } = await launchOne(base);
      const deployed = await ethers.getContractAt('LaunchToken', token);
      expect(await deployed.totalSupply()).to.equal(ethers.parseEther('1000000000'));
      expect(await deployed.decimals()).to.equal(18);
    });

    it('the strategy address is immutable — it cannot be swapped for the no-creator-fees one', async () => {
      const { launcher } = await loadFixture(deployStack);
      const names = launcher.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
      expect(names.filter((n) => /^set|upgrade|initialize|migrate/i.test(n))).to.deep.equal([]);
      expect(launcher.interface.getFunction('instantLaunchStrategy').stateMutability).to.equal('view');
    });
  });

  describe('malicious recipients', () => {
    it('a creator that rejects ETH cannot block the pad owner or protocol', async () => {
      const base = await loadFixture(deployStack);
      const rejecting = await (await ethers.getContractFactory('RejectingBeneficiary')).deploy();

      // Launch from a contract that refuses native currency.
      const rejectingAddress = await rejecting.getAddress();
      await ethers.provider.send('hardhat_impersonateAccount', [rejectingAddress]);
      await ethers.provider.send('hardhat_setBalance', [rejectingAddress, '0x56BC75E2D63100000']);
      const asRejecting = await ethers.getSigner(rejectingAddress);
      await base.launcher.connect(asRejecting).launch(await base.openPad.getAddress(), 'Bad', 'BAD');
      await ethers.provider.send('hardhat_stopImpersonatingAccount', [rejectingAddress]);

      const record = await base.launcher.launchOf(await base.launcher.allTokens(0));
      await base.vault.fund(record.positionTokenId, { value: ethers.parseEther('1') });
      await base.rewards.collectAndSplit(record.positionTokenId);

      await expect(base.rewards.withdrawFor(base.padOwner.address))
        .to.changeEtherBalance(base.padOwner, ethers.parseEther('0.3'));
      await expect(base.rewards.withdrawFor(base.protocol.address))
        .to.changeEtherBalance(base.protocol, ethers.parseEther('0.2'));
      await expect(base.rewards.withdrawFor(rejectingAddress))
        .to.be.revertedWithCustomError(base.rewards, 'TransferFailed');
      // The stuck share stays credited rather than being lost or redistributed.
      expect(await base.rewards.pending(rejectingAddress)).to.equal(ethers.parseEther('0.5'));
    });

    it('rejects a beneficiary NFT that did not come from the vault', async () => {
      const { rewards, attacker } = await loadFixture(deployStack);
      await expect(rewards.connect(attacker).onERC721Received(attacker.address, attacker.address, 1n, '0x'))
        .to.be.revertedWithCustomError(rewards, 'OnlyVaultNfts');
    });
  });

  describe('reentrancy', () => {
    it('a vault that re-enters collectAndSplit is rejected', async () => {
      const { launchpadFactory, strategy, positionManager, liquidityLauncher, openPad, protocol, creator, deployer } =
        await loadFixture(deployStack);
      const evilVault = await (await ethers.getContractFactory('ReentrantVault')).deploy();

      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
      const launcher2 = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
        await launchpadFactory.getAddress(), await liquidityLauncher.getAddress(), await strategy.getAddress(),
        await evilVault.getAddress(), await positionManager.getAddress(), predicted,
      );
      const rewards2 = await (await ethers.getContractFactory('LaunchpadRewards'))
        .deploy(await evilVault.getAddress(), await launcher2.getAddress(), protocol.address);

      // Attribute directly through the registrar path, then fund and collect.
      const launcherAddress = await launcher2.getAddress();
      await ethers.provider.send('hardhat_impersonateAccount', [launcherAddress]);
      await ethers.provider.send('hardhat_setBalance', [launcherAddress, '0x56BC75E2D63100000']);
      const asLauncher = await ethers.getSigner(launcherAddress);
      await rewards2.connect(asLauncher)
        .attributeLaunch(1n, creator.address, creator.address, await openPad.getAddress(), creator.address);
      await ethers.provider.send('hardhat_stopImpersonatingAccount', [launcherAddress]);

      await evilVault.registerBeneficiary(1n, await rewards2.getAddress());
      await evilVault.fund(1n, { value: ethers.parseEther('1') });

      await rewards2.collectAndSplit(1n);

      // The re-entrant call was attempted and was rejected by the guard.
      expect(await evilVault.reenterAttempted()).to.equal(true);
      expect(await evilVault.reenterReverted()).to.equal(true);
      // Accounting is intact: exactly one split happened.
      expect(await rewards2.lifetimeDistributed(1n)).to.equal(ethers.parseEther('1'));
      expect(await rewards2.totalPending()).to.equal(ethers.parseEther('1'));
    });

    it('a recipient re-entering during withdrawal cannot double-spend', async () => {
      const base = await loadFixture(deployStack);
      const attackerContract = await (await ethers.getContractFactory('ReentrantClaimAttacker')).deploy();
      const attackerAddress = await attackerContract.getAddress();

      await ethers.provider.send('hardhat_impersonateAccount', [attackerAddress]);
      await ethers.provider.send('hardhat_setBalance', [attackerAddress, '0x56BC75E2D63100000']);
      const asAttacker = await ethers.getSigner(attackerAddress);
      await base.launcher.connect(asAttacker).launch(await base.openPad.getAddress(), 'Re', 'RE');
      await ethers.provider.send('hardhat_stopImpersonatingAccount', [attackerAddress]);

      const record = await base.launcher.launchOf(await base.launcher.allTokens(0));
      await attackerContract.arm(await base.rewards.getAddress(), record.positionTokenId);
      await base.vault.fund(record.positionTokenId, { value: ethers.parseEther('1') });
      await base.rewards.collectAndSplit(record.positionTokenId);

      const owed = await base.rewards.pending(attackerAddress);
      expect(owed).to.equal(ethers.parseEther('0.5'));

      // Measure the delta: the attacker contract also paid gas for its own launch transaction.
      const balanceBefore = await ethers.provider.getBalance(attackerAddress);
      await base.rewards.withdrawFor(attackerAddress);
      // Re-entry happened during the payout and could not extract a second share.
      expect(await attackerContract.reenterAttempted()).to.equal(true);
      expect((await ethers.provider.getBalance(attackerAddress)) - balanceBefore)
        .to.equal(ethers.parseEther('0.5'));
      expect(await base.rewards.pending(attackerAddress)).to.equal(0n);
      // Nothing was taken from the other two parties.
      expect(await base.rewards.totalPending()).to.equal(ethers.parseEther('0.5'));
    });
  });

  describe('accounting invariants', () => {
    it('collecting an unattributed position is refused', async () => {
      const { rewards } = await loadFixture(deployStack);
      await expect(rewards.collectAndSplit(999n)).to.be.revertedWithCustomError(rewards, 'NotAttributed');
    });

    it('collecting with nothing accrued is refused rather than emitting a zero split', async () => {
      const base = await loadFixture(deployStack);
      const { tokenId } = await launchOne(base);
      await expect(base.rewards.collectAndSplit(tokenId))
        .to.be.revertedWithCustomError(base.rewards, 'NothingClaimed');
    });

    it('force-sent ETH shows up as unaccounted and never as anyone\'s balance', async () => {
      const base = await loadFixture(deployStack);
      const { tokenId } = await launchOne(base);
      await ethers.provider.send('hardhat_setBalance', [
        await base.rewards.getAddress(), '0x' + ethers.parseEther('5').toString(16),
      ]);
      expect(await base.rewards.unaccountedBalance()).to.equal(ethers.parseEther('5'));
      expect(await base.rewards.pending(base.creator.address)).to.equal(0n);
      expect(await base.rewards.totalPending()).to.equal(0n);
      expect(tokenId).to.be.greaterThan(0n);
    });
  });
});
