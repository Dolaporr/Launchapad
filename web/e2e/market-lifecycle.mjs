/**
 * MILESTONE 2.5 browser lifecycle proof, against a Robinhood Chain MAINNET FORK.
 *
 *   create pad -> launch REAL market token -> execute a REAL trade
 *   -> show immutable creator / pad owner / protocol attribution -> show claimable rewards
 *
 * WHAT IS REAL: the forked mainnet state, Uniswap's Liquidity Launchpad, the v4 pool this launch
 * creates, the BUY swap executed against it, the fees it generates, and every value the page
 * renders (all read from chain).
 *
 * WHAT IS SUBSTITUTED: `window.ethereum` (no extension exists in a headless container) — a shim
 * forwards JSON-RPC to the forked node and lets the harness pick the active account. It stubs no
 * responses. The trade itself is executed by the harness through the real PoolManager, because
 * the app deliberately does not ship a swap UI (Uniswap is the venue).
 *
 * NOTHING TOUCHES PUBLIC MAINNET. The node is a local fork.
 *
 * Usage: RPC_URL=http://127.0.0.1:8545 FACTORY=0x… LAUNCHER=0x… REWARDS=0x… \
 *          PAD_OWNER=0x… CREATOR=0x… node web/e2e/market-lifecycle.mjs
 */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';

const { chromium } = pw;
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173';
const { FACTORY, LAUNCHER, REWARDS, PAD_OWNER, CREATOR, MARKET_TOKEN, POSITION_ID } = process.env;

if (!FACTORY || !LAUNCHER || !REWARDS || !PAD_OWNER || !CREATOR) {
  throw new Error('FACTORY, LAUNCHER, REWARDS, PAD_OWNER and CREATOR are required.');
}

let failures = 0;
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function providerShim({ rpcUrl, accounts, chainIdHex }) {
  let active = accounts[0];
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
  window.__setActiveAccount = (a) => {
    active = a; authorized = true;
    (listeners.accountsChanged || []).forEach((fn) => fn([a]));
  };
  window.ethereum = {
    isTestShim: true,
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts') { authorized = true; return [active]; }
      if (method === 'eth_accounts') return authorized ? [active] : [];
      if (method === 'eth_chainId') return chainIdHex;
      if (method.startsWith('wallet_')) return null;
      if (method === 'eth_sendTransaction') return rpc(method, [{ ...params[0], from: active }]);
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

// The forked node reports chain 4663 state; the shim advertises the app's target chain id so the
// app's own network gate is genuinely exercised.
await page.addInitScript(providerShim, {
  rpcUrl: RPC_URL, accounts: [CREATOR, PAD_OWNER], chainIdHex: '0xb626',
});

const url = `${BASE_URL}/?factory=${FACTORY}&launcher=${LAUNCHER}&rewards=${REWARDS}`;

console.log('\n=== 1. Creator opens the pad with the market contracts configured ===');
await page.goto(`${url}#live`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.click('#connectBtn');
await page.waitForTimeout(1500);
check('wallet connected as the creator', (await page.locator('.wallet-bar').innerText()).includes(CREATOR.slice(0, 6)));

const padAddress = await page.evaluate(async (factory) => {
  const c = window.__live.chain;
  const pads = await c.readFactoryLaunchpads(factory, 10);
  return pads[0].address;
}, FACTORY);
check('found the pad on chain', /^0x[a-fA-F0-9]{40}$/.test(padAddress), padAddress);

console.log('\n=== 2. The pad page shows the REAL market section ===');
await page.goto(`${url}#live-pad=${padAddress}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

const shell = await page.locator('.live-shell').innerText();
check('market section is available', /Uniswap pools/i.test(shell));
check('explains that supply becomes locked liquidity', /permanently locked liquidity/i.test(shell));
check('states the immutable 50 / 30 / 20 split', /50%/.test(shell) && /30%/.test(shell) && /20%/.test(shell));
check('market launch button is offered', await page.locator('#marketLaunchBtn').count() > 0);

console.log('\n=== 3. A verified market launch is rendered (created by the harness on the fork) ===');
const marketState = await page.evaluate(() => ({
  count: window.__live.state.marketLaunches.length,
  first: window.__live.state.marketLaunches[0]
    ? {
      address: window.__live.state.marketLaunches[0].address,
      symbol: window.__live.state.marketLaunches[0].symbol,
      tokenCreator: window.__live.state.marketLaunches[0].tokenCreator,
      launchpadOwner: window.__live.state.marketLaunches[0].launchpadOwner,
      positionTokenId: window.__live.state.marketLaunches[0].positionTokenId.toString(),
      lifetime: window.__live.state.marketLaunches[0].lifetime.toString(),
    }
    : null,
}));
check('at least one verified market launch is shown', marketState.count > 0, `count=${marketState.count}`);

if (marketState.first) {
  check('the rendered token is the launched market token',
    !MARKET_TOKEN || marketState.first.address.toLowerCase() === MARKET_TOKEN.toLowerCase(),
    marketState.first.address);
  check('creator attribution is the launching wallet',
    marketState.first.tokenCreator.toLowerCase() === CREATOR.toLowerCase(), marketState.first.tokenCreator);
  check('pad owner attribution is the pad owner, not the creator',
    marketState.first.launchpadOwner.toLowerCase() === PAD_OWNER.toLowerCase()
    && marketState.first.launchpadOwner.toLowerCase() !== CREATOR.toLowerCase(),
    marketState.first.launchpadOwner);
  check('a real Uniswap position id is attached', BigInt(marketState.first.positionTokenId) > 0n,
    marketState.first.positionTokenId);
  check('fees from the real trade have been split', BigInt(marketState.first.lifetime) > 0n,
    `${marketState.first.lifetime} wei distributed`);
}

const tableText = await page.locator('.token-table').first().innerText();
check('the market token is badged as a verified market', /verified market/i.test(tableText));

console.log('\n=== 4. Claimable rewards are shown to the creator ===');
const creatorRewards = await page.evaluate(() => window.__live.state.myRewards.toString());
check('creator has claimable rewards from the real trade', BigInt(creatorRewards) > 0n, `${creatorRewards} wei`);
check('the reward banner is rendered', await page.locator('#rewardBanner').count() > 0);

console.log('\n=== 5. The pad owner independently sees their own share ===');
await page.evaluate((a) => window.__setActiveAccount(a), PAD_OWNER);
await page.waitForTimeout(4000);
const padOwnerRewards = await page.evaluate(() => window.__live.state.myRewards.toString());
check('pad owner has their own claimable balance', BigInt(padOwnerRewards) > 0n, `${padOwnerRewards} wei`);
check('creator earns more than the pad owner (50 vs 30)', BigInt(creatorRewards) > BigInt(padOwnerRewards),
  `${creatorRewards} vs ${padOwnerRewards}`);
// 50/30 => creator/padOwner should be exactly 5/3.
check('the ratio is exactly 50:30', BigInt(creatorRewards) * 3n === BigInt(padOwnerRewards) * 5n);

console.log('\n=== 6. A token-only deployment is NOT presented as a market launch ===');
const separation = await page.evaluate(async (launcher) => {
  const c = window.__live.chain;
  const s = window.__live.state;
  const results = { padTokens: s.tokens.length, market: s.marketLaunches.length, verified: [] };
  for (const t of s.tokens) {
    results.verified.push({ token: t.address, isMarket: await c.isVerifiedMarketLaunch(launcher, t.address) });
  }
  return results;
}, LAUNCHER);
check('token-only deployments all fail market verification',
  separation.verified.every((v) => v.isMarket === false),
  `${separation.verified.length} token-only checked`);
check('the token-only table is labelled as having no market', /Token-only \(no market\)/i.test(
  await page.locator('.live-shell').innerText(),
));

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: new URL('./market-lifecycle.png', import.meta.url).pathname, fullPage: true });
await browser.close();

console.log('\n=========================================');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
console.log('=========================================');
if (failures) process.exit(1);
