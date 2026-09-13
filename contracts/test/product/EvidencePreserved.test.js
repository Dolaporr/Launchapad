const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

/**
 * THE PRIMARY RUN RECORD IS EVIDENCE, NOT A SCOREBOARD.
 *
 * contracts/canary-report.json records the 2026-09-13 mainnet canary, including the TWO assertions
 * that failed when an external trader entered the pool. Those failures are the most informative
 * part of the record: they are why the verifier now discovers holders instead of assuming them.
 *
 * Making them "pass" — by editing the file, relaxing the assertion after the fact, or regenerating
 * the report — would destroy the only contemporaneous account of what happened. These tests make
 * that destruction fail loudly. Corrections live in the separate postmortem document.
 */
describe('preserved canary evidence', () => {
  const root = path.join(__dirname, '..', '..');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'canary-report.json'), 'utf8'));
  const post = JSON.parse(fs.readFileSync(
    path.join(root, 'baseline', 'canary-2026-09-13.postmortem.json'), 'utf8',
  ));

  describe('the original record still reports what actually happened', () => {
    it('still reports 2 of 52 assertions as FAILED', () => {
      expect(report.checks).to.have.lengthOf(52);
      expect(report.checks.filter((c) => !c.passed)).to.have.lengthOf(2);
      expect(report.result).to.equal('2 CHECK(S) FAILED');
    });

    it('still contains the supply assertion that an external trade falsified', () => {
      const c = report.checks.find((x) => x.label === 'every unit is locked liquidity or burned');
      expect(c, 'the failed supply assertion was removed from the record').to.not.equal(undefined);
      expect(c.passed, 'a failed assertion was rewritten to pass').to.equal(false);
    });

    it('still contains the LP-fee assertion that an external trade falsified', () => {
      const c = report.checks.find((x) => x.label === 'LP fee is within 1 wei of nominal 25 bps');
      expect(c, 'the failed fee assertion was removed from the record').to.not.equal(undefined);
      expect(c.passed, 'a failed assertion was rewritten to pass').to.equal(false);
      expect(c.detail).to.equal('delta 4998870000');
    });

    it('still holds the real transaction hashes', () => {
      const launch = report.transactions.find((t) => t.step === 'marketLaunch');
      expect(launch.hash).to.equal('0x2510145068dcdcfe7a266966a31b60a4ab1c984d7c0b8e9d6d042f693ae3c075');
      const buy = report.transactions.find((t) => t.step === 'provingBuy');
      expect(buy.valueEth).to.equal('0.001');
    });

    it('the executor no longer writes to this path, so a later run cannot overwrite it', () => {
      const src = fs.readFileSync(path.join(root, 'scripts', 'canaryExecute.cjs'), 'utf8');
      // The only mentions left must be the comments explaining why it is off limits.
      const writes = src.match(/writeFileSync\([^)]*canary-report\.json/g);
      expect(writes, 'canaryExecute.cjs writes to the preserved evidence file').to.equal(null);
      expect(src).to.include('evidence');
    });
  });

  describe('the correction is additive, in a separate document', () => {
    it('the postmortem points at the primary evidence rather than replacing it', () => {
      expect(post.kind).to.equal('postmortem');
      expect(post.primaryEvidence).to.equal('contracts/canary-report.json');
    });

    it('reconciles both failures without claiming they did not happen', () => {
      expect(post.failedAssertions).to.have.lengthOf(2);
      for (const a of post.failedAssertions) {
        expect(a.verdict).to.equal('ASSERTION WRONG — protocol correct');
        expect(a.originalLabel).to.be.a('string');
        expect(a.reconciliation.exact).to.equal(true);
        expect(a.regressionTest).to.be.a('string');
      }
    });

    it('the reconciled supply sums exactly to total supply', () => {
      const r = post.failedAssertions[0].reconciliation;
      const sum = BigInt(r.lockedInPool) + BigInt(r.burned)
        + r.holders.reduce((a, h) => a + BigInt(h.balance), 0n);
      expect(sum).to.equal(BigInt(r.totalSupply));
      expect(sum.toString()).to.equal(r.sum);
    });

    it('the reconciled fee residual is exactly 25 bps of the third party volume', () => {
      const r = post.failedAssertions[1].reconciliation;
      const residual = BigInt(r.totalLpFeeCollectedWei) - BigInt(r.expectedFromOurBuyWei);
      expect(residual.toString()).to.equal(r.residualWei);
      expect((BigInt(r.impliedThirdPartyVolumeWei) * 25n) / 10000n).to.equal(residual);
    });

    it('records that no protocol defect was found', () => {
      expect(post.conclusion.join(' ')).to.match(/No protocol defect was found/i);
    });
  });

  describe('external trading is classified as permissionless activity, not validation', () => {
    it('the postmortem says so explicitly', () => {
      expect(post.rootCause.event.classification).to.equal('permissionless third-party activity');
      expect(post.rootCause.event.solicited).to.equal(false);
    });

    it('it explicitly disclaims organic demand and user validation', () => {
      const disclaimed = post.rootCause.event.explicitlyNotEvidenceOf.join(' ').toLowerCase();
      expect(disclaimed).to.include('organic user demand');
      expect(disclaimed).to.include('product-market fit');
      expect(disclaimed).to.match(/real creator or trader validating/);
    });

    it('the frozen baseline carries the same disclaimer', () => {
      const b = JSON.parse(fs.readFileSync(
        path.join(root, 'baseline', 'canary-2026-09-13.json'), 'utf8',
      ));
      const notes = b.notes.join(' ');
      expect(notes).to.include('PERMISSIONLESS THIRD-PARTY ACTIVITY');
      expect(notes).to.match(/NOT evidence of organic demand/i);
      expect(notes).to.match(/never be cited as user validation/i);
    });
  });

  describe('canary key custody is recorded and required', () => {
    it('the postmortem records that both keys are retained, not rotated', () => {
      expect(post.custody.keysVerifiedPresent).to.equal(true);
      expect(post.custody.note).to.match(/RETAINED, not rotated or deleted/);
      expect(post.custody.padOwner).to.equal('0x23fA4a22CE185fb15911ABe7C274a33C05af2b0b');
      expect(post.custody.tokenCreator).to.equal('0x2C4AcE643cb9C6a76d9b9FBDe9C38D9732456811');
    });

    it('a custody check exists and never prints key material', () => {
      const src = fs.readFileSync(path.join(root, 'scripts', 'custodyCheck.cjs'), 'utf8');
      // It may READ the key to derive an address, but must never put it in output.
      expect(src).to.match(/never printed|never printed, logged or written/i);
      expect(src).to.not.match(/console\.log\([^)]*privateKey/);
      expect(src).to.not.match(/console\.log\([^)]*process\.env\[env\]/);
    });
  });
});
