// ---------------------------------------------------------------------------
// readGateway.js — a read-only, allowlisted window onto the chain.
//
// WHY THIS EXISTS. Reading Launchpad.family required an injected wallet, because
// every chain read went through window.ethereum. A visitor in mobile Safari
// therefore could not see the fee split, a pad's state, or a launch proof —
// public facts about a public chain — until they installed a wallet. A wallet
// should be required to SIGN, never to READ.
//
// WHY IT IS NOT A JSON-RPC PROXY. Three independent limits, all enforced here:
//
//   1. Method allowlist. Only five read methods. eth_sendTransaction,
//      eth_sendRawTransaction, personal_sign, eth_accounts and every wallet_*
//      method are not merely unimplemented, they are refused.
//   2. Selector allowlist. eth_call is permitted only for the exact view
//      functions this product reads, computed from their signatures with our own
//      keccak so there is no hardcoded constant to drift. A call carrying any
//      other selector is refused, so no state-changing function is reachable
//      even if one were somehow encoded into an eth_call.
//   3. Shape limits. Log queries are bounded in block span and restricted to
//      known event topics, so this cannot be used as a free archive-node scraper.
//
// What remains reachable is view data on a public chain — the same data a block
// explorer serves. Nothing here can move a token or authorise anything.
// ---------------------------------------------------------------------------

import { keccak256Hex } from './keccak.js';

/** Read methods this gateway will forward. Everything else is refused. */
export const ALLOWED_METHODS = new Set([
  'eth_call',
  'eth_chainId',
  'eth_blockNumber',
  'eth_getLogs',
  'eth_getBlockByNumber',
]);

/**
 * Every view function the client reads. Listed as signatures and hashed at
 * startup: a selector cannot drift from its signature because it is never typed
 * out. Adding a function here is a deliberate act with a visible diff.
 */
export const ALLOWED_SIGNATURES = [
  // ERC-20 / token
  'name()', 'symbol()', 'decimals()', 'totalSupply()', 'balanceOf(address)',
  // Launchpad + factory
  'owner()', 'metadataURI()', 'preset()', 'launchPolicy()', 'feeRouter()',
  'canLaunch(address)', 'tokenCount()', 'tokensPage(uint256,uint256)',
  'tokensOf(address)', 'count()', 'launchpadsPage(uint256,uint256)',
  'launchpadsOf(address)', 'isLaunchpad(address)', 'supportsNvdaReserve()',
  // Market launches
  'verifyMarketLaunch(address)', 'verifiedLaunchOf(address)',
  'tokensOfLaunchpad(address)', 'launchOf(address)', 'allTokens(uint256)',
  'marketLauncher()', 'isMarketLaunch()',
  // Rewards and the split
  'pending(address)', 'lifetimeDistributed(uint256)',
  'CREATOR_BPS()', 'PAD_OWNER_BPS()', 'PROTOCOL_BPS()',
  'totalPending()', 'unaccountedBalance()', 'protocolTreasury()',
  'registrar()', 'launchpadFactory()', 'rewards()',
  // Uniswap position reads
  'ownerOf(uint256)', 'attributionOf(uint256)',
  'getPoolAndPositionInfo(uint256)', 'getPositionLiquidity(uint256)',
];

export const ALLOWED_SELECTORS = new Set(
  ALLOWED_SIGNATURES.map((sig) => keccak256Hex(sig).slice(0, 10).toLowerCase()),
);

/** Event topic0 values the client filters on. */
export const ALLOWED_TOPICS = new Set([
  'Transfer(address,address,uint256)',
  'TokenLaunchedToUniswap(address,address,address,address,uint256)',
  'LaunchpadCreated(address,address,address,uint8,uint8,string,string)',
  'TokenLaunched(address,address,string,string,uint256)',
  'RewardsSplit(uint256,uint256,uint256,uint256,uint256)',
  'Withdrawn(address,uint256)',
].map((sig) => keccak256Hex(sig).toLowerCase()));

/** A log query wider than this is refused rather than quietly truncated. */
export const MAX_LOG_SPAN = 200000;

const isHexAddress = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHexData = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);

/** Parses a block tag to a number, or null for the symbolic tags. */
function blockNumberOf(tag) {
  if (tag === undefined || tag === null) return null;
  if (typeof tag === 'number') return tag;
  if (typeof tag !== 'string') return null;
  if (/^(latest|earliest|pending|safe|finalized)$/.test(tag)) return null;
  if (/^0x[0-9a-fA-F]+$/.test(tag)) return Number(BigInt(tag));
  return null;
}

/**
 * Decides whether one RPC request may be forwarded.
 *
 * @returns {{ok: true, method: string, params: any[]} | {ok: false, error: string}}
 */
export function validate({ method, params = [] } = {}) {
  if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
    return { ok: false, error: `method_not_allowed: ${String(method)}` };
  }
  if (!Array.isArray(params)) return { ok: false, error: 'params_must_be_array' };

  if (method === 'eth_chainId' || method === 'eth_blockNumber') {
    return { ok: true, method, params: [] };
  }

  if (method === 'eth_call') {
    const [tx, tag] = params;
    if (!tx || typeof tx !== 'object') return { ok: false, error: 'call_requires_object' };
    if (!isHexAddress(tx.to)) return { ok: false, error: 'call_requires_to_address' };
    if (!isHexData(tx.data) || tx.data.length < 10) {
      return { ok: false, error: 'call_requires_data' };
    }
    // The heart of it: only the view functions this product reads.
    const selector = tx.data.slice(0, 10).toLowerCase();
    if (!ALLOWED_SELECTORS.has(selector)) {
      return { ok: false, error: `selector_not_allowed: ${selector}` };
    }
    // `from` is refused outright: a read has no sender, and accepting one would
    // let a caller impersonate an address in view functions that inspect it.
    if (tx.from !== undefined) return { ok: false, error: 'call_must_not_set_from' };
    if (tx.value !== undefined && tx.value !== '0x0') {
      return { ok: false, error: 'call_must_not_send_value' };
    }
    return { ok: true, method, params: [{ to: tx.to, data: tx.data }, tag ?? 'latest'] };
  }

  if (method === 'eth_getBlockByNumber') {
    const [tag] = params;
    // Full transaction bodies are never needed and are large; only headers pass.
    return { ok: true, method, params: [tag ?? 'latest', false] };
  }

  // eth_getLogs
  const [filter] = params;
  if (!filter || typeof filter !== 'object') return { ok: false, error: 'logs_require_filter' };
  if (filter.address !== undefined && !isHexAddress(filter.address)) {
    return { ok: false, error: 'logs_address_must_be_single_address' };
  }
  const topics = filter.topics || [];
  if (!Array.isArray(topics) || topics.length === 0) {
    return { ok: false, error: 'logs_require_topic0' };
  }
  const topic0 = topics[0];
  if (typeof topic0 !== 'string' || !ALLOWED_TOPICS.has(topic0.toLowerCase())) {
    return { ok: false, error: 'logs_topic_not_allowed' };
  }
  const from = blockNumberOf(filter.fromBlock);
  const to = blockNumberOf(filter.toBlock);
  if (from !== null && to !== null && to - from > MAX_LOG_SPAN) {
    return { ok: false, error: `logs_span_too_wide: ${to - from} > ${MAX_LOG_SPAN}` };
  }
  return {
    ok: true,
    method,
    params: [{
      ...(filter.address ? { address: filter.address } : {}),
      topics,
      fromBlock: filter.fromBlock ?? '0x0',
      toBlock: filter.toBlock ?? 'latest',
    }],
  };
}

/**
 * A small fixed-window limiter, so this cannot be farmed as free RPC.
 *
 * Deliberately in-memory: the deployment is a single Machine by construction
 * (one SQLite volume), so there is no second process for a shared store to
 * coordinate with. If that ever changes, this needs to change with it.
 */
export class RateLimiter {
  constructor({ limit = 120, windowMs = 60000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** @returns {{ok: boolean, retryAfterMs: number}} */
  take(key, now = Date.now()) {
    const bucket = this.hits.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 5000) this.sweep(now);
      return { ok: true, retryAfterMs: 0 };
    }
    bucket.count += 1;
    if (bucket.count > this.limit) {
      return { ok: false, retryAfterMs: this.windowMs - (now - bucket.start) };
    }
    return { ok: true, retryAfterMs: 0 };
  }

  sweep(now = Date.now()) {
    for (const [key, bucket] of this.hits) {
      if (now - bucket.start >= this.windowMs) this.hits.delete(key);
    }
  }
}
