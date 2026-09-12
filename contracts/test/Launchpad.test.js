const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { PRESET, deployFactory, createPad } = require('./helpers');

describe('Launchpad', () => {
  async function withPad() {
    const base = await deployFactory();
    const created = await createPad(base.factory, base.padOwner, 'NVDA Floor', 'ipfs://meta', PRESET.NVDA);
    return { ...base, ...created };
  }

  it('stores immutable branding and economy', async () => {
    const { pad, padOwner, router } = await loadFixture(withPad);
    expect(await pad.owner()).to.equal(padOwner.address);
    expect(await pad.name()).to.equal('NVDA Floor');
    expect(await pad.metadataURI()).to.equal('ipfs://meta');
    expect(await pad.preset()).to.equal(BigInt(PRESET.NVDA));
    expect(await pad.feeRouter()).to.equal(await router.getAddress());
  });

  it('exposes no setter, no ownership transfer and no upgrade path', async () => {
    const { pad } = await loadFixture(withPad);
    const names = pad.interface.fragments
      .filter((f) => f.type === 'function')
      .map((f) => f.name);
    expect(names.filter((n) => /^set|^update|transferOwnership|renounce|upgrade|initialize/i.test(n)))
      .to.deep.equal([]);
  });

  describe('launchToken', () => {
    it('deploys a fixed-supply token owned entirely by the pad owner', async () => {
      const { pad, padOwner } = await loadFixture(withPad);
      const expected = ethers.parseEther('1000000');

      await expect(pad.connect(padOwner).launchToken('Alpha', 'ALPHA', 1_000_000n))
        .to.emit(pad, 'TokenLaunched');

      expect(await pad.tokenCount()).to.equal(1);
      const token = await ethers.getContractAt('LaunchToken', await pad.tokens(0));
      expect(await token.name()).to.equal('Alpha');
      expect(await token.symbol()).to.equal('ALPHA');
      expect(await token.decimals()).to.equal(18);
      expect(await token.totalSupply()).to.equal(expected);
      // 100% of supply to the creator — documented, deliberately not disguised.
      expect(await token.balanceOf(padOwner.address)).to.equal(expected);
      expect(await token.launchpad()).to.equal(await pad.getAddress());
    });

    it('is owner-only', async () => {
      const { pad, stranger } = await loadFixture(withPad);
      await expect(pad.connect(stranger).launchToken('Sneak', 'SNK', 1n))
        .to.be.revertedWithCustomError(pad, 'NotOwner');
      expect(await pad.tokenCount()).to.equal(0);
    });

    it('validates token metadata', async () => {
      const { pad, padOwner } = await loadFixture(withPad);
      await expect(pad.connect(padOwner).launchToken('', 'SYM', 1n))
        .to.be.revertedWithCustomError(pad, 'InvalidMetadata');
      await expect(pad.connect(padOwner).launchToken('Name', '', 1n))
        .to.be.revertedWithCustomError(pad, 'InvalidMetadata');
      await expect(pad.connect(padOwner).launchToken('x'.repeat(65), 'SYM', 1n))
        .to.be.revertedWithCustomError(pad, 'InvalidMetadata');
      await expect(pad.connect(padOwner).launchToken('Name', 'x'.repeat(12), 1n))
        .to.be.revertedWithCustomError(pad, 'InvalidMetadata');
    });

    it('validates supply bounds', async () => {
      const { pad, padOwner } = await loadFixture(withPad);
      await expect(pad.connect(padOwner).launchToken('Name', 'SYM', 0n))
        .to.be.revertedWithCustomError(pad, 'InvalidSupply');
      await expect(pad.connect(padOwner).launchToken('Name', 'SYM', 1_000_000_000_001n))
        .to.be.revertedWithCustomError(pad, 'InvalidSupply');
      await expect(pad.connect(padOwner).launchToken('Name', 'SYM', 1_000_000_000_000n))
        .to.not.be.reverted;
    });

    it('scales whole tokens to 18 decimals without overflow at the cap', async () => {
      const { pad, padOwner } = await loadFixture(withPad);
      await pad.connect(padOwner).launchToken('Max', 'MAX', 1_000_000_000_000n);
      const token = await ethers.getContractAt('LaunchToken', await pad.tokens(0));
      expect(await token.totalSupply()).to.equal(10n ** 30n);
    });

    it('tracks and paginates launched tokens', async () => {
      const { pad, padOwner } = await loadFixture(withPad);
      for (let i = 0; i < 4; i += 1) {
        await pad.connect(padOwner).launchToken(`Token ${i}`, `T${i}`, 1000n);
      }
      const all = await pad.tokensPage(0, 50);
      expect(all).to.have.lengthOf(4);
      expect(await pad.tokensPage(2, 50)).to.deep.equal(all.slice(2));
      expect(await pad.tokensPage(0, 2)).to.deep.equal(all.slice(0, 2));
      expect(await pad.tokensPage(4, 1)).to.have.lengthOf(0);
    });
  });

  describe('honesty boundary', () => {
    it('does not make launched tokens pay the fee router (no on-chain market exists yet)', async () => {
      const { pad, padOwner, router, stranger } = await loadFixture(withPad);
      await pad.connect(padOwner).launchToken('Alpha', 'ALPHA', 1_000_000n);
      const token = await ethers.getContractAt('LaunchToken', await pad.tokens(0));

      await token.connect(padOwner).transfer(stranger.address, ethers.parseEther('1000'));

      // A transfer moves no fee anywhere. The "mandatory 1%" has no enforcement point yet.
      expect(await router.totalRoutedGross()).to.equal(0n);
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n);
      expect(await token.balanceOf(stranger.address)).to.equal(ethers.parseEther('1000'));
    });
  });
});
