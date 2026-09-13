const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

describe('ReserveVault', () => {
  async function deployVault() {
    const [deployer, vaultOwner, stranger, recipient] = await ethers.getSigners();
    // MockScaledUIToken stands in for a Robinhood Stock Token. It is NOT NVDA.
    const reserveToken = await (await ethers.getContractFactory('MockScaledUIToken'))
      .deploy(deployer.address, ethers.parseEther('1000'), ethers.parseEther('1.000775159164630595'));
    const vault = await (await ethers.getContractFactory('ReserveVault'))
      .deploy(vaultOwner.address, await reserveToken.getAddress());
    return { vault, reserveToken, deployer, vaultOwner, stranger, recipient };
  }

  it('rejects zero addresses at construction', async () => {
    const Vault = await ethers.getContractFactory('ReserveVault');
    const [a] = await ethers.getSigners();
    await expect(Vault.deploy(ethers.ZeroAddress, a.address))
      .to.be.revertedWithCustomError(Vault, 'ZeroAddress');
    await expect(Vault.deploy(a.address, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(Vault, 'ZeroAddress');
  });

  describe('the lock invariant', () => {
    it('reports the reserve balance it actually holds', async () => {
      const { vault, reserveToken, deployer } = await loadFixture(deployVault);
      expect(await vault.reserveBalance()).to.equal(0n);
      await reserveToken.connect(deployer).transfer(await vault.getAddress(), ethers.parseEther('42'));
      expect(await vault.reserveBalance()).to.equal(ethers.parseEther('42'));
    });

    it('refuses to let the owner sweep the reserve asset', async () => {
      const { vault, reserveToken, deployer, vaultOwner } = await loadFixture(deployVault);
      await reserveToken.connect(deployer).transfer(await vault.getAddress(), ethers.parseEther('42'));

      await expect(vault.connect(vaultOwner).sweepNonReserve(await reserveToken.getAddress(), vaultOwner.address))
        .to.be.revertedWithCustomError(vault, 'ReserveLocked');
      expect(await vault.reserveBalance()).to.equal(ethers.parseEther('42'));
    });

    it('exposes no function that can move the reserve token out', async () => {
      const { vault } = await loadFixture(deployVault);
      const names = vault.interface.fragments
        .filter((f) => f.type === 'function')
        .map((f) => f.name);
      // sweepNonReserve is the only state-changing entry point, and it reverts on the reserve.
      expect(names.filter((n) => /withdraw|redeem|transfer|migrate|upgrade|rescue|setReserve/i.test(n)))
        .to.deep.equal([]);
      expect(names).to.include('sweepNonReserve');
    });

    it('has an immutable owner and reserve token', async () => {
      const { vault, vaultOwner, reserveToken } = await loadFixture(deployVault);
      expect(await vault.owner()).to.equal(vaultOwner.address);
      expect(await vault.reserveToken()).to.equal(await reserveToken.getAddress());
      const names = vault.interface.fragments
        .filter((f) => f.type === 'function')
        .map((f) => f.name);
      expect(names.filter((n) => /^set|transferOwnership/i.test(n))).to.deep.equal([]);
    });
  });

  describe('sweepNonReserve (the one privileged capability)', () => {
    it('lets the owner recover a mistakenly sent ERC-20', async () => {
      const { vault, vaultOwner, deployer, recipient } = await loadFixture(deployVault);
      const junk = await (await ethers.getContractFactory('LaunchToken'))
        .deploy('Junk', 'JUNK', deployer.address, ethers.ZeroAddress);
      await junk.connect(deployer).transfer(await vault.getAddress(), ethers.parseEther('500'));

      await expect(vault.connect(vaultOwner).sweepNonReserve(await junk.getAddress(), recipient.address))
        .to.emit(vault, 'JunkSwept')
        .withArgs(await junk.getAddress(), recipient.address, ethers.parseEther('500'));
      expect(await junk.balanceOf(recipient.address)).to.equal(ethers.parseEther('500'));
    });

    it('is owner-only', async () => {
      const { vault, stranger, deployer } = await loadFixture(deployVault);
      const junk = await (await ethers.getContractFactory('LaunchToken'))
        .deploy('Junk', 'JUNK', deployer.address, ethers.ZeroAddress);
      await expect(vault.connect(stranger).sweepNonReserve(await junk.getAddress(), stranger.address))
        .to.be.revertedWithCustomError(vault, 'NotOwner');
    });

    it('rejects zero addresses and empty sweeps', async () => {
      const { vault, vaultOwner, deployer } = await loadFixture(deployVault);
      const junk = await (await ethers.getContractFactory('LaunchToken'))
        .deploy('Junk', 'JUNK', deployer.address, ethers.ZeroAddress);

      await expect(vault.connect(vaultOwner).sweepNonReserve(ethers.ZeroAddress, vaultOwner.address))
        .to.be.revertedWithCustomError(vault, 'ZeroAddress');
      await expect(vault.connect(vaultOwner).sweepNonReserve(await junk.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(vault, 'ZeroAddress');
      await expect(vault.connect(vaultOwner).sweepNonReserve(await junk.getAddress(), vaultOwner.address))
        .to.be.revertedWithCustomError(vault, 'NothingToSweep');
    });

    it('tolerates tokens whose transfer returns no data', async () => {
      const { vault, vaultOwner, recipient } = await loadFixture(deployVault);
      const weird = await (await ethers.getContractFactory('NoReturnValueToken'))
        .deploy(await vault.getAddress(), 1000n);
      await expect(vault.connect(vaultOwner).sweepNonReserve(await weird.getAddress(), recipient.address))
        .to.not.be.reverted;
      expect(await weird.balanceOf(recipient.address)).to.equal(1000n);
    });

    it('reverts when a token reports transfer failure instead of reverting', async () => {
      const { vault, vaultOwner, recipient } = await loadFixture(deployVault);
      const liar = await (await ethers.getContractFactory('FalseReturningToken'))
        .deploy(await vault.getAddress(), 1000n);
      await expect(vault.connect(vaultOwner).sweepNonReserve(await liar.getAddress(), recipient.address))
        .to.be.revertedWithCustomError(vault, 'TransferFailed');
    });
  });

  describe('native currency', () => {
    it('rejects native value instead of trapping it forever', async () => {
      const { vault, stranger } = await loadFixture(deployVault);
      await expect(stranger.sendTransaction({ to: await vault.getAddress(), value: 1n }))
        .to.be.revertedWithCustomError(vault, 'NativeNotAccepted');
      await expect(stranger.sendTransaction({ to: await vault.getAddress(), value: 1n, data: '0x1234' }))
        .to.be.revertedWithCustomError(vault, 'NativeNotAccepted');
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
    });
  });

  describe('ERC-8056 scaled UI accounting', () => {
    it('surfaces the reserve token UI multiplier so a frontend cannot misreport the reserve', async () => {
      const { vault, reserveToken, deployer } = await loadFixture(deployVault);
      await reserveToken.connect(deployer).transfer(await vault.getAddress(), ethers.parseEther('100'));

      const [supported, multiplier] = await vault.reserveUIMultiplier();
      expect(supported).to.equal(true);
      expect(multiplier).to.equal(ethers.parseEther('1.000775159164630595'));

      // Raw balance != displayed holding for a stock token.
      const raw = await vault.reserveBalance();
      const displayed = (raw * multiplier) / ethers.parseEther('1');
      expect(displayed).to.equal(await reserveToken.balanceOfUI(await vault.getAddress()));
      expect(displayed).to.not.equal(raw);
    });

    it('degrades gracefully for a plain ERC-20 reserve asset', async () => {
      const [, vaultOwner, holder] = await ethers.getSigners();
      const plain = await (await ethers.getContractFactory('LaunchToken'))
        .deploy('Plain', 'PLN', holder.address, ethers.ZeroAddress);
      const vault = await (await ethers.getContractFactory('ReserveVault'))
        .deploy(vaultOwner.address, await plain.getAddress());

      const [supported, multiplier] = await vault.reserveUIMultiplier();
      expect(supported).to.equal(false);
      expect(multiplier).to.equal(0n);
    });
  });
});
