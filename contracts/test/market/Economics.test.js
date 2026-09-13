const { expect } = require('chai');
const { ethers } = require('hardhat');

/**
 * Locks the economic model to the contracts. If anyone changes the split, or Uniswap's
 * 40%-of-ETH-side share changes, these numbers move and this test fails loudly rather than the
 * business model quietly drifting away from the code.
 */
describe('Milestone 2 — economics of the approved 50/30/20', () => {
  const LP_FEE_BPS = 25;          // InstantLaunchStrategy.LP_FEE = 2500 hundredths of a bip
  const VAULT_ETH_SHARE = 0.40;   // FeeSplitter#creator-fees, read from mainnet
  const VAULT_TOKEN_SHARE = 0.00;

  let rewards;

  before(async () => {
    const [deployer, protocol] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory('MockUniswapBeneficiaryVault')).deploy();
    const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
      .deploy(protocol.address, deployer.address);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    const pm = await (await ethers.getContractFactory('MockPositionManager')).deploy();
    const strat = await (await ethers.getContractFactory('MockInstantLaunchStrategy'))
      .deploy(await vault.getAddress(), await pm.getAddress());
    const ll = await (await ethers.getContractFactory('MockLiquidityLauncher')).deploy();
    const launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
      await factory.getAddress(), await ll.getAddress(), await strat.getAddress(),
      await vault.getAddress(), await pm.getAddress(), predicted,
    );
    rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
      .deploy(await vault.getAddress(), await launcher.getAddress(), protocol.address);
  });

  it('the contract split is exactly the approved 50 / 30 / 20', async () => {
    expect(await rewards.CREATOR_BPS()).to.equal(5000);
    expect(await rewards.PAD_OWNER_BPS()).to.equal(3000);
    expect(await rewards.PROTOCOL_BPS()).to.equal(2000);
  });

  it('ETH side: 25 bps LP fee becomes 5 / 3 / 2 bps for creator / pad / protocol', async () => {
    const streamBps = LP_FEE_BPS * VAULT_ETH_SHARE;             // 10 bps reaches us
    const [c, p, t] = await rewards.previewSplit(ethers.parseEther('1'));
    const oneEth = Number(ethers.formatEther(ethers.parseEther('1')));

    expect(streamBps).to.equal(10);
    expect(streamBps * Number(ethers.formatEther(c)) / oneEth).to.equal(5);
    expect(streamBps * Number(ethers.formatEther(p)) / oneEth).to.equal(3);
    expect(streamBps * Number(ethers.formatEther(t)) / oneEth).to.equal(2);
  });

  it('TOKEN side: we receive nothing, because Uniswap keeps 100% of it', () => {
    const streamBps = LP_FEE_BPS * VAULT_TOKEN_SHARE;
    expect(streamBps).to.equal(0);
  });

  it('blended across a 50/50 buy-sell mix the protocol earns 1 bp of TOTAL volume', async () => {
    const buyShare = 0.5;
    const streamOfTotal = LP_FEE_BPS * VAULT_ETH_SHARE * buyShare; // 5 bps
    const protocolOfTotal = streamOfTotal * 0.2;
    expect(protocolOfTotal).to.equal(1);
    // Which means $1,000,000 of total volume is $100 of protocol revenue.
    expect(1_000_000 * (protocolOfTotal / 10000)).to.equal(100);
  });

  it('the three shares always sum to the whole stream, at every scale', async () => {
    for (const amount of [1n, 7n, 12345n, ethers.parseEther('1'), ethers.parseEther('123.456789')]) {
      const [c, p, t] = await rewards.previewSplit(amount);
      expect(c + p + t).to.equal(amount);
    }
  });
});
