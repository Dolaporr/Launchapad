// ---------------------------------------------------------------------------
// live.js — the on-chain section of the app.
//
// HARD RULE, enforced by structure: this file never reads or writes the demo's
// localStorage state, and app.js's demo mode never calls into here. Every number
// rendered by this file was read from a chain. Every pad and token shown here
// exists on chain. There is no seeded, simulated or placeholder data below.
// ---------------------------------------------------------------------------

import * as chain from './chain.js';
import { resolveFactoryAddress, resolveLauncherAddress, resolveRewardsAddress, DEPLOYMENT } from './config.js';
import { buildLaunchState } from './launchState.js';
import { renderLaunchDetail } from './launchDetail.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = () => document.getElementById('app');

const state = {
  account: null,
  chainId: null,
  // The launch currently open in the detail view, as a verification record plus its display model.
  launchRecord: null,
  launchState: null,
  launchError: null,
  pads: [],
  pad: null,
  tokens: [],
  busy: false,
  tx: null, // {status:'pending'|'success'|'error', hash, label, message, links:[]}
  loadError: null,
  // Milestone 2.5 — real market launches. Kept separate from `tokens` (token-only deployments)
  // so the two can never be rendered as the same kind of thing.
  marketLaunches: [],
  myRewards: 0n,
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
function launcherAddress() {
  return resolveLauncherAddress();
}
function rewardsAddress() {
  return resolveRewardsAddress();
}
/** Market launches are only possible where Uniswap's Liquidity Launchpad is deployed. */
function marketAvailable() {
  return Boolean(launcherAddress() && rewardsAddress());
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
    await loadMarketLaunches(address);
  } catch (error) {
    state.loadError = chain.describeError(error);
  }
}

/**
 * Reads this pad's REAL market launches. Every entry is re-verified on chain via the two-way
 * binding, so a token that merely claims to be a market launch never appears here.
 */
async function loadMarketLaunches(padAddress) {
  state.marketLaunches = [];
  state.myRewards = 0n;
  if (!marketAvailable()) return;

  const launcher = launcherAddress();
  const tokens = await chain.readMarketTokensOfPad(launcher, padAddress);

  const launches = [];
  for (const token of tokens) {
    const record = await chain.readMarketLaunch(launcher, token);
    if (!record) continue; // failed verification — never render it as a market launch
    const [meta, rewardInfo] = await Promise.all([
      chain.readToken(token),
      chain.readRewards(rewardsAddress(), { positionTokenId: record.positionTokenId }),
    ]);
    launches.push({ ...record, ...meta, lifetime: rewardInfo.lifetime, splits: rewardInfo });
  }
  state.marketLaunches = launches;

  if (state.account) {
    const { pending } = await chain.readRewards(rewardsAddress(), { party: state.account });
    state.myRewards = pending;
  }
}

async function loadRoute() {
  if (!isLiveRoute()) return;
  const [route, value] = parseRoute();
  if (!chain.hasWallet()) { render(); return; }

  state.busy = true; render();
  try {
    if (route === 'live-launch' && value) await loadLaunchDetail(value);
    else if (route === 'live-pad' && value) await loadPad(value);
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

  if (!name || !symbol) {
    setTx({ status: 'error', label: 'Launch token', message: 'Name and symbol are both required.' });
    return;
  }

  try {
    setTx({ status: 'pending', label: 'Launch token', message: 'Confirm in your wallet…' });
    const hash = await chain.launchTokenTx({
      from: state.account,
      pad: state.pad.address,
      name,
      symbol,
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

async function submitMarketLaunch(form) {
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  const symbol = String(data.get('symbol') || '').trim().toUpperCase();
  if (!name || !symbol) {
    setTx({ status: 'error', label: 'Market launch', message: 'Name and symbol are both required.' });
    return;
  }

  try {
    setTx({ status: 'pending', label: 'Market launch', message: 'Confirm in your wallet…' });
    const hash = await chain.launchMarketTokenTx({
      from: state.account,
      launcher: launcherAddress(),
      pad: state.pad.address,
      name,
      symbol,
    });
    setTx({
      status: 'pending', label: 'Market launch', hash,
      message: 'Creating the Uniswap pool…', links: txLinks(hash),
    });

    const receipt = await chain.waitForReceipt(hash);
    const topic = chain.ABI.TOPICS['TokenLaunchedToUniswap(address,address,address,address,uint256)'];
    const tokenAddress = chain.addressFromLog(receipt, topic, 1);
    if (!tokenAddress) throw new Error('Launched, but no TokenLaunchedToUniswap event was found.');

    setTx({
      status: 'success', label: 'Market launched', hash,
      message: `${symbol} is live in a Uniswap pool at ${tokenAddress}`,
      links: [...txLinks(hash), ...addressLinks(tokenAddress, 'token')],
    });
    await loadPad(state.pad.address);
    render();
  } catch (error) {
    setTx({ status: 'error', label: 'Market launch', message: chain.describeError(error) });
  }
}

async function submitCollect(positionTokenId) {
  try {
    setTx({ status: 'pending', label: 'Collect rewards', message: 'Confirm in your wallet…' });
    const hash = await chain.collectAndSplitTx({
      from: state.account, rewards: rewardsAddress(), positionTokenId,
    });
    setTx({ status: 'pending', label: 'Collect rewards', hash, message: 'Splitting 50 / 30 / 20…', links: txLinks(hash) });
    await chain.waitForReceipt(hash);
    setTx({
      status: 'success', label: 'Rewards collected', hash,
      message: 'Trading fees claimed from Uniswap and split three ways.', links: txLinks(hash),
    });
    await loadPad(state.pad.address);
    render();
  } catch (error) {
    setTx({ status: 'error', label: 'Collect rewards', message: chain.describeError(error) });
  }
}

async function submitWithdraw() {
  try {
    setTx({ status: 'pending', label: 'Withdraw rewards', message: 'Confirm in your wallet…' });
    const hash = await chain.withdrawRewardsTx({ from: state.account, rewards: rewardsAddress() });
    await chain.waitForReceipt(hash);
    setTx({
      status: 'success', label: 'Rewards withdrawn', hash,
      message: 'Your share has been sent to your wallet.', links: txLinks(hash),
    });
    await loadPad(state.pad.address);
    render();
  } catch (error) {
    setTx({ status: 'error', label: 'Withdraw rewards', message: chain.describeError(error) });
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
    : `<div class="empty">${emptyMessage(factory)}</div>`}
  </section>`;
}

/**
 * An empty list and a failed read are different facts and must never look the same. Claiming
 * "no launchpads yet" when the RPC call actually failed would invite someone to create a
 * duplicate pad because the UI hid an error.
 */
function emptyMessage(factory) {
  if (state.busy) return 'Reading from chain…';
  if (state.loadError) return 'Could not read the chain, so the list above is unknown — not empty. Fix the connection and refresh.';
  if (!factory) return 'Deploy a factory to get started.';
  return 'No launchpads on this factory yet. Create the first one.';
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

      ${marketSection()}

      ${state.tokens.length ? `<table class="token-table" style="margin-top:18px">
        <thead><tr><th>Token-only (no market)</th><th>Supply</th><th>Address</th></tr></thead>
        <tbody>${state.tokens.map(tokenRow).join('')}</tbody></table>`
    : `<div class="empty">${state.busy ? 'Reading from chain…' : 'No tokens launched on this pad yet.'}</div>`}
    </div>
  </section>`;
}

/**
 * The market section. Everything here is a VERIFIED market launch — each entry passed the
 * two-way on-chain binding check before being rendered. Token-only deployments are rendered
 * separately, below, and are labelled as having no market.
 */
function marketSection() {
  if (!marketAvailable()) {
    return `<div class="notice" style="margin-top:18px"><strong>Market launches unavailable here.</strong>
      Uniswap's Liquidity Launchpad is deployed on Robinhood Chain <strong>mainnet only</strong>, so real
      pools cannot be created on testnet. Point the app at a launcher with
      <code>?launcher=0x…&amp;rewards=0x…</code> to enable this section.</div>`;
  }

  const pad = state.pad;
  const canLaunch = pad.callerCanLaunch === true;
  const rows = state.marketLaunches.map(marketRow).join('');

  return `<div class="market-block">
    <div class="toolbar" style="margin-top:24px">
      <div><div class="eyebrow green">Real market</div>
        <h2 style="margin:6px 0">Uniswap pools</h2></div>
      <button class="btn primary" id="marketLaunchBtn" ${!canLaunch || !state.account ? 'disabled' : ''}>
        Launch market token +</button>
    </div>
    <div class="notice">A market launch creates a <strong>real Uniswap v4 pool</strong> and puts the
      entire supply in as permanently locked liquidity. The creator receives no tokens — they receive
      <strong>50%</strong> of the pool's creator-fee stream, with 30% to the pad owner and 20% to the
      protocol. Those shares are immutable.</div>

    ${state.myRewards > 0n ? `<div class="reward-banner" id="rewardBanner">
      <div><div class="metric-label">Your claimable rewards</div>
        <div class="value green">${esc(chain.formatUnits(state.myRewards))} ETH</div></div>
      <button class="btn primary small" id="withdrawBtn">Withdraw</button></div>` : ''}

    ${rows ? `<table class="token-table" style="margin-top:16px">
      <thead><tr><th>Market token</th><th>Creator</th><th>Pad owner</th><th>Fees split</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`
    : `<div class="empty">${state.busy ? 'Reading from chain…' : 'No market launches on this pad yet.'}</div>`}
  </div>`;
}

function marketRow(launch) {
  const link = chain.explorerUrl('address', launch.address, state.chainId);
  const isCreator = state.account && launch.tokenCreator.toLowerCase() === state.account.toLowerCase();
  const isPadOwner = state.account && launch.launchpadOwner.toLowerCase() === state.account.toLowerCase();
  return `<tr>
    <td><strong>$${esc(launch.symbol)}</strong> <span class="pill pill-open">verified market</span>
      <div class="muted mono small">${esc(chain.shortAddress(launch.address))}
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">↗</a>` : ''}</div></td>
    <td class="mono small">${esc(chain.shortAddress(launch.tokenCreator))}${isCreator ? ' <strong>(you)</strong>' : ''}</td>
    <td class="mono small">${esc(chain.shortAddress(launch.launchpadOwner))}${isPadOwner ? ' <strong>(you)</strong>' : ''}</td>
    <td class="small">50 / 30 / 20<div class="muted">split so far: ${esc(chain.formatUnits(launch.lifetime))} ETH</div></td>
    <td><a class="btn ghost small" href="#live-launch=${esc(launch.address)}">View</a>
      <button class="btn ghost small" data-collect="${launch.positionTokenId}"
      ${!state.account ? 'disabled' : ''}>Collect</button></td>
  </tr>`;
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
    <div class="field"><label>Fixed supply</label>
      <input value="1,000,000,000 (fixed)" disabled /></div>
    <div class="notice">Supply is always 1,000,000,000 and is <strong>not a choice</strong> —
      Uniswap's InstantLaunchStrategy rejects any other supply, so offering the option would be a
      lie. This sends a real transaction; the entire supply is minted to
      <span class="mono">${esc(chain.shortAddress(state.account))}</span> and can never change.</div>
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

function marketLaunchModal() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<form class="card modal" id="marketLaunchForm">
    <div class="modal-head"><div><div class="eyebrow green">${esc(state.pad.name)}</div>
      <h2>Launch into a real Uniswap pool</h2></div>
      <button class="icon-btn" type="button" id="closeMarketModal">×</button></div>
    <div class="field"><label>Name</label><input name="name" maxlength="64" required placeholder="My Token" /></div>
    <div class="field"><label>Symbol</label><input name="symbol" maxlength="11" required placeholder="MTK" /></div>
    <div class="field"><label>Supply</label><input value="1,000,000,000 (fixed)" disabled /></div>
    <div class="notice"><strong>You receive no tokens.</strong> The entire supply becomes permanently
      locked liquidity in a Uniswap v4 pool — neither you, nor the pad owner, nor Launchpad.family
      can withdraw it. What you receive is 50% of the pool's creator-fee stream, for as long as the
      pool trades.</div>
    <button class="btn primary" style="width:100%;margin-top:18px" type="submit">Create the pool →</button>
  </form>`;
  document.body.appendChild(wrap);
  $('#closeMarketModal', wrap).onclick = () => wrap.remove();
  $('#marketLaunchForm', wrap).onsubmit = async (e) => {
    e.preventDefault();
    wrap.remove();
    await submitMarketLaunch(e.target);
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
  on('marketLaunchBtn', marketLaunchModal);
  on('withdrawBtn', submitWithdraw);
  document.querySelectorAll('[data-collect]').forEach((b) => {
    b.addEventListener('click', () => submitCollect(BigInt(b.dataset.collect)));
  });

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
  else if (route === 'live-launch') { app().innerHTML = launchDetailView(); }
  else if (route === 'live-pad') renderPad();
  else renderList();
  bind();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Launch detail — Token / Pool / Locked liquidity / Trading / Fees / Revenue split
// ---------------------------------------------------------------------------

/**
 * Reads ONE launch from chain and builds its display model.
 *
 * Everything rendered comes from `chain.readLaunchState`. If the read fails, the view says so
 * rather than rendering a page of zeroes: an unverifiable launch must never look like a healthy
 * one with nothing in it.
 */
async function loadLaunchDetail(token) {
  state.launchRecord = null;
  state.launchState = null;
  state.launchError = null;

  const launcher = resolveLauncherAddress();
  if (!launcher) {
    state.launchError = 'No market launcher is configured, so this launch cannot be verified here.';
    return;
  }

  try {
    // Holder discovery needs a scan window. The launch event gives us one; without it we say so
    // rather than silently reporting an unreconciled supply as if it balanced.
    let fromBlock;
    try {
      const logs = await chain.getLogs({
        address: launcher,
        topics: [
          chain.ABI.TOPICS['TokenLaunchedToUniswap(address,address,address,address,uint256)'],
          `0x${'0'.repeat(24)}${token.replace(/^0x/, '')}`.toLowerCase(),
        ],
        fromBlock: 0,
      });
      if (logs.length) fromBlock = Number(BigInt(logs[0].blockNumber));
    } catch { /* leave undefined; the record will mark supply as unreconcilable */ }

    const controlled = [state.account].filter(Boolean);
    const record = await chain.readLaunchState({ launcher, token, controlledWallets: controlled, fromBlock });
    state.launchRecord = record;
    state.launchState = buildLaunchState(record);
  } catch (e) {
    state.launchError = chain.describeError(e);
  }
}

function launchDetailView() {
  const back = state.pad
    ? `#live-pad=${state.pad.address}`
    : '#live';

  if (state.launchError) {
    return `<div class="live-shell">
      <a class="muted small" href="${esc(back)}">← back</a>
      <div class="notice bad" style="margin-top:12px"><strong>Could not verify this launch.</strong>
        ${esc(state.launchError)}</div></div>`;
  }
  if (!state.launchState) {
    return `<div class="live-shell"><a class="muted small" href="${esc(back)}">← back</a>
      <div class="empty">${state.busy ? 'Verifying on chain…' : 'Nothing loaded.'}</div></div>`;
  }

  const s = state.launchState;
  const explorerBase = chain.CHAINS && state.chainId
    ? (chain.explorerUrl('address', '0x0', state.chainId) || '').replace(/\/address\/0x0$/, '')
    : '';

  return `<div class="live-shell">
    <a class="muted small" href="${esc(back)}">← back</a>
    <div class="toolbar" style="margin-top:10px">
      <div><div class="eyebrow green">Launch</div>
        <h2 style="margin:6px 0">$${esc(s.token.symbol || '')} — full lifecycle</h2></div>
    </div>
    ${renderLaunchDetail(s, { explorerBase })}
  </div>`;
}

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
window.__live = { state, chain, boot, factoryAddress, DEPLOYMENT, buildLaunchState, renderLaunchDetail };

if (isLiveRoute()) boot();
