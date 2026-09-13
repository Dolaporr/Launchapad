const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

/**
 * The rendered launch page.
 *
 * These tests read the produced HTML, because the guarantees that matter are about what a reader
 * SEES: that swapped ETH is never labelled revenue, that an unknown value never renders as a
 * confident zero, and that a failed verification is impossible to miss.
 */
describe('launch detail view', () => {
  let renderLaunchDetail; let buildLaunchState;
  let baseline; let html;

  before(async () => {
    const web = path.join(__dirname, '..', '..', '..', 'web');
    ({ renderLaunchDetail } = await import(`file://${path.join(web, 'launchDetail.js')}`));
    ({ buildLaunchState } = await import(`file://${path.join(web, 'launchState.js')}`));
    baseline = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'baseline', 'canary-2026-09-13.json'), 'utf8',
    ));
    html = renderLaunchDetail(buildLaunchState(baseline), {
      explorerBase: 'https://robinhoodchain.blockscout.com',
    });
  });

  describe('renders the full lifecycle in order', () => {
    it('shows all six steps', () => {
      for (const title of ['Token', 'Uniswap v4 pool', 'Locked liquidity',
        'Trading activity', 'Fees captured', 'Revenue split']) {
        expect(html, `missing step: ${title}`).to.include(title);
      }
    });

    it('orders them Token -> Pool -> Liquidity -> Trading -> Fees -> Split', () => {
      const order = ['Token', 'Uniswap v4 pool', 'Locked liquidity',
        'Trading activity', 'Fees captured', 'Revenue split'];
      const positions = order.map((t) => html.indexOf(t));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions).to.deep.equal(sorted);
    });

    it('shows the verified banner with the reconciliation block', () => {
      expect(html).to.include('Verified on chain');
      expect(html).to.include(String(baseline.reconciledAtBlock));
    });
  });

  describe('swapped ETH is never presented as revenue', () => {
    it('labels trading activity explicitly as not income', () => {
      expect(html).to.include('This is activity, not income');
      expect(html).to.match(/NOT revenue/);
    });

    it('says the revenue section is the only revenue, and what it is a share of', () => {
      expect(html).to.include('This is the only revenue');
      expect(html).to.match(/not of trading volume/);
      expect(html).to.match(/not of the ETH buyers spent/);
    });

    it('never places the proving buy amount inside the revenue table', () => {
      const splitSection = html.slice(html.indexOf('Revenue split'));
      // 0.001 ETH was swapped. It must not appear as an earned figure.
      expect(splitSection).to.not.match(/>0\.001</);
    });

    it('shows captured fees at their true, tiny magnitude', () => {
      expect(html).to.include('0.000001001');
    });
  });

  describe('third-party trading is shown and correctly characterised', () => {
    it('lists the external buyer separately from ours', () => {
      expect(html).to.include('2be87aD7'.slice(0, 8));
      expect(html).to.match(/third party \(permissionless\)/);
      expect(html).to.match(/ours \(test wallet\)/);
    });

    it('carries the disclaimer that it is not organic demand', () => {
      expect(html).to.include('On third-party trading');
      expect(html).to.match(/not\s+evidence of organic demand/i);
    });
  });

  describe('unknown renders as unknown, never as zero', () => {
    it('shows ETH volume as not established rather than 0', () => {
      // The verifier cannot derive ETH volume from Transfer logs alone.
      expect(html).to.include('not established');
      const volumeRow = html.slice(html.indexOf('ETH volume'), html.indexOf('ETH volume') + 220);
      expect(volumeRow).to.include('not established');
      expect(volumeRow).to.not.match(/>0\.0 ETH</);
    });

    it('marks an unprovable liquidity lock as unknown, not as unlocked', () => {
      const stripped = JSON.parse(JSON.stringify(baseline));
      stripped.verification.checks = stripped.verification.checks
        .filter((c) => c.id !== 'liquidity.permanentlyLocked');
      const out = renderLaunchDetail(buildLaunchState(stripped));
      expect(out).to.include('pill-unknown');
      expect(out).to.not.include('pill-bad');
    });

    // Regression: the pair and hook rows were hardcoded, so a pool whose key could
    // not be read still displayed "$SYM / ETH" and "none (hookless)" as if proven.
    it('shows an unreadable pool key as not established, not as an ETH-paired hookless pool', () => {
      const stripped = JSON.parse(JSON.stringify(baseline));
      delete stripped.pool.currency0;
      delete stripped.pool.hooks;
      const out = renderLaunchDetail(buildLaunchState(stripped));
      expect(out).to.not.include('none (hookless)');
      expect(out).to.match(/not established/);
    });

    it('renders missing fee accounting as a stated gap, not an empty table of zeroes', () => {
      const stripped = JSON.parse(JSON.stringify(baseline));
      delete stripped.feeAccounting;
      const out = renderLaunchDetail(buildLaunchState(stripped));
      expect(out).to.include('Fee accounting could not be established');
      expect(out).to.include('Split could not be established');
    });
  });

  describe('a failed verification is impossible to miss', () => {
    let failedHtml;
    before(() => {
      const broken = JSON.parse(JSON.stringify(baseline));
      broken.verification.status = 'FAILED';
      broken.verification.checks.push({
        id: 'supply.reconcilesExactly', passed: false, detail: 'short by 5 units',
      });
      failedHtml = renderLaunchDetail(buildLaunchState(broken));
    });

    it('leads with a NOT VERIFIED banner', () => {
      expect(failedHtml).to.include('NOT VERIFIED');
      expect(failedHtml).to.include('notice bad');
    });

    it('names the failing check and warns the figures are not settled', () => {
      expect(failedHtml).to.include('supply.reconcilesExactly');
      expect(failedHtml).to.include('short by 5 units');
      expect(failedHtml).to.match(/must not be treated as settled/);
    });
  });

  describe('output safety', () => {
    it('escapes hostile content rather than injecting it', () => {
      const nasty = JSON.parse(JSON.stringify(baseline));
      nasty.token.name = '<img src=x onerror=alert(1)>';
      nasty.token.symbol = '"><script>alert(2)</script>';
      const out = renderLaunchDetail(buildLaunchState(nasty));
      expect(out).to.not.include('<img src=x');
      expect(out).to.not.include('<script>alert(2)');
      expect(out).to.include('&lt;img');
    });

    it('omits explorer links when no explorer base is configured', () => {
      const out = renderLaunchDetail(buildLaunchState(baseline));
      expect(out).to.not.include('href="/address');
      expect(out).to.not.include('href="undefined');
    });
  });
});
