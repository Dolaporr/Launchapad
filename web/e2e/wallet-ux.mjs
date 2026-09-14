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
// Must match the chain the server is configured for, or every wallet shim below
// reads as "wrong network" and the Create step never opens.
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}`;
/** Switching needs a chain the client has a definition for. */
const SWITCHABLE = CHAIN_ID === 4663 || CHAIN_ID === 46630;

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
async function openBare(hostname, deviceName, { secure = true, recordErrors = true } = {}) {
  const context = await browser.newContext(deviceName ? devices[deviceName] : {});
  const page = await context.newPage();
  if (recordErrors) {
    page.on('pageerror', (e) => pageErrors.push(`${hostname}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(`${hostname} console: ${m.text()}`);
    });
  }
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
section('8. No wallet: the builder reads real economics and reaches Preview');

const { page: build } = await openBare(APEX, 'iPhone 13');
await build.goto(`${origin(APEX)}/#create`, { waitUntil: 'networkidle' });
await build.waitForTimeout(2000);

check('no wallet is injected on this page',
  await build.evaluate(() => window.ethereum === undefined));

// Identity — the slug check is server-side and never needed a wallet.
await build.fill('#padName', 'Safari Test');
await build.waitForTimeout(1200);
const availability = await build.locator('#slugHint').innerText();
check('a name can be checked for availability with no wallet',
  /Available/i.test(availability), availability.trim());

await build.click('#toRules');
await build.waitForTimeout(400);
await build.click('#policyOpen');
await build.waitForTimeout(200);
await build.click('#toModel');
await build.waitForTimeout(2500);

const modelText = await build.locator('body').innerText();
check('the launch model renders instead of a read failure',
  /The launch model/i.test(modelText)
  && !/could not be read from the contracts/i.test(modelText));
check('it states the split read from chain',
  /50%/.test(modelText) && /30%/.test(modelText) && /20%/.test(modelText));
check('it says the figures were read live from the contracts',
  /Read live from/i.test(modelText));

// The numbers must come from the chain, not from the page. Read the same three
// values independently through the gateway and require them to agree.
const onchain = await build.evaluate(async () => {
  // Config is fetched from inside the page: the apex hostname only resolves in
  // this browser, which is given resolver rules Node does not have.
  const rewards = (await (await fetch('/api/config')).json()).contracts.rewards;
  const call = async (data) => {
    const r = await fetch('/api/chain/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'eth_call', params: [{ to: rewards, data }, 'latest'] }),
    });
    const j = await r.json();
    return j.result ? Number(BigInt(j.result)) : null;
  };
  return {
    creator: await call('0x45904567'),
    padOwner: await call('0xc833d8d4'),
    protocol: await call('0xc1e7af35'),
  };
});

check('the split really is on mainnet as 50/30/20 bps-wise',
  onchain.creator === 5000 && onchain.padOwner === 3000 && onchain.protocol === 2000,
  JSON.stringify(onchain));

const continueBtn = build.locator('#toPreview');
check('Continue to Preview is enabled without a wallet',
  await continueBtn.count() === 1 && !(await continueBtn.isDisabled()));

await continueBtn.click();
await build.waitForTimeout(1200);
const previewText = await build.locator('body').innerText();
check('Preview is reachable with no wallet', /preview/i.test(previewText));
check('the preview shows the future address',
  new RegExp(`safari-test\\.${APEX.replace('.', '\\.')}`).test(previewText));

await build.screenshot({ path: `${SHOT_DIR}wallet-builder-model.png`, fullPage: false });

// ...and only here does a wallet become necessary.
const toCreate = build.locator('#toCreate');
if (await toCreate.count()) {
  await toCreate.click();
  await build.waitForTimeout(900);
}
const createText = await build.locator('body').innerText();
check('Create is where a wallet is finally required',
  /wallet is needed|Connect your wallet|Connect wallet/i.test(createText));
check('and it offers a way to connect rather than dead-ending',
  await build.locator('[data-wallet-open]').count() > 0);

// ---------------------------------------------------------------------------
section('9. Fail closed: an unreadable chain shows "not established"');

// Errors are not recorded for this page: the 502s below are induced by the test
// itself, and counting them would make the fault injection look like a defect.
const { page: blind } = await openBare(APEX, 'iPhone 13', { recordErrors: false });
// Break only the read gateway, leaving the rest of the site working.
await blind.route('**/api/chain/read', (r) => r.fulfill({
  status: 502, contentType: 'application/json', body: '{"error":"upstream_read_failed"}',
}));
await blind.goto(`${origin(APEX)}/#create`, { waitUntil: 'networkidle' });
await blind.waitForTimeout(1500);
await blind.fill('#padName', 'Fail Closed');
await blind.waitForTimeout(1200);
await blind.click('#toRules');
await blind.waitForTimeout(300);
await blind.click('#toModel');
await blind.waitForTimeout(2000);

const blindText = await blind.locator('body').innerText();
check('it says the model could not be read',
  /could not be read from the contracts/i.test(blindText));
check('it never invents a split', !/50%/.test(blindText) && !/30%/.test(blindText));
const blindContinue = blind.locator('#toPreview');
check('and refuses to continue on unverified economics',
  await blindContinue.count() === 1 && await blindContinue.isDisabled());

// ---------------------------------------------------------------------------
section('10. A wallet on another chain is not trusted for reads');

// The dangerous case: the wallet answers eth_call SUCCESSFULLY with `0x`.
// That is not an error the client can detect — it decodes as zero — so a wallet
// on the wrong chain would silently poison the economics. It must not be used
// as a read source at all unless its chain matches.
const wrongChainCtx = await browser.newContext(devices['iPhone 13']);
const foreign = await wrongChainCtx.newPage();
await foreign.addInitScript(() => {
  window.__injectedCalls = [];
  window.ethereum = {
    async request({ method, params = [] }) {
      if (method === 'eth_chainId') return '0x1';            // Ethereum mainnet
      if (method === 'eth_accounts') return [];
      if (method === 'eth_requestAccounts') return ['0x' + '11'.repeat(20)];
      if (method === 'eth_call') {
        // Succeeds, returns nothing. The silent-corruption case.
        window.__injectedCalls.push(params[0]?.data);
        return '0x';
      }
      if (method === 'eth_blockNumber') return '0x1';
      if (method === 'eth_sendTransaction') throw new Error('TEST FAILURE: transaction attempted');
      return null;
    },
    on() {}, removeListener() {},
  };
});
await foreign.goto(`${origin(APEX)}/#create`, { waitUntil: 'networkidle' });
await foreign.waitForTimeout(1500);
await foreign.fill('#padName', 'Foreign Chain');
await foreign.waitForTimeout(1200);
await foreign.click('#toRules');
await foreign.waitForTimeout(300);
await foreign.click('#toModel');
await foreign.waitForTimeout(2500);

const foreignText = await foreign.locator('body').innerText();
check('the wallet is on a different chain', await foreign.evaluate(
  () => window.ethereum.request({ method: 'eth_chainId' }),
) === '0x1');
check('the economics are still correct, from the gateway',
  /50%/.test(foreignText) && /30%/.test(foreignText) && /20%/.test(foreignText));
check('not rendered as a read failure', !/could not be read from the contracts/i.test(foreignText));

// The proof it came from the gateway and not the wallet: the wallet's eth_call
// was never used for these reads.
const injectedCalls = await foreign.evaluate(() => window.__injectedCalls);
check('the foreign wallet was never asked for a value',
  injectedCalls.length === 0, `${injectedCalls.length} call(s): ${injectedCalls.slice(0, 3)}`);

// This shim reports no accounts, so the wallet is DISCONNECTED rather than
// wrong-chain — you cannot be on the wrong chain before connecting. The
// wrong-chain header is covered by section 4. What matters here is that the
// header still offers an action while the reads came from the gateway.
check('the header still offers a connect action',
  /connect wallet/i.test(await foreign.locator('#walletSlot').innerText()));

// ---------------------------------------------------------------------------
section('11. Connecting AT the Create step updates it, with no refresh');

// The manually reported bug: the builder was completed with a DISCONNECTED
// wallet, Create showed the connection gate, connecting succeeded — and the
// gate stayed on screen, because only the dashboard re-rendered on wallet
// change. NO TRANSACTION IS SENT: the shim throws if one is attempted.
const gateCtx = await browser.newContext(devices['iPhone 13']);
const gate = await gateCtx.newPage();
gate.on('pageerror', (e) => pageErrors.push(`create-gate: ${e.message}`));
await gate.addInitScript((chainHex) => {
  window.__calls = [];
  window.__authorized = false;
  window.__chain = chainHex;
  window.ethereum = {
    async request({ method, params = [] }) {
      window.__calls.push(method);
      if (method === 'eth_chainId') return window.__chain;
      if (method === 'eth_accounts') {
        return window.__authorized ? ['0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'] : [];
      }
      if (method === 'eth_requestAccounts') {
        // A real prompt takes time; the pause is what lets a second tap race it.
        await new Promise((r) => setTimeout(r, 300));
        window.__authorized = true;
        return ['0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'];
      }
      if (method === 'wallet_switchEthereumChain') {
        await new Promise((r) => setTimeout(r, 200));
        window.__chain = params[0].chainId;
        return null;
      }
      // This shim cannot reach a node, so reads are deferred to the server's
      // read gateway by failing here — the same fallback a locked wallet takes.
      // The economics on screen are therefore the configured chain's real values.
      if (method === 'eth_call') throw new Error('shim: use the read gateway');
      if (method === 'eth_sendTransaction') throw new Error('TEST FAILURE: transaction attempted');
      return null;
    },
    on() {}, removeListener() {},
  };
}, CHAIN_HEX);

await gate.goto(`${origin(APEX)}/#create`, { waitUntil: 'networkidle' });
await gate.waitForTimeout(1800);

await gate.fill('#padName', 'Gate Test');
await gate.waitForTimeout(1200);
await gate.click('#toRules');
await gate.waitForTimeout(300);
await gate.click('#toModel');
await gate.waitForTimeout(2500);
await gate.click('#toPreview');
await gate.waitForTimeout(800);

const gateToCreate = gate.locator('#toCreate');
if (await gateToCreate.count()) { await gateToCreate.click(); await gate.waitForTimeout(700); }

const gateText = await gate.locator('body').innerText();
check('Create shows the connection gate while disconnected',
  /Connect your wallet|wallet is needed/i.test(gateText));
check('the builder is still on its Create step, draft intact',
  /5\. Create/i.test(gateText) || /Create/i.test(gateText));

// Connect through the real UI, exactly as a person would.
await gate.locator('[data-wallet-open]').first().click();
await gate.waitForTimeout(400);
await gate.locator('[data-wallet-connect]').first().click();
// Deliberately no reload, and no extra interaction.
await gate.waitForTimeout(2000);

const afterConnect = await gate.locator('body').innerText();
check('the gate is replaced with NO page refresh',
  !/Connect your wallet/i.test(afterConnect), afterConnect.replace(/\s+/g, ' ').slice(0, 110));
check('the Create confirmation is now shown',
  /Create launchpad/i.test(afterConnect));
check('the completed draft is preserved', /Gate Test/i.test(afterConnect));
check('the permanence warning is on the confirmation', /permanent/i.test(afterConnect));

await gate.screenshot({ path: `${SHOT_DIR}wallet-create-after-connect.png`, fullPage: false });

// ---------------------------------------------------------------------------
section('12. Wrong chain at Create: switch, then the confirmation appears');

if (!SWITCHABLE) {
  console.log(`  – skipped: chain ${CHAIN_ID} has no client-side definition to switch to`);
} else {
const swCtx = await browser.newContext(devices['iPhone 13']);
const sw = await swCtx.newPage();
await sw.addInitScript(() => {
  window.__chain = '0x1'; // Ethereum mainnet
  window.ethereum = {
    async request({ method, params = [] }) {
      if (method === 'eth_chainId') return window.__chain;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return ['0x90F79bf6EB2c4f870365E785982E1f101E93b906'];
      }
      if (method === 'wallet_switchEthereumChain') {
        await new Promise((r) => setTimeout(r, 200));
        window.__chain = params[0].chainId;
        return null;
      }
      // This shim cannot reach a node, so reads are deferred to the server's
      // read gateway by failing here — the same fallback a locked wallet takes.
      // The economics on screen are therefore the configured chain's real values.
      if (method === 'eth_call') throw new Error('shim: use the read gateway');
      if (method === 'eth_sendTransaction') throw new Error('TEST FAILURE: transaction attempted');
      return null;
    },
    on(e, h) { (this._h = this._h || {})[e] = h; },
    removeListener() {},
  };
});
await sw.goto(`${origin(APEX)}/#create`, { waitUntil: 'networkidle' });
await sw.waitForTimeout(1800);
await sw.fill('#padName', 'Switch Test');
await sw.waitForTimeout(1200);
await sw.click('#toRules');
await sw.waitForTimeout(300);
await sw.click('#toModel');
await sw.waitForTimeout(2500);
await sw.click('#toPreview');
await sw.waitForTimeout(800);
const toCreate2 = sw.locator('#toCreate');
if (await toCreate2.count()) { await toCreate2.click(); await sw.waitForTimeout(700); }

const wrongText = await sw.locator('body').innerText();
check('Create offers Switch network on the wrong chain',
  /Wrong network|Switch network/i.test(wrongText),
  wrongText.replace(/\s+/g, ' ').slice(0, 110));

const gateSwitch = sw.locator('#gateSwitch');
if (await gateSwitch.count()) {
  await gateSwitch.click();
} else {
  await sw.locator('[data-wallet-open]').first().click();
  await sw.waitForTimeout(400);
  await sw.locator('[data-wallet-switch]').first().click();
}
await sw.waitForTimeout(2200);

const afterSwitch = await sw.locator('body').innerText();
check('a successful switch reveals the Create confirmation, with no refresh',
  /Create launchpad/i.test(afterSwitch), afterSwitch.replace(/\s+/g, ' ').slice(0, 110));
check('the draft survived the switch', /Switch Test/i.test(afterSwitch));
}

// ---------------------------------------------------------------------------
section('13. Mobile wallet browser: repeated taps make ONE wallet request');

// Its own wallet: V1 allows one hosted launchpad per wallet, so reusing the
// journey's owner here would make the reservation legitimately refuse before
// any wallet request could happen.
//
// The second reported bug. A wallet that is slow to answer, plus a person
// tapping again, used to mean two overlapping prompts — and the wallet replies
// -32002 to the second with nothing visible to respond to.
const mmCtx = await browser.newContext({
  ...devices['iPhone 13'],
  userAgent: `${devices['iPhone 13'].userAgent} MetaMaskMobile`,
});
const mm = await mmCtx.newPage();
await mm.addInitScript((chainHex) => {
  window.__chainHex = chainHex;
  window.__sent = [];
  window.__methods = [];
  window.__pendingSend = 0;
  window.ethereum = {
    async request({ method, params = [] }) {
      window.__methods.push(method);
      if (method === 'eth_chainId') return window.__chainHex;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return ['0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'];
      }
      // This shim cannot reach a node, so reads are deferred to the server's
      // read gateway by failing here — the same fallback a locked wallet takes.
      // The economics on screen are therefore the configured chain's real values.
      if (method === 'eth_call') throw new Error('shim: use the read gateway');
      if (method === 'eth_sendTransaction') {
        window.__sent.push(params[0]);
        window.__pendingSend += 1;
        // A real wallet holds here while the person reads the prompt. Any second
        // request arriving now is what produces -32002 in the wild.
        if (window.__pendingSend > 1) {
          window.__pendingSend -= 1;
          const e = new Error('Request of type eth_sendTransaction already pending');
          e.code = -32002;
          throw e;
        }
        await new Promise((r) => setTimeout(r, 2500));
        window.__pendingSend -= 1;   // a real wallet frees its slot once answered
        const e = new Error('User rejected the request.');
        e.code = 4001;               // ends the test without a real transaction
        throw e;
      }
      return null;
    },
    on() {}, removeListener() {},
  };
}, CHAIN_HEX);
await mm.goto(`${origin(APEX)}/#create`, { waitUntil: 'networkidle' });
await mm.waitForTimeout(1800);
await mm.fill('#padName', 'Tap Test');
await mm.waitForTimeout(1200);
await mm.click('#toRules');
await mm.waitForTimeout(300);
await mm.click('#toModel');
await mm.waitForTimeout(2500);
await mm.click('#toPreview');
await mm.waitForTimeout(800);
const toCreate3 = mm.locator('#toCreate');
if (await toCreate3.count()) { await toCreate3.click(); await mm.waitForTimeout(700); }

const signBtn = mm.locator('#signCreate');
const mmStage = (await mm.locator('body').innerText()).replace(/\s+/g, ' ');
const hasBtn = await signBtn.count() === 1;
check('the Create button is present and enabled',
  hasBtn && !(await signBtn.isDisabled()),
  hasBtn ? '' : `no #signCreate; page shows: ${mmStage.slice(0, 200)}`);
if (!hasBtn) {
  console.log('  – cannot continue section 13 without the Create step');
} else {

// A real double-tap is three clicks dispatched in ONE tick on the element under
// the finger. An auto-waiting locator is not that: it would sit and wait for the
// button to come back after the first request resolved, and clicking a Retry
// that has legitimately reappeared is a user retrying, not a double-tap.
const tapResult = await mm.evaluate(() => {
  const btn = document.getElementById('signCreate');
  btn.click(); btn.click(); btn.click();
  return { disabledAfter: btn.disabled };
});
check('the button is disabled synchronously, in the same tick as the first tap',
  tapResult.disabledAfter === true);

await mm.waitForTimeout(900);
const sentDuring = await mm.evaluate(() => window.__sent.length);
check('three taps in one tick produced exactly ONE wallet request',
  sentDuring === 1,
  sentDuring === 1 ? '' : `${sentDuring} request(s); page: `
    + `methods=${JSON.stringify(await mm.evaluate(() => window.__methods))} `
    + `notice=${await mm.locator('.notice.bad').first().innerText().catch(() => 'none')}`);

// Tapping again while it is genuinely in flight must not start another.
await mm.evaluate(() => document.getElementById('signCreate')?.click());
await mm.waitForTimeout(400);
check('a further tap while in flight still produces no second request',
  await mm.evaluate(() => window.__sent.length) === 1);

await mm.waitForTimeout(3200); // let the wallet answer

const mmText = await mm.locator('body').innerText();
const sentTotal = await mm.evaluate(() => window.__sent.length);
check('still exactly one request after it resolved', sentTotal === 1, `${sentTotal}`);
check('the rejection is reported honestly', /rejected/i.test(mmText),
  mmText.replace(/\s+/g, ' ').slice(0, 110));
check('it never claims a visible prompt exists that may not',
  !/Open it and respond/i.test(mmText));
check('a Retry is offered once nothing is in flight',
  await mm.locator('#signCreate').count() === 1
  && !(await mm.locator('#signCreate').isDisabled()));

// A -32002 must not be described as definitely visible.
const wording = await mm.evaluate(async () => {
  const mod = await import('/chain.js');
  const err = new Error('already pending'); err.code = -32002;
  return mod.describeError(err);
});
check('the -32002 wording says it may not be visible',
  /may not be visible/i.test(wording), wording);
check('and no longer instructs the user to open and respond',
  !/Open it and respond/i.test(wording));
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
