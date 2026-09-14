import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validate, RateLimiter, resolveBlockTag,
  clientKeyFor, normaliseClientIp, isRailway, shouldTrustProxyHeaders,
  ALLOWED_SELECTORS, ALLOWED_TOPICS, MAX_LOG_SPAN,
} from '../lib/readGateway.js';
import { keccak256Hex } from '../lib/keccak.js';

const sel = (sig) => keccak256Hex(sig).slice(0, 10);
const topic = (sig) => keccak256Hex(sig);
const TOKEN = '0xe848A44Bb9ab5Fc9788e2E6D64b5CbBDd114d7F4';
const REWARDS = '0xC2fE1c6730cc029DcBaC04a04D80baFfC7ed530b';

// The gateway's whole justification is that it is NOT an open JSON-RPC proxy.
// These are the tests that make that claim mean something.
test('refuses every method that could change state or touch a key', () => {
  const forbidden = [
    'eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign',
    'eth_sign', 'eth_signTypedData_v4', 'eth_requestAccounts', 'eth_accounts',
    'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_getBalance',
    'debug_traceTransaction', 'evm_mine', 'anvil_setBalance', 'admin_nodeInfo',
  ];
  for (const method of forbidden) {
    const verdict = validate({ method, params: [] });
    assert.equal(verdict.ok, false, `${method} must be refused`);
    assert.match(verdict.error, /method_not_allowed/);
  }
});

test('allows only the five read methods', () => {
  for (const method of ['eth_chainId', 'eth_blockNumber']) {
    assert.equal(validate({ method }).ok, true, method);
  }
  assert.equal(validate({ method: 'eth_getBlockByNumber', params: ['0x1'] }).ok, true);
});

test('eth_call is limited to the view functions this product reads', () => {
  const ok = validate({
    method: 'eth_call',
    params: [{ to: REWARDS, data: sel('CREATOR_BPS()') }, 'latest'],
  });
  assert.equal(ok.ok, true);

  // A real, state-changing function on our own contracts must not pass.
  for (const sig of ['withdraw()', 'collectAndSplit(uint256)', 'launchToken(string,string)',
    'createLaunchpad(string,string,uint8,uint8)', 'transfer(address,uint256)',
    'approve(address,uint256)', 'launch(address,string,string)']) {
    const verdict = validate({
      method: 'eth_call', params: [{ to: REWARDS, data: sel(sig) }],
    });
    assert.equal(verdict.ok, false, `${sig} must be refused`);
    assert.match(verdict.error, /selector_not_allowed/);
  }
});

test('selectors are derived from signatures, never typed as constants', () => {
  // If a selector were hardcoded and drifted from its signature, this fails.
  assert.ok(ALLOWED_SELECTORS.has(sel('balanceOf(address)')));
  assert.ok(ALLOWED_SELECTORS.has(sel('PROTOCOL_BPS()')));
  assert.ok(ALLOWED_SELECTORS.has(sel('getPoolAndPositionInfo(uint256)')));
  assert.ok(!ALLOWED_SELECTORS.has(sel('selfdestruct()')));
});

// A read has no sender. Accepting one would let a caller impersonate an address
// to any view function that inspects msg.sender.
test('refuses a call that sets from or value', () => {
  const data = sel('CREATOR_BPS()');
  assert.equal(validate({
    method: 'eth_call', params: [{ to: REWARDS, data, from: TOKEN }],
  }).ok, false);
  assert.equal(validate({
    method: 'eth_call', params: [{ to: REWARDS, data, value: '0x1' }],
  }).ok, false);
});

test('refuses malformed calls rather than passing them upstream', () => {
  assert.equal(validate({ method: 'eth_call', params: [] }).ok, false);
  assert.equal(validate({ method: 'eth_call', params: [{ to: 'nope', data: sel('name()') }] }).ok, false);
  assert.equal(validate({ method: 'eth_call', params: [{ to: TOKEN, data: '0x' }] }).ok, false);
  assert.equal(validate({ method: 'eth_call', params: [{ to: TOKEN }] }).ok, false);
  assert.equal(validate({ method: 'eth_call', params: 'not-an-array' }).ok, false);
});

const HEAD = 62_000_000;
const TRANSFER = topic('Transfer(address,address,uint256)');
const logs = (filter, headBlock = HEAD) => validate(
  { method: 'eth_getLogs', params: [filter] }, { headBlock },
);

test('log queries are limited to known events and a named contract', () => {
  const good = logs({
    address: TOKEN, topics: [TRANSFER], fromBlock: '0x0', toBlock: '0x64',
  });
  assert.equal(good.ok, true);
  assert.ok(ALLOWED_TOPICS.has(TRANSFER));

  const unknownTopic = logs({
    address: TOKEN, topics: [topic('Approval(address,address,uint256)')],
    fromBlock: '0x0', toBlock: '0x1',
  });
  assert.equal(unknownTopic.ok, false);
  assert.match(unknownTopic.error, /topic_not_allowed/);

  const noTopic = logs({ address: TOKEN, fromBlock: '0x0', toBlock: '0x1' });
  assert.equal(noTopic.ok, false);
});

// ---------------------------------------------------------------------------
// The range bypass. Every one of these forwarded an unbounded scan before:
// the span check only ran when BOTH endpoints parsed as numbers, and `latest`
// parsed as null.
// ---------------------------------------------------------------------------

test('0x0 -> latest is refused, not forwarded as a full-chain scan', () => {
  const verdict = logs({
    address: TOKEN, topics: [TRANSFER], fromBlock: '0x0', toBlock: 'latest',
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /span_too_wide/);
});

test('omitted endpoints resolve to the head, never to the whole chain', () => {
  // Previously both defaulted to 0x0 -> latest, an unbounded scan. Omitting an
  // endpoint now means `latest` on BOTH sides, per JSON-RPC, so the request
  // resolves to a single block rather than the entire history.
  const both = logs({ address: TOKEN, topics: [TRANSFER] });
  assert.equal(both.ok, true);
  assert.equal(both.resolved.from, HEAD);
  assert.equal(both.resolved.to, HEAD);
  assert.equal(both.resolved.span, 0);
  assert.equal(both.params[0].fromBlock, `0x${HEAD.toString(16)}`);

  // An omitted `to` with an explicit early `from` is still bounded and refused.
  const wide = logs({ address: TOKEN, topics: [TRANSFER], fromBlock: '0x0' });
  assert.equal(wide.ok, false);
  assert.match(wide.error, /span_too_wide/);
});

test('a numeric from with latest to is bounded against the head', () => {
  const tooFar = logs({
    address: TOKEN, topics: [TRANSFER], fromBlock: '0x1', toBlock: 'latest',
  });
  assert.equal(tooFar.ok, false);
  assert.match(tooFar.error, /span_too_wide/);

  // Just inside the limit: allowed, and resolved to concrete numbers.
  const near = logs({
    address: TOKEN,
    topics: [TRANSFER],
    fromBlock: `0x${(HEAD - MAX_LOG_SPAN).toString(16)}`,
    toBlock: 'latest',
  });
  assert.equal(near.ok, true);
  assert.equal(near.resolved.span, MAX_LOG_SPAN);
  assert.equal(near.params[0].toBlock, `0x${HEAD.toString(16)}`);
});

test('every symbolic tag resolves against the head, none reach the node', () => {
  for (const tag of ['latest', 'pending', 'safe', 'finalized']) {
    const verdict = logs({
      address: TOKEN,
      topics: [TRANSFER],
      fromBlock: `0x${(HEAD - 10).toString(16)}`,
      toBlock: tag,
    });
    assert.equal(verdict.ok, true, tag);
    assert.equal(verdict.params[0].toBlock, `0x${HEAD.toString(16)}`, tag);
    assert.ok(!/latest|pending|safe|finalized/.test(JSON.stringify(verdict.params)), tag);
  }
  // earliest is block 0, and with a distant head that is over-wide.
  const earliest = logs({
    address: TOKEN, topics: [TRANSFER], fromBlock: 'earliest', toBlock: 'latest',
  });
  assert.equal(earliest.ok, false);
  assert.equal(resolveBlockTag('earliest', HEAD), 0);
  assert.equal(resolveBlockTag('latest', HEAD), HEAD);
  assert.equal(resolveBlockTag(undefined, HEAD), HEAD);
  assert.equal(resolveBlockTag('not-a-tag', HEAD), undefined);
});

test('a chain-wide scan by topic alone is refused', () => {
  const verdict = logs({ topics: [TRANSFER], fromBlock: '0x0', toBlock: '0x64' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /require_single_address/);

  // An array of addresses is not a single contract either.
  const many = logs({
    address: [TOKEN, REWARDS], topics: [TRANSFER], fromBlock: '0x0', toBlock: '0x64',
  });
  assert.equal(many.ok, false);
  assert.match(many.error, /require_single_address/);
});

test('a log query with no resolvable head is refused, not guessed', () => {
  const verdict = validate(
    { method: 'eth_getLogs', params: [{ address: TOKEN, topics: [TRANSFER] }] },
    {},
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /head_block_unavailable/);
});

test('an inverted range is refused rather than silently swapped', () => {
  const verdict = logs({
    address: TOKEN, topics: [TRANSFER], fromBlock: '0x64', toBlock: '0x1',
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /inverted_range/);
});

test('an unparseable block tag is refused', () => {
  const verdict = logs({
    address: TOKEN, topics: [TRANSFER], fromBlock: 'yesterday', toBlock: 'latest',
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /unparseable_block_tag/);
});

test('never forwards full transaction bodies for a block', () => {
  const verdict = validate({ method: 'eth_getBlockByNumber', params: ['0x1', true] });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.params[1], false);
});

test('forwards only the sanitised params, not the caller\'s object', () => {
  const verdict = validate({
    method: 'eth_call',
    params: [{ to: REWARDS, data: sel('CREATOR_BPS()'), extra: 'ignored' }, 'latest'],
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(Object.keys(verdict.params[0]).sort(), ['data', 'to']);
});

test('rate limiter bounds a single caller and then recovers', () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(limiter.take('a', now).ok, true);
  assert.equal(limiter.take('a', now).ok, true);
  assert.equal(limiter.take('a', now).ok, true);
  const blocked = limiter.take('a', now);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);

  // One caller's limit must not affect another.
  assert.equal(limiter.take('b', now).ok, true);
  // The window rolls.
  assert.equal(limiter.take('a', now + 1001).ok, true);
});

// ---------------------------------------------------------------------------
// Who gets which rate-limit bucket.
//
// Behind Railway every request arrives on a socket from Railway's proxy, so the
// socket address is identical for everyone. Keying on it would put the whole
// internet in one bucket; trusting a header off Railway would let anyone mint a
// fresh bucket per request. Both failures are covered here.
// ---------------------------------------------------------------------------

const PROXY_SOCKET = '100.64.0.7';          // Railway's internal proxy
const req = (headers = {}, remoteAddress = PROXY_SOCKET) => ({ headers, socket: { remoteAddress } });
const onRailway = { trustProxyHeaders: true };
const local = { trustProxyHeaders: false };

test('two visitors behind one proxy socket get independent buckets', () => {
  const a = clientKeyFor(req({ 'x-real-ip': '203.0.113.10' }), onRailway);
  const b = clientKeyFor(req({ 'x-real-ip': '198.51.100.22' }), onRailway);
  assert.notEqual(a, b);
  assert.equal(a, '203.0.113.10');
  assert.equal(b, '198.51.100.22');

  // And the limiter genuinely separates them: exhausting one leaves the other free.
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  const now = 5_000_000;
  assert.equal(limiter.take(a, now).ok, true);
  assert.equal(limiter.take(a, now).ok, true);
  assert.equal(limiter.take(a, now).ok, false, 'first visitor is limited');
  assert.equal(limiter.take(b, now).ok, true, 'second visitor must be unaffected');
});

test('repeated requests from one client IP share a single bucket', () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
  const now = 6_000_000;
  // Same client, different sockets and ports — Railway may spread them.
  const keys = [
    clientKeyFor(req({ 'x-real-ip': '203.0.113.10' }, '100.64.0.7'), onRailway),
    clientKeyFor(req({ 'x-real-ip': '203.0.113.10' }, '100.64.0.9'), onRailway),
    clientKeyFor(req({ 'x-real-ip': '203.0.113.10:51234' }, '100.64.1.2'), onRailway),
    clientKeyFor(req({ 'x-real-ip': '::ffff:203.0.113.10' }, '100.64.2.3'), onRailway),
  ];
  assert.deepEqual([...new Set(keys)], ['203.0.113.10'], 'all four must be one key');
  assert.equal(limiter.take(keys[0], now).ok, true);
  assert.equal(limiter.take(keys[1], now).ok, true);
  assert.equal(limiter.take(keys[2], now).ok, true);
  assert.equal(limiter.take(keys[3], now).ok, false, 'the fourth must be limited');
});

test('local development with no Railway header uses the socket address', () => {
  assert.equal(clientKeyFor(req({}, '127.0.0.1'), local), '127.0.0.1');
  assert.equal(clientKeyFor(req({}, '::ffff:127.0.0.1'), local), '127.0.0.1');
  assert.equal(clientKeyFor(req({}, '::1'), local), '::1');
  // Header present but untrusted: it must be ignored entirely.
  assert.equal(
    clientKeyFor(req({ 'x-real-ip': '203.0.113.10' }, '127.0.0.1'), local),
    '127.0.0.1',
    'an untrusted header must not become the key',
  );
  // On Railway, with no header at all, the socket is still the fallback.
  assert.equal(clientKeyFor(req({}, '100.64.0.7'), onRailway), '100.64.0.7');
});

test('malformed client IPs never create arbitrary unlimited buckets', () => {
  const junk = [
    'not-an-ip', '', '   ', '999.999.999.999', '1.2.3', '1.2.3.4.5',
    '<script>', '203.0.113.10; DROP TABLE', '../../etc/passwd',
    'a'.repeat(200), '01.02.03.04', 'gggg::1', '1:2:3:4:5:6:7:8:9',
    '::ffff::1', '12345::1',
  ];
  for (const value of junk) {
    assert.equal(normaliseClientIp(value), null, `${value} must not normalise`);
    // Every junk value collapses onto ONE key — the shared socket — rather than
    // each minting a fresh bucket, which would defeat the limiter entirely.
    assert.equal(
      clientKeyFor(req({ 'x-real-ip': value }), onRailway),
      PROXY_SOCKET,
      `${value} must fall back to the socket`,
    );
  }

  // The attack this prevents: a unique header per request buying unlimited quota.
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  const now = 7_000_000;
  let allowed = 0;
  for (let i = 0; i < 10; i += 1) {
    const key = clientKeyFor(req({ 'x-real-ip': `junk-${i}` }), onRailway);
    if (limiter.take(key, now).ok) allowed += 1;
  }
  assert.equal(allowed, 2, 'ten forged headers must not buy ten buckets');
});

test('X-Forwarded-For contributes only its leftmost entry', () => {
  assert.equal(
    clientKeyFor(req({ 'x-forwarded-for': '203.0.113.10, 100.64.0.7, 10.0.0.1' }), onRailway),
    '203.0.113.10',
  );
  // A repeated header arrives as an array.
  assert.equal(
    clientKeyFor(req({ 'x-forwarded-for': ['198.51.100.5, 10.0.0.1', '1.1.1.1'] }), onRailway),
    '198.51.100.5',
  );
});

// Railway's own tracker reports x-real-ip being set to the CDN edge address on
// CDN-routed traffic. Falling through to the next edge-set header keeps buckets
// per-client instead of collapsing every visitor onto one CDN address.
test('falls through to the next trusted header when the first is unusable', () => {
  assert.equal(clientKeyFor(req({
    'x-real-ip': 'nonsense',
    'x-envoy-external-address': '203.0.113.44',
  }), onRailway), '203.0.113.44');

  assert.equal(clientKeyFor(req({
    'x-real-ip': '',
    'x-forwarded-for': '198.51.100.7, 100.64.0.7',
  }), onRailway), '198.51.100.7');

  // A usable x-real-ip still wins: it is the documented source of truth.
  assert.equal(clientKeyFor(req({
    'x-real-ip': '203.0.113.1',
    'x-forwarded-for': '198.51.100.7',
  }), onRailway), '203.0.113.1');
});

test('proxy headers are trusted only in a Railway (or declared) deployment', () => {
  assert.equal(isRailway({}), false);
  assert.equal(isRailway({ RAILWAY_PROJECT_ID: 'p1' }), true);
  assert.equal(isRailway({ RAILWAY_SERVICE_ID: 's1' }), true);
  assert.equal(isRailway({ RAILWAY_ANYTHING_NEW: 'x' }), true, 'catch-all for naming drift');
  assert.equal(isRailway({ HOME: '/root', PATH: '/usr/bin' }), false);

  assert.equal(shouldTrustProxyHeaders({}), false);
  assert.equal(shouldTrustProxyHeaders({ RAILWAY_PROJECT_ID: 'p1' }), true);
  // Explicit override wins in both directions.
  assert.equal(shouldTrustProxyHeaders({ TRUST_PROXY_HEADERS: 'true' }), true);
  assert.equal(
    shouldTrustProxyHeaders({ RAILWAY_PROJECT_ID: 'p1', TRUST_PROXY_HEADERS: 'false' }),
    false,
    'a Railway deployment must be able to opt out',
  );
});
