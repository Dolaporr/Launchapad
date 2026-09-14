import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validate, RateLimiter, ALLOWED_SELECTORS, ALLOWED_TOPICS, MAX_LOG_SPAN,
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

test('log queries are limited to known events and a bounded span', () => {
  const good = validate({
    method: 'eth_getLogs',
    params: [{
      address: TOKEN,
      topics: [topic('Transfer(address,address,uint256)')],
      fromBlock: '0x0',
      toBlock: '0x64',
    }],
  });
  assert.equal(good.ok, true);

  assert.ok(ALLOWED_TOPICS.has(topic('Transfer(address,address,uint256)')));

  // An unknown event would make this a general log scraper.
  const unknownTopic = validate({
    method: 'eth_getLogs',
    params: [{ topics: [topic('Approval(address,address,uint256)')] }],
  });
  assert.equal(unknownTopic.ok, false);
  assert.match(unknownTopic.error, /topic_not_allowed/);

  const noTopic = validate({ method: 'eth_getLogs', params: [{ address: TOKEN }] });
  assert.equal(noTopic.ok, false);

  // Refused, not silently truncated: a partial log set corrupts every total
  // computed from it.
  const tooWide = validate({
    method: 'eth_getLogs',
    params: [{
      topics: [topic('Transfer(address,address,uint256)')],
      fromBlock: '0x0',
      toBlock: `0x${(MAX_LOG_SPAN + 1).toString(16)}`,
    }],
  });
  assert.equal(tooWide.ok, false);
  assert.match(tooWide.error, /span_too_wide/);
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
