const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { verifyLaunch, UNISWAP } = require('../../scripts/lib/launchVerifier.cjs');

/**
 * VERIFIER REGRESSION TESTS against a real Robinhood Chain mainnet fork.
 *
 * These lock down the behaviour the live canary taught us: the pool is PUBLIC, so strangers trade
 * it, and every reconciliation must stay exact while that happens. A verifier that only balances
 * when we are the sole trader is worthless in production.
 *
 *   FORK_RPC=https://rpc.mainnet.chain.robinhood.com npm run test:verify
 */
const describeFork = process.env.FORK_RPC ? describe : describe.skip;

describeFork('FORK: deterministic launch verification', function () {
  this.timeout(1800000);

  let deployer, padOwner, creator, treasury, ourBuyer, stranger, secondStranger;
  let factory, launcher, rewards, router, pad, token, positionTokenId;
  let controlledWallets;
  // A fork starts at a real mainnet height (tens of millions of blocks), so scanning from 0 would
  // chunk-read the entire chain. Everything this test cares about happens after the fork point.
  let startBlock;

  const poolKeyFor = (t) => ({
    currency0: ethers.ZeroAddress, currency1: t, fee: 2500, tickSpacing: 25, hooks: ethers.ZeroAddress,
  });

  before(async () => {
    await network.provider.send('evm_mine');
    startBlock = await ethers.provider.getBlockNumber();
    [deployer, padOwner, creator, treasury, ourBuyer, stranger, secondStranger] = await ethers.getSigners();

    factory = await (await ethers.getContractFactory('LaunchpadFactory'))
      .deploy(treasury.address, ethers.ZeroAddress);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
      await factory.getAddress(), UNISWAP.liquidityLauncher, UNISWAP.instantLaunchStrategy,
      UNISWAP.beneficiaryVault, UNISWAP.positionManager, predicted,
    );
    rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
      .deploy(UNISWAP.beneficiaryVault, await launcher.getAddress(), treasury.address);
    router = await (await ethers.getContractFactory('V4TestSwapRouter')).deploy(UNISWAP.poolManager);

    await factory.connect(padOwner).createLaunchpad('Verify Pad', '', 0, 1);
    pad = await factory.launchpads(0);

    await launcher.connect(creator).launch(pad, 'Verify Token', 'VRFY');
    token = await launcher.allTokens(0);
    positionTokenId = (await launcher.launchOf(token)).positionTokenId;

    controlledWallets = [deployer.address, padOwner.address, creator.address,
      treasury.address, ourBuyer.address];
  });

  /** Collects the pool's LP fees into the vault, then splits them to the three parties. */
  async function collectAndSplit() {
    const splitter = new ethers.Contract(UNISWAP.feeSplitter,
      ['function collectFees(uint256[] tokenIds)'], deployer);
    await (await splitter.collectFees([positionTokenId])).wait();
    await (await rewards.connect(deployer).collectAndSplit(positionTokenId)).wait();
  }

  const run = () => verifyLaunch({
    provider: ethers.provider,
    token,
    launcher: launcher.target ?? launcher.address,
    controlledWallets,
    fromBlock: startBlock,
  });

  describe('a launch with no trading at all', () => {
    it('verifies, and reconciles the whole supply into pool + burn', async () => {
      const r = await run();
      expect(r.verification.status).to.equal('VERIFIED');
      expect(r.supplyReconciliation.exact).to.equal(true);
      expect(r.supplyReconciliation.holders).to.deep.equal([]);
      expect(BigInt(r.supplyReconciliation.lockedInPool) + BigInt(r.supplyReconciliation.burned))
        .to.equal(BigInt(r.token.totalSupply));
    });

    it('reports zero fees without claiming anything was earned', async () => {
      const r = await run();
      expect(r.feeAccounting.claimedTotalWei).to.equal('0');
      expect(r.feeAccounting.exact).to.equal(true);
      expect(r.trading.buys).to.equal(0);
    });
  });

  describe('REGRESSION: a third party trades BEFORE we verify', () => {
    // Exactly what happened on mainnet: a stranger bought five blocks after launch, and two of the
    // canary's assertions failed because they assumed we were the only trader.
    before(async () => {
      await router.connect(stranger).buyExactIn(poolKeyFor(token), ethers.parseEther('0.5'),
        { value: ethers.parseEther('0.5') });
    });

    it('still reconciles every base unit of supply', async () => {
      const r = await run();
      expect(r.supplyReconciliation.exact).to.equal(true);
      const sum = BigInt(r.supplyReconciliation.lockedInPool)
        + BigInt(r.supplyReconciliation.burned)
        + r.supplyReconciliation.holders.reduce((a, h) => a + BigInt(h.balance), 0n);
      expect(sum).to.equal(BigInt(r.token.totalSupply));
    });

    it('discovers the stranger and classifies them EXTERNAL, not as an error', async () => {
      const r = await run();
      const external = r.supplyReconciliation.holders.filter((h) => h.classification === 'external');
      expect(external).to.have.lengthOf(1);
      expect(external[0].address.toLowerCase()).to.equal(stranger.address.toLowerCase());
      expect(r.verification.status).to.equal('VERIFIED');
    });

    it('does not treat an external holder as a privileged party holding supply', async () => {
      const r = await run();
      const check = r.verification.checks.find((c) => c.id === 'supply.noPrivilegedPartyHoldsSupply');
      expect(check.passed).to.equal(true);
    });

    it('counts their ETH as volume, never as revenue', async () => {
      const r = await run();
      // Before any collection, nothing has been earned even though volume exists.
      expect(r.trading.buys).to.be.greaterThan(0);
      expect(r.feeAccounting.claimedTotalWei).to.equal('0');
    });
  });

  describe('REGRESSION: fee reconciliation with MULTIPLE buyers', () => {
    before(async () => {
      await router.connect(ourBuyer).buyExactIn(poolKeyFor(token), ethers.parseEther('1'),
        { value: ethers.parseEther('1') });
      await router.connect(secondStranger).buyExactIn(poolKeyFor(token), ethers.parseEther('0.25'),
        { value: ethers.parseEther('0.25') });
      await collectAndSplit();
    });

    it('reconciles fees generated by controlled AND external buyers together', async () => {
      const r = await run();
      expect(r.feeAccounting.exact).to.equal(true);
      const credited = BigInt(r.feeAccounting.creditedWei.creator)
        + BigInt(r.feeAccounting.creditedWei.launchpadOwner)
        + BigInt(r.feeAccounting.creditedWei.protocol);
      expect(credited).to.equal(BigInt(r.feeAccounting.claimedTotalWei));
      expect(BigInt(r.feeAccounting.claimedTotalWei)).to.be.greaterThan(0n);
    });

    it('splits external volume to the same three parties, 50 / 30 / 20', async () => {
      const r = await run();
      const total = BigInt(r.feeAccounting.claimedTotalWei);
      expect(BigInt(r.feeAccounting.creditedWei.creator)).to.equal((total * 5000n) / 10000n);
      expect(BigInt(r.feeAccounting.creditedWei.launchpadOwner)).to.equal((total * 3000n) / 10000n);
      expect(r.verification.checks.find((c) => c.id === 'fees.splitConservesEveryWei').passed)
        .to.equal(true);
    });

    it('separates controlled from external traders', async () => {
      const r = await run();
      const controlled = r.trading.traders.filter((t) => t.classification === 'controlled');
      const external = r.trading.traders.filter((t) => t.classification === 'external');
      expect(controlled.map((t) => t.address.toLowerCase())).to.include(ourBuyer.address.toLowerCase());
      expect(external.map((t) => t.address.toLowerCase()))
        .to.have.members([stranger.address.toLowerCase(), secondStranger.address.toLowerCase()]);
    });

    it('still reconciles supply across three separate buyers', async () => {
      const r = await run();
      expect(r.supplyReconciliation.exact).to.equal(true);
      expect(r.supplyReconciliation.holders.length).to.equal(3);
    });

    it('lifetimeDistributed agrees with the summed split events', async () => {
      const r = await run();
      expect(r.verification.checks.find((c) => c.id === 'fees.lifetimeMatchesEvents').passed)
        .to.equal(true);
    });
  });

  describe('REGRESSION: repeated verification after MORE trades', () => {
    // A record is a snapshot. Re-verifying later must stay exact while totals legitimately grow.
    let before1;

    before(async () => {
      before1 = await run();
      await router.connect(stranger).buyExactIn(poolKeyFor(token), ethers.parseEther('0.75'),
        { value: ethers.parseEther('0.75') });
      await collectAndSplit();
    });

    it('remains VERIFIED after additional external trading', async () => {
      const r = await run();
      expect(r.verification.status).to.equal('VERIFIED');
      expect(r.supplyReconciliation.exact).to.equal(true);
      expect(r.feeAccounting.exact).to.equal(true);
    });

    it('fees only ever grow, and the earlier snapshot is not contradicted', async () => {
      const r = await run();
      expect(BigInt(r.feeAccounting.claimedTotalWei))
        .to.be.greaterThan(BigInt(before1.feeAccounting.claimedTotalWei));
      expect(r.reconciledAtBlock).to.be.greaterThanOrEqual(before1.reconciledAtBlock);
    });

    it('credited still equals withdrawn plus pending for every party', async () => {
      const r = await run();
      for (const role of ['creator', 'launchpadOwner', 'protocol']) {
        const check = r.verification.checks
          .find((c) => c.id === `fees.${role}.creditedEqualsWithdrawnPlusPending`);
        expect(check, `missing check for ${role}`).to.not.equal(undefined);
        expect(check.passed, `${role}: ${check.detail}`).to.equal(true);
      }
    });

    it('survives withdrawals happening between verifications', async () => {
      await (await rewards.connect(creator).withdraw()).wait();
      const r = await run();
      expect(r.verification.status).to.equal('VERIFIED');
      expect(BigInt(r.feeAccounting.withdrawnWei.creator)).to.be.greaterThan(0n);
      expect(r.feeAccounting.exact).to.equal(true);
    });
  });

  describe('unverifiable state FAILS rather than being inferred', () => {
    it('a token this launcher never launched is reported as such', async () => {
      const other = await (await ethers.getContractFactory('LaunchToken'))
        .deploy('Imposter', 'IMP', deployer.address, launcher.target ?? launcher.address);
      const r = await verifyLaunch({
        provider: ethers.provider,
        token: await other.getAddress(),
        launcher: launcher.target ?? launcher.address,
        fromBlock: startBlock,
      });
      expect(r.verification.status).to.equal('FAILED');
      expect(r.verification.checks.find((c) => c.id === 'launch.recordedByLauncher').passed)
        .to.equal(false);
    });

    it('an address with no code as the launcher fails instead of throwing', async () => {
      const r = await verifyLaunch({
        provider: ethers.provider, token, launcher: stranger.address, fromBlock: startBlock,
      });
      expect(r.verification.status).to.equal('FAILED');
      expect(r.verification.checks.find((c) => c.id === 'launcher.hasCode').passed).to.equal(false);
    });

    it('refuses a malformed address outright', async () => {
      await expect(verifyLaunch({
        provider: ethers.provider, token: 'not-an-address', launcher: launcher.target,
      })).to.be.rejectedWith(/not an address/);
    });
  });
});
