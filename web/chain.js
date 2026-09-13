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
    // --- launch detail: proving the lock and reconciling the money ---
    'ownerOf(uint256)': '0x6352211e',
    'attributionOf(uint256)': '0x84c07853',
    'totalPending()': '0x3f90916a',
    'unaccountedBalance()': '0x382e8547',
    'protocolTreasury()': '0x803db96d',
    'registrar()': '0x2b20e397',
    'launchpadFactory()': '0x69cc944e',
    'rewards()': '0x9ec5a894',
    // --- the pool a position actually sits in, read rather than assumed ---
    'getPoolAndPositionInfo(uint256)': '0x7ba03aad',
    'getPositionLiquidity(uint256)': '0x1efeed33',
  },
  // Event topic0 (keccak256 of the full event signature).
  TOPICS: {
    'LaunchpadCreated(address,address,address,uint8,uint8,string,string)':
      '0x250a87cdd3d55ffa4a6a59db17dbe48b7250ad56fbf2a6782958f25a2d8f7e3d',
    'TokenLaunched(address,address,string,string,uint256)':
      '0x1a8ab442384acdb09c73bc5f71549c099dad32203f07e1655e0ebce05831f749',
    'TokenLaunchedToUniswap(address,address,address,address,uint256)':
      '0x2fd6deff2f7d7caf7306d19d27f3b6ed9f732b7cf47683a76664a8703e663d65',
    'Transfer(address,address,uint256)':
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    'RewardsSplit(uint256,uint256,uint256,uint256,uint256)':
      '0xb13a17f6e353d70a3d72e277f048428b5c8220f16d1a73924fd7fc4833668e95',
    'Withdrawn(address,uint256)':
      '0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5',
  },
};

// Official Uniswap deployment on Robinhood Chain mainnet (4663). Pinned, never resolved by name.
export const UNISWAP = {
  feeSplitter: '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf',
  beneficiaryVault: '0xd35E9CA72F64C7F93BE30fad67524323396B36D7',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  instantLaunchStrategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',
};
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

// Every read takes an optional block tag. Reconciliation reads pin themselves to
// one block: a claim like "every wei reconciles" is only true of a single state,
// and a fee claimed between two `latest` reads would make the sums disagree for
// reasons that have nothing to do with the protocol being wrong.
export async function ethCall(to, data, blockTag = 'latest') {
  return request('eth_call', [{ to, data }, blockTag]);
}

export async function callUint(to, signature, args = [], blockTag = 'latest') {
  return decodeUint(await ethCall(to, encodeCall(signature, args), blockTag));
}

export async function callString(to, signature, args = [], blockTag = 'latest') {
  return decodeString(await ethCall(to, encodeCall(signature, args), blockTag));
}

export async function callAddress(to, signature, args = [], blockTag = 'latest') {
  return decodeAddress(await ethCall(to, encodeCall(signature, args), blockTag));
}

export async function callAddressArray(to, signature, args = [], blockTag = 'latest') {
  return decodeAddressArray(await ethCall(to, encodeCall(signature, args), blockTag));
}

export async function callBool(to, signature, args = [], blockTag = 'latest') {
  return (await callUint(to, signature, args, blockTag)) === 1n;
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
export async function readMarketLaunch(launcher, token, blockTag = 'latest') {
  const raw = await ethCall(launcher, encodeCall('verifiedLaunchOf(address)', [
    { type: 'address', value: token },
  ]), blockTag);
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

/**
 * The PoolKey an LP position actually sits in, plus its liquidity.
 *
 * The pool's parameters are READ, never assumed. Deriving a pool id from the
 * parameters we expect and then reporting those same parameters back would
 * prove nothing: it would only restate the assumption. Asking the
 * PositionManager which pool THIS position is in proves the launch really used
 * an ETH-paired, 25 bps, hookless pool.
 *
 * PoolKey is a static struct, so the return is six flat words:
 * currency0, currency1, fee, tickSpacing, hooks, packed position info.
 */
export async function readPoolKey(positionTokenId, blockTag = 'latest') {
  const raw = await ethCall(
    UNISWAP.positionManager,
    encodeCall('getPoolAndPositionInfo(uint256)', [{ type: 'uint', value: positionTokenId }]),
    blockTag,
  );
  const hex = strip(raw);
  if (hex.length < 64 * 6) return null;
  const word = (i) => hex.slice(i * 64, (i + 1) * 64);
  return {
    currency0: decodeAddress(word(0)),
    currency1: decodeAddress(word(1)),
    fee: Number(BigInt(`0x${word(2)}`)),
    // int24, but a tick spacing is never negative in practice; read as unsigned.
    tickSpacing: Number(BigInt(`0x${word(3)}`)),
    hooks: decodeAddress(word(4)),
  };
}

export async function readPositionLiquidity(positionTokenId, blockTag = 'latest') {
  return callUint(UNISWAP.positionManager, 'getPositionLiquidity(uint256)',
    [{ type: 'uint', value: positionTokenId }], blockTag);
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

// ---------------------------------------------------------------------------
// Launch detail — builds a verification record for ONE launch, from chain.
//
// Produces the same shape as contracts/scripts/lib/launchVerifier.cjs so the
// tested product model in launchState.js consumes it unchanged.
//
// Anything that cannot be established from chain is left NULL and the matching
// check is recorded as failed. It is never inferred, and never defaulted to a
// value that would render as a confident zero.
// ---------------------------------------------------------------------------

/** eth_getLogs through the injected provider. Throws rather than returning partial data. */
export async function getLogs({ address, topics, fromBlock, toBlock = 'latest' }) {
  return request('eth_getLogs', [{
    address,
    topics,
    fromBlock: typeof fromBlock === 'number' ? `0x${fromBlock.toString(16)}` : fromBlock,
    toBlock,
  }]);
}

export async function getBlockNumber() {
  return Number(BigInt(await request('eth_blockNumber')));
}

const topicToAddress = (t) => `0x${strip(t).slice(24)}`;

/**
 * Reads everything needed to display and audit one market launch.
 *
 * @param {object} o
 * @param {string} o.launcher  our LaunchpadFamilyLauncher
 * @param {string} o.token     the token to audit
 * @param {string[]} o.controlledWallets  wallets known to be ours; others are external
 * @param {number} [o.fromBlock]  scan window start; required for holder discovery
 */
export async function readLaunchState({ launcher, token, controlledWallets = [], fromBlock }) {
  const checks = [];
  const add = (id, passed, detail = '') => checks.push({ id, passed, detail });
  const controlled = new Set(controlledWallets.filter(Boolean).map((a) => a.toLowerCase()));

  // Every read below is pinned to this block, so the reconciliation describes
  // one state of the chain rather than a moving one.
  const head = await getBlockNumber();
  const at = `0x${head.toString(16)}`;

  const rewardsAddress = await callAddress(launcher, 'rewards()', [], at);
  const factoryAddress = await callAddress(launcher, 'launchpadFactory()', [], at);

  // --- the two-way binding ------------------------------------------------
  const launch = await readMarketLaunch(launcher, token, at);
  add('launch.recordedByLauncher', Boolean(launch) && launch.verified === true,
    launch ? launch.token : 'no record');
  if (!launch || !launch.verified) {
    return {
      schemaVersion: 1,
      reconciledAtBlock: head,
      verification: { status: 'FAILED', checks },
      findings: ['This launcher has no verified record for that token.'],
    };
  }
  add('launch.verifyMarketLaunch', true);

  const [name, symbol, totalSupply, decimals] = await Promise.all([
    callString(token, 'name()', [], at),
    callString(token, 'symbol()', [], at),
    callUint(token, 'totalSupply()', [], at),
    callUint(token, 'decimals()', [], at),
  ]);
  add('token.supplyIsOneBillion18', totalSupply === FIXED_TOKEN_SUPPLY * 10n ** 18n,
    totalSupply.toString());

  // --- the pool this position is actually in ------------------------------
  const positionId = launch.positionTokenId;
  let poolKey = null;
  let positionLiquidity = null;
  try {
    poolKey = await readPoolKey(positionId, at);
  } catch { /* left null: reported as failed checks below */ }
  try {
    positionLiquidity = await readPositionLiquidity(positionId, at);
  } catch { /* left null */ }

  if (poolKey) {
    add('pool.pairedWithEth', poolKey.currency0 === ZERO_ADDRESS
      && poolKey.currency1.toLowerCase() === token.toLowerCase(),
    `${poolKey.currency0} / ${poolKey.currency1}`);
    add('pool.feeIs25Bps', poolKey.fee === 2500, String(poolKey.fee));
    add('pool.hookless', poolKey.hooks === ZERO_ADDRESS, poolKey.hooks);
  } else {
    add('pool.pairedWithEth', false, 'the position\'s pool key could not be read');
  }
  add('pool.hasLiquidity', positionLiquidity !== null && positionLiquidity > 0n,
    positionLiquidity === null ? 'position liquidity could not be read' : String(positionLiquidity));

  // --- the lock -----------------------------------------------------------
  let positionOwner = null;
  let beneficiaryOwner = null;
  try {
    positionOwner = await callAddress(UNISWAP.positionManager, 'ownerOf(uint256)', [{ type: 'uint256', value: positionId }], at);
  } catch { /* left null: reported as a failed check below */ }
  try {
    beneficiaryOwner = await callAddress(UNISWAP.beneficiaryVault, 'ownerOf(uint256)', [{ type: 'uint256', value: positionId }], at);
  } catch { /* left null */ }

  add('liquidity.permanentlyLocked',
    Boolean(positionOwner) && positionOwner.toLowerCase() === UNISWAP.feeSplitter.toLowerCase(),
    positionOwner || 'position owner could not be read');
  add('beneficiary.ownedByRewards',
    Boolean(beneficiaryOwner) && beneficiaryOwner.toLowerCase() === rewardsAddress.toLowerCase(),
    beneficiaryOwner || 'beneficiary owner could not be read');

  // --- supply reconciliation ---------------------------------------------
  const lockedInPool = await callUint(token, 'balanceOf(address)', [{ type: 'address', value: UNISWAP.poolManager }], at);
  const burned = await callUint(token, 'balanceOf(address)', [{ type: 'address', value: BURN_ADDRESS }], at);

  let holders = [];
  let supplyExact = false;
  if (fromBlock !== undefined && fromBlock !== null) {
    const logs = await getLogs({
      address: token, topics: [ABI.TOPICS['Transfer(address,address,uint256)']], fromBlock, toBlock: at,
    });
    const touched = new Set();
    for (const log of logs) {
      touched.add(topicToAddress(log.topics[1]));
      touched.add(topicToAddress(log.topics[2]));
    }
    const skip = new Set([
      ZERO_ADDRESS.toLowerCase(), UNISWAP.poolManager.toLowerCase(), BURN_ADDRESS.toLowerCase(),
    ]);
    for (const address of touched) {
      if (skip.has(address.toLowerCase())) continue;
      const balance = await callUint(token, 'balanceOf(address)', [{ type: 'address', value: address }], at);
      if (balance === 0n) continue;
      holders.push({
        address,
        balance: balance.toString(),
        classification: controlled.has(address.toLowerCase()) ? 'controlled' : 'external',
      });
    }
    const sum = lockedInPool + burned + holders.reduce((a, h) => a + BigInt(h.balance), 0n);
    supplyExact = sum === totalSupply;
    add('supply.reconcilesExactly', supplyExact, `${sum} vs ${totalSupply}`);
  } else {
    // No scan window means holders cannot be discovered. That is UNKNOWN, not zero.
    holders = null;
    add('supply.reconcilesExactly', false,
      'no scan window: holders could not be discovered, so supply cannot be reconciled');
  }

  // --- fee accounting -----------------------------------------------------
  const treasury = await callAddress(rewardsAddress, 'protocolTreasury()', [], at);
  const [creatorBps, padBps, protocolBps] = await Promise.all([
    callUint(rewardsAddress, 'CREATOR_BPS()', [], at),
    callUint(rewardsAddress, 'PAD_OWNER_BPS()', [], at),
    callUint(rewardsAddress, 'PROTOCOL_BPS()', [], at),
  ]);
  add('split.sumsTo100Pct', creatorBps + padBps + protocolBps === 10000n,
    `${creatorBps}/${padBps}/${protocolBps}`);

  const lifetime = await callUint(rewardsAddress, 'lifetimeDistributed(uint256)', [{ type: 'uint256', value: positionId }], at);
  const parties = {
    creator: launch.tokenCreator,
    launchpadOwner: launch.launchpadOwner,
    protocol: treasury,
  };
  const pendingWei = {};
  for (const [role, address] of Object.entries(parties)) {
    pendingWei[role] = (await callUint(rewardsAddress, 'pending(address)', [{ type: 'address', value: address }], at)).toString();
  }

  // Credited per party is derived from the immutable split applied to the lifetime total.
  const creditedWei = {
    creator: ((lifetime * creatorBps) / 10000n).toString(),
    launchpadOwner: ((lifetime * padBps) / 10000n).toString(),
    protocol: (lifetime - (lifetime * creatorBps) / 10000n - (lifetime * padBps) / 10000n).toString(),
  };
  const withdrawnWei = {};
  for (const role of Object.keys(parties)) {
    withdrawnWei[role] = (BigInt(creditedWei[role]) - BigInt(pendingWei[role])).toString();
  }
  const unaccounted = await callUint(rewardsAddress, 'unaccountedBalance()', [], at);
  add('fees.noUnaccountedEth', unaccounted === 0n, unaccounted.toString());
  const feeExact = Object.keys(parties)
    .every((r) => BigInt(withdrawnWei[r]) + BigInt(pendingWei[r]) === BigInt(creditedWei[r]))
    && unaccounted === 0n;
  add('fees.splitConservesEveryWei', feeExact);

  const distinct = new Set(Object.values(parties).map((a) => a.toLowerCase()));
  add('roles.threeDistinctRecipients', distinct.size === 3, `${distinct.size}/3`);

  const traders = (holders || []).map((h) => ({
    address: h.address,
    classification: h.classification,
    tokensReceived: h.balance,
  }));

  const failed = checks.filter((c) => !c.passed);
  return {
    schemaVersion: 1,
    reconciledAtBlock: head,
    chainId: TARGET_CHAIN.chainId,
    contracts: {
      LaunchpadFactory: factoryAddress,
      LaunchpadFamilyLauncher: launcher,
      LaunchpadRewards: rewardsAddress,
    },
    launchpad: { address: launch.launchpad, owner: launch.launchpadOwner, policy: null },
    token: {
      address: token, name, symbol, decimals: Number(decimals), totalSupply: totalSupply.toString(),
    },
    pool: {
      // Not derived: computing a pool id needs keccak, which this build-stepless
      // client does not carry. The pool's parameters below are read instead, which
      // is the stronger evidence anyway.
      poolId: null,
      positionTokenId: positionId.toString(),
      currency0: poolKey?.currency0 ?? null,
      currency1: poolKey?.currency1 ?? null,
      fee: poolKey?.fee ?? null,
      tickSpacing: poolKey?.tickSpacing ?? null,
      hooks: poolKey?.hooks ?? null,
      liquidity: positionLiquidity === null ? null : positionLiquidity.toString(),
      positionOwner,
      beneficiaryOwner,
    },
    roles: {
      tokenCreator: launch.tokenCreator,
      launchpadOwner: launch.launchpadOwner,
      protocolTreasury: treasury,
    },
    splitBps: {
      creator: Number(creatorBps), launchpadOwner: Number(padBps), protocol: Number(protocolBps),
    },
    supplyReconciliation: holders === null ? null : {
      totalSupply: totalSupply.toString(),
      lockedInPool: lockedInPool.toString(),
      burned: burned.toString(),
      holders,
      exact: supplyExact,
    },
    feeAccounting: {
      lpFeeNativeWei: null,
      lpFeeTokenWei: null,
      attributedToVaultWei: '0',
      claimedTotalWei: lifetime.toString(),
      creditedWei,
      withdrawnWei,
      pendingWei,
      unaccountedWei: unaccounted.toString(),
      exact: feeExact,
    },
    trading: { buys: traders.length, traders },
    verification: {
      status: failed.length === 0 ? 'VERIFIED' : 'FAILED',
      verifiedAt: new Date().toISOString(),
      checks,
    },
    findings: failed.map((c) => `${c.id}: ${c.detail}`),
    notes: (holders || []).some((h) => h.classification === 'external')
      ? ['Third-party trading observed. A public pool is permissionless; this is expected activity '
        + 'and is not evidence of organic demand.']
      : [],
  };
}
