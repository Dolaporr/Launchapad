// ---------------------------------------------------------------------------
// chain.js — the ONLY file in this app that talks to a blockchain.
//
// Everything here reads or writes real on-chain state through an injected
// EIP-1193 wallet (MetaMask, Rabby, the Robinhood Wallet, ...). Nothing in this
// file is simulated, and nothing in app.js's demo mode may call into it.
//
// No build step and no CDN: the ABI codec below is hand-rolled and the selectors
// are precomputed from the compiled contract ABIs. `contracts/test/WebAbi.test.js`
// recomputes every one of them with ethers and fails CI if any drifts.
// ---------------------------------------------------------------------------

export const CHAINS = {
  // Verified 2026-09-12 against https://docs.robinhood.com/chain/connecting
  robinhoodTestnet: {
    chainId: 46630,
    chainIdHex: '0xb626',
    chainName: 'Robinhood Chain Testnet',
    rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
    blockExplorerUrls: ['https://explorer.testnet.chain.robinhood.com'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
};

export const TARGET_CHAIN = CHAINS.robinhoodTestnet;

export const PRESET = { STANDARD: 0, NVDA: 1 };
export const POLICY = { OWNER_ONLY: 0, OPEN: 1 };

export const ABI = {
  // Function selectors (first 4 bytes of keccak256 of the signature).
  SELECTORS: {
    'createLaunchpad(string,string,uint8,uint8)': '0x533f8cfb',
    'launchToken(string,string)': '0x8f84f199',
    'count()': '0x06661abd',
    'launchpadsPage(uint256,uint256)': '0xec7bccd5',
    'launchpadsOf(address)': '0xaf9607b9',
    'isLaunchpad(address)': '0xe4606ec1',
    'supportsNvdaReserve()': '0xf3b9d603',
    'name()': '0x06fdde03',
    'metadataURI()': '0x03ee438c',
    'owner()': '0x8da5cb5b',
    'preset()': '0x9256e1ff',
    'launchPolicy()': '0xf26b16db',
    'feeRouter()': '0xf29ebf61',
    'canLaunch(address)': '0x58373f04',
    'tokenCount()': '0x9f181b5e',
    'tokensPage(uint256,uint256)': '0x14fc6393',
    'tokensOf(address)': '0x5a3f2672',
    'symbol()': '0x95d89b41',
    'totalSupply()': '0x18160ddd',
    'balanceOf(address)': '0x70a08231',
    'decimals()': '0x313ce567',
    // --- Milestone 2.5: market launches through Uniswap ---
    'launch(address,string,string)': '0xce7b50f1',
    'verifyMarketLaunch(address)': '0x745d1e35',
    'verifiedLaunchOf(address)': '0xd191a66b',
    'tokensOfLaunchpad(address)': '0x1fa7c263',
    'launchOf(address)': '0x029282d7',
    'allTokens(uint256)': '0x634282af',
    'marketLauncher()': '0xfbc07d57',
    'isMarketLaunch()': '0xacff1543',
    'pending(address)': '0x5eebea20',
    'collectAndSplit(uint256)': '0x3458beb5',
    'withdraw()': '0x3ccfd60b',
    'lifetimeDistributed(uint256)': '0x2a2e6203',
    'CREATOR_BPS()': '0x45904567',
    'PAD_OWNER_BPS()': '0xc833d8d4',
    'PROTOCOL_BPS()': '0xc1e7af35',
  },
  // Event topic0 (keccak256 of the full event signature).
  TOPICS: {
    'LaunchpadCreated(address,address,address,uint8,uint8,string,string)':
      '0x250a87cdd3d55ffa4a6a59db17dbe48b7250ad56fbf2a6782958f25a2d8f7e3d',
    'TokenLaunched(address,address,string,string,uint256)':
      '0x1a8ab442384acdb09c73bc5f71549c099dad32203f07e1655e0ebce05831f749',
    'TokenLaunchedToUniswap(address,address,address,address,uint256)':
      '0x2fd6deff2f7d7caf7306d19d27f3b6ed9f732b7cf47683a76664a8703e663d65',
  },
};

// ---------------------------------------------------------------------------
// Minimal ABI codec
// ---------------------------------------------------------------------------

const strip = (hex) => (hex || '').replace(/^0x/, '');

export function padWord(hex) {
  return strip(hex).padStart(64, '0');
}

export function encodeUint(value) {
  return padWord(BigInt(value).toString(16));
}

export function encodeAddress(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`bad address: ${address}`);
  return padWord(address.slice(2).toLowerCase());
}

function utf8ToHex(text) {
  return Array.from(new TextEncoder().encode(text))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToUtf8(hex) {
  const bytes = new Uint8Array((strip(hex).match(/.{1,2}/g) || []).map((b) => parseInt(b, 16)));
  return new TextDecoder().decode(bytes);
}

/** Encodes a dynamic string as its own tail: length word + right-padded data. */
export function encodeStringTail(text) {
  const data = utf8ToHex(text);
  const byteLength = data.length / 2;
  const padded = byteLength === 0 ? '' : data.padEnd(Math.ceil(byteLength / 32) * 64, '0');
  return encodeUint(byteLength) + padded;
}

/**
 * Encodes a call whose arguments are, in order, any mix of static words and dynamic strings.
 * `args` entries are {type:'uint'|'address'|'string', value}.
 */
export function encodeCall(signature, args = []) {
  const selector = ABI.SELECTORS[signature];
  if (!selector) throw new Error(`unknown signature: ${signature}`);

  const head = [];
  const tails = [];
  // Head is one word per argument; dynamic args put an offset there and data in the tail.
  let tailOffset = args.length * 32;

  for (const arg of args) {
    if (arg.type === 'string') {
      head.push(encodeUint(tailOffset));
      const tail = encodeStringTail(arg.value);
      tails.push(tail);
      tailOffset += tail.length / 2;
    } else if (arg.type === 'address') {
      head.push(encodeAddress(arg.value));
    } else {
      head.push(encodeUint(arg.value));
    }
  }

  return selector + head.join('') + tails.join('');
}

export function decodeAddress(word) {
  return `0x${strip(word).slice(-40)}`;
}

export function decodeUint(word) {
  const hex = strip(word);
  return hex ? BigInt(`0x${hex}`) : 0n;
}

/** Decodes an ABI-encoded `string` return value. */
export function decodeString(returnData) {
  const hex = strip(returnData);
  if (hex.length < 128) return '';
  const length = Number(decodeUint(hex.slice(64, 128)));
  return hexToUtf8(hex.slice(128, 128 + length * 2));
}

/** Decodes an ABI-encoded `address[]` return value. */
export function decodeAddressArray(returnData) {
  const hex = strip(returnData);
  if (hex.length < 128) return [];
  const length = Number(decodeUint(hex.slice(64, 128)));
  const out = [];
  for (let i = 0; i < length; i += 1) {
    out.push(decodeAddress(hex.slice(128 + i * 64, 192 + i * 64)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export function getProvider() {
  return typeof window !== 'undefined' && window.ethereum ? window.ethereum : null;
}

export function hasWallet() {
  return getProvider() !== null;
}

export class WalletError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** Turns an EIP-1193 / JSON-RPC error into something a person can act on. */
export function describeError(error) {
  const code = error?.code ?? error?.data?.code;
  if (code === 4001 || /user rejected|user denied/i.test(error?.message || '')) {
    return 'You rejected the request in your wallet.';
  }
  if (code === 4902) return 'That network is not in your wallet yet.';
  if (code === -32002) return 'Your wallet already has a pending request. Open it and respond.';
  const message = error?.data?.message || error?.message || String(error);
  if (/insufficient funds/i.test(message)) {
    return 'This wallet has no testnet ETH for gas. Fund it and try again.';
  }
  return message.length > 220 ? `${message.slice(0, 220)}…` : message;
}

export async function request(method, params = []) {
  const provider = getProvider();
  if (!provider) throw new WalletError('No EVM wallet found in this browser.', 'NO_WALLET');
  return provider.request({ method, params });
}

export async function connect() {
  const accounts = await request('eth_requestAccounts');
  if (!accounts || !accounts.length) throw new WalletError('Wallet returned no accounts.', 'NO_ACCOUNTS');
  return accounts[0];
}

export async function getAccounts() {
  if (!hasWallet()) return [];
  try {
    return (await request('eth_accounts')) || [];
  } catch {
    return [];
  }
}

export async function getChainId() {
  const raw = await request('eth_chainId');
  return Number(BigInt(raw));
}

export async function isOnTargetChain() {
  try {
    return (await getChainId()) === TARGET_CHAIN.chainId;
  } catch {
    return false;
  }
}

/** Switches the wallet to Robinhood Chain testnet, adding it first if the wallet lacks it. */
export async function switchToTargetChain() {
  try {
    await request('wallet_switchEthereumChain', [{ chainId: TARGET_CHAIN.chainIdHex }]);
    return true;
  } catch (error) {
    // 4902 = unrecognised chain. Some wallets nest the code, hence the message fallback.
    const code = error?.code ?? error?.data?.originalError?.code;
    if (code === 4902 || /unrecognized chain|not added|Unrecognized chain/i.test(error?.message || '')) {
      await request('wallet_addEthereumChain', [{
        chainId: TARGET_CHAIN.chainIdHex,
        chainName: TARGET_CHAIN.chainName,
        rpcUrls: TARGET_CHAIN.rpcUrls,
        blockExplorerUrls: TARGET_CHAIN.blockExplorerUrls,
        nativeCurrency: TARGET_CHAIN.nativeCurrency,
      }]);
      return true;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Chain reads and writes
// ---------------------------------------------------------------------------

export async function ethCall(to, data) {
  return request('eth_call', [{ to, data }, 'latest']);
}

export async function callUint(to, signature, args = []) {
  return decodeUint(await ethCall(to, encodeCall(signature, args)));
}

export async function callString(to, signature, args = []) {
  return decodeString(await ethCall(to, encodeCall(signature, args)));
}

export async function callAddress(to, signature, args = []) {
  return decodeAddress(await ethCall(to, encodeCall(signature, args)));
}

export async function callAddressArray(to, signature, args = []) {
  return decodeAddressArray(await ethCall(to, encodeCall(signature, args)));
}

export async function callBool(to, signature, args = []) {
  return (await callUint(to, signature, args)) === 1n;
}

export async function sendTransaction({ from, to, data }) {
  return request('eth_sendTransaction', [{ from, to, data }]);
}

export async function getReceipt(txHash) {
  return request('eth_getTransactionReceipt', [txHash]);
}

/** Polls for a receipt. Rejects on a reverted transaction rather than reporting false success. */
export async function waitForReceipt(txHash, { timeoutMs = 180000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await getReceipt(txHash);
    if (receipt) {
      // status is '0x0' on revert. Never treat a mined-but-failed tx as success.
      if (receipt.status && BigInt(receipt.status) === 0n) {
        throw new WalletError('Transaction reverted on chain.', 'REVERTED');
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new WalletError('Timed out waiting for the transaction to be mined.', 'TIMEOUT');
}

/** Pulls an indexed address out of the first matching log. topicIndex 1 = first indexed arg. */
export function addressFromLog(receipt, topic0, topicIndex = 1) {
  const log = (receipt?.logs || []).find(
    (entry) => (entry.topics || [])[0]?.toLowerCase() === topic0.toLowerCase(),
  );
  return log ? decodeAddress(log.topics[topicIndex]) : null;
}

// ---------------------------------------------------------------------------
// Domain reads — every value here comes from the chain, never from localStorage
// ---------------------------------------------------------------------------

export async function readLaunchpad(address) {
  const [name, metadataURI, owner, preset, policy, feeRouter, tokenCount] = await Promise.all([
    callString(address, 'name()'),
    callString(address, 'metadataURI()'),
    callAddress(address, 'owner()'),
    callUint(address, 'preset()'),
    callUint(address, 'launchPolicy()'),
    callAddress(address, 'feeRouter()'),
    callUint(address, 'tokenCount()'),
  ]);

  return {
    address,
    name,
    metadataURI,
    owner,
    preset: Number(preset),
    launchPolicy: Number(policy),
    feeRouter,
    tokenCount: Number(tokenCount),
  };
}

export async function readToken(address) {
  const [name, symbol, totalSupply, decimals] = await Promise.all([
    callString(address, 'name()'),
    callString(address, 'symbol()'),
    callUint(address, 'totalSupply()'),
    callUint(address, 'decimals()'),
  ]);
  return { address, name, symbol, totalSupply, decimals: Number(decimals) };
}

export async function readPadTokens(padAddress, limit = 50) {
  const addresses = await callAddressArray(padAddress, 'tokensPage(uint256,uint256)', [
    { type: 'uint', value: 0 },
    { type: 'uint', value: limit },
  ]);
  return Promise.all(addresses.map(readToken));
}

export async function readFactoryLaunchpads(factoryAddress, limit = 50) {
  const addresses = await callAddressArray(factoryAddress, 'launchpadsPage(uint256,uint256)', [
    { type: 'uint', value: 0 },
    { type: 'uint', value: limit },
  ]);
  return Promise.all(addresses.map(readLaunchpad));
}

// ---------------------------------------------------------------------------
// Domain writes
// ---------------------------------------------------------------------------

export async function createLaunchpadTx({ from, factory, name, metadataURI, preset, policy }) {
  const data = encodeCall('createLaunchpad(string,string,uint8,uint8)', [
    { type: 'string', value: name },
    { type: 'string', value: metadataURI || '' },
    { type: 'uint', value: preset },
    { type: 'uint', value: policy },
  ]);
  return sendTransaction({ from, to: factory, data });
}

/// Supply is not a parameter: every LaunchToken is fixed at 1,000,000,000 x 18 decimals,
/// because Uniswap's InstantLaunchStrategy rejects anything else.
export const FIXED_TOKEN_SUPPLY = 1000000000n;

// ---------------------------------------------------------------------------
// Market launches (Milestone 2.5)
//
// A market launch creates a real Uniswap v4 pool with permanently locked liquidity.
// A token-only deployment (`launchTokenTx` below) creates neither. The UI must never
// present them as the same thing — always gate on `verifyMarketLaunch`.
// ---------------------------------------------------------------------------

/// Sends the real market launch: pad -> Uniswap Liquidity Launchpad -> pool + attribution.
export async function launchMarketTokenTx({ from, launcher, pad, name, symbol }) {
  const data = encodeCall('launch(address,string,string)', [
    { type: 'address', value: pad },
    { type: 'string', value: name },
    { type: 'string', value: symbol },
  ]);
  return sendTransaction({ from, to: launcher, data });
}

/// The canonical check. Both directions of the binding, verified on chain.
export async function isVerifiedMarketLaunch(launcher, token) {
  return callBool(launcher, 'verifyMarketLaunch(address)', [{ type: 'address', value: token }]);
}

/// Reads the immutable attribution for a verified market launch.
export async function readMarketLaunch(launcher, token) {
  const raw = await ethCall(launcher, encodeCall('verifiedLaunchOf(address)', [
    { type: 'address', value: token },
  ]));
  const hex = (raw || '').replace(/^0x/, '');
  if (hex.length < 64 * 5) return null;
  const word = (i) => hex.slice(i * 64, (i + 1) * 64);
  const verified = BigInt(`0x${word(0)}`) === 1n;
  if (!verified) return null;
  return {
    token,
    verified,
    tokenCreator: decodeAddress(word(1)),
    launchpadOwner: decodeAddress(word(2)),
    launchpad: decodeAddress(word(3)),
    positionTokenId: BigInt(`0x${word(4)}`),
  };
}

export async function readMarketTokensOfPad(launcher, pad) {
  return callAddressArray(launcher, 'tokensOfLaunchpad(address)', [{ type: 'address', value: pad }]);
}

/// What a party can withdraw right now, and what has been distributed for a position so far.
export async function readRewards(rewards, { party, positionTokenId }) {
  const [pending, lifetime, creatorBps, padBps, protocolBps] = await Promise.all([
    party ? callUint(rewards, 'pending(address)', [{ type: 'address', value: party }]) : Promise.resolve(0n),
    positionTokenId !== undefined
      ? callUint(rewards, 'lifetimeDistributed(uint256)', [{ type: 'uint', value: positionTokenId }])
      : Promise.resolve(0n),
    callUint(rewards, 'CREATOR_BPS()'),
    callUint(rewards, 'PAD_OWNER_BPS()'),
    callUint(rewards, 'PROTOCOL_BPS()'),
  ]);
  return { pending, lifetime, creatorBps, padBps, protocolBps };
}

/// Permissionless: pulls this position's accrued fees from Uniswap and splits them 50/30/20.
export async function collectAndSplitTx({ from, rewards, positionTokenId }) {
  const data = encodeCall('collectAndSplit(uint256)', [{ type: 'uint', value: positionTokenId }]);
  return sendTransaction({ from, to: rewards, data });
}

export async function withdrawRewardsTx({ from, rewards }) {
  return sendTransaction({ from, to: rewards, data: encodeCall('withdraw()') });
}

export async function launchTokenTx({ from, pad, name, symbol }) {
  const data = encodeCall('launchToken(string,string)', [
    { type: 'string', value: name },
    { type: 'string', value: symbol },
  ]);
  return sendTransaction({ from, to: pad, data });
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function explorerUrl(kind, value, chainId = TARGET_CHAIN.chainId) {
  const chain = Object.values(CHAINS).find((c) => c.chainId === chainId);
  // Never invent an explorer URL for a chain we have no explorer for.
  if (!chain) return null;
  return `${chain.blockExplorerUrls[0]}/${kind}/${value}`;
}

export function shortAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatUnits(value, decimals = 18) {
  const negative = value < 0n;
  const raw = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = raw.slice(0, raw.length - decimals);
  const fraction = raw.slice(raw.length - decimals).replace(/0+$/, '');
  const formatted = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${formatted}` : formatted;
}

export function presetLabel(preset) {
  return preset === PRESET.NVDA ? 'NVDA Reserve' : 'Standard (alpha default)';
}

export function policyLabel(policy) {
  return policy === POLICY.OPEN ? 'Open — anyone can launch' : 'Owner only';
}
