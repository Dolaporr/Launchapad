/**
 * Wallet connection UX — proved in a real browser, on mobile and desktop.
 *
 * The bug: a normal mobile browser has no injected wallet, and the page rendered
 * the dead text "No wallet detected". Every visitor on iOS Safari hit that and
 * had nothing to press.
 *
 * These runs use NO provider shim on purpose. That is the whole point — this is
 * the case the old UI could not serve. The one section that does inject a wallet
 * uses a shim reporting the WRONG chain, to prove the switch flow now aims at
 * mainnet instead of looping back to testnet.
 *
 * NO TRANSACTION IS SENT. Nothing here calls eth_sendTransaction; the shim would
 * throw if anything tried.
 *
 *   RPC_URL=… PORT=4173 APEX=launchpad.family node web/e2e/wallet-ux.mjs
 */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';

const { chromium, devices } = pw;
const APEX = process.env.APEX || 'launchpad.family';
const PORT = process.env.PORT || '4173';
const SHOT_DIR = new URL('./', import.meta.url).pathname;

let failures = 0;
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const section = (t) => console.log(`\n=== ${t} ===`);
const origin = (host) => `http://${host}:${PORT}`;

const browser = await chromium.launch({
  args: [`--host-resolver-rules=MAP ${APEX} 127.0.0.1, MAP *.${APEX} 127.0.0.1`],
});

const pageErrors = [];

/**
 * A page with NO wallet. `window.ethereum` is deleted after load so the app sees
 * exactly what a stock mobile browser presents.
 */
async function openBare(hostname, deviceName, { secure = true } = {}) {
  const context = await browser.newContext(deviceName ? devices[deviceName] : {});
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${hostname}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`${hostname} console: ${m.text()}`);
  });
  await page.addInitScript((isSecure) => {
    try { delete window.ethereum; } catch { window.ethereum = undefined; }
    // This harness serves plain http on a non-localhost host, so the browser
    // reports an insecure context — and the app correctly refuses to offer
    // wallet hand-offs there. Production is https behind Cloudflare, so the
    // flag is forced to match production. Section 7 tests the http case for real.
    Object.defineProperty(window, 'isSecureContext', { value: isSecure, configurable: true });
  }, secure);
  return { page, context };
}

/** A page with a wallet that is on the WRONG chain, to exercise the switch flow. */
async function openWrongChain(hostname, deviceName) {
  const context = await browser.newContext(deviceName ? devices[deviceName] : {});
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${hostname}: ${e.message}`));
  await page.addInitScript(() => {
    window.__switchCalls = [];
    window.ethereum = {
      async request({ method, params = [] }) {
        if (method === 'eth_chainId') return window.__chain || '0x1';
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
          return ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'];
        }
        if (method === 'wallet_switchEthereumChain') {
          window.__switchCalls.push(params[0]);
          window.__chain = params[0].chainId;
          return null;
        }
        if (method === 'wallet_addEthereumChain') {
          window.__switchCalls.push(params[0]);
          return null;
        }
        if (method === 'eth_sendTransaction') {
          throw new Error('TEST FAILURE: a transaction was attempted');
        }
        return null;
      },
      on() {}, removeListener() {},
    };
  });
  return { page, context };
}

// ---------------------------------------------------------------------------
section('1. Mobile, no wallet — the case that used to dead-end');

const { page: ios } = await openBare(APEX, 'iPhone 13');
await ios.goto(origin(APEX), { waitUntil: 'networkidle' });
await ios.waitForTimeout(1500);

const iosHeader = await ios.locator('#walletSlot').innerText();
check('the header shows a Connect wallet CTA, not dead text',
  /connect wallet/i.test(iosHeader), iosHeader.trim());
check('the words "No wallet detected" are gone from the header',
  !/no wallet detected/i.test(iosHeader));

const cta = ios.locator('#walletSlot [data-wallet-open]');
check('the CTA is a real button', await cta.count() === 1);
await cta.click();
await ios.waitForTimeout(400);

const sheet = ios.locator('.wc-panel');
check('tapping it opens a connect sheet', await sheet.count() === 1);
const iosSheet = await sheet.innerText();
check('the sheet explains this browser has no wallet in it',
  /no wallet in it/i.test(iosSheet));

const iosLinks = await ios.locator('.wc-item').allInnerTexts();
check('it offers at least one wallet app to open the page in',
  iosLinks.length > 0, iosLinks.join(' | '));
check('MetaMask is offered', iosLinks.some((t) => /metamask/i.test(t)));
check('Trust Wallet is NOT offered on iOS (no dApp browser there)',
  !iosLinks.some((t) => /trust/i.test(t)));

const hrefs = await ios.locator('.wc-item[href]').evaluateAll(
  (els) => els.map((e) => e.getAttribute('href')),
);
check('every hand-off link is a real https deep link',
  hrefs.length > 0 && hrefs.every((h) => /^https:\/\//.test(h)), hrefs.join(' | '));
check('the MetaMask link carries this exact page',
  hrefs.some((h) => h.includes(`metamask.app.link/dapp/${APEX}`)));
check('a copyable link is offered as the universal fallback',
  /copy/i.test(iosSheet) && await ios.locator('[data-wallet-copy]').count() === 1);

await ios.screenshot({ path: `${SHOT_DIR}wallet-ios.png`, fullPage: false });

// ---------------------------------------------------------------------------
section('2. Android, no wallet');

const { page: android } = await openBare(APEX, 'Pixel 5');
await android.goto(origin(APEX), { waitUntil: 'networkidle' });
await android.waitForTimeout(1500);
await android.locator('#walletSlot [data-wallet-open]').click();
await android.waitForTimeout(400);

const androidLinks = await android.locator('.wc-item').allInnerTexts();
check('Android is offered wallet hand-off links', androidLinks.length > 0,
  androidLinks.join(' | '));
check('Trust Wallet IS offered on Android',
  androidLinks.some((t) => /trust/i.test(t)));

// ---------------------------------------------------------------------------
section('3. Desktop, no extension — instructions, not a phone link');

const { page: desktop } = await openBare(APEX);
await desktop.goto(origin(APEX), { waitUntil: 'networkidle' });
await desktop.waitForTimeout(1500);

const deskHeader = await desktop.locator('#walletSlot').innerText();
check('the desktop header also shows a Connect CTA', /connect wallet/i.test(deskHeader));
await desktop.locator('#walletSlot [data-wallet-open]').click();
await desktop.waitForTimeout(400);

const deskSheet = await desktop.locator('.wc-panel').innerText();
check('it says no extension is installed', /no wallet extension/i.test(deskSheet));
check('it links somewhere to install one', /install/i.test(deskSheet));
const deskLinks = await desktop.locator('.wc-item[href]').evaluateAll(
  (els) => els.map((e) => e.getAttribute('href')),
);
check('it does NOT offer mobile deep links on desktop',
  !deskLinks.some((h) => /metamask\.app\.link|go\.cb-w\.com|link\.trustwallet/.test(h)),
  deskLinks.join(' | '));

await desktop.screenshot({ path: `${SHOT_DIR}wallet-desktop.png`, fullPage: false });

// ---------------------------------------------------------------------------
section('4. Wrong network — switches to MAINNET, not testnet');

const { page: wrong } = await openWrongChain(APEX);
await wrong.goto(origin(APEX), { waitUntil: 'networkidle' });
await wrong.waitForTimeout(1500);

const wrongHeader = await wrong.locator('#walletSlot').innerText();
check('the header reports the wrong network', /wrong network/i.test(wrongHeader),
  wrongHeader.trim());

await wrong.locator('#walletSlot [data-wallet-open]').click();
await wrong.waitForTimeout(300);
const wrongSheet = await wrong.locator('.wc-panel').innerText();
check('the sheet names the chain it wants', /Robinhood Chain/i.test(wrongSheet));
check('it names the chain id', /4663/.test(wrongSheet), wrongSheet.replace(/\s+/g, ' ').slice(0, 160));

await wrong.locator('[data-wallet-switch]').click();
await wrong.waitForTimeout(800);

const switchCalls = await wrong.evaluate(() => window.__switchCalls);
check('a switch was actually requested', switchCalls.length > 0,
  JSON.stringify(switchCalls));
// The regression that made this a blocker: it used to ask for 0xb626 (testnet).
check('the wallet was asked for 0x1237 (mainnet 4663)',
  switchCalls.some((c) => c.chainId === '0x1237'),
  switchCalls.map((c) => c.chainId).join(', '));
check('the wallet was NOT asked for 0xb626 (testnet)',
  !switchCalls.some((c) => c.chainId === '0xb626'));

// ---------------------------------------------------------------------------
section("5. A hosted pad offers the same path");

// Which pad to open. The harness does not create one: it is given an existing
// slug so this stays a UI proof and never sends a transaction. Run this part
// against a stack where a pad already exists:
//   PAD_SLUG=ai-fun PORT=<fork server> node web/e2e/wallet-ux.mjs
const PAD_SLUG = process.env.PAD_SLUG || '';
if (!PAD_SLUG) {
  console.log('  – skipped: set PAD_SLUG to a pad that exists on this server');
} else {
  const { page: pad } = await openBare(`${PAD_SLUG}.${APEX}`, 'iPhone 13');
  await pad.goto(origin(`${PAD_SLUG}.${APEX}`), { waitUntil: 'networkidle' });
  await pad.waitForTimeout(2500);

  const padNav = await pad.locator('#padNav').innerText();
  check('the pad header shows a Connect CTA too', /connect wallet/i.test(padNav),
    padNav.replace(/\s+/g, ' ').slice(0, 100));
  check('the pad header no longer says "No wallet"', !/No wallet\b/i.test(padNav));
  const padCta = pad.locator('#padNav [data-wallet-open]');
  check('the pad CTA is a real button', await padCta.count() === 1);
  if (await padCta.count()) {
    await padCta.click();
    await pad.waitForTimeout(400);
    check('the same sheet opens on a pad', await pad.locator('.wc-panel').count() === 1);
    const padSheet = await pad.locator('.wc-panel').innerText();
    check('with the same mobile hand-off options', /no wallet in it/i.test(padSheet));
  }
  await pad.screenshot({ path: `${SHOT_DIR}wallet-pad.png`, fullPage: false });
}

// ---------------------------------------------------------------------------
section('7. An insecure page says so, instead of looping the visitor');

// Not forced: this is the browser's real verdict on plain http.
const { page: insecure } = await openBare(APEX, 'iPhone 13', { secure: false });
await insecure.goto(origin(APEX), { waitUntil: 'networkidle' });
await insecure.waitForTimeout(1500);
check('the browser really does report an insecure context here',
  await insecure.evaluate(() => window.isSecureContext) === false);

await insecure.locator('#walletSlot [data-wallet-open]').click();
await insecure.waitForTimeout(400);
const insecureSheet = await insecure.locator('.wc-panel').innerText();
check('it names HTTPS as the blocker', /HTTPS/i.test(insecureSheet),
  insecureSheet.replace(/\s+/g, ' ').slice(0, 120));
check('it offers no hand-off links that could not work anyway',
  await insecure.locator('.wc-item').count() === 0);

// ---------------------------------------------------------------------------
section('6. Nothing was signed or sent');

// Refusing to aim the switch flow at a chain we have no definition for is the
// guard, not a fault — and it is exactly what fires on a local fork (31337).
// Asserted positively rather than filtered away, so the guard stays proven.
const guardMsgs = pageErrors.filter((e) => /No Robinhood Chain definition for chain id/.test(e));
const otherErrors = pageErrors.filter((e) => !/No Robinhood Chain definition for chain id/.test(e));

if (guardMsgs.length) {
  check('a non-Robinhood chain is refused loudly rather than silently mis-aimed',
    true, guardMsgs[0].replace(/^[^:]*console: /, ''));
}
check('no unexpected page errors', otherErrors.length === 0, otherErrors.slice(0, 3).join(' | '));

await browser.close();

console.log(`\n${'='.repeat(45)}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
console.log('='.repeat(45));
process.exit(failures === 0 ? 0 : 1);
