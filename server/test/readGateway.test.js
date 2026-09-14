import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validate, RateLimiter, resolveBlockTag,
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
