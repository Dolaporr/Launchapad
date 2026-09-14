// ---------------------------------------------------------------------------
// walletEnv.js — what kind of browser is this, and what can the visitor do here?
//
// Pure functions only: no DOM, no window, no network. Everything takes its
// inputs as arguments so the whole decision table is testable in Node.
//
// The problem this solves: a visitor on mobile Safari has no injected wallet and
// never will. Telling them "No wallet detected" is true and useless. What they
// need is the one action that works — reopen this page inside their wallet's own
// browser — and on iOS that is the ONLY thing that works.
// ---------------------------------------------------------------------------

/** What connection routes are available to this visitor. */
export const ROUTE = {
  INJECTED: 'injected',     // a wallet is in this page; connect directly
  DEEP_LINK: 'deep_link',   // no wallet here, but we can hand off to a wallet app
  MANUAL: 'manual',         // no wallet and no reliable hand-off; give instructions
};

export const PLATFORM = {
  IOS: 'ios',
  ANDROID: 'android',
  DESKTOP: 'desktop',
};

/**
 * Platform from a user-agent string.
 *
 * iPadOS 13+ reports itself as a Mac, and the only reliable tell is that it is a
 * "Mac" with a touchscreen. Getting this wrong matters: iPad users would be
 * offered desktop extension advice that cannot work there.
 */
export function platformOf(userAgent = '', { maxTouchPoints = 0 } = {}) {
  const ua = String(userAgent);
  if (/iPhone|iPod/i.test(ua)) return PLATFORM.IOS;
  if (/iPad/i.test(ua)) return PLATFORM.IOS;
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return PLATFORM.IOS;
  if (/Android/i.test(ua)) return PLATFORM.ANDROID;
  return PLATFORM.DESKTOP;
}

export function isMobile(platform) {
  return platform === PLATFORM.IOS || platform === PLATFORM.ANDROID;
}

/**
 * Are we already running inside a wallet's in-app browser?
 *
 * Worth knowing because such a browser DOES inject a provider, and offering it a
 * "open in your wallet app" button would loop the user back to where they are.
 */
export function isInWalletBrowser(userAgent = '') {
  return /MetaMaskMobile|Trust\/|TrustWallet|CoinbaseWallet|CoinbaseBrowser|Rainbow|imToken|TokenPocket|OKApp/i
    .test(String(userAgent));
}

// ---------------------------------------------------------------------------
// Wallet hand-off links.
//
// Each of these reopens the CURRENT page inside a wallet's own browser, where a
// provider is injected and the normal injected flow takes over. No SDK, no relay
// server, no project ID, no third party in the connection path.
//
// Formats verified 2026-09-13 against each vendor's own developer documentation.
// They are vendor-owned URLs and can change; `linkFor` returning null is a
// supported outcome, not a bug.
// ---------------------------------------------------------------------------

export const WALLETS = [
  {
    id: 'metamask',
    name: 'MetaMask',
    // Takes host+path WITHOUT a scheme. Passing https:// here yields a broken link.
    link: ({ host, path }) => `https://metamask.app.link/dapp/${host}${path}`,
    platforms: [PLATFORM.IOS, PLATFORM.ANDROID],
  },
  {
    id: 'coinbase',
    name: 'Coinbase Wallet',
    link: ({ url }) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}`,
    platforms: [PLATFORM.IOS, PLATFORM.ANDROID],
  },
  {
    id: 'trust',
    name: 'Trust Wallet',
    link: ({ url }) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}`,
    // ANDROID ONLY. Trust removed its in-app dApp browser on iOS in May 2021 to
    // comply with App Store rules, so this link is a dead end on an iPhone and
    // must never be offered there.
    platforms: [PLATFORM.ANDROID],
  },
];

/**
 * Hand-off link for one wallet, or null when that wallet cannot open a dApp on
 * this platform.
 *
 * @param {string} walletId
 * @param {{href: string}} location  the page to reopen
 * @param {string} platform
 */
export function linkFor(walletId, location, platform) {
  const entry = WALLETS.find((w) => w.id === walletId);
  if (!entry) return null;
  if (!entry.platforms.includes(platform)) return null;

  const url = String(location?.href || '');
  if (!/^https?:\/\//i.test(url)) return null;
  // Deep links hand a URL to another app. Only http(s) may ever be handed over.
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  return entry.link({
    url,
    host: parsed.host,
    path: `${parsed.pathname}${parsed.search}`,
  });
}

/** Every wallet that can actually open this page on this platform. */
export function walletLinks(location, platform) {
  return WALLETS
    .map((w) => ({ id: w.id, name: w.name, href: linkFor(w.id, location, platform) }))
    .filter((w) => w.href !== null);
}

/**
 * The whole decision, in one place.
 *
 * @param {object} env
 * @param {boolean} env.hasInjected     is an EIP-1193 provider present
 * @param {string}  env.userAgent
 * @param {number}  env.maxTouchPoints
 * @param {{href: string}} env.location
 * @param {boolean} env.secureContext   wallets refuse to inject over plain http
 */
export function connectionEnvironment({
  hasInjected = false,
  userAgent = '',
  maxTouchPoints = 0,
  location = { href: '' },
  secureContext = true,
} = {}) {
  const platform = platformOf(userAgent, { maxTouchPoints });
  const inWalletBrowser = isInWalletBrowser(userAgent);

  if (hasInjected) {
    return {
      route: ROUTE.INJECTED, platform, inWalletBrowser, links: [], reason: null,
    };
  }

  // A wallet will not inject over plain http, so no amount of app-switching
  // helps until the page is served over https. Say that, rather than sending
  // the visitor round a loop that cannot close.
  if (!secureContext) {
    return {
      route: ROUTE.MANUAL,
      platform,
      inWalletBrowser,
      links: [],
      reason: 'insecure_context',
    };
  }

  // Already inside a wallet browser but still no provider: handing off again
  // would just reopen the same page in the same app.
  if (inWalletBrowser) {
    return {
      route: ROUTE.MANUAL, platform, inWalletBrowser, links: [], reason: 'wallet_browser_no_provider',
    };
  }

  const links = isMobile(platform) ? walletLinks(location, platform) : [];
  return links.length
    ? { route: ROUTE.DEEP_LINK, platform, inWalletBrowser, links, reason: null }
    : {
      route: ROUTE.MANUAL,
      platform,
      inWalletBrowser,
      links: [],
      reason: platform === PLATFORM.DESKTOP ? 'desktop_no_extension' : 'no_supported_wallet',
    };
}
