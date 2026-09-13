const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

const POLICY = { OPEN: 1 };
const PRESET = { STANDARD: 0 };

/**
 * MILESTONE 2.5 — resolving the direct-launch ambiguity.
 *
 * Two very different things used to look identical on chain:
 *   A) `Launchpad.launchToken`      -> a bare ERC-20, 100% supply in one wallet, NO market.
 *   B) `LaunchpadFamilyLauncher`    -> a real Uniswap pool with permanently locked liquidity.
 *
 * They must never be presentable as the same thing. The distinction is a TWO-WAY BINDING:
 *   1. the token names its launcher (`marketLauncher`), and
 *   2. the launcher's own record names that token (`launchOf`).
 * Either half alone is forgeable; together they are not, because only a real launch writes (2),
 * and only after the pool exists and the beneficiary NFT is confirmed.
 */
async function deployStack() {
  const [deployer, padOwner, creator, protocol, attacker] = await ethers.getSigners();

  const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
    .deploy(protocol.address, attacker.address);
  const vault = await (await ethers.getContractFactory('MockUniswapBeneficiaryVault')).deploy();
  const positionManager = await (await ethers.getContractFactory('MockPositionManager')).deploy();
  const strategy = await (await ethers.getContractFactory('MockInstantLaunchStrategy'))
    .deploy(await vault.getAddress(), await positionManager.getAddress());
  const liquidityLauncher = await (await ethers.getContractFactory('MockLiquidityLauncher')).deploy();

  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
  const launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
    await factory.getAddress(), await liquidityLauncher.getAddress(), await strategy.getAddress(),
    await vault.getAddress(), await positionManager.getAddress(), predicted,
  );
  const rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
    .deploy(await vault.getAddress(), await launcher.getAddress(), protocol.address);

  await factory.connect(padOwner).createLaunchpad('Pad', '', PRESET.STANDARD, POLICY.OPEN);
  const pad = await ethers.getContractAt('Launchpad', await factory.launchpads(0));

  return { deployer, padOwner, creator, protocol, attacker, factory, launcher, rewards, pad, vault };
}

describe('Milestone 2.5 — market launch vs token-only deployment', () => {
  describe('a real market launch', () => {
    it('is verifiable in both directions', async () => {
      const { launcher, pad, creator } = await loadFixture(deployStack);
      await launcher.connect(creator).launch(await pad.getAddress(), 'Real', 'REAL');
      const token = await launcher.allTokens(0);
      const erc20 = await ethers.getContractAt('LaunchToken', token);

      // Direction 1: the token names the launcher.
      expect(await erc20.marketLauncher()).to.equal(await launcher.getAddress());
      expect(await erc20.isMarketLaunch()).to.equal(true);
      // Direction 2: the launcher's record names the token, with a real position id.
      const record = await launcher.launchOf(token);
      expect(record.token).to.equal(token);
      expect(record.positionTokenId).to.be.greaterThan(0n);
      // The canonical check passes.
      expect(await launcher.verifyMarketLaunch(token)).to.equal(true);
    });

    it('exposes attribution only for a verified launch', async () => {
      const { launcher, pad, creator, padOwner } = await loadFixture(deployStack);
      await launcher.connect(creator).launch(await pad.getAddress(), 'Real', 'REAL');
      const token = await launcher.allTokens(0);

      const [verified, tokenCreator, launchpadOwner, launchpad, positionTokenId] =
        await launcher.verifiedLaunchOf(token);
      expect(verified).to.equal(true);
      expect(tokenCreator).to.equal(creator.address);
      expect(launchpadOwner).to.equal(padOwner.address);
      expect(launchpad).to.equal(await pad.getAddress());
      expect(positionTokenId).to.be.greaterThan(0n);
    });
  });

  describe('a token-only deployment', () => {
    it('self-reports that it has no market', async () => {
      const { pad, creator } = await loadFixture(deployStack);
      await pad.connect(creator).launchToken('Bare', 'BARE');
      const erc20 = await ethers.getContractAt('LaunchToken', await pad.tokens(0));

      expect(await erc20.marketLauncher()).to.equal(ethers.ZeroAddress);
      expect(await erc20.isMarketLaunch()).to.equal(false);
    });

    it('FAILS the canonical verification', async () => {
      const { launcher, pad, creator } = await loadFixture(deployStack);
      await pad.connect(creator).launchToken('Bare', 'BARE');
      const token = await pad.tokens(0);

      expect(await launcher.verifyMarketLaunch(token)).to.equal(false);
      const [verified, , , , positionTokenId] = await launcher.verifiedLaunchOf(token);
      expect(verified).to.equal(false);
      expect(positionTokenId).to.equal(0n);
    });

    it('is visibly different from a market launch on every signal', async () => {
      const { launcher, pad, creator } = await loadFixture(deployStack);
      await pad.connect(creator).launchToken('Bare', 'BARE');
      await launcher.connect(creator).launch(await pad.getAddress(), 'Real', 'REAL');

      const bare = await ethers.getContractAt('LaunchToken', await pad.tokens(0));
      const real = await ethers.getContractAt('LaunchToken', await launcher.allTokens(0));

      // Supply location is the economic difference: bare tokens sit in a wallet, market tokens
      // are in the pool.
      expect(await bare.balanceOf(creator.address)).to.equal(ethers.parseEther('1000000000'));
      expect(await real.balanceOf(creator.address)).to.equal(0n);

      expect(await bare.isMarketLaunch()).to.equal(false);
      expect(await real.isMarketLaunch()).to.equal(true);
      expect(await launcher.verifyMarketLaunch(await bare.getAddress())).to.equal(false);
      expect(await launcher.verifyMarketLaunch(await real.getAddress())).to.equal(true);
    });
  });

  describe('forgery attempts', () => {
    it('a token that merely CLAIMS the launcher does not verify', async () => {
      const { launcher, attacker } = await loadFixture(deployStack);
      // Anyone can deploy an ERC-20 naming our launcher. That is direction 1 only.
      const fake = await (await ethers.getContractFactory('LaunchToken'))
        .deploy('Fake', 'FAKE', attacker.address, await launcher.getAddress());

      expect(await fake.marketLauncher()).to.equal(await launcher.getAddress());
      expect(await fake.isMarketLaunch()).to.equal(true); // the token's own CLAIM
      // But the launcher never recorded it, so the binding is one-sided and verification fails.
      expect(await launcher.verifyMarketLaunch(await fake.getAddress())).to.equal(false);
    });

    it('an arbitrary contract that is not a token does not verify', async () => {
      const { launcher, pad } = await loadFixture(deployStack);
      expect(await launcher.verifyMarketLaunch(await pad.getAddress())).to.equal(false);
      expect(await launcher.verifyMarketLaunch(await launcher.getAddress())).to.equal(false);
    });

    it('an EOA and the zero address do not verify', async () => {
      const { launcher, attacker } = await loadFixture(deployStack);
      expect(await launcher.verifyMarketLaunch(attacker.address)).to.equal(false);
      expect(await launcher.verifyMarketLaunch(ethers.ZeroAddress)).to.equal(false);
    });

    it('a token launched through a DIFFERENT launcher does not verify against ours', async () => {
      const base = await loadFixture(deployStack);
      const { factory, launcher, pad, attacker, deployer, vault } = base;
      const positionManager = await (await ethers.getContractFactory('MockPositionManager')).deploy();
      const strategy = await (await ethers.getContractFactory('MockInstantLaunchStrategy'))
        .deploy(await vault.getAddress(), await positionManager.getAddress());
      const ll = await (await ethers.getContractFactory('MockLiquidityLauncher')).deploy();

      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
      const other = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
        await factory.getAddress(), await ll.getAddress(), await strategy.getAddress(),
        await vault.getAddress(), await positionManager.getAddress(), predicted,
      );
      await (await ethers.getContractFactory('LaunchpadRewards'))
        .deploy(await vault.getAddress(), await other.getAddress(), attacker.address);

      await other.connect(attacker).launch(await pad.getAddress(), 'Other', 'OTH');
      const token = await other.allTokens(0);

      // Verifies against its own launcher...
      expect(await other.verifyMarketLaunch(token)).to.equal(true);
      // ...but not against ours. Each launcher vouches only for its own launches.
      expect(await launcher.verifyMarketLaunch(token)).to.equal(false);
    });
  });

  describe('the launcher remains the canonical production path', () => {
    it('adds no admin control to make the distinction', async () => {
      const { launcher } = await loadFixture(deployStack);
      const names = launcher.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
      expect(names.filter((n) => /^set|owner|pause|allow|deny|block|verifyAs|admin/i.test(n)))
        .to.deep.equal([]);
      expect(launcher.interface.getFunction('verifyMarketLaunch').stateMutability).to.equal('view');
    });

    it('marketLauncher on the token is immutable with no setter', async () => {
      const { launcher, pad, creator } = await loadFixture(deployStack);
      await launcher.connect(creator).launch(await pad.getAddress(), 'Real', 'REAL');
      const erc20 = await ethers.getContractAt('LaunchToken', await launcher.allTokens(0));
      const names = erc20.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
      expect(names.filter((n) => /^set|update|migrate/i.test(n))).to.deep.equal([]);
      expect(erc20.interface.getFunction('marketLauncher').stateMutability).to.equal('view');
    });
  });
});
