const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { PRESET, POLICY, deployFactory, createPad } = require('./helpers');

/**
 * The product mismatch this fixes: a launchpad is meant to be a place OTHER people launch
 * tokens through. OwnerOnly is kept as a deliberate option, not as the only behaviour.
 */
describe('LaunchPolicy', () => {
  async function openPad() {
    const base = await deployFactory();
    const created = await createPad(base.factory, base.padOwner, 'Open Pad', '', PRESET.STANDARD, POLICY.OPEN);
    return { ...base, ...created };
  }

  async function ownerOnlyPad() {
    const base = await deployFactory();
    const created = await createPad(
      base.factory, base.padOwner, 'Closed Pad', '', PRESET.STANDARD, POLICY.OWNER_ONLY,
    );
    return { ...base, ...created };
  }

  describe('OPEN mode', () => {
    it('lets a wallet that is not the pad owner launch a token', async () => {
      const { pad, stranger, padOwner } = await loadFixture(openPad);

      expect(await pad.launchPolicy()).to.equal(BigInt(POLICY.OPEN));
      expect(await pad.canLaunch(stranger.address)).to.equal(true);
      expect(await pad.canLaunch(padOwner.address)).to.equal(true);

      await expect(pad.connect(stranger).launchToken('Stranger Coin', 'STRG', 1_000_000n))
        .to.emit(pad, 'TokenLaunched');
      expect(await pad.tokenCount()).to.equal(1);
    });

    it('gives the entire supply to the token creator, not the pad owner', async () => {
      const { pad, stranger, padOwner } = await loadFixture(openPad);
      await pad.connect(stranger).launchToken('Stranger Coin', 'STRG', 1_000_000n);

      const token = await ethers.getContractAt('LaunchToken', await pad.tokens(0));
      const supply = ethers.parseEther('1000000');

      expect(await token.totalSupply()).to.equal(supply);
      expect(await token.balanceOf(stranger.address)).to.equal(supply);
      // The pad owner gets nothing and has no claim on it.
      expect(await token.balanceOf(padOwner.address)).to.equal(0n);
    });

    it('gives the pad owner no power over a token launched by someone else', async () => {
      const { pad, stranger, padOwner } = await loadFixture(openPad);
      await pad.connect(stranger).launchToken('Stranger Coin', 'STRG', 1_000n);
      const token = await ethers.getContractAt('LaunchToken', await pad.tokens(0));

      // No seize path exists: the owner has no allowance and no admin function.
      expect(await token.allowance(stranger.address, padOwner.address)).to.equal(0n);
      await expect(
        token.connect(padOwner).transferFrom(stranger.address, padOwner.address, 1n),
      ).to.be.revertedWithCustomError(token, 'InsufficientAllowance');
    });

    it('supports many creators launching under one pad', async () => {
      const { pad, padOwner, stranger, protocol, reserveReceiver } = await loadFixture(openPad);
      const creators = [padOwner, stranger, protocol, reserveReceiver];

      for (const [i, creator] of creators.entries()) {
        await pad.connect(creator).launchToken(`Token ${i}`, `T${i}`, 1000n);
      }

      expect(await pad.tokenCount()).to.equal(4);
      for (const creator of creators) {
        expect(await pad.tokenCountOf(creator.address)).to.equal(1);
        const [tokenAddress] = await pad.tokensOf(creator.address);
        const token = await ethers.getContractAt('LaunchToken', tokenAddress);
        expect(await token.balanceOf(creator.address)).to.equal(ethers.parseEther('1000'));
      }
    });

    it('records the creator in the event so an indexer can attribute launches', async () => {
      const { pad, stranger } = await loadFixture(openPad);
      const receipt = await (await pad.connect(stranger).launchToken('S', 'S', 1n)).wait();
      const event = receipt.logs
        .map((log) => { try { return pad.interface.parseLog(log); } catch { return null; } })
        .find((parsed) => parsed && parsed.name === 'TokenLaunched');

      expect(event.args.creator).to.equal(stranger.address);
    });

    it('still enforces metadata and supply bounds for third-party creators', async () => {
      const { pad, stranger } = await loadFixture(openPad);
      await expect(pad.connect(stranger).launchToken('', 'SYM', 1n))
        .to.be.revertedWithCustomError(pad, 'InvalidMetadata');
      await expect(pad.connect(stranger).launchToken('Name', 'x'.repeat(12), 1n))
        .to.be.revertedWithCustomError(pad, 'InvalidMetadata');
      await expect(pad.connect(stranger).launchToken('Name', 'SYM', 0n))
        .to.be.revertedWithCustomError(pad, 'InvalidSupply');
      await expect(pad.connect(stranger).launchToken('Name', 'SYM', 1_000_000_000_001n))
        .to.be.revertedWithCustomError(pad, 'InvalidSupply');
    });
  });

  describe('OWNER_ONLY mode (preserved)', () => {
    it('rejects a launch from anyone but the owner', async () => {
      const { pad, stranger, padOwner } = await loadFixture(ownerOnlyPad);

      expect(await pad.launchPolicy()).to.equal(BigInt(POLICY.OWNER_ONLY));
      expect(await pad.canLaunch(stranger.address)).to.equal(false);
      expect(await pad.canLaunch(padOwner.address)).to.equal(true);

      await expect(pad.connect(stranger).launchToken('Sneak', 'SNK', 1n))
        .to.be.revertedWithCustomError(pad, 'NotOwner');
      expect(await pad.tokenCount()).to.equal(0);
    });

    it('still lets the owner launch, with supply to the owner', async () => {
      const { pad, padOwner } = await loadFixture(ownerOnlyPad);
      await pad.connect(padOwner).launchToken('Owner Coin', 'OWN', 500n);
      const token = await ethers.getContractAt('LaunchToken', await pad.tokens(0));
      expect(await token.balanceOf(padOwner.address)).to.equal(ethers.parseEther('500'));
    });
  });

  describe('immutability of the policy', () => {
    it('exposes no way to change the policy after creation', async () => {
      const { pad } = await loadFixture(openPad);
      const names = pad.interface.fragments
        .filter((f) => f.type === 'function')
        .map((f) => f.name);

      expect(names.filter((n) => /setLaunchPolicy|setPolicy|open|close|setOwner|pause/i.test(n)))
        .to.deep.equal([]);
      // launchPolicy is a Solidity immutable: getter only, no setter of any kind.
      const policyFragment = pad.interface.getFunction('launchPolicy');
      expect(policyFragment.stateMutability).to.equal('view');
      expect(policyFragment.inputs).to.have.lengthOf(0);
    });

    it('keeps each pad on the policy it was created with', async () => {
      const { factory, padOwner, stranger } = await loadFixture(deployFactory);
      const open = await createPad(factory, padOwner, 'Open', '', PRESET.STANDARD, POLICY.OPEN);
      const closed = await createPad(factory, padOwner, 'Closed', '', PRESET.STANDARD, POLICY.OWNER_ONLY);

      expect(await open.pad.launchPolicy()).to.equal(BigInt(POLICY.OPEN));
      expect(await closed.pad.launchPolicy()).to.equal(BigInt(POLICY.OWNER_ONLY));
      await expect(open.pad.connect(stranger).launchToken('A', 'A', 1n)).to.not.be.reverted;
      await expect(closed.pad.connect(stranger).launchToken('B', 'B', 1n))
        .to.be.revertedWithCustomError(closed.pad, 'NotOwner');
    });

    it('rejects an out-of-range policy value at the ABI boundary', async () => {
      const { factory, padOwner } = await loadFixture(deployFactory);
      // Solidity enums revert on an invalid value; ethers rejects it before sending.
      await expect(factory.connect(padOwner).createLaunchpad('X', '', PRESET.STANDARD, 2))
        .to.be.reverted;
    });
  });

  describe('factory plumbing', () => {
    it('emits the policy so an indexer can filter open pads', async () => {
      const { factory, padOwner } = await loadFixture(deployFactory);
      const { event } = await createPad(factory, padOwner, 'Open', '', PRESET.STANDARD, POLICY.OPEN);
      expect(event.args.launchPolicy).to.equal(BigInt(POLICY.OPEN));
    });

    it('works with either economic preset', async () => {
      const { factory, padOwner, stranger } = await loadFixture(deployFactory);
      const nvdaOpen = await createPad(factory, padOwner, 'NVDA Open', '', PRESET.NVDA, POLICY.OPEN);
      expect(await nvdaOpen.pad.preset()).to.equal(BigInt(PRESET.NVDA));
      await expect(nvdaOpen.pad.connect(stranger).launchToken('X', 'X', 1n)).to.not.be.reverted;
    });
  });
});
