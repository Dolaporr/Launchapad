const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

/**
 * The product data model for one launch.
 *
 * The single most important property tested here: SWAPPED ETH IS NEVER PRESENTED AS REVENUE.
 * A buyer's ETH bought tokens. It was never ours. Only fee capture is income, and the model must
 * make that impossible to misread — including for someone who only skims the summary line.
 */
describe('launch state (product model)', () => {
  let buildLaunchState; let summariseLaunch; let formatEth; let TRADER_CLASS_LABEL;
  let baseline;

  before(async () => {
    const mod = await import(
      `file://${path.join(__dirname, '..', '..', '..', 'web', 'launchState.js')}`
    );
    ({ buildLaunchState, summariseLaunch, formatEth, TRADER_CLASS_LABEL } = mod);
    baseline = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'baseline', 'canary-2026-09-13.json'), 'utf8',
    ));
  });

  describe('built from the real mainnet baseline', () => {
    let s;
    before(() => { s = buildLaunchState(baseline); });

    it('reports the token', () => {
      expect(s.token.symbol).to.equal('CANARY');
      expect(s.token.address).to.equal('0xe848A44Bb9ab5Fc9788e2E6D64b5CbBDd114d7F4');
      expect(s.token.totalSupplyFormatted).to.equal('1,000,000,000');
    });

    it('reports the pool as a real hookless 25 bps ETH pair', () => {
      expect(s.pool.positionTokenId).to.equal('2635400');
      expect(s.pool.feeBps).to.equal(25);
      expect(s.pool.pairedWith).to.equal('ETH');
      expect(s.pool.hookless).to.equal(true);
    });

    it('asserts liquidity is locked only from the check that proves it', () => {
      expect(s.liquidity.locked).to.equal(true);
      expect(s.liquidity.positionOwner).to.equal('0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf');
      expect(s.liquidity.reconciles).to.equal(true);
      expect(s.liquidity.lockedPercentOfSupply).to.be.greaterThan(99.9);
      expect(s.liquidity.explanation).to.match(/no withdraw, burn or decrease/i);
    });

    it('separates the three revenue recipients with their own figures', () => {
      expect(s.split.map((r) => r.key)).to.deep.equal(['creator', 'launchpadOwner', 'protocol']);
      const [creator, padOwner, protocol] = s.split;
      expect(creator.sharePercent).to.equal(50);
      expect(padOwner.sharePercent).to.equal(30);
      expect(protocol.sharePercent).to.equal(20);
      expect(creator.address).to.equal('0x2C4AcE643cb9C6a76d9b9FBDe9C38D9732456811');
      expect(padOwner.address).to.equal('0x23fA4a22CE185fb15911ABe7C274a33C05af2b0b');
      expect(protocol.address).to.equal('0x82Eb14F2FC326DD2E6e16E8A77b56bf45537f1Ef');
    });

    it('shows credited, withdrawn and claimable separately, and they balance', () => {
      for (const row of s.split) {
        expect(row.balances, `${row.key} does not balance`).to.equal(true);
        expect(row.creditedWei).to.equal(row.withdrawnWei + row.claimableWei);
      }
      expect(s.totals.creditedWei).to.equal(BigInt(baseline.feeAccounting.claimedTotalWei));
    });

    it('reports verification and reconciliation status', () => {
      expect(s.verification.verified).to.equal(true);
      expect(s.verification.reconciled).to.equal(true);
      expect(s.verification.failed).to.deep.equal([]);
    });
  });

  describe('swapped ETH is never revenue', () => {
    let s;
    before(() => { s = buildLaunchState(baseline); });

    it('keeps trading activity and fee capture in separate structures', () => {
      expect(s.trading).to.not.have.property('revenue');
      expect(s.trading).to.not.have.property('earnings');
      expect(s.fees).to.not.have.property('volume');
    });

    it('captured revenue is the fee stream, orders of magnitude below the ETH swapped', () => {
      // 0.001 ETH was swapped; ~0.000001 ETH was captured. If the model ever conflated them
      // this ratio would collapse.
      const captured = s.fees.capturedWei;
      const swapped = 1000000000000000n; // the proving buy
      expect(captured).to.be.lessThan(swapped / 100n);
      expect(captured).to.equal(1001999548000n);
    });

    it('carries an explicit caveat that buyer ETH is not revenue', () => {
      expect(s.trading.volumeCaveat).to.match(/NOT revenue/);
      expect(s.trading.volumeCaveat).to.match(/exchanged for tokens/i);
    });

    it('never derives revenue from token amounts bought', () => {
      // Tokens bought is activity. It must not appear anywhere in the split figures.
      const splitValues = s.split.flatMap((r) => [r.creditedWei, r.withdrawnWei, r.claimableWei]);
      expect(splitValues).to.not.include(s.trading.tokensBoughtTotal);
    });

    it('the one-line summary leads with fee capture, not volume', () => {
      const line = summariseLaunch(s);
      expect(line).to.match(/captured in fees/);
      expect(line.indexOf('captured')).to.be.lessThan(line.indexOf('buy('));
    });
  });

  describe('external versus controlled trading is shown separately', () => {
    let s;
    before(() => { s = buildLaunchState(baseline); });

    it('identifies the third-party trader from the real launch', () => {
      expect(s.trading.externalTraderCount).to.equal(1);
      expect(s.trading.controlledTraderCount).to.equal(1);
      const external = s.trading.traders.find((t) => t.classification === 'external');
      expect(external.address).to.equal('0x2be87aD70Cf11EA294d7c42044b5b8277A3E4874');
    });

    it('splits tokens bought by class', () => {
      expect(s.trading.tokensBoughtExternal + s.trading.tokensBoughtControlled)
        .to.equal(s.trading.tokensBoughtTotal);
      expect(s.trading.tokensBoughtExternal).to.equal(795456757487108587460n);
    });

    it('labels third-party activity as permissionless, not as user validation', () => {
      expect(TRADER_CLASS_LABEL.external).to.match(/permissionless/i);
      expect(s.trading.externalCaveat).to.match(/not\s+evidence of organic demand/i);
      expect(s.trading.externalCaveat).to.match(/permissionless/i);
    });
  });

  describe('unknown state renders as unknown, never as zero', () => {
    it('a record with no fee accounting yields null fees rather than zeroes', () => {
      const stripped = { ...baseline };
      delete stripped.feeAccounting;
      const s = buildLaunchState(stripped);
      expect(s.fees).to.equal(null);
      expect(s.split).to.equal(null);
      expect(s.totals).to.equal(null);
    });

    it('an unproven liquidity lock is null, not false-negative "unlocked"', () => {
      const stripped = JSON.parse(JSON.stringify(baseline));
      stripped.verification.checks = stripped.verification.checks
        .filter((c) => c.id !== 'liquidity.permanentlyLocked');
      const s = buildLaunchState(stripped);
      expect(s.liquidity.locked).to.equal(null);
    });

    it('ETH volume stays null when it cannot be derived, rather than being estimated', () => {
      const s = buildLaunchState(baseline);
      expect(s.nativeVolumeWei).to.equal(undefined);
      expect(s.trading.nativeVolumeWei).to.equal(null);
    });

    it('a failed verification surfaces the failures instead of rendering a clean page', () => {
      const broken = JSON.parse(JSON.stringify(baseline));
      broken.verification.status = 'FAILED';
      broken.verification.checks.push({ id: 'supply.reconcilesExactly', passed: false, detail: 'short by 5' });
      const s = buildLaunchState(broken);
      expect(s.verification.verified).to.equal(false);
      expect(s.verification.failed).to.have.lengthOf(1);
      expect(summariseLaunch(s)).to.match(/NOT VERIFIED/);
    });

    it('rejects a non-record outright', () => {
      expect(() => buildLaunchState(null)).to.throw(/requires a verification record/);
      expect(() => buildLaunchState('nope')).to.throw(/requires a verification record/);
    });
  });

  describe('formatting keeps sub-microether fee capture legible', () => {
    it('does not round tiny fee amounts to zero', () => {
      // Truncates rather than rounds: a revenue figure must never be displayed as larger than it
      // is. 1001999548000 wei is 0.000001001999548 ETH, shown to 9 places as 0.000001001.
      expect(formatEth(1001999548000n)).to.equal('0.000001001');
      expect(formatEth(1n, 18)).to.equal('0.000000000000000001');
    });

    it('truncates rather than rounds, so revenue is never overstated', () => {
      // 0.0000000019 ETH must not display as 0.000000002.
      expect(formatEth(1900000000n, 9)).to.equal('0.000000001');
    });

    it('groups large token amounts', () => {
      expect(formatEth(1000000000000000000000n, 0)).to.equal('1,000');
    });

    it('never uses floating point for wei', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'web', 'launchState.js'), 'utf8',
      );
      expect(src).to.not.match(/parseFloat|Number\(\s*big/);
    });
  });
});
