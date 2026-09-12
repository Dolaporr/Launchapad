const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

describe('LaunchToken', () => {
  async function deployToken() {
    const [deployer, holder, spender, other] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory('LaunchToken'))
      .deploy('Alpha', 'ALPHA', ethers.parseEther('1000'), holder.address);
    return { token, deployer, holder, spender, other };
  }

  it('mints the whole fixed supply to one recipient', async () => {
    const { token, holder, deployer } = await loadFixture(deployToken);
    expect(await token.totalSupply()).to.equal(ethers.parseEther('1000'));
    expect(await token.balanceOf(holder.address)).to.equal(ethers.parseEther('1000'));
    expect(await token.launchpad()).to.equal(deployer.address);
  });

  it('rejects a zero recipient or zero supply', async () => {
    const Token = await ethers.getContractFactory('LaunchToken');
    const [, holder] = await ethers.getSigners();
    await expect(Token.deploy('A', 'A', 1n, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(Token, 'ZeroAddress');
    await expect(Token.deploy('A', 'A', 0n, holder.address))
      .to.be.revertedWithCustomError(Token, 'ZeroSupply');
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
    await expect(token.connect(holder).transfer(other.address, ethers.parseEther('250')))
      .to.emit(token, 'Transfer')
      .withArgs(holder.address, other.address, ethers.parseEther('250'));

    expect(await token.balanceOf(holder.address)).to.equal(ethers.parseEther('750'));
    expect(await token.balanceOf(other.address)).to.equal(ethers.parseEther('250'));
    expect(await token.totalSupply()).to.equal(ethers.parseEther('1000'));
  });

  it('rejects transfers above balance and to the zero address', async () => {
    const { token, holder, other } = await loadFixture(deployToken);
    await expect(token.connect(holder).transfer(other.address, ethers.parseEther('1001')))
      .to.be.revertedWithCustomError(token, 'InsufficientBalance');
    await expect(token.connect(holder).transfer(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(token, 'ZeroAddress');
    await expect(token.connect(other).transfer(holder.address, 1n))
      .to.be.revertedWithCustomError(token, 'InsufficientBalance');
  });

  it('allows a zero-value transfer without corrupting balances', async () => {
    const { token, holder, other } = await loadFixture(deployToken);
    await token.connect(holder).transfer(other.address, 0n);
    expect(await token.balanceOf(holder.address)).to.equal(ethers.parseEther('1000'));
  });

  it('handles a self-transfer without minting value', async () => {
    const { token, holder } = await loadFixture(deployToken);
    await token.connect(holder).transfer(holder.address, ethers.parseEther('400'));
    expect(await token.balanceOf(holder.address)).to.equal(ethers.parseEther('1000'));
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
        token.connect(spender).transferFrom(holder.address, other.address, ethers.parseEther('1001')),
      ).to.be.revertedWithCustomError(token, 'InsufficientBalance');
    });
  });
});
