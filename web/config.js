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
  // Live on public Robinhood Chain testnet.
  // https://explorer.testnet.chain.robinhood.com/address/0x26481da19fC7ac724DE7Dd52f98f7596f2aaBB97
  FACTORY_ADDRESS: '0x26481da19fC7ac724DE7Dd52f98f7596f2aaBB97',
  // No ReserveVault was deployed. This factory's supportsNvdaReserve() is false, so it cannot
  // create an NVDA-preset launchpad at all: there is no official NVDA Stock Token on testnet.
  RESERVE_VAULT: null,
  deployedAt: '2026-09-12T22:31:54Z',
  deployTx: '0x259edebafb8ba50628bb5ba13113435379337a969f8ec154987103747096c251',

  // --- Milestone 2.5 market contracts ---
  // null until deployed. Uniswap's Liquidity Launchpad exists ONLY on Robinhood Chain mainnet
  // (4663), so these can only be exercised against mainnet or a mainnet fork — never on testnet.
  LAUNCHER_ADDRESS: null,
  REWARDS_ADDRESS: null,
};

const LAUNCHER_KEY = 'launchpad-family-launcher';
const REWARDS_KEY = 'launchpad-family-rewards';

function resolveFrom(key, param, baked) {
  let fromUrl = null;
  try { fromUrl = new URLSearchParams(window.location.search).get(param); } catch { /* no URL */ }
  if (fromUrl && /^0x[0-9a-fA-F]{40}$/.test(fromUrl)) {
    try { localStorage.setItem(key, fromUrl); } catch { /* private mode */ }
    return fromUrl;
  }
  try {
    const stored = localStorage.getItem(key);
    if (stored && /^0x[0-9a-fA-F]{40}$/.test(stored)) return stored;
  } catch { /* private mode */ }
  return baked;
}

/** Market launcher address, from ?launcher=, then localStorage, then the baked-in value. */
export function resolveLauncherAddress() {
  return resolveFrom(LAUNCHER_KEY, 'launcher', DEPLOYMENT.LAUNCHER_ADDRESS);
}

/** Rewards splitter address, from ?rewards=, then localStorage, then the baked-in value. */
export function resolveRewardsAddress() {
  return resolveFrom(REWARDS_KEY, 'rewards', DEPLOYMENT.REWARDS_ADDRESS);
}

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
