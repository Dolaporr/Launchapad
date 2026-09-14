// ---------------------------------------------------------------------------
// connectUI.js — one Connect wallet control, and the sheet behind it.
//
// Shared by the apex and by every hosted pad so the connect path is identical
// wherever a visitor meets it.
//
// The rule this module exists to enforce: THE HEADER ALWAYS OFFERS AN ACTION.
// Previously a visitor with no injected wallet got the text "No wallet detected"
// and nothing to press, which on mobile Safari is every visitor. A dead end is
// not a state, it is a bug.
// ---------------------------------------------------------------------------

import * as wallet from './wallet.js';
import { ROUTE, PLATFORM } from '../walletEnv.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** The header control. Always a button, never a dead label. */
export function connectButton({ small = true } = {}) {
  const w = wallet.wallet;
  const cls = small ? 'btn small' : 'btn';

  if (w.status === wallet.WALLET.READY) {
    return `<button class="${cls} ghost" data-wallet-open
      title="${esc(w.address)}">${esc(wallet.shortAddress(w.address))}</button>`;
  }
  if (w.status === wallet.WALLET.WRONG_CHAIN) {
    return `<button class="${cls}" data-wallet-open>Wrong network</button>`;
  }
  // NO_PROVIDER and DISCONNECTED both get the same call to action. What differs
  // is what the sheet offers once it opens.
  return `<button class="${cls} primary" data-wallet-open>Connect wallet</button>`;
}

function chainName(chainId) {
  const c = wallet.chain.CHAINS_BY_ID?.[Number(chainId)];
  return c ? c.chainName : `chain ${chainId}`;
}

// --- the sheet -------------------------------------------------------------

function sheetBody() {
  const w = wallet.wallet;
  const env = wallet.environment;

  if (w.status === wallet.WALLET.READY) {
    return `
      <p class="muted small">Connected on ${esc(chainName(w.chainId))}.</p>
      <div class="wc-addr mono">${esc(w.address)}</div>
      <p class="muted small">Launchpad.family never holds your keys. Every action is
         signed in your own wallet, and nothing is signed unless you approve it.</p>`;
  }

  if (w.status === wallet.WALLET.WRONG_CHAIN) {
    const target = wallet.chain.TARGET_CHAIN;
    return `
      <p>Your wallet is on <strong>${esc(chainName(w.chainId))}</strong>. This runs on
         <strong>${esc(target.chainName)}</strong> (chain ${esc(String(target.chainId))}).</p>
      <button class="btn primary wc-wide" data-wallet-switch>
        Switch to ${esc(target.chainName)}</button>
      <p class="muted small">If your wallet does not know this network yet, it will offer
         to add it first. Adding a network does not move any funds.</p>`;
  }

  if (env.route === ROUTE.INJECTED || w.status === wallet.WALLET.DISCONNECTED) {
    const choices = wallet.providerChoices();
    const picker = choices.length > 1
      ? `<p class="muted small">Several wallets are installed. Pick one:</p>
         <div class="wc-list">${choices.map((c) => `
           <button class="wc-item" data-wallet-use="${esc(c.rdns)}">
             ${c.icon ? `<img src="${esc(c.icon)}" alt="" />` : '<span class="wc-dot"></span>'}
             <span>${esc(c.name)}</span>
           </button>`).join('')}</div>`
      : '';
    return `
      ${picker}
      <button class="btn primary wc-wide" data-wallet-connect>Connect</button>
      <p class="muted small">Your wallet will ask you to approve the connection.
         Connecting only shares your address — it cannot move funds.</p>`;
  }

  if (env.route === ROUTE.DEEP_LINK) {
    return `
      <p>This browser has no wallet in it. Open this page inside your wallet's own
         browser and it will connect automatically.</p>
      <div class="wc-list">${env.links.map((l) => `
        <a class="wc-item" href="${esc(l.href)}" rel="noopener">
          <span class="wc-dot"></span><span>Open in ${esc(l.name)}</span>
        </a>`).join('')}</div>
      ${copyBlock('Or copy this link and paste it into your wallet app\'s browser.')}`;
  }

  // ROUTE.MANUAL — say which of the several reasons applies.
  if (env.reason === 'insecure_context') {
    return `<div class="notice bad"><strong>This page is not served over HTTPS.</strong>
      Wallets refuse to connect to an insecure page, so no wallet can be used here
      until that is fixed. This is a problem with the site, not with your wallet.</div>`;
  }
  if (env.reason === 'wallet_browser_no_provider') {
    return `<p>You appear to be inside a wallet app's browser, but it is not offering a
      wallet to this page. Try reloading, or check that the wallet app is unlocked.</p>
      ${copyBlock('If it keeps failing, copy this link and open it in a different wallet.')}`;
  }
  if (env.platform === PLATFORM.DESKTOP) {
    return `
      <p>No wallet extension is installed in this browser. Launchpads are created on
         chain, so a wallet is needed to sign.</p>
      <div class="wc-list">
        <a class="wc-item" href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">
          <span class="wc-dot"></span><span>Install MetaMask</span></a>
        <a class="wc-item" href="https://www.coinbase.com/wallet/downloads" target="_blank" rel="noopener noreferrer">
          <span class="wc-dot"></span><span>Install Coinbase Wallet</span></a>
      </div>
      <p class="muted small">Install one, then reload this page. Any EVM wallet works —
         these are only the most common.</p>`;
  }
  return `
    <p>No wallet is available in this browser, and we could not find a wallet app to
       hand this page to.</p>
    ${copyBlock('Copy this link and open it inside your wallet app\'s browser.')}`;
}

function copyBlock(label) {
  const href = typeof window === 'undefined' ? '' : window.location.href;
  return `<p class="muted small">${esc(label)}</p>
    <div class="wc-copy">
      <code class="mono">${esc(href)}</code>
      <button class="btn small" data-wallet-copy>Copy</button>
    </div>`;
}

let sheet = null;

function close() {
  sheet?.remove();
  sheet = null;
  document.removeEventListener('keydown', onKey);
}

function onKey(event) { if (event.key === 'Escape') close(); }

function render() {
  if (!sheet) return;
  const w = wallet.wallet;
  const title = w.status === wallet.WALLET.READY ? 'Wallet'
    : w.status === wallet.WALLET.WRONG_CHAIN ? 'Wrong network' : 'Connect a wallet';

  sheet.innerHTML = `
    <div class="wc-backdrop" data-wallet-close></div>
    <div class="wc-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="wc-head">
        <h3>${esc(title)}</h3>
        <button class="wc-x" data-wallet-close aria-label="Close">&times;</button>
      </div>
      <div class="wc-body">${sheetBody()}</div>
    </div>`;

  sheet.querySelectorAll('[data-wallet-close]').forEach((el) => { el.onclick = close; });

  const connectBtn = sheet.querySelector('[data-wallet-connect]');
  if (connectBtn) {
    connectBtn.onclick = async () => {
      connectBtn.disabled = true;
      connectBtn.textContent = 'Check your wallet…';
      const result = await wallet.connect();
      if (result.ok) { close(); return; }
      render();
      if (result.message) {
        const body = sheet?.querySelector('.wc-body');
        if (body) {
          body.insertAdjacentHTML('afterbegin',
            `<div class="notice warn">${esc(result.message)}</div>`);
        }
      }
    };
  }

  const switchBtn = sheet.querySelector('[data-wallet-switch]');
  if (switchBtn) {
    switchBtn.onclick = async () => {
      switchBtn.disabled = true;
      switchBtn.textContent = 'Check your wallet…';
      const result = await wallet.switchChain();
      if (result.ok) { close(); return; }
      render();
      if (result.message) {
        const body = sheet?.querySelector('.wc-body');
        if (body) {
          body.insertAdjacentHTML('afterbegin',
            `<div class="notice warn">${esc(result.message)}</div>`);
        }
      }
    };
  }

  sheet.querySelectorAll('[data-wallet-use]').forEach((el) => {
    el.onclick = async () => {
      await wallet.useProvider(el.getAttribute('data-wallet-use'));
      render();
    };
  });

  const copyBtn = sheet.querySelector('[data-wallet-copy]');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        copyBtn.textContent = 'Copied';
      } catch {
        // Clipboard is permission-gated and blocked in some in-app browsers.
        // The URL is on screen either way, so say so instead of failing silently.
        copyBtn.textContent = 'Select it above';
      }
    };
  }
}

export function openSheet() {
  if (sheet) { render(); return; }
  sheet = document.createElement('div');
  sheet.className = 'wc-sheet';
  document.body.appendChild(sheet);
  document.addEventListener('keydown', onKey);
  render();
}

/**
 * Delegated so a header can be re-rendered freely without rebinding. Call once.
 */
export function install() {
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-wallet-open]');
    if (!trigger) return;
    event.preventDefault();
    openSheet();
  });
  wallet.onWalletChange(() => { if (sheet) render(); });
}
