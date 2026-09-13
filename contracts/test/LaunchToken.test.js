const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

/** The one supply a LaunchToken can have. Uniswap's InstantLaunchStrategy requires exactly this. */
const SUPPLY = ethers.parseEther('1000000000'); // 1e9 x 18 decimals

describe('LaunchToken', () => {
  async function deployToken() {
    const [deployer, holder, spender, other] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory('LaunchToken'))
      .deploy('Alpha', 'ALPHA', holder.address, ethers.ZeroAddress);
    return { token, deployer, holder, spender, other };
  }

  describe('the fixed supply', () => {
    it('mints exactly 1,000,000,000 x 18 decimals to one recipient', async () => {
      const { token, holder, deployer } = await loadFixture(deployToken);
      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await token.TOTAL_SUPPLY()).to.equal(SUPPLY);
      expect(await token.balanceOf(holder.address)).to.equal(SUPPLY);
      expect(await token.decimals()).to.equal(18);
      expect(await token.launchpad()).to.equal(deployer.address);
    });

    it('matches what Uniswap InstantLaunchStrategy demands', async () => {
      const { token } = await loadFixture(deployToken);
      // Hard-coded from the strategy's own source: TOTAL_SUPPLY = 1_000_000_000e18, decimals 18.
      expect(await token.totalSupply()).to.equal(10n ** 9n * 10n ** 18n);
      expect(await token.decimals()).to.equal(18);
    });

    it('takes no supply argument at all, so it cannot be launched with the wrong one', async () => {
      const Token = await ethers.getContractFactory('LaunchToken');
      const ctor = Token.interface.deploy;
      expect(ctor.inputs.map((i) => i.type)).to.deep.equal(['string', 'string', 'address', 'address']);
      expect(ctor.inputs.map((i) => i.name)).to.not.include('supply_');
    });

    it('a token-only deployment reports no market launcher', async () => {
      const { token } = await loadFixture(deployToken);
      expect(await token.marketLauncher()).to.equal(ethers.ZeroAddress);
      expect(await token.isMarketLaunch()).to.equal(false);
    });

    it('exposes totalSupply as an immutable with no setter', async () => {
      const { token } = await loadFixture(deployToken);
      const names = token.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
      expect(names.filter((n) => /^set|mint|burn|rebase/i.test(n))).to.deep.equal([]);
    });
  });

  it('rejects a zero recipient', async () => {
    const Token = await ethers.getContractFactory('LaunchToken');
    await expect(Token.deploy('A', 'A', ethers.ZeroAddress, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(Token, 'ZeroAddress');
  });

  it('has no mint, burn, owner or pause function', async () => {
    const { token } = await loadFixture(deployToken);
    const names = token.interface.fragments
      .filter((f) => f.type === 'function')
      .map((f) => f.name.toLowerCase());
    for (const forbidden of ['mint', 'burn', 'owner', 'pause', 'blacklist', 'settaxrate', 'upgradeto']) {
      expect(names, `token should not expose ${forbidden}`).to.not.include(forbidden);
    }
  });

  it('transfers and conserves total supply', async () => {
    const { token, holder, other } = await loadFixture(deployToken);
    const amount = ethers.parseEther('250');
    await expect(token.connect(holder).transfer(other.address, amount))
      .to.emit(token, 'Transfer')
      .withArgs(holder.address, other.address, amount);

    expect(await token.balanceOf(holder.address)).to.equal(SUPPLY - amount);
    expect(await token.balanceOf(other.address)).to.equal(amount);
    expect(await token.totalSupply()).to.equal(SUPPLY);
  });

  it('rejects transfers above balance and to the zero address', async () => {
    const { token, holder, other } = await loadFixture(deployToken);
    await expect(token.connect(holder).transfer(other.address, SUPPLY + 1n))
      .to.be.revertedWithCustomError(token, 'InsufficientBalance');
    await expect(token.connect(holder).transfer(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(token, 'ZeroAddress');
    await expect(token.connect(other).transfer(holder.address, 1n))
      .to.be.revertedWithCustomError(token, 'InsufficientBalance');
  });

  it('allows a zero-value transfer without corrupting balances', async () => {
    const { token, holder, other } = await loadFixture(deployToken);
    await token.connect(holder).transfer(other.address, 0n);
    expect(await token.balanceOf(holder.address)).to.equal(SUPPLY);
  });

  it('handles a self-transfer without minting value', async () => {
    const { token, holder } = await loadFixture(deployToken);
    await token.connect(holder).transfer(holder.address, ethers.parseEther('400'));
    expect(await token.balanceOf(holder.address)).to.equal(SUPPLY);
  });

  describe('allowances', () => {
    it('spends and decrements a finite allowance', async () => {
      const { token, holder, spender, other } = await loadFixture(deployToken);
      await expect(token.connect(holder).approve(spender.address, ethers.parseEther('100')))
        .to.emit(token, 'Approval')
        .withArgs(holder.address, spender.address, ethers.parseEther('100'));

      await token.connect(spender).transferFrom(holder.address, other.address, ethers.parseEther('60'));
      expect(await token.allowance(holder.address, spender.address)).to.equal(ethers.parseEther('40'));
      expect(await token.balanceOf(other.address)).to.equal(ethers.parseEther('60'));
    });

    it('rejects spending more than approved', async () => {
      const { token, holder, spender, other } = await loadFixture(deployToken);
      await token.connect(holder).approve(spender.address, ethers.parseEther('10'));
      await expect(
        token.connect(spender).transferFrom(holder.address, other.address, ethers.parseEther('11')),
      ).to.be.revertedWithCustomError(token, 'InsufficientAllowance');
    });

    it('rejects spending with no allowance at all', async () => {
      const { token, holder, spender, other } = await loadFixture(deployToken);
      await expect(token.connect(spender).transferFrom(holder.address, other.address, 1n))
        .to.be.revertedWithCustomError(token, 'InsufficientAllowance');
    });

    it('treats uint256.max as an infinite allowance and does not decrement it', async () => {
      const { token, holder, spender, other } = await loadFixture(deployToken);
      await token.connect(holder).approve(spender.address, ethers.MaxUint256);
      await token.connect(spender).transferFrom(holder.address, other.address, ethers.parseEther('500'));
      expect(await token.allowance(holder.address, spender.address)).to.equal(ethers.MaxUint256);
    });

    it('still enforces the balance check when the allowance is infinite', async () => {
      const { token, holder, spender, other } = await loadFixture(deployToken);
      await token.connect(holder).approve(spender.address, ethers.MaxUint256);
      await expect(
        token.connect(spender).transferFrom(holder.address, other.address, SUPPLY + 1n),
      ).to.be.revertedWithCustomError(token, 'InsufficientBalance');
    });
  });
});
