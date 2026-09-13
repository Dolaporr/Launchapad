const { expect } = require('chai');
const plan = require('../../scripts/lib/canaryPlan.cjs');

/**
 * REGRESSION TESTS FOR FAILURES THAT HAPPENED ON MAINNET.
 *
 * Every case below aborted a real run of the canary and cost real ETH. They are unit tests now so
 * the next run cannot repeat them. Each `describe` names the failure it locks down.
 */
describe('canary plan — regressions from the live mainnet run', () => {
  // 0.1 gwei-ish, in the range Robinhood Chain actually runs at.
  const BASE = 100000000n;

  describe('REGRESSION: base fee rose between estimation and send', () => {
    // Live failure: "max fee per gas less than block base fee: maxFeePerGas: 117700593,
    // baseFee: 131992000". The default fee data was computed from a block that was already stale.
    it('caps above the base fee it was computed from', () => {
      expect(plan.capFor(BASE)).to.be.greaterThan(BASE);
    });

    it('survives a base fee that rises sharply before inclusion', () => {
      const cap = plan.capFor(BASE);
      // The exact live jump was ~1.12x. The cap must absorb far worse than that.
      for (const multiplier of [112n, 150n, 200n, 300n, 399n]) {
        const risen = (BASE * multiplier) / 100n;
        expect(cap, `base fee rose to ${multiplier}%`).to.be.greaterThanOrEqual(risen);
      }
    });

    it('is a ceiling, not a cost — budgeting uses the expected price instead', () => {
      expect(plan.expectedPriceFor(BASE)).to.be.lessThan(plan.capFor(BASE));
      // And the expected price still clears the current base fee.
      expect(plan.expectedPriceFor(BASE)).to.be.greaterThan(BASE);
    });

    it('reproduces the exact live numbers and would NOT have been rejected', () => {
      // The block whose base fee rejected us.
      const liveBaseFee = 131992000n;
      // What the default fee data produced.
      const rejectedCap = 117700593n;
      expect(rejectedCap).to.be.lessThan(liveBaseFee); // this is why it failed
      // What we would send now, computed from a base fee one block earlier.
      const ourCap = plan.capFor(117700593n / 2n);
      expect(ourCap).to.be.greaterThan(liveBaseFee);
    });
  });

  describe('REGRESSION: signer could not afford its own transaction under maxFeePerGas', () => {
    // Live failure: "gas required exceeds allowance (1290580)". The creator was funded at the
    // EXPECTED price, but a node computes allowance as balance / maxFeePerGas, and the cap is
    // higher — so the wallet could not pay for the launch it had just been funded for.
    const LAUNCH_GAS = 1234753n;

    it('models the node allowance calculation that rejected the launch', () => {
      const cap = plan.capFor(BASE);
      const underfunded = LAUNCH_GAS * plan.expectedPriceFor(BASE) * 2n; // the old, wrong formula
      const allowance = plan.gasAllowanceFor(underfunded, cap);
      expect(allowance).to.be.lessThan(LAUNCH_GAS * 2n);
    });

    it('funds at the CAP so the wallet can always afford its transaction', () => {
      const cap = plan.capFor(BASE);
      const funded = plan.fundingAmountFor(LAUNCH_GAS, cap);
      expect(plan.canAfford(funded, LAUNCH_GAS, cap)).to.equal(true);
      // With real headroom, not marginally.
      expect(plan.gasAllowanceFor(funded, cap)).to.be.greaterThanOrEqual(LAUNCH_GAS * 2n);
    });

    it('the old formula fails this exact check, so the regression is real', () => {
      const cap = plan.capFor(BASE);
      const oldFormula = LAUNCH_GAS * plan.expectedPriceFor(BASE) * 2n;
      const newFormula = plan.fundingAmountFor(LAUNCH_GAS, cap);
      expect(newFormula).to.be.greaterThan(oldFormula);
      expect(plan.canAfford(newFormula, LAUNCH_GAS, cap)).to.equal(true);
    });

    it('holds across a wide range of base fees', () => {
      for (const base of [1n, 1000n, BASE, BASE * 100n, 10n ** 12n]) {
        const cap = plan.capFor(base);
        const funded = plan.fundingAmountFor(LAUNCH_GAS, cap);
        expect(plan.canAfford(funded, LAUNCH_GAS, cap), `base ${base}`).to.equal(true);
      }
    });

    it('refuses a nonsensical zero cap rather than dividing by zero', () => {
      expect(() => plan.gasAllowanceFor(1000n, 0n)).to.throw(/positive/);
    });
  });

  describe('REGRESSION: idempotent funding after an interrupted run', () => {
    // Live failure: the first attempt funded the pad owner, then aborted. Re-running must not pay
    // that wallet twice.
    const NEED = 1895007n;

    it('tops up only the shortfall', () => {
      const cap = plan.capFor(BASE);
      const target = plan.fundingAmountFor(NEED, cap);
      const have = target / 3n;
      expect(plan.topUpFor(have, NEED, cap)).to.equal(target - have);
    });

    it('sends nothing to a wallet that is already funded', () => {
      const cap = plan.capFor(BASE);
      const target = plan.fundingAmountFor(NEED, cap);
      expect(plan.topUpFor(target, NEED, cap)).to.equal(0n);
      expect(plan.topUpFor(target * 5n, NEED, cap)).to.equal(0n);
    });

    it('is idempotent: applying the top-up twice sends nothing the second time', () => {
      const cap = plan.capFor(BASE);
      let balance = 0n;
      balance += plan.topUpFor(balance, NEED, cap);
      const second = plan.topUpFor(balance, NEED, cap);
      expect(second).to.equal(0n);
      expect(plan.canAfford(balance, NEED, cap)).to.equal(true);
    });
  });

  describe('REGRESSION: resume-aware budget accounting', () => {
    // Live failure mode: after the interruption, the guard still counted the deploy phases, so the
    // remaining balance looked insufficient for work that had already been paid for.
    const PHASES = ['fundPadOwner', 'fundTokenCreator', 'deployFactory', 'deployLauncher',
      'deployRewards', 'createLaunchpad', 'marketLaunch', 'provingBuy', 'collectFees'];
    const GAS = {
      fundPadOwner: 21000n,
      fundTokenCreator: 21000n,
      deployFactory: 2771806n,
      deployLauncher: 1834285n,
      deployRewards: 841432n,
      createLaunchpad: 1895007n,
      marketLaunch: 1234753n,
      provingBuy: 165622n,
      collectFees: 225806n,
    };

    it('a fresh run counts every phase', () => {
      const r = plan.remainingCost({
        phaseOrder: PHASES, gas: GAS, fromPhase: 'fundPadOwner', baseFee: BASE,
      });
      expect(r.phases).to.have.lengthOf(PHASES.length);
      expect(r.gas).to.equal(Object.values(GAS).reduce((a, b) => a + b, 0n));
    });

    it('a resumed run excludes phases already paid for', () => {
      const { alreadyDone } = plan.resumePlan({
        factory: '0x1', launcher: '0x2', rewards: '0x3', pad: '0x4',
      });
      const r = plan.remainingCost({
        phaseOrder: PHASES, gas: GAS, fromPhase: 'fundPadOwner', alreadyDone, baseFee: BASE,
      });
      expect(r.phases).to.deep.equal(['marketLaunch', 'provingBuy', 'collectFees']);
      expect(r.gas).to.equal(GAS.marketLaunch + GAS.provingBuy + GAS.collectFees);
    });

    it('a resumed estimate is strictly cheaper than a fresh one', () => {
      const fresh = plan.remainingCost({
        phaseOrder: PHASES, gas: GAS, fromPhase: 'fundPadOwner', baseFee: BASE,
      });
      const { alreadyDone } = plan.resumePlan({
        factory: '0x1', launcher: '0x2', rewards: '0x3', pad: '0x4',
      });
      const resumed = plan.remainingCost({
        phaseOrder: PHASES, gas: GAS, fromPhase: 'fundPadOwner', alreadyDone, baseFee: BASE,
      });
      expect(resumed.cost).to.be.lessThan(fresh.cost);
    });

    it('the live scenario: a balance too small for a fresh run still covers the resumed one', () => {
      const fresh = plan.remainingCost({
        phaseOrder: PHASES, gas: GAS, fromPhase: 'fundPadOwner', baseFee: BASE,
        valueStillToSend: 10n ** 15n,
      });
      const { alreadyDone } = plan.resumePlan({
        factory: '0x1', launcher: '0x2', rewards: '0x3', pad: '0x4',
      });
      const resumed = plan.remainingCost({
        phaseOrder: PHASES, gas: GAS, fromPhase: 'fundPadOwner', alreadyDone, baseFee: BASE,
        valueStillToSend: 10n ** 15n,
      });
      // A balance between the two: a resume-unaware guard would have aborted here.
      const balance = (fresh.cost + resumed.cost) / 2n;
      expect(balance).to.be.lessThan(fresh.cost);
      expect(balance).to.be.greaterThanOrEqual(resumed.cost);
    });

    it('applies the safety margin to measured gas', () => {
      const r = plan.remainingCost({
        phaseOrder: PHASES, gas: GAS, fromPhase: 'marketLaunch', baseFee: BASE,
      });
      expect(r.gasWithMargin).to.equal((r.gas * plan.GAS_MARGIN_PCT) / 100n);
      expect(r.gasWithMargin).to.be.greaterThan(r.gas);
    });

    it('refuses a phase it has no measured gas for rather than assuming zero', () => {
      expect(() => plan.remainingCost({
        phaseOrder: [...PHASES, 'somethingNew'], gas: GAS, fromPhase: 'fundPadOwner', baseFee: BASE,
      })).to.throw(/no measured gas/);
    });

    it('refuses an unknown starting phase', () => {
      expect(() => plan.remainingPhases(PHASES, 'nope')).to.throw(/unknown phase/);
    });
  });

  describe('REGRESSION: interrupted deployment and partially completed stack', () => {
    it('no resume inputs means a fresh run', () => {
      const r = plan.resumePlan({});
      expect(r.isResume).to.equal(false);
      expect(r.partial).to.equal(false);
      expect(r.alreadyDone.size).to.equal(0);
    });

    it('all four inputs means a valid resume', () => {
      const r = plan.resumePlan({
        factory: '0xB314cd4731c4F3B4025FCcF5B8E0a3072E8BCbde',
        launcher: '0x4FFbCb9395a839F02f8baeDc02b42CB6E64d9ea6',
        rewards: '0xC2fE1c6730cc029DcBaC04a04D80baFfC7ed530b',
        pad: '0x755b0d58Db11c845FB19a28CD5F0717c24098681',
      });
      expect(r.isResume).to.equal(true);
      expect(r.partial).to.equal(false);
      expect([...r.alreadyDone].sort()).to.deep.equal([...plan.RESUMABLE_PHASES].sort());
    });

    it('a PARTIAL stack is rejected, never silently half-deployed', () => {
      // Attaching to some contracts while deploying others would produce a mismatched system:
      // a launcher pointing at one rewards contract, with a different one actually deployed.
      const r = plan.resumePlan({ factory: '0x1', launcher: '0x2' });
      expect(r.isResume).to.equal(false);
      expect(r.partial).to.equal(true);
      expect(r.missing).to.deep.equal(['rewards', 'pad']);
    });

    it('names every missing piece so the abort is actionable', () => {
      expect(plan.resumePlan({ factory: '0x1' }).missing).to.deep.equal(['launcher', 'rewards', 'pad']);
      expect(plan.resumePlan({ pad: '0x4' }).missing).to.deep.equal(['factory', 'launcher', 'rewards']);
    });

    it('treats blank and whitespace-only values as absent', () => {
      const r = plan.resumePlan({ factory: '0x1', launcher: '  ', rewards: '', pad: '0x4' });
      expect(r.partial).to.equal(true);
      expect(r.missing).to.deep.equal(['launcher', 'rewards']);
    });
  });
});
