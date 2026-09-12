// ---------------------------------------------------------------------------
// live.js — the on-chain section of the app.
//
// HARD RULE, enforced by structure: this file never reads or writes the demo's
// localStorage state, and app.js's demo mode never calls into here. Every number
// rendered by this file was read from a chain. Every pad and token shown here
// exists on chain. There is no seeded, simulated or placeholder data below.
// ---------------------------------------------------------------------------

import * as chain from './chain.js';
import { resolveFactoryAddress, DEPLOYMENT } from './config.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = () => document.getElementById('app');

const state = {
  account: null,
  chainId: null,
  pads: [],
  pad: null,
  tokens: [],
  busy: false,
  tx: null, // {status:'pending'|'success'|'error', hash, label, message, links:[]}
  loadError: null,
};

const esc = (s = '') => String(s).replace(/[&<>'"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]
));

function isLiveRoute() {
  return (location.hash.slice(1).split('=')[0] || '').startsWith('live');
}

function parseRoute() {
  const [route, value] = location.hash.slice(1).split('=');
  return [route || '', value || ''];
}

function go(route, value) {
  location.hash = value ? `${route}=${value}` : route;
}

// ---------------------------------------------------------------------------
// Wallet plumbing
// ---------------------------------------------------------------------------

async function refreshWallet() {
  if (!chain.hasWallet()) {
    state.account = null;
    state.chainId = null;
    return;
  }
  const accounts = await chain.getAccounts();
  state.account = accounts[0] || null;
  try {
    state.chainId = await chain.getChainId();
  } catch {
    state.chainId = null;
  }
}

function onTargetChain() {
  return state.chainId === chain.TARGET_CHAIN.chainId;
}

async function handleConnect() {
  try {
    state.busy = true; render();
    state.account = await chain.connect();
    state.chainId = await chain.getChainId();
    if (!onTargetChain()) await handleSwitchChain({ silent: true });
  } catch (error) {
    setTx({ status: 'error', label: 'Connect wallet', message: chain.describeError(error) });
  } finally {
    state.busy = false;
    await refreshWallet();
    await loadRoute();
  }
}

/** Disconnect is local: EIP-1193 has no revoke, so we drop our reference to the account. */
function handleDisconnect() {
  state.account = null;
  state.pad = null;
  state.tx = null;
  render();
}

async function handleSwitchChain({ silent = false } = {}) {
  try {
    state.busy = true; render();
    await chain.switchToTargetChain();
    await refreshWallet();
    if (!silent) setTx(null);
    await loadRoute();
  } catch (error) {
    setTx({ status: 'error', label: 'Switch network', message: chain.describeError(error) });
  } finally {
    state.busy = false;
    render();
  }
}

function setTx(tx) {
  state.tx = tx;
  render();
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

function factoryAddress() {
  return resolveFactoryAddress();
}

async function loadPads() {
  state.loadError = null;
  const factory = factoryAddress();
  if (!factory) { state.pads = []; return; }
  try {
    state.pads = await chain.readFactoryLaunchpads(factory, 50);
  } catch (error) {
    state.pads = [];
    state.loadError = chain.describeError(error);
  }
}

async function loadPad(address) {
  state.loadError = null;
  state.pad = null;
  state.tokens = [];
  try {
    state.pad = await chain.readLaunchpad(address);
    state.tokens = await chain.readPadTokens(address, 50);
    if (state.account) {
      state.pad.callerCanLaunch = await chain.callBool(address, 'canLaunch(address)', [
        { type: 'address', value: state.account },
      ]);
    }
  } catch (error) {
    state.loadError = chain.describeError(error);
  }
}

async function loadRoute() {
  if (!isLiveRoute()) return;
  const [route, value] = parseRoute();
  if (!chain.hasWallet()) { render(); return; }

  state.busy = true; render();
  try {
    if (route === 'live-pad' && value) await loadPad(value);
    else if (route === 'live') await loadPads();
  } finally {
    state.busy = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Chain writes
// ---------------------------------------------------------------------------

async function submitCreatePad(form) {
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  const metadataURI = String(data.get('metadataURI') || '').trim();
  const policy = data.get('policy') === 'open' ? chain.POLICY.OPEN : chain.POLICY.OWNER_ONLY;

  if (!name) { setTx({ status: 'error', label: 'Create launchpad', message: 'Name is required.' }); return; }

  try {
    setTx({ status: 'pending', label: 'Create launchpad', message: 'Confirm in your wallet…' });
    const hash = await chain.createLaunchpadTx({
      from: state.account,
      factory: factoryAddress(),
      name,
      metadataURI,
      // Only Standard is offered in the live UI: there is no NVDA on testnet, so an NVDA
      // pad here could not do what its name claims. See README "Known gaps".
      preset: chain.PRESET.STANDARD,
      policy,
    });

    setTx({
      status: 'pending',
      label: 'Create launchpad',
      hash,
      message: 'Submitted. Waiting for confirmation…',
      links: txLinks(hash),
    });

    const receipt = await chain.waitForReceipt(hash);
    // Read the address the contract actually emitted, not one we guessed.
    const topic = chain.ABI.TOPICS['LaunchpadCreated(address,address,address,uint8,uint8,string,string)'];
    const padAddress = chain.addressFromLog(receipt, topic, 1);
    if (!padAddress) throw new Error('Launchpad created but no LaunchpadCreated event was found.');

    setTx({
      status: 'success',
      label: 'Launchpad created',
      hash,
      message: `Launchpad live at ${padAddress}`,
      links: [...txLinks(hash), ...addressLinks(padAddress, 'launchpad')],
      padAddress,
    });

    go('live-pad', padAddress);
  } catch (error) {
    setTx({ status: 'error', label: 'Create launchpad', message: chain.describeError(error) });
  }
}

async function submitLaunchToken(form) {
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  const symbol = String(data.get('symbol') || '').trim().toUpperCase();
  const supply = String(data.get('supply') || '').trim();

  if (!name || !symbol || !supply) {
    setTx({ status: 'error', label: 'Launch token', message: 'Name, symbol and supply are all required.' });
    return;
  }

  try {
    setTx({ status: 'pending', label: 'Launch token', message: 'Confirm in your wallet…' });
    const hash = await chain.launchTokenTx({
      from: state.account,
      pad: state.pad.address,
      name,
      symbol,
      wholeSupply: BigInt(supply),
    });

    setTx({
      status: 'pending', label: 'Launch token', hash, message: 'Submitted. Waiting for confirmation…', links: txLinks(hash),
    });

    const receipt = await chain.waitForReceipt(hash);
    const topic = chain.ABI.TOPICS['TokenLaunched(address,address,string,string,uint256)'];
    const tokenAddress = chain.addressFromLog(receipt, topic, 1);
    if (!tokenAddress) throw new Error('Token launched but no TokenLaunched event was found.');

    setTx({
      status: 'success',
      label: 'Token launched',
      hash,
      message: `${symbol} live at ${tokenAddress}`,
      links: [...txLinks(hash), ...addressLinks(tokenAddress, 'token')],
      tokenAddress,
    });

    await loadPad(state.pad.address); // re-read from chain, never patch local state
    render();
  } catch (error) {
    setTx({ status: 'error', label: 'Launch token', message: chain.describeError(error) });
  }
}

function txLinks(hash) {
  const url = chain.explorerUrl('tx', hash, state.chainId);
  return url ? [{ label: 'View transaction', url }] : [];
}

function addressLinks(address, label) {
  const url = chain.explorerUrl('address', address, state.chainId);
  return url ? [{ label: `View ${label}`, url }] : [];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function walletBar() {
  if (!chain.hasWallet()) {
    return `<div class="wallet-bar"><span class="chain-dot bad"></span><span>No EVM wallet detected in this browser.</span>
      <a class="btn ghost small" href="https://docs.robinhood.com/chain/add-network-to-wallet" target="_blank" rel="noopener">How to set one up</a></div>`;
  }
  if (!state.account) {
    return `<div class="wallet-bar"><span class="chain-dot bad"></span><span>Wallet not connected.</span>
      <button class="btn primary small" id="connectBtn" ${state.busy ? 'disabled' : ''}>Connect wallet</button></div>`;
  }

  const ok = onTargetChain();
  const chainLabel = ok
    ? chain.TARGET_CHAIN.chainName
    : `Wrong network (chain ${state.chainId ?? '?'})`;

  return `<div class="wallet-bar">
    <span class="chain-dot ${ok ? 'good' : 'bad'}"></span>
    <span><strong>${esc(chainLabel)}</strong></span>
    <span class="mono" id="accountLabel" title="${esc(state.account)}">${esc(chain.shortAddress(state.account))}</span>
    ${ok ? '' : `<button class="btn primary small" id="switchBtn" ${state.busy ? 'disabled' : ''}>Switch to ${esc(chain.TARGET_CHAIN.chainName)}</button>`}
    <button class="btn ghost small" id="disconnectBtn">Disconnect</button>
  </div>`;
}

function txBanner() {
  if (!state.tx) return '';
  const { status, label, message, links = [] } = state.tx;
  const icon = status === 'pending' ? '◌' : status === 'success' ? '✓' : '✕';
  return `<div class="tx-banner ${esc(status)}" id="txBanner" role="status">
    <div class="tx-row"><span class="tx-icon">${icon}</span>
      <div><strong>${esc(label)}</strong><div class="muted">${esc(message || '')}</div></div>
      <button class="icon-btn" id="dismissTx" type="button" aria-label="Dismiss">×</button></div>
    ${links.length ? `<div class="tx-links">${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>` : ''}
  </div>`;
}

function notDeployedNotice() {
  return `<div class="notice">
    <strong>No factory deployed yet.</strong> The live section needs a <code>LaunchpadFactory</code>
    address on ${esc(chain.TARGET_CHAIN.chainName)}. Deploy one with
    <code>npm run deploy:testnet</code>, then set <code>FACTORY_ADDRESS</code> in
    <code>web/config.js</code> or open this page with <code>?factory=0x…</code>.
  </div>`;
}

function renderList() {
  const factory = factoryAddress();
  const factoryLink = factory ? chain.explorerUrl('address', factory, state.chainId) : null;

  app().innerHTML = `
  <section class="shell page-head">
    <div class="eyebrow">On-chain — ${esc(chain.TARGET_CHAIN.chainName)}</div>
    <h1>Live launchpads</h1>
    <p class="muted">Every launchpad below was read from the factory contract. No simulated data appears on this page.</p>
  </section>
  <section class="shell live-shell">
    ${walletBar()}
    ${txBanner()}
    ${factory ? `<div class="muted mono small">Factory: ${esc(factory)} ${factoryLink ? `<a href="${esc(factoryLink)}" target="_blank" rel="noopener">↗</a>` : ''}</div>` : notDeployedNotice()}
    ${state.loadError ? `<div class="notice danger-notice">Could not read the chain: ${esc(state.loadError)}</div>` : ''}
    <div class="toolbar" style="margin:22px 0">
      <h2 style="margin:0;font-size:26px">${state.pads.length} launchpad${state.pads.length === 1 ? '' : 's'}</h2>
      <div>
        <button class="btn ghost" id="refreshBtn" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Reading chain…' : 'Refresh'}</button>
        <button class="btn primary" id="newPadBtn" ${!state.account || !factory ? 'disabled' : ''}>Create launchpad +</button>
      </div>
    </div>
    ${state.pads.length ? `<div class="grid">${state.pads.map(padCard).join('')}</div>`
    : `<div class="empty">${state.busy ? 'Reading from chain…' : factory ? 'No launchpads on this factory yet. Create the first one.' : 'Deploy a factory to get started.'}</div>`}
  </section>`;
}

function padCard(pad) {
  const open = pad.launchPolicy === chain.POLICY.OPEN;
  return `<article class="card pad-card live-card" data-pad="${esc(pad.address)}">
    <div class="pad-head">
      <div class="pad-logo">${esc((pad.name || '?')[0])}</div>
      <span class="pill ${open ? 'pill-open' : ''}">${open ? 'Open' : 'Owner only'}</span>
    </div>
    <h3>${esc(pad.name)}</h3>
    <p class="muted mono small">${esc(chain.shortAddress(pad.address))}</p>
    <div class="card-stats">
      <div class="card-stat"><span class="metric-label">Tokens on chain</span><strong>${pad.tokenCount}</strong></div>
      <div class="card-stat"><span class="metric-label">Economy</span><strong>${esc(chain.presetLabel(pad.preset).split(' (')[0])}</strong></div>
    </div>
  </article>`;
}

function renderCreate() {
  app().innerHTML = `
  <section class="shell page-head">
    <div class="eyebrow">On-chain — ${esc(chain.TARGET_CHAIN.chainName)}</div>
    <h1>Create a launchpad</h1>
    <p class="muted">This sends a real transaction from your wallet and costs testnet gas.</p>
  </section>
  <section class="shell live-shell">
    ${walletBar()}
    ${txBanner()}
    <form class="card form-card" id="createPadForm" style="max-width:640px">
      <div class="field"><label>Launchpad name</label>
        <input name="name" maxlength="64" required placeholder="Agent Arena" /></div>
      <div class="field"><label>Metadata URI <span class="muted">(optional)</span></label>
        <input name="metadataURI" maxlength="256" placeholder="ipfs://…" /></div>

      <div class="field"><label>Who can launch tokens here?</label>
        <div class="preset-grid">
          <label class="preset policy-option"><input type="radio" name="policy" value="open" checked />
            <strong>Open</strong><span class="muted">Anyone can launch. Each token's supply belongs to whoever launched it.</span></label>
          <label class="preset policy-option"><input type="radio" name="policy" value="owner_only" />
            <strong>Owner only</strong><span class="muted">Only you can launch tokens through this pad.</span></label>
        </div>
      </div>

      <div class="notice"><strong>This choice is permanent.</strong> The launch policy is immutable on
        chain: an open pad can never be closed, and a closed pad can never be opened.</div>

      <div class="notice" style="margin-top:12px">Economy: <strong>Standard</strong> —
        0.60% fee split 0.50% pad owner / 0.10% protocol. This is an <strong>alpha default,
        not final product policy</strong>, and it has no enforcement point yet because there is no
        on-chain market. NVDA Reserve is not offered here: canonical NVDA does not exist on testnet.</div>

      <button class="btn primary" style="width:100%;margin-top:18px" type="submit"
        ${!state.account || !onTargetChain() ? 'disabled' : ''}>
        ${!state.account ? 'Connect a wallet first' : !onTargetChain() ? 'Switch network first' : 'Create launchpad on chain →'}
      </button>
    </form>
  </section>`;
}

function renderPad() {
  const pad = state.pad;
  if (!pad) {
    app().innerHTML = `<section class="shell page-head"><h1>Launchpad</h1>
      ${state.loadError ? `<div class="notice danger-notice">${esc(state.loadError)}</div>`
    : `<p class="muted">${state.busy ? 'Reading from chain…' : 'Not found on chain.'}</p>`}
      <button class="btn ghost" id="backBtn">← All live launchpads</button></section>`;
    return;
  }

  const open = pad.launchPolicy === chain.POLICY.OPEN;
  const canLaunch = pad.callerCanLaunch === true;
  const padLink = chain.explorerUrl('address', pad.address, state.chainId);
  const isOwner = state.account && pad.owner.toLowerCase() === state.account.toLowerCase();

  app().innerHTML = `
  <section class="shell page-head">
    <div class="eyebrow">On-chain — ${esc(chain.TARGET_CHAIN.chainName)}</div>
    <h1>${esc(pad.name)}</h1>
    <p class="muted mono small">${esc(pad.address)} ${padLink ? `<a href="${esc(padLink)}" target="_blank" rel="noopener">↗</a>` : ''}</p>
  </section>
  <section class="shell live-shell">
    ${walletBar()}
    ${txBanner()}
    <button class="btn ghost small" id="backBtn">← All live launchpads</button>

    <div class="stats" style="margin:20px 0">
      <div class="card stat"><div class="metric-label">Launch policy</div>
        <div class="value">${open ? 'Open' : 'Owner only'}</div></div>
      <div class="card stat"><div class="metric-label">Tokens on chain</div>
        <div class="value">${pad.tokenCount}</div></div>
      <div class="card stat"><div class="metric-label">Economy</div>
        <div class="value">${esc(chain.presetLabel(pad.preset).split(' (')[0])}</div></div>
      <div class="card stat"><div class="metric-label">Owner</div>
        <div class="value mono small">${esc(chain.shortAddress(pad.owner))}${isOwner ? ' (you)' : ''}</div></div>
    </div>

    <div class="card form-card">
      <div class="toolbar">
        <div><div class="eyebrow">On chain</div><h2 style="margin:6px 0">Tokens</h2></div>
        <button class="btn primary" id="launchTokenBtn" ${!canLaunch || !onTargetChain() ? 'disabled' : ''}>Launch token +</button>
      </div>
      ${!state.account ? '<div class="notice" style="margin-top:14px">Connect a wallet to launch a token here.</div>'
    : canLaunch ? `<div class="notice" style="margin-top:14px">${open && !isOwner
      ? 'This pad is <strong>open</strong>: you can launch a token here even though you do not own the pad, and the entire supply will be yours.'
      : 'You can launch tokens on this pad.'}</div>`
      : '<div class="notice" style="margin-top:14px">This pad is <strong>owner only</strong> and you are not its owner, so you cannot launch here.</div>'}

      ${state.tokens.length ? `<table class="token-table" style="margin-top:18px">
        <thead><tr><th>Token</th><th>Supply</th><th>Address</th></tr></thead>
        <tbody>${state.tokens.map(tokenRow).join('')}</tbody></table>`
    : `<div class="empty">${state.busy ? 'Reading from chain…' : 'No tokens launched on this pad yet.'}</div>`}
    </div>
  </section>`;
}

function tokenRow(token) {
  const link = chain.explorerUrl('address', token.address, state.chainId);
  return `<tr><td><strong>$${esc(token.symbol)}</strong><div class="muted">${esc(token.name)}</div></td>
    <td>${esc(Number(chain.formatUnits(token.totalSupply, token.decimals)).toLocaleString())}</td>
    <td class="mono small">${esc(chain.shortAddress(token.address))}
      ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">↗</a>` : ''}</td></tr>`;
}

function tokenModal() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<form class="card modal" id="launchTokenForm">
    <div class="modal-head"><div><div class="eyebrow">${esc(state.pad.name)}</div>
      <h2>Launch a token on chain</h2></div>
      <button class="icon-btn" type="button" id="closeTokenModal">×</button></div>
    <div class="field"><label>Name</label><input name="name" maxlength="64" required placeholder="My Token" /></div>
    <div class="field"><label>Symbol</label><input name="symbol" maxlength="11" required placeholder="MTK" /></div>
    <div class="field"><label>Fixed supply (whole tokens)</label>
      <input name="supply" type="number" min="1" max="1000000000000" step="1" value="1000000000" required /></div>
    <div class="notice">This sends a real transaction. The entire supply is minted to
      <span class="mono">${esc(chain.shortAddress(state.account))}</span> — your wallet — and the
      total supply can never change.</div>
    <button class="btn primary" style="width:100%;margin-top:18px" type="submit">Launch token →</button>
  </form>`;
  document.body.appendChild(wrap);
  $('#closeTokenModal', wrap).onclick = () => wrap.remove();
  $('#launchTokenForm', wrap).onsubmit = async (e) => {
    e.preventDefault();
    wrap.remove();
    await submitLaunchToken(e.target);
  };
}

function bind() {
  const on = (id, handler, event = 'click') => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  };

  on('connectBtn', handleConnect);
  on('disconnectBtn', handleDisconnect);
  on('switchBtn', () => handleSwitchChain());
  on('dismissTx', () => setTx(null));
  on('refreshBtn', loadRoute);
  on('newPadBtn', () => go('live-create'));
  on('backBtn', () => go('live'));
  on('launchTokenBtn', tokenModal);

  const createForm = document.getElementById('createPadForm');
  if (createForm) {
    createForm.addEventListener('submit', (e) => { e.preventDefault(); submitCreatePad(e.target); });
  }

  document.querySelectorAll('[data-pad]').forEach((card) => {
    card.addEventListener('click', () => go('live-pad', card.dataset.pad));
  });
}

function render() {
  if (!isLiveRoute()) return;
  const [route] = parseRoute();
  if (route === 'live-create') renderCreate();
  else if (route === 'live-pad') renderPad();
  else renderList();
  bind();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  await refreshWallet();
  await loadRoute();
}

window.addEventListener('hashchange', () => {
  if (!isLiveRoute()) return;
  // The transaction banner deliberately SURVIVES navigation. A successful create/launch moves
  // the user to the new pad, and clearing the banner here would destroy the confirmation and
  // its explorer link at the exact moment they are most useful. It is cleared by the dismiss
  // button, or replaced when the next transaction starts.
  boot();
});

if (chain.hasWallet()) {
  const provider = chain.getProvider();
  provider.on?.('accountsChanged', async () => { await refreshWallet(); await loadRoute(); });
  provider.on?.('chainChanged', async () => { await refreshWallet(); await loadRoute(); });
}

// Exposed for the end-to-end browser test, which drives the real UI and then asserts on the
// same chain-read state the UI rendered from.
window.__live = { state, chain, boot, factoryAddress, DEPLOYMENT };

if (isLiveRoute()) boot();
