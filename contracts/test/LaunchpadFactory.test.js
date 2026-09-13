const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { PRESET, POLICY, deployFactory, createPad } = require('./helpers');

describe('LaunchpadFactory', () => {
  it('rejects a zero protocol treasury', async () => {
    const Factory = await ethers.getContractFactory('LaunchpadFactory');
    await expect(Factory.deploy(ethers.ZeroAddress, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(Factory, 'ZeroAddress');
  });

  it('lets anyone create a launchpad and records it', async () => {
    const { factory, padOwner, stranger } = await loadFixture(deployFactory);

    const { pad, router } = await createPad(factory, padOwner, 'NVDA Floor', 'ipfs://meta', PRESET.NVDA);
    await createPad(factory, stranger, 'AI Arena', '', PRESET.STANDARD);

    expect(await factory.count()).to.equal(2);
    expect(await factory.isLaunchpad(await pad.getAddress())).to.equal(true);
    expect(await factory.isLaunchpad(stranger.address)).to.equal(false);
    expect(await pad.owner()).to.equal(padOwner.address);
    expect(await pad.feeRouter()).to.equal(await router.getAddress());
    expect(await factory.ownerLaunchpadCount(padOwner.address)).to.equal(1);
    expect(await factory.launchpadsOf(padOwner.address)).to.deep.equal([await pad.getAddress()]);
  });

  it('emits creation metadata for indexers', async () => {
    const { factory, padOwner, protocol, reserveReceiver } = await loadFixture(deployFactory);
    const { event, router } = await createPad(factory, padOwner, 'NVDA Floor', 'ipfs://meta', PRESET.NVDA);

    expect(event.args.owner).to.equal(padOwner.address);
    expect(event.args.name).to.equal('NVDA Floor');
    expect(event.args.metadataURI).to.equal('ipfs://meta');
    expect(event.args.preset).to.equal(BigInt(PRESET.NVDA));
    expect(await router.protocolTreasury()).to.equal(protocol.address);
    expect(await router.reserveReceiver()).to.equal(reserveReceiver.address);
  });

  it('gives every launchpad its own dedicated fee router', async () => {
    const { factory, padOwner, stranger } = await loadFixture(deployFactory);
    const a = await createPad(factory, padOwner, 'A', '', PRESET.STANDARD);
    const b = await createPad(factory, stranger, 'B', '', PRESET.STANDARD);

    expect(await a.router.getAddress()).to.not.equal(await b.router.getAddress());
    expect(await a.router.padOwner()).to.equal(padOwner.address);
    expect(await b.router.padOwner()).to.equal(stranger.address);
  });

  it('paginates launchpads without unbounded calls', async () => {
    const { factory, padOwner } = await loadFixture(deployFactory);
    for (let i = 0; i < 5; i += 1) {
      await createPad(factory, padOwner, `Pad ${i}`, '', PRESET.STANDARD);
    }
    const all = await factory.launchpadsPage(0, 100);
    expect(all).to.have.lengthOf(5);
    expect(await factory.launchpadsPage(3, 100)).to.deep.equal(all.slice(3));
    expect(await factory.launchpadsPage(1, 2)).to.deep.equal(all.slice(1, 3));
    expect(await factory.launchpadsPage(5, 10)).to.have.lengthOf(0);
    expect(await factory.launchpadsPage(99, 10)).to.have.lengthOf(0);
  });

  it('enforces launchpad metadata bounds', async () => {
    const { factory, padOwner } = await loadFixture(deployFactory);
    const pad = await ethers.getContractFactory('Launchpad');

    await expect(factory.connect(padOwner).createLaunchpad('', '', PRESET.STANDARD, POLICY.OWNER_ONLY))
      .to.be.revertedWithCustomError(pad, 'InvalidMetadata');
    await expect(factory.connect(padOwner).createLaunchpad('x'.repeat(65), '', PRESET.STANDARD, POLICY.OWNER_ONLY))
      .to.be.revertedWithCustomError(pad, 'InvalidMetadata');
    await expect(factory.connect(padOwner).createLaunchpad('ok', 'x'.repeat(257), PRESET.STANDARD, POLICY.OWNER_ONLY))
      .to.be.revertedWithCustomError(pad, 'InvalidMetadata');
    await expect(factory.connect(padOwner).createLaunchpad('x'.repeat(64), 'x'.repeat(256), PRESET.STANDARD, POLICY.OWNER_ONLY))
      .to.not.be.reverted;
  });

  describe('reserve receiver misconfiguration', () => {
    it('reports NVDA support and blocks NVDA pads when the reserve receiver is unset', async () => {
      const [, padOwner, protocol] = await ethers.getSigners();
      const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
        .deploy(protocol.address, ethers.ZeroAddress);
      const router = await ethers.getContractFactory('FeeRouter');

      expect(await factory.supportsNvdaReserve()).to.equal(false);
      await expect(factory.connect(padOwner).createLaunchpad('Nope', '', PRESET.NVDA, POLICY.OWNER_ONLY))
        .to.be.revertedWithCustomError(router, 'ZeroAddress');
      // Standard pads still work, so the factory is degraded rather than dead.
      await expect(factory.connect(padOwner).createLaunchpad('Fine', '', PRESET.STANDARD, POLICY.OWNER_ONLY))
        .to.not.be.reverted;
    });

    it('has no owner, admin, pause or upgrade entry points', async () => {
      const { factory } = await loadFixture(deployFactory);
      const names = factory.interface.fragments
        .filter((f) => f.type === 'function')
        .map((f) => f.name.toLowerCase());
      for (const forbidden of ['owner', 'transferownership', 'pause', 'upgradeto', 'setfee', 'initialize']) {
        expect(names, `factory should not expose ${forbidden}`).to.not.include(forbidden);
      }
    });
  });
});
