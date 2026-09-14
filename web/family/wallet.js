// ---------------------------------------------------------------------------
// Wallet state.
//
// Wallet states are product states, not edge cases. A visitor with no wallet, a
// wallet on the wrong chain, a rejected signature and a pending transaction are
// each things a real person hits on their first visit, so each has a defined
// shape here and a defined rendering at the call site.
//
// Chain reads and transactions go through web/chain.js, which is already
// CI-guarded against selector drift.
// ---------------------------------------------------------------------------

import * as chain from '../chain.js';
import { connectionEnvironment, ROUTE, PLATFORM } from '../walletEnv.js';

export const WALLET = {
  NO_PROVIDER: 'no_provider',   // no injected wallet at all
  DISCONNECTED: 'disconnected', // provider present, not authorised
  WRONG_CHAIN: 'wrong_chain',   // connected, but not the chain this pad lives on
  READY: 'ready',
};

export { ROUTE, PLATFORM };

/**
 * How THIS browser can reach a wallet.
 *
 * Computed once at init from the real environment. NO_PROVIDER is not one state:
 * a desktop visitor needs an extension, an Android visitor needs a hand-off link,
 * and someone on plain http cannot connect at all until that is fixed. Collapsing
 * them into "No wallet detected" is what left mobile visitors with no way forward.
 */
export const environment = {
  route: ROUTE.MANUAL,
  platform: PLATFORM.DESKTOP,
  inWalletBrowser: false,
  links: [],
  reason: null,
};

const listeners = new Set();

export const wallet = {
  status: WALLET.NO_PROVIDER,
  address: null,
  chainId: null,
  /** The chain the app expects, supplied by the server config. */
  expectedChainId: null,
};

export function onWalletChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() { listeners.forEach((fn) => fn(wallet)); }

export function shortAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function sameAddress(a, b) {
  return Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();
}

/** Reads current wallet state without prompting. Safe to call on every render. */
export async function refresh() {
  if (!chain.hasWallet()) {
    wallet.status = WALLET.NO_PROVIDER;
    wallet.address = null;
    emit();
    return wallet;
  }
  try {
    const accounts = await chain.getAccounts();
    wallet.chainId = await chain.getChainId();
    if (!accounts.length) {
      wallet.status = WALLET.DISCONNECTED;
      wallet.address = null;
    } else if (wallet.expectedChainId && wallet.chainId !== wallet.expectedChainId) {
      wallet.status = WALLET.WRONG_CHAIN;
      wallet.address = accounts[0];
    } else {
      wallet.status = WALLET.READY;
      wallet.address = accounts[0];
    }
  } catch {
    wallet.status = WALLET.DISCONNECTED;
    wallet.address = null;
  }
  emit();
  return wallet;
}

/** Prompts for connection. Rejection is a normal outcome, not an error to throw. */
export async function connect() {
  if (!chain.hasWallet()) return { ok: false, code: WALLET.NO_PROVIDER };
  try {
    await chain.connect();
    await refresh();
    return { ok: wallet.status === WALLET.READY, status: wallet.status };
  } catch (error) {
    await refresh();
    return { ok: false, code: 'rejected', message: chain.describeError(error) };
  }
}

export async function switchChain() {
  try {
    await chain.switchToTargetChain();
    await refresh();
    return { ok: wallet.status === WALLET.READY };
  } catch (error) {
    return { ok: false, message: chain.describeError(error) };
  }
}

/** Signs a server challenge. Returns a discriminated result rather than throwing. */
export async function signMessage(message) {
  if (!wallet.address) return { ok: false, code: 'no_wallet' };
  try {
    const signature = await chain.request('personal_sign', [
      `0x${Array.from(new TextEncoder().encode(message))
        .map((b) => b.toString(16).padStart(2, '0')).join('')}`,
      wallet.address,
    ]);
    return { ok: true, signature };
  } catch (error) {
    return { ok: false, code: 'rejected', message: chain.describeError(error) };
  }
}

/** Wallets this browser can hand off to. Empty on desktop and in wallet browsers. */
export function walletLinks() { return environment.links; }

/** Switches to an EIP-6963 wallet the visitor picked, then re-reads state. */
export async function useProvider(rdns) {
  if (!chain.selectProvider(rdns)) return { ok: false, code: 'unknown_provider' };
  bindProviderEvents();
  await refresh();
  return { ok: true };
}

export function providerChoices() { return chain.listProviders(); }
export function needsProviderChoice() { return chain.needsProviderChoice(); }

let boundProvider = null;
function bindProviderEvents() {
  const provider = chain.getProvider();
  if (!provider || provider === boundProvider) return;
  boundProvider = provider;
  provider.on?.('accountsChanged', () => { refresh(); });
  provider.on?.('chainChanged', () => {
    // The wallet may have just moved off the chain we read about, so the next
    // read must re-decide whether it can be trusted as a source.
    chain.resetInjectedChainCache();
    refresh();
  });
}

export function init(expectedChainId) {
  wallet.expectedChainId = expectedChainId;

  // Aim the switch/add-network flow at the SAME chain detection compares against.
  // These two disagreeing is what made "Switch network" an unescapable loop.
  if (expectedChainId) {
    try {
      chain.setTargetChain(expectedChainId);
    } catch (error) {
      // A chain we have no definition for cannot be switched to or added. Surfaced
      // rather than swallowed: silently aiming at the wrong chain is the bug we
      // are fixing.
      console.error(`wallet: ${error.message}`);
    }
  }

  chain.discoverProviders();

  Object.assign(environment, connectionEnvironment({
    hasInjected: chain.hasWallet(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    maxTouchPoints: typeof navigator === 'undefined' ? 0 : (navigator.maxTouchPoints || 0),
    location: typeof window === 'undefined' ? { href: '' } : window.location,
    secureContext: typeof window === 'undefined' ? true : window.isSecureContext,
  }));

  bindProviderEvents();

  // A wallet that announces itself over EIP-6963 can arrive after first paint,
  // which would otherwise leave a visitor looking at a permanent "no wallet".
  if (typeof window !== 'undefined') {
    window.addEventListener('eip6963:announceProvider', () => {
      if (environment.route !== ROUTE.INJECTED && chain.hasWallet()) {
        environment.route = ROUTE.INJECTED;
        environment.links = [];
        bindProviderEvents();
        refresh();
      }
    });
  }

  return refresh();
}

export { chain };
