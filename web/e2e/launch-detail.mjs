/**
 * Browser proof of the LAUNCH DETAIL view, against a Robinhood Chain MAINNET FORK.
 *
 * Proves the productised lifecycle renders from real chain reads:
 *   Token -> Pool -> Locked Liquidity -> Trading Activity -> Fees -> Revenue Split
 *
 * and that the two rules the product must never break hold in the rendered page:
 *   - swapped ETH is never presented as revenue;
 *   - a value that could not be established renders as unknown, never as zero.
 *
 * WHAT IS REAL: the forked mainnet state, Uniswap's contracts, the pool, the trades, and every
 * number the page renders (all read from chain by web/chain.js).
 * WHAT IS SUBSTITUTED: `window.ethereum` only — a shim forwarding JSON-RPC to the forked node.
 *
 * Usage: RPC_URL=… FACTORY=… LAUNCHER=… REWARDS=… MARKET_TOKEN=… CREATOR=… PAD_OWNER=… \
 *          node web/e2e/launch-detail.mjs
 */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';

const { chromium } = pw;
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173';
const { FACTORY, LAUNCHER, REWARDS, MARKET_TOKEN, CREATOR, PAD_OWNER } = process.env;

if (!FACTORY || !LAUNCHER || !REWARDS || !MARKET_TOKEN || !CREATOR) {
  throw new Error('FACTORY, LAUNCHER, REWARDS, MARKET_TOKEN and CREATOR are required.');
}

let failures = 0;
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function providerShim({ rpcUrl, account, chainIdHex }) {
  let authorized = false;
  const listeners = {};
  const rpc = async (method, params = []) => {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
    return j.result;
  };
  window.ethereum = {
    isTestShim: true,
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts') { authorized = true; return [account]; }
      if (method === 'eth_accounts') return authorized ? [account] : [];
      if (method === 'eth_chainId') return chainIdHex;
      if (method.startsWith('wallet_')) return null;
      if (method === 'eth_sendTransaction') return rpc(method, [{ ...params[0], from: account }]);
      return rpc(method, params);
    },
    on(e, h) { (listeners[e] = listeners[e] || []).push(h); },
    removeListener(e, h) { listeners[e] = (listeners[e] || []).filter((f) => f !== h); },
  };
}

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

await page.addInitScript(providerShim, {
  rpcUrl: RPC_URL, account: CREATOR, chainIdHex: '0xb626',
});

const url = `${BASE_URL}/?factory=${FACTORY}&launcher=${LAUNCHER}&rewards=${REWARDS}`;

console.log('\n=== 1. Open the launch detail view for the real market token ===');
await page.goto(`${url}#live`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.click('#connectBtn');
await page.waitForTimeout(1200);

await page.goto(`${url}#live-launch=${MARKET_TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(8000);

const shell = await page.locator('.live-shell').innerText();
check('the detail view rendered', shell.length > 0);

console.log('\n=== 2. All six lifecycle steps are present, in order ===');
const steps = ['Token', 'Uniswap v4 pool', 'Locked liquidity', 'Trading activity',
  'Fees captured', 'Revenue split'];
const positions = steps.map((s) => shell.indexOf(s));
for (let i = 0; i < steps.length; i += 1) {
  check(`step ${i + 1}: ${steps[i]}`, positions[i] >= 0);
}
check('steps appear in lifecycle order',
  positions.every((p, i) => i === 0 || p > positions[i - 1]));

console.log('\n=== 3. Locked liquidity is proven, not asserted ===');
const state = await page.evaluate(() => {
  const s = window.__live.state.launchState;
  if (!s) return null;
  return {
    verified: s.verification.verified,
    locked: s.liquidity.locked,
    positionOwner: s.liquidity.positionOwner,
    lockedPercent: s.liquidity.lockedPercentOfSupply,
    supplyReconciles: s.liquidity.reconciles,
    captured: s.fees ? s.fees.capturedWei.toString() : null,
    split: s.split ? s.split.map((r) => ({
      key: r.key, share: r.sharePercent, credited: r.creditedWei.toString(), balances: r.balances,
    })) : null,
    external: s.trading.externalTraderCount,
    controlled: s.trading.controlledTraderCount,
    nativeVolume: s.trading.nativeVolumeWei,
  };
});
check('a launch state was built from chain', state !== null);
check('liquidity is reported locked', state?.locked === true);
check('the LP position is held by Uniswap\'s FeeSplitter',
  (state?.positionOwner || '').toLowerCase() === '0xeff166aaf189323c58dc27ed1206eb2c37faacdf',
  state?.positionOwner);
check('essentially the whole supply is locked', (state?.lockedPercent ?? 0) > 99);
check('supply reconciles exactly', state?.supplyReconciles === true);

console.log('\n=== 4. Swapped ETH is NOT presented as revenue ===');
check('the trading section says it is activity, not income',
  /This is activity, not income/.test(shell));
check('it states buyer ETH was exchanged for tokens and is not revenue',
  /NOT revenue/.test(shell) && /exchanged for tokens/i.test(shell));
check('the revenue section states it is the only revenue',
  /This is the only revenue/.test(shell));
check('the revenue section disclaims trading volume',
  /not of trading volume/.test(shell));
check('captured fees are far smaller than the ETH swapped',
  state?.captured != null && BigInt(state.captured) < 10n ** 15n,
  `${state?.captured} wei captured`);

console.log('\n=== 5. The three recipients are shown separately at 50 / 30 / 20 ===');
check('three parties are listed', state?.split?.length === 3);
check('creator is 50%', state?.split?.[0]?.share === 50);
check('pad owner is 30%', state?.split?.[1]?.share === 30);
check('protocol is 20%', state?.split?.[2]?.share === 20);
check('every party balances (earned == withdrawn + claimable)',
  state?.split?.every((r) => r.balances) === true);

console.log('\n=== 6. External vs controlled trading is distinguished ===');
check('at least one third-party trader is shown', (state?.external ?? 0) >= 1,
  `${state?.external} external, ${state?.controlled} ours`);
check('third-party activity is labelled permissionless',
  /third party \(permissionless\)/.test(shell));
check('it is disclaimed as not organic demand',
  /not\s+evidence of organic demand/i.test(shell));

console.log('\n=== 7. Unknown renders as unknown, never as zero ===');
check('ETH volume is not derivable and is shown as not established',
  state?.nativeVolume === null && /not established/.test(shell));

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: new URL('./launch-detail.png', import.meta.url).pathname, fullPage: true });
await browser.close();

console.log('\n=========================================');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
console.log('=========================================');
if (failures) process.exit(1);
