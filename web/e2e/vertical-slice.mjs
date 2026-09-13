/**
 * End-to-end proof of the Milestone 1 vertical slice, driven through the real browser UI:
 *
 *   connect wallet -> create OPEN launchpad -> tx confirmed -> enter launchpad
 *   -> switch to a SECOND wallet -> launch token -> token appears under the pad
 *   -> every rendered value re-read from chain
 *
 * WHAT IS REAL HERE: the page, app.js, live.js, chain.js, the calldata, the contracts, the
 * transactions, the receipts, the event logs and every value rendered. Nothing is stubbed.
 *
 * WHAT IS SUBSTITUTED: `window.ethereum`. There is no browser extension in a headless
 * container, so the test injects a minimal EIP-1193 provider that forwards JSON-RPC straight
 * to the node under test and lets the test choose the active account (which is how it proves
 * the two-wallet case). It does not fake responses.
 *
 * Usage:
 *   RPC_URL=http://127.0.0.1:8545 FACTORY=0x... BASE_URL=http://127.0.0.1:4173 \
 *     node web/e2e/vertical-slice.mjs
 */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';

const { chromium } = pw;
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const FACTORY = process.env.FACTORY;
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173';
const WALLET_A = process.env.WALLET_A;
const WALLET_B = process.env.WALLET_B;

if (!FACTORY || !WALLET_A || !WALLET_B) {
  throw new Error('FACTORY, WALLET_A and WALLET_B are required.');
}

const results = [];
let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/** Injected EIP-1193 shim: forwards to the node, with a test-selectable active account. */
function providerShim({ rpcUrl, accounts, chainIdHex }) {
  let active = accounts[0];
  // A fresh wallet exposes no accounts until the user approves a connection request, so
  // eth_accounts stays empty until eth_requestAccounts has been called at least once.
  let authorized = false;
  const listeners = {};

  const rpc = async (method, params = []) => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const body = await response.json();
    if (body.error) {
      const error = new Error(body.error.message || 'rpc error');
      error.code = body.error.code;
      throw error;
    }
    return body.result;
  };

  window.__setActiveAccount = (address) => {
    active = address;
    authorized = true;
    (listeners.accountsChanged || []).forEach((fn) => fn([address]));
  };

  window.ethereum = {
    isMetaMask: false,
    isTestShim: true,
    async request({ method, params = [] }) {
      switch (method) {
        case 'eth_requestAccounts':
          authorized = true;
          return [active];
        case 'eth_accounts':
          return authorized ? [active] : [];
        case 'eth_chainId':
          return chainIdHex;
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null;
        case 'eth_sendTransaction':
          // The node holds the keys for its own accounts, so it signs. No key is in the page.
          return rpc('eth_sendTransaction', [{ ...params[0], from: active }]);
        default:
          return rpc(method, params);
      }
    },
    on(event, handler) {
      (listeners[event] = listeners[event] || []).push(handler);
    },
    removeListener(event, handler) {
      listeners[event] = (listeners[event] || []).filter((fn) => fn !== handler);
    },
  };
}

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

await page.addInitScript(providerShim, {
  rpcUrl: RPC_URL,
  accounts: [WALLET_A, WALLET_B],
  chainIdHex: '0xb626',
});

console.log('\n=== 1. Wallet A: open the live section and connect ===');
await page.goto(`${BASE_URL}/?factory=${FACTORY}#live`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

check('banner switches to live mode', /Live mode/i.test(await page.locator('#modeBanner').innerText()));
check('wallet detected', await page.locator('#connectBtn').count() > 0);

await page.click('#connectBtn');
await page.waitForTimeout(1200);

const walletBar = await page.locator('.wallet-bar').innerText();
check('connected address shown', walletBar.includes(WALLET_A.slice(0, 6)), walletBar.replace(/\s+/g, ' ').trim());
check('correct network detected', /Robinhood Chain Testnet/.test(walletBar));
check('network indicator is green', await page.locator('.chain-dot.good').count() > 0);
check('factory address rendered', (await page.locator('.live-shell').innerText()).includes(FACTORY.slice(0, 10)));

console.log('\n=== 2. Wallet A: create an OPEN launchpad (real transaction) ===');
await page.click('#newPadBtn');
await page.waitForTimeout(500);
await page.fill('input[name="name"]', 'E2E Open Pad');
await page.fill('input[name="metadataURI"]', 'ipfs://e2e');
await page.check('input[value="open"]');
check('policy immutability warned in UI', /permanent/i.test(await page.locator('.notice').first().innerText()));
check('alpha-default economics labelled', /alpha default/i.test(await page.locator('.live-shell').innerText()));

await page.click('#createPadForm button[type="submit"]');
await page.waitForSelector('.tx-banner.success', { timeout: 60000 });

const createBanner = await page.locator('.tx-banner').innerText();
const padAddress = (createBanner.match(/0x[a-fA-F0-9]{40}/) || [])[0];
check('create-pad transaction succeeded', /Launchpad created/i.test(createBanner));
check('pad address read from the emitted event', /^0x[a-fA-F0-9]{40}$/.test(padAddress || ''), padAddress);

const createTxLink = await page.locator('.tx-links a').first().getAttribute('href');
check('explorer link rendered for the tx', /explorer\.testnet\.chain\.robinhood\.com\/tx\/0x[a-f0-9]{64}/i.test(createTxLink || ''), createTxLink);
const createTxHash = (createTxLink.match(/0x[a-f0-9]{64}/i) || [])[0];

console.log('\n=== 3. Wallet A lands inside the launchpad, read from chain ===');
await page.waitForTimeout(1500);
check('navigated into the pad', page.url().includes(`live-pad=${padAddress}`), page.url());

const padText = await page.locator('.live-shell').innerText();
check('pad name read from chain', padText.includes('E2E Open Pad') || (await page.locator('h1').innerText()).includes('E2E Open Pad'));
check('policy shown as Open', /Open/.test(await page.locator('.stats').innerText()));
check('token count starts at 0 from chain', /\b0\b/.test(await page.locator('.stats').innerText()));

console.log('\n=== 4. Switch to wallet B (a different person) ===');
await page.evaluate((addr) => window.__setActiveAccount(addr), WALLET_B);
await page.waitForTimeout(1500);

const barB = await page.locator('.wallet-bar').innerText();
check('wallet B is now the active account', barB.includes(WALLET_B.slice(0, 6)), barB.replace(/\s+/g, ' ').trim());
check('wallet B is not the pad owner', !(await page.locator('.stats').innerText()).includes('(you)'));
check('open pad lets a non-owner launch', /you can launch a token here even though you do not own/i.test(await page.locator('.live-shell').innerText()));
check('launch button enabled for wallet B', !(await page.locator('#launchTokenBtn').isDisabled()));

console.log('\n=== 5. Wallet B launches a token through wallet A\'s pad ===');
await page.click('#launchTokenBtn');
await page.waitForTimeout(400);
await page.fill('#launchTokenForm input[name="name"]', 'Second Wallet Coin');
await page.fill('#launchTokenForm input[name="symbol"]', 'swc');
await page.click('#launchTokenForm button[type="submit"]');
await page.waitForSelector('.tx-banner.success', { timeout: 60000 });

const tokenBanner = await page.locator('.tx-banner').innerText();
const tokenAddress = (tokenBanner.match(/0x[a-fA-F0-9]{40}/) || [])[0];
check('launch-token transaction succeeded', /Token launched/i.test(tokenBanner));
check('token address read from the emitted event', /^0x[a-fA-F0-9]{40}$/.test(tokenAddress || ''), tokenAddress);

const tokenTxLink = await page.locator('.tx-links a').first().getAttribute('href');
const tokenTxHash = (tokenTxLink.match(/0x[a-f0-9]{64}/i) || [])[0];
check('explorer link rendered for the token tx', Boolean(tokenTxHash), tokenTxLink);

console.log('\n=== 6. Token appears under the pad, from on-chain reads ===');
await page.waitForTimeout(1500);
const tableText = await page.locator('.token-table').innerText();
check('token row rendered', /SWC/.test(tableText), tableText.replace(/\s+/g, ' ').trim());
check('fixed 1,000,000,000 supply rendered from chain', /1,000,000,000/.test(tableText));
check('token count incremented on chain', /\b1\b/.test(await page.locator('.stats').innerText()));

// Independent verification: ask the chain directly, bypassing the UI entirely.
const onChain = await page.evaluate(async ({ pad, token, owner, creator }) => {
  const c = window.__live.chain;
  const padData = await c.readLaunchpad(pad);
  const tokenData = await c.readToken(token);
  const creatorBalance = await c.callUint(token, 'balanceOf(address)', [{ type: 'address', value: creator }]);
  const ownerBalance = await c.callUint(token, 'balanceOf(address)', [{ type: 'address', value: owner }]);
  return {
    padName: padData.name,
    padOwner: padData.owner,
    padPolicy: padData.launchPolicy,
    padTokenCount: padData.tokenCount,
    tokenSymbol: tokenData.symbol,
    totalSupply: tokenData.totalSupply.toString(),
    creatorBalance: creatorBalance.toString(),
    ownerBalance: ownerBalance.toString(),
  };
}, { pad: padAddress, token: tokenAddress, owner: WALLET_A, creator: WALLET_B });

const expectedSupply = (1000000000n * 10n ** 18n).toString(); // fixed by Uniswap's requirement
check('chain says pad is owned by wallet A', onChain.padOwner.toLowerCase() === WALLET_A.toLowerCase());
check('chain says policy is Open (1)', onChain.padPolicy === 1);
check('chain says pad holds 1 token', onChain.padTokenCount === 1);
check('chain says token symbol is SWC', onChain.tokenSymbol === 'SWC');
check('ENTIRE supply belongs to wallet B, the creator', onChain.creatorBalance === expectedSupply,
  `${onChain.creatorBalance} of ${expectedSupply}`);
check('pad owner (wallet A) holds ZERO of it', onChain.ownerBalance === '0');

console.log('\n=== 7. Demo and live data stay separated ===');
await page.goto(`${BASE_URL}/#explore`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const demoText = await page.locator('#app').innerText();
check('demo mode banner restored', /Demo mode/i.test(await page.locator('#modeBanner').innerText()));
check('demo section does not show the on-chain pad', !demoText.includes('E2E Open Pad'));
check('demo figures still labelled simulated', /sim \$/.test(demoText));

await page.goto(`${BASE_URL}/?factory=${FACTORY}#live`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const liveText = await page.locator('#app').innerText();
check('live section shows the on-chain pad', liveText.includes('E2E Open Pad'));
check('live section shows no simulated figures', !/sim \$/.test(liveText));

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await page.screenshot({ path: new URL('./e2e-pad.png', import.meta.url).pathname, fullPage: true });
await browser.close();

console.log('\n=========================================');
console.log(`E2E: ${results.length - failures}/${results.length} checks passed`);
console.log('Artifacts:');
console.log(`  launchpad:  ${padAddress}`);
console.log(`  token:      ${tokenAddress}`);
console.log(`  createTx:   ${createTxHash}`);
console.log(`  launchTx:   ${tokenTxHash}`);
console.log('=========================================');

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
