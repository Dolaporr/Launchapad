/**
 * V1 BROWSER PROOF — the whole journey, against a Robinhood Chain MAINNET FORK.
 *
 *   build AI.fun -> sign -> hosted at ai.<apex> -> creator launches a token
 *   -> Onchain Launch Proof -> owner sees earnings and recruiting tools -> export
 *
 * WHAT IS REAL: the forked mainnet state, Uniswap's contracts, our deployed
 * factory/launcher/rewards, the pad created on chain, the token launched into a
 * real pool, and every number the pages render.
 *
 * WHAT IS SUBSTITUTED: `window.ethereum` (no extension exists in a headless
 * container) — a shim forwarding JSON-RPC to the forked node, which stubs no
 * responses. And DNS: Chromium is told to resolve *.launchpad.family to
 * localhost, so the browser sends REAL hostnames and REAL Host headers and the
 * server runs its genuine production host-routing path. Only name resolution is
 * local; nothing about the routing is faked.
 *
 * Usage: RPC_URL=… BASE_URL=… APEX=… OWNER=… CREATOR=… node web/e2e/v1-journey.mjs
 */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';

const { chromium } = pw;
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const PORT = process.env.PORT || '4173';
const APEX = process.env.APEX || 'launchpad.family';
/** Real hostnames. DNS is redirected at the browser, not the URL. */
const origin = (hostname) => `http://${hostname}:${PORT}`;
/** Must match the chain the server is configured for, or the app shows its wrong-chain gate. */
const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`;
const { OWNER, CREATOR } = process.env;

if (!OWNER || !CREATOR) throw new Error('OWNER and CREATOR are required.');

let failures = 0;
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const section = (t) => console.log(`\n=== ${t} ===`);

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
  window.__setAccount = (a) => {
    window.__account = a;
    (listeners.accountsChanged || []).forEach((fn) => fn([a]));
  };
  window.__account = account;
  window.ethereum = {
    isTestShim: true,
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts') { authorized = true; return [window.__account]; }
      if (method === 'eth_accounts') return authorized ? [window.__account] : [];
      if (method === 'eth_chainId') return chainIdHex;
      if (method.startsWith('wallet_')) return null;
      if (method === 'eth_sendTransaction') {
        return rpc(method, [{ ...params[0], from: window.__account }]);
      }
      if (method === 'personal_sign') {
        // The node signs for an unlocked account, exactly as a wallet would.
        return rpc('personal_sign', [params[0], window.__account]);
      }
      return rpc(method, params);
    },
    on(e, h) { (listeners[e] = listeners[e] || []).push(h); },
    removeListener(e, h) { listeners[e] = (listeners[e] || []).filter((f) => f !== h); },
  };
}

const browser = await chromium.launch({
  args: [
    // The browser genuinely requests ai-fun.launchpad.family; only resolution is local.
    `--host-resolver-rules=MAP ${APEX} 127.0.0.1, MAP *.${APEX} 127.0.0.1`,
    '--ignore-certificate-errors',
  ],
});

/** A page whose Host header names the given hostname, so server routing is real. */
async function openPage(hostname, account) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${hostname}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`${hostname} console: ${m.text()}`);
  });
  await page.addInitScript(providerShim, {
    rpcUrl: RPC_URL, account, chainIdHex: CHAIN_ID_HEX,
  });
  return { page, context };
}

const pageErrors = [];

/**
 * Connects through the real UI: the header CTA opens the connect sheet, and the
 * sheet's own button calls the wallet. Driving the wallet directly here would
 * skip the very path a visitor has to take.
 */
async function connectThroughUI(page) {
  await page.locator('[data-wallet-open]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.locator('[data-wallet-connect]').first().click().catch(() => {});
  await page.waitForTimeout(900);
}

// ---------------------------------------------------------------------------
section('1. The apex sells "build your own launchpad", not "launch a token"');

const { page: apex, context: apexCtx } = await openPage(APEX, OWNER);
await apex.goto(`${origin(APEX)}/`, { waitUntil: 'networkidle' });
await apex.waitForTimeout(1200);

const apexText = await apex.locator('body').innerText();
check('headline is about building a launchpad', /Build your own launchpad/i.test(apexText));
check('the hosted address is shown up front', new RegExp(`\\.${APEX.replace('.', '\\.')}`).test(apexText));
check('empty leaderboard states why, and does not look broken',
  /No launchpads have launched a token yet|Top launchpads/i.test(apexText));

// ---------------------------------------------------------------------------
section('2. Build AI.fun');

await apex.goto(`${origin(APEX)}/#create`, { waitUntil: 'networkidle' });
await apex.waitForTimeout(600);
await connectThroughUI(apex);

await apex.fill('#padName', 'AI.fun');
await apex.waitForTimeout(900); // slug suggestion + availability check

const slugEcho = await apex.locator('#slugEcho').innerText();
check('a web address is suggested from the name', slugEcho === 'ai-fun', slugEcho);
const hint = await apex.locator('#slugHint').innerText();
check('availability is confirmed before continuing', /Available/i.test(hint), hint);

await apex.fill('#padTagline', 'Launch AI tokens');
await apex.fill('#padDescription', 'A launchpad for AI projects.');
await apex.click('.swatch[data-accent="teal"]').catch(() => {});
await apex.waitForTimeout(300);

await apex.click('#toRules');
await apex.waitForTimeout(300);
const rulesText = await apex.locator('body').innerText();
check('launch rules explain OPEN vs OWNER_ONLY and say it is permanent',
  /Anyone can launch/i.test(rulesText) && /permanent/i.test(rulesText));

await apex.click('#policyOpen');
await apex.waitForTimeout(200);
await apex.click('#toModel');
await apex.waitForTimeout(1200);

const modelText = await apex.locator('body').innerText();
check('the launch model is shown BEFORE creating anything',
  /The launch model/i.test(modelText));
check('it leads with the creator receiving no tokens',
  /creator receives no tokens/i.test(modelText));
check('it says the supply becomes permanently locked liquidity',
  /permanently locked liquidity/i.test(modelText));
check('the split is shown as percentages of the creator-fee stream',
  /creator-fee stream only/i.test(modelText));
check('the split was read live from the contracts',
  /Read live from/i.test(modelText));

await apex.click('#toPreview');
await apex.waitForTimeout(500);
const previewText = await apex.locator('body').innerText();
check('a preview shows the pad at its future address',
  previewText.includes(`ai-fun.${APEX}`));
check('the preview shows the real zero state a visitor would see',
  /No launches yet/i.test(previewText));

await apex.click('#toCreate');
await apex.waitForTimeout(400);
await apex.click('#signCreate');

// The launch transaction plus server confirmation.
await apex.waitForFunction(() => {
  const d = window.__family?.state?.draft;
  return d?.created || d?.tx?.status === 'error';
}, null, { timeout: 180000 });

const draft = await apex.evaluate(() => ({
  created: Boolean(window.__family.state.draft.created),
  hostname: window.__family.state.draft.created?.hostname,
  padAddress: window.__family.state.draft.created?.pad?.padAddress,
  error: window.__family.state.draft.tx?.message,
}));
check('the launchpad was created on chain and confirmed', draft.created, draft.error || '');
check('it is hosted at its own address', draft.hostname === `ai-fun.${APEX}`, draft.hostname);

const createdText = await apex.locator('body').innerText();
check('the owner is told it is live and given the link', /is live/i.test(createdText));
check('and told it is not listed until its first launch',
  /not appear in the public directory/i.test(createdText));

// ---------------------------------------------------------------------------
section('3. The hosted pad foregrounds AI.fun, not Launchpad.family');

const { page: pad, context: padCtx } = await openPage(`ai-fun.${APEX}`, CREATOR);
await pad.goto(`${origin(`ai-fun.${APEX}`)}/`, { waitUntil: 'networkidle' });
await pad.waitForTimeout(2500);

const title = await pad.title();
check('the browser tab says the pad name', title === 'AI.fun', title);
const navText = await pad.locator('#padNav').innerText();
check('the masthead is the pad, not Launchpad.family', /AI\.fun/.test(navText));
check('Launchpad.family is not in the masthead', !/Launchpad\.family/i.test(navText));
const footText = await pad.locator('footer').innerText();
check('Launchpad.family appears once, as infrastructure', /infrastructure by/i.test(footText));
check('the footer disclaims endorsement', /does not endorse/i.test(footText));

const padBody = await pad.locator('body').innerText();
check('a pad with no launches has a real zero state',
  /No tokens have launched here yet/i.test(padBody));
check('the zero state invites the first launch', /first token/i.test(padBody));
check('accent branding was applied',
  (await pad.evaluate(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim())) === '#3FC8B4');

// ---------------------------------------------------------------------------
section('4. A creator launches a token through AI.fun');

await pad.click('a[href="/launch"]');
await pad.waitForTimeout(800);
await connectThroughUI(pad);

const launchText = await pad.locator('body').innerText();
check('supply is fixed and explained, not a free field',
  /Fixed by the market contracts/i.test(launchText));
check('the creator is told they receive no tokens',
  /receive no tokens/i.test(launchText));
check('and that it cannot be undone', /cannot be undone/i.test(launchText));

await pad.fill('#tokenName', 'Neural Coin');
await pad.fill('#tokenSymbol', 'NRL');
await pad.click('#doLaunch');
await pad.waitForFunction(() => {
  const d = window.__pad?.state?.launchDraft;
  return d?.created || d?.tx?.status === 'error';
}, null, { timeout: 240000 });

const launched = await pad.evaluate(() => ({
  token: window.__pad.state.launchDraft.created?.token,
  error: window.__pad.state.launchDraft.tx?.message,
}));
check('the token launched into a real pool', Boolean(launched.token), launched.error || '');

// ---------------------------------------------------------------------------
section('5. Onchain Launch Proof — and what it does NOT claim');

await pad.goto(`${origin(`ai-fun.${APEX}`)}/t/${launched.token}`, { waitUntil: 'networkidle' });
await pad.waitForTimeout(6000);

const tokenText = await pad.locator('body').innerText();
check('the label is Onchain Launch Proof', /Onchain Launch Proof/.test(tokenText));
check('it never says "Verified Token"', !/Verified Token/i.test(tokenText));
check('it states plainly that it is not a safety check',
  /not a safety check/i.test(tokenText));
check('it names what is actually proven',
  /liquidity is locked/i.test(tokenText) && /fee split/i.test(tokenText));
check('the token is framed as launched on the pad', /Launched on AI\.fun/i.test(tokenText));
check('the full lifecycle is shown',
  /Locked liquidity/.test(tokenText) && /Revenue split/.test(tokenText));
check('swapped ETH is not presented as revenue', /This is activity, not income/.test(tokenText));

// Every step badge must agree with the banner. A page that claims all checks
// passed while a step still reads "unknown" is telling the reader two different
// things, and the reader is right not to believe either.
const stepBadges = await pad.locator('.step-head .pill').allInnerTexts();
check('every lifecycle step is resolved, none left unknown',
  stepBadges.length > 0 && !stepBadges.some((t) => /unknown/i.test(t)),
  stepBadges.join(', '));
check('the pool section states the pair, fee and hook it actually read',
  /25 bps/.test(tokenText) && /none \(hookless\)/.test(tokenText));
// The banner names the block the reconciliation describes, so the reader can go
// and check it. An em dash there means the page reconciled against nothing.
const bannerText = await pad.locator('.notice.ok').first().innerText().catch(() => '');
check('the banner names the block it reconciled at',
  /at block \d+/.test(bannerText), bannerText.slice(0, 120));

// ---------------------------------------------------------------------------
section('6. The owner sees earnings and recruiting tools');

const { page: owner, context: ownerCtx } = await openPage(`ai-fun.${APEX}`, OWNER);
await owner.goto(`${origin(`ai-fun.${APEX}`)}/owner`, { waitUntil: 'networkidle' });
await owner.waitForTimeout(1200);
await connectThroughUI(owner);
await owner.waitForTimeout(1800);

const ownerText = await owner.locator('body').innerText();
check('the owner console is reachable', /Owner tools/i.test(ownerText));
check('earnings are shown as claimable', /Claimable now/i.test(ownerText));
check('a creator invite link is offered', /Recruit creators/i.test(ownerText));
check('an embeddable launch button is offered', /Embed a launch button/i.test(ownerText));

const invite = await owner.locator('#inviteLink').inputValue();
check('the invite link points at the pad', invite.includes(`ai-fun.${APEX}/launch`), invite);
const embed = await owner.locator('#embedSnippet').inputValue();
check('the embed snippet names the pad', /Launch on AI\.fun/.test(embed), embed);

// ---------------------------------------------------------------------------
section('7. Export is a skin, and inherits no endorsement');

const exportPreview = await owner.evaluate(async () => {
  const r = await fetch('/api/export/ai-fun/preview');
  return r.json();
});
check('an export can be generated', Array.isArray(exportPreview.files), '');
check('it contains a config, README and client',
  ['pad.config.json', 'README.md', 'index.html', 'app.js'].every(
    (f) => exportPreview.files.some((x) => x.path === f),
  ));
check('GitHub creation is reported unconfigured rather than claimed',
  exportPreview.github?.configured === false && exportPreview.github?.proven === false);

// ---------------------------------------------------------------------------
section('8. The pad is now discoverable, and ranked on creators');

await apex.goto(`${origin(APEX)}/#pads`, { waitUntil: 'networkidle' });
await apex.waitForTimeout(3000);
const dirText = await apex.locator('body').innerText();
check('the pad appears in the directory once it has a launch', /AI\.fun/.test(dirText));

await apex.goto(`${origin(APEX)}/`, { waitUntil: 'networkidle' });
await apex.waitForTimeout(3000);
const homeText = await apex.locator('body').innerText();
check('the leaderboard ranks by creators, not volume',
  /Ranked by creators, not volume/i.test(homeText));
check('survival shows "not enough history yet" for a new launch',
  /Not enough history yet/i.test(homeText));
check('activity metrics are disclaimed as not safety metrics',
  /not safety metrics/i.test(homeText));

// This harness runs on a local fork (31337), which is deliberately NOT one of the
// Robinhood chains. The client refusing to aim its switch flow at an unknown chain
// — loudly — is the guard working, so it is excluded here rather than treated as a
// defect. Everything else still fails the run.
const expectedOnFork = /No Robinhood Chain definition for chain id/;
const unexpectedErrors = pageErrors.filter((e) => !expectedOnFork.test(e));
check('no uncaught page errors', unexpectedErrors.length === 0,
  unexpectedErrors.slice(0, 3).join(' | '));

await apex.screenshot({ path: new URL('./v1-apex.png', import.meta.url).pathname, fullPage: true });
await pad.screenshot({ path: new URL('./v1-pad.png', import.meta.url).pathname, fullPage: true });
await owner.screenshot({ path: new URL('./v1-owner.png', import.meta.url).pathname, fullPage: true });

await apexCtx.close(); await padCtx.close(); await ownerCtx.close();
await browser.close();

console.log(`\n${'='.repeat(45)}`);
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
console.log('='.repeat(45));
if (failures) process.exit(1);
