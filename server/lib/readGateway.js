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
//   3. Shape limits. A log query must name ONE contract and a known event, and
//      both of its block endpoints are resolved against the current head before
//      the span is checked — so `latest`, or an omitted endpoint, cannot slip a
//      full-chain scan past the bound. Over-wide ranges are refused, never
//      truncated: a caller that asked for a range and silently received part of
//      it would compute totals from an incomplete log set.
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

/**
 * Resolves a block tag to a concrete number against a known head.
 *
 * Every symbolic tag resolves; nothing is left unbounded. This is the whole
 * point: the previous version returned null for `latest`, and the span check
 * then skipped itself, so `0x0 -> latest` forwarded a full-chain scan.
 *
 * @returns {number|undefined} undefined when the tag is unparseable.
 */
export function resolveBlockTag(tag, headBlock) {
  if (tag === undefined || tag === null) return headBlock;
  if (typeof tag === 'number' && Number.isInteger(tag) && tag >= 0) return tag;
  if (typeof tag !== 'string') return undefined;
  if (tag === 'earliest') return 0;
  if (/^(latest|pending|safe|finalized)$/.test(tag)) return headBlock;
  if (/^0x[0-9a-fA-F]+$/.test(tag)) return Number(BigInt(tag));
  return undefined;
}

const toHex = (n) => `0x${n.toString(16)}`;

/**
 * Decides whether one RPC request may be forwarded, and normalises it.
 *
 * Pure and synchronous: the caller resolves the chain head first and passes it
 * in, so the bounding rules stay deterministic and testable without a network.
 *
 * @param {{method: string, params: any[]}} request
 * @param {{headBlock?: number}} context  current head; REQUIRED for eth_getLogs
 * @returns {{ok: true, method: string, params: any[], resolved?: object}
 *          | {ok: false, error: string}}
 */
export function validate({ method, params = [] } = {}, { headBlock } = {}) {
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

  // A single contract is REQUIRED. Topic-only queries are chain-wide scans:
  // every Transfer on the chain matches, which is an indexer's workload, not a
  // product read.
  if (!isHexAddress(filter.address)) {
    return { ok: false, error: 'logs_require_single_address' };
  }

  const topics = filter.topics || [];
  if (!Array.isArray(topics) || topics.length === 0) {
    return { ok: false, error: 'logs_require_topic0' };
  }
  const topic0 = topics[0];
  if (typeof topic0 !== 'string' || !ALLOWED_TOPICS.has(topic0.toLowerCase())) {
    return { ok: false, error: 'logs_topic_not_allowed' };
  }

  // Without a head block there is no way to bound `latest`, so the request is
  // refused rather than forwarded on the hope that it is small.
  if (!Number.isInteger(headBlock) || headBlock < 0) {
    return { ok: false, error: 'logs_head_block_unavailable' };
  }

  const from = resolveBlockTag(filter.fromBlock, headBlock);
  const to = resolveBlockTag(filter.toBlock, headBlock);
  if (from === undefined || to === undefined) {
    return { ok: false, error: 'logs_unparseable_block_tag' };
  }
  if (to < from) return { ok: false, error: `logs_inverted_range: ${from} > ${to}` };

  const span = to - from;
  // Refused, never truncated: a caller that asked for a range and silently got
  // part of it would compute totals from an incomplete log set.
  if (span > MAX_LOG_SPAN) {
    return { ok: false, error: `logs_span_too_wide: ${span} > ${MAX_LOG_SPAN}` };
  }

  return {
    ok: true,
    method,
    // Both endpoints are forwarded as concrete numbers. No symbolic tag reaches
    // the upstream node, so the bounded range cannot widen between check and use.
    params: [{
      address: filter.address,
      topics,
      fromBlock: toHex(from),
      toBlock: toHex(to),
    }],
    resolved: { from, to, span },
  };
}

// ---------------------------------------------------------------------------
// Who is the caller?
//
// Behind Railway's edge every request arrives on a socket from Railway's own
// proxy, so `req.socket.remoteAddress` is the SAME value for every visitor.
// Keying the rate limiter on it would put the whole internet in one bucket.
//
// The client's address therefore has to come from a header — which is only safe
// because Railway's edge SETS these headers, overwriting whatever the client
// sent. Off Railway there is no such edge, so a header is just something the
// caller typed, and trusting it would let anyone mint an unlimited bucket per
// request. Hence the explicit trust gate: headers are consulted ONLY when the
// process is running on Railway (or a deployment says so outright).
// ---------------------------------------------------------------------------

/**
 * Headers to try, in order, when proxy headers are trusted.
 *
 * `x-real-ip` is Railway's documented single source of truth and comes first.
 * The other two are fallbacks because Railway's own issue tracker reports
 * x-real-ip being set to the CDN EDGE address rather than the client when
 * traffic crosses their CDN layer — which would collapse every visitor into one
 * bucket, exactly the failure this code exists to prevent. Taking the first
 * header that yields a valid address keeps per-client buckets working either
 * way, and all three are set by the same trusted edge.
 */
export const CLIENT_IP_HEADERS = ['x-real-ip', 'x-envoy-external-address', 'x-forwarded-for'];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Validates and canonicalises one client address.
 *
 * Anything that is not a well-formed IP returns null, and a null sends the
 * caller back to the socket address. A malformed or attacker-chosen value must
 * never become a bucket key of its own.
 *
 * @returns {string|null}
 */
export function normaliseClientIp(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (!ip || ip.length > 60) return null;

  // `[::1]:443` — bracketed IPv6 with a port.
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) [, ip] = bracketed;
  // `1.2.3.4:5678` — IPv4 with a port. IPv6 is excluded by its own colons.
  else if ((ip.match(/:/g) || []).length === 1 && ip.includes('.')) [ip] = ip.split(':');

  // IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is the same host as the IPv4 form, so
  // it must normalise to one key or a caller gets two buckets.
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) [, ip] = mapped;

  const v4 = ip.match(IPV4);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    // Reject 0-padded forms; they are ambiguous and would double-bucket a host.
    if (v4.slice(1).some((o) => o.length > 1 && o.startsWith('0'))) return null;
    return octets.join('.');
  }

  // IPv6: hex groups and at most one `::`. Deliberately strict rather than
  // clever — an unrecognised shape falls back to the socket, which is safe.
  const lower = ip.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(lower)) return null;
  if ((lower.match(/::/g) || []).length > 1) return null;
  const groups = lower.split(':').filter((g) => g !== '');
  if (!groups.length || groups.length > 8) return null;
  if (groups.some((g) => g.length > 4)) return null;
  return lower;
}

/** Known Railway-injected variables, plus any RAILWAY_* as a catch-all. */
export function isRailway(env = process.env) {
  if (env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_SERVICE_ID
    || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PUBLIC_DOMAIN) return true;
  return Object.keys(env).some((k) => k.startsWith('RAILWAY_'));
}

/**
 * Whether proxy headers may be believed.
 *
 * TRUST_PROXY_HEADERS overrides in both directions, so a deployment behind some
 * other trusted edge can opt in, and a Railway deployment can opt out.
 */
export function shouldTrustProxyHeaders(env = process.env) {
  if (env.TRUST_PROXY_HEADERS === 'true') return true;
  if (env.TRUST_PROXY_HEADERS === 'false') return false;
  return isRailway(env);
}

/**
 * The rate-limit bucket key for one request.
 *
 * @param {{headers?: object, socket?: {remoteAddress?: string}}} req
 * @param {{trustProxyHeaders?: boolean}} options
 */
export function clientKeyFor(req, { trustProxyHeaders = false } = {}) {
  const socketIp = normaliseClientIp(req?.socket?.remoteAddress) ?? 'unknown';
  if (!trustProxyHeaders) return socketIp;

  const headers = req?.headers || {};
  for (const name of CLIENT_IP_HEADERS) {
    const raw = headers[name];
    if (!raw) continue;
    // X-Forwarded-For is a list; the leftmost entry is the original client.
    // A header arriving as an array (repeated header) takes its first value.
    const first = String(Array.isArray(raw) ? raw[0] : raw).split(',')[0];
    const ip = normaliseClientIp(first);
    if (ip) return ip;
  }
  // Every trusted header was absent or malformed. Falling back to the socket
  // means such callers SHARE a bucket rather than each getting a fresh one.
  return socketIp;
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
