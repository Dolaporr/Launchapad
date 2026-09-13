// ---------------------------------------------------------------------------
// A hosted launchpad — e.g. ai.launchpad.family.
//
// This is AI.fun, not a Launchpad.family profile page. The pad's own name, logo
// and colour are the masthead; Launchpad.family appears once in the footer as
// infrastructure. Every route below is the pad's, and the copy speaks as the pad.
//
//   /          pad home: what it is, its launches, how to launch
//   /launch    creator launch flow
//   /owner     owner console: earnings, recruiting, export
//   /t/<token> a launch, with its Onchain Launch Proof
// ---------------------------------------------------------------------------

import { api } from './api.js';
import * as wallet from './wallet.js';
import { WALLET } from './wallet.js';
import { readSplit, creatorEconomicsSummary, MARKET_FACTS } from './economics.js';
import { survivalCell } from './leaderboard.js';
import { buildLaunchState } from '../launchState.js';
import { renderLaunchDetail } from '../launchDetail.js';
import * as chain from '../chain.js';

const app = () => document.getElementById('app');
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = {
  config: null,
  pad: null,
  split: null,
  launches: [],
  earnings: null,
  error: null,
  launchDraft: { name: '', symbol: '', tx: null, created: null },
};

// --- routing ---------------------------------------------------------------

function currentRoute() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const token = path.match(/^\/t\/(0x[0-9a-fA-F]{40})$/);
  if (token) return { name: 'token', token: token[1] };
  if (path === '/launch') return { name: 'launch' };
  if (path === '/owner') return { name: 'owner' };
  return { name: 'home' };
}

function navigate(path) {
  history.pushState({}, '', path);
  render();
}

// --- chrome ----------------------------------------------------------------

function renderNav() {
  const nav = document.getElementById('padNav');
  if (!nav || !state.pad) return;
  const b = state.pad.branding;
  const w = wallet.wallet;
  const isOwner = wallet.sameAddress(w.address, state.pad.owner);

  const walletBit = w.status === WALLET.READY
    ? `<span class="mono small muted">${esc(wallet.shortAddress(w.address))}</span>`
    : w.status === WALLET.NO_PROVIDER
      ? '<span class="muted small">No wallet</span>'
      : `<button class="btn small" id="navConnect">Connect wallet</button>`;

  nav.innerHTML = `
    <a class="pad-brand" href="/" data-nav>
      <span class="pad-mark">${b.logo
    ? `<img src="${esc(b.logo)}" alt="" />`
    : esc((b.displayName || state.pad.slug).slice(0, 2).toUpperCase())}</span>
      <div>
        <h1 class="pad-title">${esc(b.displayName)}</h1>
        ${b.tagline ? `<p class="pad-tagline">${esc(b.tagline)}</p>` : ''}
      </div>
    </a>
    <nav class="fam-nav-links">
      <a href="/" data-nav>Launches</a>
      ${state.pad.onchain?.launchPolicy === 1 || isOwner
    ? '<a href="/launch" data-nav>Launch a token</a>' : ''}
      ${isOwner ? '<a href="/owner" data-nav>Owner</a>' : ''}
      ${walletBit}
    </nav>`;

  document.getElementById('navConnect')?.addEventListener('click', () => wallet.connect());
  nav.querySelectorAll('[data-nav]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.getAttribute('href'));
    });
  });
}

function applyBranding() {
  if (!state.pad) return;
  const accent = state.pad.branding.accentColor;
  document.documentElement.style.setProperty('--accent', accent);
  // The tab says the pad's name, not ours.
  document.title = state.pad.branding.displayName;
  const familyLink = document.getElementById('familyLink');
  if (familyLink) familyLink.href = `${location.protocol}//${state.config.apex}`;
}

// --- render ----------------------------------------------------------------

async function render() {
  if (state.error) {
    app().innerHTML = `<div class="notice bad"><strong>${esc(state.error)}</strong></div>`;
    return;
  }
  if (!state.pad) { app().innerHTML = '<div class="fam-boot">Loading…</div>'; return; }

  renderNav();
  const route = currentRoute();
  if (route.name === 'launch') return renderLaunch();
  if (route.name === 'owner') return renderOwner();
  if (route.name === 'token') return renderToken(route.token);
  return renderHome();
}

function listingBanner() {
  const l = state.pad.listing;
  if (l.status === 'DELISTED') {
    return `<div class="notice bad" style="margin-bottom:18px">
      <strong>This launchpad is not listed by Launchpad.family.</strong>
      <p class="small" style="margin:6px 0 0">
        It has been removed from our directory and recommendations. Its onchain history is
        unchanged and remains independently verifiable. Being unlisted is our distribution
        decision — it is not a statement that anything here is or is not safe.
      </p>
    </div>`;
  }
  return '';
}

function renderHome() {
  const pad = state.pad;
  const policy = pad.onchain?.launchPolicyLabel;
  const canLaunch = pad.onchain?.launchPolicy === 1;

  app().innerHTML = `${listingBanner()}
    ${pad.branding.description
    ? `<p style="max-width:620px;font-size:16px">${esc(pad.branding.description)}</p>` : ''}

    <div class="row" style="margin:18px 0 26px">
      ${canLaunch
    ? '<a class="btn primary" href="/launch" data-nav>Launch a token here</a>'
    : `<span class="pill pill-owner">${esc(policy || '')}</span>
       <span class="muted small">Only the owner of this launchpad can launch tokens.</span>`}
      ${Object.entries(pad.branding.links || {}).map(([key, url]) => `
        <a class="btn ghost small" href="${esc(url)}" target="_blank" rel="noopener nofollow">
          ${esc(key)}</a>`).join('')}
    </div>

    <div id="launchesSlot"><div class="fam-boot">Reading launches from chain…</div></div>`;

  app().querySelectorAll('[data-nav]').forEach((link) => {
    link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.getAttribute('href')); });
  });
  loadLaunches();
}

async function loadLaunches() {
  const slot = document.getElementById('launchesSlot');
  if (!slot) return;
  const m = state.pad.metrics;

  if (!m) {
    slot.innerHTML = `<div class="notice warn">
      <strong>Launch data is unavailable.</strong>
      <p class="small" style="margin:6px 0 0">This launchpad's launches could not be read from
        chain right now. Nothing is shown rather than showing an empty list that would imply
        there are none.</p></div>`;
    return;
  }

  if (m.totalLaunches === 0) {
    slot.innerHTML = `<div class="zero">
      <h3>No tokens have launched here yet</h3>
      <p>${state.pad.onchain?.launchPolicy === 1
    ? 'This launchpad is open — anyone can be the first to launch through it.'
    : 'The owner has not launched a token here yet.'}</p>
      ${state.pad.onchain?.launchPolicy === 1
    ? '<a class="btn primary" href="/launch" data-nav>Launch the first token</a>' : ''}
    </div>
    <p class="muted small" style="margin-top:16px">
      This launchpad will not appear in the Launchpad.family directory or leaderboard until its
      first token launches.
    </p>`;
    app().querySelectorAll('[data-nav]').forEach((link) => {
      link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.getAttribute('href')); });
    });
    return;
  }

  slot.innerHTML = `
    <div class="grid three" style="margin-bottom:20px">
      <div class="metric"><span class="label">Launches</span>
        <span class="value accent">${esc(String(m.totalLaunches))}</span></div>
      <div class="metric"><span class="label">Unique creators</span>
        <span class="value">${esc(String(m.uniqueCreators))}</span></div>
      <div class="metric"><span class="label">Repeat creators</span>
        <span class="value">${esc(String(m.repeatCreators))}</span></div>
      <div class="metric"><span class="label">7-day activity</span>${survivalCell(m.survival7d)}</div>
      <div class="metric"><span class="label">30-day activity</span>${survivalCell(m.survival30d)}</div>
    </div>
    <p class="muted small">
      Activity shows whether launches still had independent traders later. It is not a safety or
      quality measure and says nothing about whether a token is legitimate.
    </p>`;
}

// --- creator launch flow ---------------------------------------------------

function renderLaunch() {
  const pad = state.pad;
  const d = state.launchDraft;
  const w = wallet.wallet;

  if (pad.onchain?.launchPolicy !== 1 && !wallet.sameAddress(w.address, pad.owner)) {
    app().innerHTML = `<div class="zero">
      <h3>This launchpad is not open</h3>
      <p>Only ${esc(pad.branding.displayName)}'s owner can launch tokens here.</p>
    </div>`;
    return;
  }

  if (d.created) {
    const url = `/t/${d.created.token}`;
    app().innerHTML = `<div class="notice ok"><strong>$${esc(d.symbol)} is live on ${esc(pad.branding.displayName)}.</strong></div>
      <div class="card" style="margin-top:16px">
        <h2>${esc(d.name)}</h2>
        <p class="muted small mono">${esc(d.created.token)}</p>
        <div class="row" style="margin-top:14px">
          <a class="btn primary" href="${esc(url)}" data-nav>View the launch</a>
        </div>
      </div>`;
    app().querySelectorAll('[data-nav]').forEach((link) => {
      link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.getAttribute('href')); });
    });
    return;
  }

  app().innerHTML = `<h2>Launch a token on ${esc(pad.branding.displayName)}</h2>
    <div class="grid two" style="margin-top:16px">
      <div class="card">
        <div class="field">
          <label for="tokenName">Token name</label>
          <input id="tokenName" type="text" maxlength="64" value="${esc(d.name)}" placeholder="My Token" />
        </div>
        <div class="field">
          <label for="tokenSymbol">Symbol</label>
          <input id="tokenSymbol" type="text" maxlength="11" value="${esc(d.symbol)}" placeholder="MYT" />
        </div>
        <div class="field">
          <label>Supply</label>
          <input type="text" value="${esc(MARKET_FACTS.totalSupply)}" disabled />
          <span class="hint">Fixed by the market contracts. Every launch is the same size.</span>
        </div>
        ${d.tx?.status === 'error'
    ? `<div class="notice bad"><strong>That did not go through.</strong>
         <p class="small" style="margin:6px 0 0">${esc(d.tx.message)}</p></div>` : ''}
        <button class="btn primary" id="doLaunch"
          ${w.status === WALLET.READY && d.tx?.status !== 'pending' ? '' : 'disabled'}>
          ${d.tx?.status === 'pending' ? 'Launching…' : 'Launch token'}
        </button>
        ${w.status !== WALLET.READY
    ? '<p class="muted small" style="margin-top:10px">Connect your wallet to launch.</p>' : ''}
      </div>

      <div class="card">
        <h3>What happens</h3>
        <ol class="muted small" style="padding-left:18px;margin:8px 0 0">
          <li>Your token is created with a fixed supply of ${esc(MARKET_FACTS.totalSupply)}.</li>
          <li>The entire supply goes into a new Uniswap pool as
              <strong>permanently locked liquidity</strong>. You receive no tokens.</li>
          <li>You earn a share of the trading fees, for as long as it trades.</li>
        </ol>
        <div style="margin-top:14px">${creatorEconomicsSummary(state.split)}</div>
        <p class="muted small">
          This cannot be undone. The liquidity cannot be withdrawn by you, by
          ${esc(pad.branding.displayName)}, or by Launchpad.family.
        </p>
      </div>
    </div>`;

  document.getElementById('tokenName')?.addEventListener('input', (e) => { d.name = e.target.value; });
  document.getElementById('tokenSymbol')?.addEventListener('input', (e) => { d.symbol = e.target.value; });
  document.getElementById('doLaunch')?.addEventListener('click', submitLaunch);
}

async function submitLaunch() {
  const d = state.launchDraft;
  const w = wallet.wallet;
  const launcher = state.config.contracts.launcher;

  if (!d.name.trim() || !d.symbol.trim()) {
    d.tx = { status: 'error', message: 'A name and symbol are required.' };
    return renderLaunch();
  }
  if (!launcher) {
    d.tx = { status: 'error', message: 'No market launcher is configured for this deployment.' };
    return renderLaunch();
  }

  d.tx = { status: 'pending' };
  renderLaunch();
  try {
    const hash = await chain.launchMarketTokenTx({
      from: w.address,
      launcher,
      launchpad: state.pad.padAddress,
      name: d.name.trim(),
      symbol: d.symbol.trim(),
    });
    const receipt = await chain.waitForReceipt(hash);
    if (!receipt || receipt.status === '0x0') throw new Error('The transaction reverted.');

    const token = chain.addressFromLog(
      receipt, chain.ABI.TOPICS['TokenLaunchedToUniswap(address,address,address,address,uint256)'],
    );
    if (!token) throw new Error('Could not find the new token in the transaction logs.');
    d.created = { token };
    d.tx = { status: 'done', hash };
    // The pad is now discoverable; refresh so its metrics reflect the launch.
    state.pad = await api.pad(state.pad.slug);
  } catch (error) {
    d.tx = { status: 'error', message: chain.describeError(error) };
  }
  renderLaunch();
}

// --- token page ------------------------------------------------------------

async function renderToken(token) {
  app().innerHTML = '<div class="fam-boot">Verifying on chain…</div>';
  const launcher = state.config.contracts.launcher;
  if (!launcher) {
    app().innerHTML = '<div class="notice warn">No market launcher configured.</div>';
    return;
  }

  try {
    const record = await chain.readLaunchState({
      launcher,
      token,
      controlledWallets: [wallet.wallet.address].filter(Boolean),
    });
    const model = buildLaunchState(record);
    const explorerBase = (chain.explorerUrl('address', '0x0', state.config.chainId) || '')
      .replace(/\/address\/0x0$/, '');

    app().innerHTML = `
      <div class="spread" style="margin-bottom:14px">
        <div>
          <div class="eyebrow">Launched on ${esc(state.pad.branding.displayName)}</div>
          <h2 style="margin:6px 0 0">$${esc(model.token.symbol || '')}</h2>
        </div>
        ${model.verification.verified
    ? '<span class="pill pill-proof">Onchain Launch Proof</span>' : ''}
      </div>
      ${model.verification.verified ? `<div class="notice" style="margin-bottom:16px">
        <strong>What this proof covers.</strong>
        <p class="small" style="margin:6px 0 0">
          That this token was launched through ${esc(state.pad.branding.displayName)} using the
          Launchpad.family market contracts, that its liquidity is locked, that the fee split is
          recorded on chain, and who it is attributed to. <strong>It is not a safety check.</strong>
          It says nothing about the team, the idea, or whether the token is worth anything.
        </p>
      </div>` : ''}
      ${renderLaunchDetail(model, { explorerBase })}`;
  } catch (error) {
    app().innerHTML = `<div class="notice bad">
      <strong>Could not verify this token.</strong>
      <p class="small" style="margin:6px 0 0">${esc(chain.describeError(error))}</p></div>`;
  }
}

// --- owner console ---------------------------------------------------------

async function renderOwner() {
  const pad = state.pad;
  const w = wallet.wallet;

  if (!wallet.sameAddress(w.address, pad.owner)) {
    app().innerHTML = `<div class="zero">
      <h3>Owner tools</h3>
      <p>Connect the wallet that owns ${esc(pad.branding.displayName)} to see earnings and
         recruiting tools.</p>
      ${w.status === WALLET.NO_PROVIDER ? '' : '<button class="btn primary" id="ownerConnect">Connect wallet</button>'}
    </div>`;
    document.getElementById('ownerConnect')?.addEventListener('click', () => wallet.connect());
    return;
  }

  const padUrl = `${location.protocol}//${pad.slug}.${state.config.apex}`;
  const embed = `<a href="${padUrl}/launch">Launch on ${pad.branding.displayName}</a>`;

  app().innerHTML = `<h2>Owner tools</h2>
    <div class="grid two" style="margin-top:16px">
      <div class="card">
        <h3>Your earnings</h3>
        <div id="earningsSlot" class="muted small">Reading from chain…</div>
      </div>

      <div class="card">
        <h3>Recruit creators</h3>
        <p class="muted small">Anyone with this link can launch through
          ${esc(pad.branding.displayName)}${pad.onchain?.launchPolicy === 1 ? '' : ' — but this launchpad is owner-only, so only you can'}.</p>
        <div class="copy-row" style="margin-top:10px">
          <input type="text" readonly value="${esc(padUrl)}/launch" id="inviteLink" />
          <button class="btn small" data-copy="inviteLink">Copy</button>
        </div>

        <h3 style="margin-top:18px">Embed a launch button</h3>
        <div class="copy-row" style="margin-top:8px">
          <input type="text" readonly value="${esc(embed)}" id="embedSnippet" />
          <button class="btn small" data-copy="embedSnippet">Copy</button>
        </div>
        <p class="hint" style="margin-top:8px">Paste into your own site.</p>
      </div>

      <div class="card">
        <h3>Export your frontend</h3>
        <p class="muted small">
          Download a repository for this launchpad's frontend. It is a skin around the same onchain
          launchpad: it reads every economic value from the contracts, contains no keys, and cannot
          change fee recipients, attribution or the split. If you point it at different contracts,
          those launches are simply not recognised as coming from ${esc(pad.branding.displayName)}.
        </p>
        <div id="exportSlot" class="muted small">Checking…</div>
      </div>
    </div>`;

  app().querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const input = document.getElementById(button.dataset.copy);
      await navigator.clipboard?.writeText(input.value);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1400);
    });
  });

  loadOwnerEarnings();
  loadExportStatus();
}

async function loadOwnerEarnings() {
  const slot = document.getElementById('earningsSlot');
  if (!slot) return;
  const rewards = state.config.contracts.rewards;
  if (!rewards) { slot.textContent = 'No rewards contract configured.'; return; }

  try {
    const pending = await chain.callUint(rewards, 'pending(address)', [
      { type: 'address', value: state.pad.owner },
    ]);
    slot.innerHTML = `
      <div class="metric" style="margin-bottom:12px">
        <span class="label">Claimable now</span>
        <span class="value accent">${esc(chain.formatUnits(pending))} ETH</span>
      </div>
      ${pending > 0n ? '<button class="btn primary small" id="withdrawBtn">Withdraw</button>' : ''}
      <p class="muted small" style="margin-top:10px">
        This is your share of fees from every token launched here. Fees accumulate in Uniswap's
        vault until someone collects them for a launch — anyone can, including you.
      </p>`;
    document.getElementById('withdrawBtn')?.addEventListener('click', async () => {
      try {
        const hash = await chain.withdrawRewardsTx({ from: wallet.wallet.address, rewards });
        await chain.waitForReceipt(hash);
        loadOwnerEarnings();
      } catch (error) {
        slot.insertAdjacentHTML('beforeend',
          `<p class="small" style="color:var(--bad)">${esc(chain.describeError(error))}</p>`);
      }
    });
  } catch (error) {
    slot.innerHTML = `<span style="color:var(--bad)">Could not read earnings: ${esc(chain.describeError(error))}</span>`;
  }
}

async function loadExportStatus() {
  const slot = document.getElementById('exportSlot');
  if (!slot) return;
  try {
    const status = await api.exportStatus();
    slot.innerHTML = `
      <a class="btn small primary" href="/api/export/${esc(state.pad.slug)}/download">
        Download repository</a>
      ${status.github?.configured
    ? `<a class="btn small ghost" href="/api/export/${esc(state.pad.slug)}/github"
          style="margin-left:8px">Create on GitHub</a>`
    : `<p class="hint" style="margin-top:10px">
         Creating the repository directly on GitHub is not enabled on this deployment
         ${status.github?.reason ? `(${esc(status.github.reason)})` : ''}. The download contains
         the same files.</p>`}`;
  } catch (error) {
    slot.innerHTML = `<span style="color:var(--bad)">${esc(error.message)}</span>`;
  }
}

// --- boot ------------------------------------------------------------------

async function boot() {
  try {
    state.config = await api.config();
    const slug = state.config.padSlug ?? location.pathname.match(/^\/p\/([^/]+)/)?.[1];
    if (!slug) { state.error = 'This address does not resolve to a launchpad.'; return render(); }

    state.pad = await api.pad(slug);
    applyBranding();
    await wallet.init(state.config.chainId);
    wallet.onWalletChange(() => { renderNav(); render(); });
    state.split = await readSplit(state.config.contracts.rewards);
  } catch (error) {
    state.error = error.message;
  }
  await render();
}

window.addEventListener('popstate', render);
boot();

window.__pad = { state, api, wallet, render, boot, navigate };
