// ---------------------------------------------------------------------------
// Deployment addresses for the live (on-chain) section of the app.
//
// FACTORY_ADDRESS is null until a real LaunchpadFactory has been deployed to
// Robinhood Chain testnet. While it is null the live section says so plainly
// rather than pretending to have a chain to talk to.
//
// You can also point the app at a factory without editing this file:
//   http://localhost:4173/?factory=0x...       (remembered in localStorage)
// ---------------------------------------------------------------------------

export const DEPLOYMENT = {
  chainId: 46630,
  chainName: 'Robinhood Chain Testnet',
  // Set by scripts/deploy.cjs output. null = not deployed yet.
  FACTORY_ADDRESS: null,
  // The vault is deployed alongside the factory but the live UI does not use it yet:
  // there is no NVDA on testnet and no buyer module, so no reserve flow is exposed.
  RESERVE_VAULT: null,
  deployedAt: null,
};

const STORAGE_KEY = 'launchpad-factory-address';

/** Resolves the factory address from ?factory=, then localStorage, then the baked-in default. */
export function resolveFactoryAddress() {
  let fromUrl = null;
  try {
    fromUrl = new URLSearchParams(window.location.search).get('factory');
  } catch { /* no URL access */ }

  if (fromUrl && /^0x[0-9a-fA-F]{40}$/.test(fromUrl)) {
    try { localStorage.setItem(STORAGE_KEY, fromUrl); } catch { /* private mode */ }
    return fromUrl;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && /^0x[0-9a-fA-F]{40}$/.test(stored)) return stored;
  } catch { /* private mode */ }

  return DEPLOYMENT.FACTORY_ADDRESS;
}

export function clearStoredFactoryAddress() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
}
