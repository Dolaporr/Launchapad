import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseSlug, validateSlug, isCanonicalSlug, slugFromMetadataUri,
  slugFromHost, hostnameFor, metadataUriFor, RESERVED_SLUGS,
  MIN_SLUG_LENGTH, MAX_SLUG_LENGTH,
} from '../lib/slug.js';

// A slug becomes a hostname, so these are security tests, not formatting tests.

test('normalisation collapses what a human reads as the same name', () => {
  assert.equal(normaliseSlug('AI Fun'), 'ai-fun');
  assert.equal(normaliseSlug('  AI.fun  '), 'ai-fun');
  assert.equal(normaliseSlug('ai_fun'), 'ai-fun');
  assert.equal(normaliseSlug('AI---fun'), 'ai-fun');
  assert.equal(normaliseSlug('-ai-fun-'), 'ai-fun');
  assert.equal(normaliseSlug('AI fun'), 'ai-fun'); // non-breaking space
});

test('normalisation is idempotent', () => {
  for (const input of ['AI Fun', 'a--b', ' Mixed_Case.Name ', 'x']) {
    const once = normaliseSlug(input);
    assert.equal(normaliseSlug(once), once, `not idempotent for ${input}`);
  }
});

test('two inputs a human would confuse cannot become two different pads', () => {
  const variants = ['AI fun', 'ai-fun', 'AI_FUN', 'ai.fun', 'Ai--Fun', '  ai fun  '];
  const slugs = new Set(variants.map(normaliseSlug));
  assert.equal(slugs.size, 1, `variants split into ${[...slugs].join(', ')}`);
});

test('accepts ordinary names', () => {
  for (const name of ['ai', 'ai-fun', 'degen', 'pad123', 'a1b', 'x7']) {
    assert.equal(validateSlug(name).ok, true, `rejected ${name}`);
  }
});

test('rejects names that are too short or too long, with an actionable reason', () => {
  assert.equal(validateSlug('a').code, 'too_short');
  assert.match(validateSlug('a').message, new RegExp(String(MIN_SLUG_LENGTH)));
  // Two characters is the floor, because the flagship example is `ai`.
  assert.equal(validateSlug('ai').ok, true);
  const long = 'a'.repeat(MAX_SLUG_LENGTH + 1);
  assert.equal(validateSlug(long).code, 'too_long');
});

test('rejects rather than silently rewrites unexpected characters', () => {
  // The user must never end up owning a hostname they did not type.
  for (const bad of ['ai/fun', 'ai@fun', 'ai!fun', 'ai:fun', 'ai%2ffun', 'ai#fun', 'ai?fun']) {
    const r = validateSlug(bad);
    assert.equal(r.ok, false, `accepted ${bad}`);
    assert.equal(r.code, 'invalid_characters');
  }
});

test('rejects non-ASCII and punycode impersonation vectors', () => {
  // Cyrillic "а" renders identically to Latin "a" in an address bar.
  assert.equal(validateSlug('аi-fun').ok, false);
  assert.equal(validateSlug('xn--80ak6aa92e').code, 'punycode');
  assert.equal(validateSlug('ai​fun').ok, false); // zero-width space
});

test('rejects all-numeric labels', () => {
  assert.equal(validateSlug('12345').code, 'all_numeric');
  assert.equal(validateSlug('1a2').ok, true);
});

test('refuses every reserved hostname and product surface', () => {
  for (const word of ['www', 'api', 'admin', 'docs', 'create', 'dashboard', 'verify',
    'launchpad', 'family', 'official', 'safe', 'audited']) {
    const r = validateSlug(word);
    assert.equal(r.ok, false, `reserved word "${word}" was accepted`);
    assert.equal(r.code, 'reserved');
  }
});

test('the reserved list is itself all-canonical, so nothing slips past normalisation', () => {
  for (const word of RESERVED_SLUGS) {
    assert.equal(normaliseSlug(word), word, `reserved word "${word}" is not canonical`);
  }
});

test('a reserved word cannot be reached by an alternate spelling', () => {
  // "Admin" and "ADMIN" normalise onto the reserved "admin" and are refused.
  for (const spelling of ['Admin', 'ADMIN', ' admin ', 'ad_min']) {
    const r = validateSlug(spelling);
    if (normaliseSlug(spelling) === 'admin') {
      assert.equal(r.ok, false, `"${spelling}" reached admin`);
    }
  }
});

test('isCanonicalSlug only accepts the already-normalised form', () => {
  assert.equal(isCanonicalSlug('ai-fun'), true);
  assert.equal(isCanonicalSlug('AI-Fun'), false);
  assert.equal(isCanonicalSlug('ai--fun'), false);
});

test('metadata URI round-trips to the slug it committed to', () => {
  const uri = metadataUriFor('ai-fun');
  assert.equal(uri, 'https://launchpad.family/p/ai-fun');
  assert.equal(slugFromMetadataUri(uri), 'ai-fun');
  assert.equal(slugFromMetadataUri(`${uri}/`), 'ai-fun');
  assert.ok(uri.length <= 256, 'must fit MAX_METADATA_URI_LENGTH');
});

test('metadata URI parsing refuses a non-canonical claim', () => {
  // A pad pointing at /p/AI--Fun did NOT claim ai-fun. It claimed nothing.
  assert.equal(slugFromMetadataUri('https://launchpad.family/p/AI--Fun'), null);
  assert.equal(slugFromMetadataUri('https://launchpad.family/p/admin'), null);
  assert.equal(slugFromMetadataUri('https://launchpad.family/pads/ai'), null);
  assert.equal(slugFromMetadataUri('https://evil.example/p/ai'), 'ai'); // host checked elsewhere
  assert.equal(slugFromMetadataUri('ipfs://whatever'), null);
  assert.equal(slugFromMetadataUri(''), null);
  assert.equal(slugFromMetadataUri(null), null);
});

test('host routing maps a subdomain to its pad', () => {
  assert.equal(slugFromHost('ai.launchpad.family'), 'ai');
  assert.equal(slugFromHost('AI.LAUNCHPAD.FAMILY'), 'ai');
  assert.equal(slugFromHost('ai.launchpad.family:8080'), 'ai');
  assert.equal(slugFromHost('ai.launchpad.family.'), 'ai');
  assert.equal(hostnameFor('ai'), 'ai.launchpad.family');
});

test('host routing refuses the apex, www and nested labels', () => {
  assert.equal(slugFromHost('launchpad.family'), null);
  assert.equal(slugFromHost('www.launchpad.family'), null);
  // a.b.launchpad.family must NOT resolve to pad "a" — that is a spoofing vector.
  assert.equal(slugFromHost('a.b.launchpad.family'), null);
  assert.equal(slugFromHost('evil.com'), null);
  assert.equal(slugFromHost('launchpad.family.evil.com'), null);
  assert.equal(slugFromHost(''), null);
  assert.equal(slugFromHost(null), null);
});

test('host routing refuses a subdomain that is not a valid slug', () => {
  assert.equal(slugFromHost('a.launchpad.family'), null); // too short
  assert.equal(slugFromHost('admin.launchpad.family'), null); // reserved
  assert.equal(slugFromHost('xn--80ak6aa92e.launchpad.family'), null); // punycode
});

test('an alternate apex is honoured for local and staging use', () => {
  assert.equal(slugFromHost('ai.localhost', 'localhost'), 'ai');
  assert.equal(slugFromHost('localhost', 'localhost'), null);
});
