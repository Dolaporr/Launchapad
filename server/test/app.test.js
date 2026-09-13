import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../lib/app.js';
import { Registry } from '../lib/registry.js';
import { BrandingStore } from '../lib/branding.js';

const CHAIN = 4663;
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const PAD_A = '0xAAaAaAAAaAAAAAAAAAaAaAAAAAaAAAaAaAAaAAAa';
const WEB_ROOT = new URL('../../web/', import.meta.url).pathname;

/**
 * A stand-in for the chain that returns whatever the test says the chain says.
 * Every method mirrors ChainReader, so the app cannot tell the difference.
 */
function fakeChain({ pads = {}, knownPads = new Set(), signatures = new Map() } = {}) {
  return {
    async readPad(address) { return pads[String(address).toLowerCase()] ?? null; },
    async padOwner(address) {
      const pad = pads[String(address).toLowerCase()];
      if (!pad) throw new Error('no pad');
      return pad.owner;
    },
    async factoryKnowsPad(_factory, pad) { return knownPads.has(String(pad).toLowerCase()); },
    async verifySignedBy(message, signature) { return signatures.get(signature) === message; },
  };
}

function makeApp(overrides = {}) {
  return new App({
    registry: new Registry(':memory:'),
    branding: new BrandingStore(':memory:'),
    webRoot: WEB_ROOT,
    chainId: CHAIN,
    apex: 'launchpad.family',
    origin: 'https://launchpad.family',
    ...overrides,
  });
}

/** Drives the app's router without a socket. */
async function request(app, method, path, { host = 'launchpad.family', body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: path,
    headers: { host, ...headers },
    on(event, handler) {
      if (event === 'data') chunks.forEach((c) => handler(c));
      if (event === 'end') handler();
      return this;
    },
    destroy() {},
  };
  let status; let payload = ''; let responseHeaders = {};
  const res = {
    writeHead(code, h) { status = code; responseHeaders = h ?? {}; },
    end(data) { payload = data ? data.toString() : ''; },
  };
  await app.handler()(req, res);
  let json = null;
  try { json = JSON.parse(payload); } catch { /* html or text */ }
  return { status, json, text: payload, headers: responseHeaders };
}

// --- host routing -----------------------------------------------------------

test('the apex and a pad subdomain are the same code path, split by Host', async () => {
  const app = makeApp();
  const apex = await request(app, 'GET', '/api/config', { host: 'launchpad.family' });
  assert.equal(apex.json.padSlug, null);

  const pad = await request(app, 'GET', '/api/config', { host: 'ai.launchpad.family' });
  assert.equal(pad.json.padSlug, 'ai');
  app.registry.close();
});

test('a pad subdomain serves the pad shell for deep links, not the apex app', async () => {
  const app = makeApp();
  const root = await request(app, 'GET', '/', { host: 'ai.launchpad.family' });
  assert.equal(root.status, 200);
  assert.match(root.text, /data-shell="pad"/);

  // Client-side route on the pad: still the pad shell.
  const deep = await request(app, 'GET', '/launch', { host: 'ai.launchpad.family' });
  assert.match(deep.text, /data-shell="pad"/);
  app.registry.close();
});

test('the apex serves the apex shell', async () => {
  const app = makeApp();
  const home = await request(app, 'GET', '/', { host: 'launchpad.family' });
  assert.equal(home.status, 200);
  assert.match(home.text, /data-shell="apex"/);
  app.registry.close();
});

test('www and nested hosts are never treated as pads', async () => {
  const app = makeApp();
  for (const host of ['www.launchpad.family', 'a.b.launchpad.family', 'evil.com']) {
    const r = await request(app, 'GET', '/api/config', { host });
    assert.equal(r.json.padSlug, null, `${host} resolved to a pad`);
  }
  app.registry.close();
});

test('no request can read a file outside the web root', async () => {
  const app = makeApp();
  // Through the router, URL parsing already collapses `..`, so these land on the
  // SPA shell or a 404. What matters is that secret content never comes back.
  for (const path of ['/../contracts/.env', '/..%2f..%2f.env', '/../../etc/passwd',
    '/../contracts/hardhat.config.js']) {
    const r = await request(app, 'GET', path);
    assert.ok(!/PRIVATE_KEY|BEGIN .*PRIVATE|root:x:/.test(r.text),
      `leaked file contents for ${path}`);
  }
  app.registry.close();
});

test('serveFile itself refuses a path that resolves outside the web root', async () => {
  // Tested directly, because the router's URL parsing would otherwise hide
  // whether the containment check works at all.
  const app = makeApp();
  const attempt = async (raw) => {
    let status;
    let body = '';
    const res = {
      writeHead(code) { status = code; },
      end(data) { body = data ? data.toString() : ''; },
    };
    await app.serveFile(res, raw);
    return { status, body };
  };

  for (const raw of ['/../contracts/.env', '../contracts/.env',
    '/../../etc/passwd', '/../contracts/hardhat.config.js']) {
    const r = await attempt(raw);
    assert.equal(r.status, 404, `containment failed for ${raw}`);
    assert.equal(r.body, 'Not found');
  }

  // A legitimate file inside the root still serves.
  const ok = await attempt('/styles.css');
  assert.equal(ok.status, 200);
  app.registry.close();
});

// --- slug lifecycle ---------------------------------------------------------

test('slug check reports availability and shows the address being claimed', async () => {
  const app = makeApp();
  const r = await request(app, 'GET', '/api/slug/check?slug=AI%20Fun');
  assert.equal(r.json.available, true);
  assert.equal(r.json.slug, 'ai-fun');
  assert.equal(r.json.hostname, 'ai-fun.launchpad.family');
  assert.equal(r.json.metadataURI, 'https://launchpad.family/p/ai-fun');

  const reserved = await request(app, 'GET', '/api/slug/check?slug=admin');
  assert.equal(reserved.json.available, false);
  assert.equal(reserved.json.code, 'reserved');
  app.registry.close();
});

test('reserving holds a name, and a second wallet is refused', async () => {
  const app = makeApp();
  const first = await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });
  assert.equal(first.status, 200);
  assert.equal(first.json.hostname, 'ai.launchpad.family');

  const second = await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: BOB } });
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'reserved_by_other');
  app.registry.close();
});

// --- confirmation: the only call that permanently takes a name --------------

test('confirming requires the pad to exist, be owned, and commit to the slug on chain', async () => {
  const pads = {
    [PAD_A.toLowerCase()]: {
      address: PAD_A, owner: ALICE, name: 'AI.fun',
      metadataURI: 'https://launchpad.family/p/ai', launchPolicy: 1,
    },
  };
  const app = makeApp({ chain: fakeChain({ pads, knownPads: new Set([PAD_A.toLowerCase()]) }) });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });

  const ok = await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: ALICE, padAddress: PAD_A, factoryAddress: '0xf00' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.hostname, 'ai.launchpad.family');
  assert.equal(ok.json.pad.onchain.launchPolicyLabel, 'OPEN');
  app.registry.close();
});

test('a wallet cannot claim a pad it does not own', async () => {
  const pads = {
    [PAD_A.toLowerCase()]: {
      address: PAD_A, owner: ALICE, name: 'AI.fun',
      metadataURI: 'https://launchpad.family/p/ai', launchPolicy: 1,
    },
  };
  const app = makeApp({ chain: fakeChain({ pads, knownPads: new Set([PAD_A.toLowerCase()]) }) });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: BOB } });
  const r = await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: BOB, padAddress: PAD_A, factoryAddress: '0xf00' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'not_owner');
  app.registry.close();
});

test('a pad that committed to a DIFFERENT slug on chain cannot take this one', async () => {
  const pads = {
    [PAD_A.toLowerCase()]: {
      address: PAD_A, owner: ALICE, name: 'Other',
      metadataURI: 'https://launchpad.family/p/other', launchPolicy: 1,
    },
  };
  const app = makeApp({ chain: fakeChain({ pads, knownPads: new Set([PAD_A.toLowerCase()]) }) });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });
  const r = await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: ALICE, padAddress: PAD_A, factoryAddress: '0xf00' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'slug_mismatch');
  assert.match(r.json.message, /committed to "other"/);
  app.registry.close();
});

test('a pad not created by our factory is refused', async () => {
  const pads = {
    [PAD_A.toLowerCase()]: {
      address: PAD_A, owner: ALICE, name: 'AI.fun',
      metadataURI: 'https://launchpad.family/p/ai', launchPolicy: 1,
    },
  };
  const app = makeApp({ chain: fakeChain({ pads, knownPads: new Set() }) });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });
  const r = await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: ALICE, padAddress: PAD_A, factoryAddress: '0xf00' },
  });
  assert.equal(r.json.code, 'unknown_pad');
  app.registry.close();
});

test('an address with no pad is refused', async () => {
  const app = makeApp({ chain: fakeChain({}) });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });
  const r = await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: ALICE, padAddress: PAD_A },
  });
  assert.equal(r.json.code, 'not_a_pad');
  app.registry.close();
});

// --- branding auth ----------------------------------------------------------

test('branding updates require a valid single-use signature from the owner', async () => {
  const pads = {
    [PAD_A.toLowerCase()]: {
      address: PAD_A, owner: ALICE, name: 'AI.fun',
      metadataURI: 'https://launchpad.family/p/ai', launchPolicy: 1,
    },
  };
  const signatures = new Map();
  const app = makeApp({
    chain: fakeChain({ pads, knownPads: new Set([PAD_A.toLowerCase()]), signatures }),
  });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });
  await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: ALICE, padAddress: PAD_A, factoryAddress: '0xf00' },
  });

  const challenge = await request(app, 'POST', '/api/challenge', {
    body: { address: ALICE, action: 'update-branding', slug: 'ai' },
  });
  const { nonce, message } = challenge.json;
  signatures.set('0xgoodsig', message);

  const ok = await request(app, 'PUT', '/api/pads/ai/branding', {
    body: { nonce, signature: '0xgoodsig', branding: { displayName: 'AI.fun', accent: 'teal' } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.branding.accent, 'teal');

  // The nonce is single-use: the same signature cannot be replayed.
  const replay = await request(app, 'PUT', '/api/pads/ai/branding', {
    body: { nonce, signature: '0xgoodsig', branding: { displayName: 'Hijacked' } },
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.code, 'bad_nonce');
  app.registry.close();
});

test('branding cannot be changed without a signature, or with a bad one', async () => {
  const pads = {
    [PAD_A.toLowerCase()]: {
      address: PAD_A, owner: ALICE, name: 'AI.fun',
      metadataURI: 'https://launchpad.family/p/ai', launchPolicy: 1,
    },
  };
  const app = makeApp({
    chain: fakeChain({ pads, knownPads: new Set([PAD_A.toLowerCase()]), signatures: new Map() }),
  });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });
  await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: ALICE, padAddress: PAD_A, factoryAddress: '0xf00' },
  });

  const none = await request(app, 'PUT', '/api/pads/ai/branding', {
    body: { branding: { displayName: 'Hijacked' } },
  });
  assert.equal(none.status, 401);

  const challenge = await request(app, 'POST', '/api/challenge', {
    body: { address: BOB, action: 'update-branding', slug: 'ai' },
  });
  const wrongWallet = await request(app, 'PUT', '/api/pads/ai/branding', {
    body: { nonce: challenge.json.nonce, signature: '0xsig', branding: { displayName: 'Hijacked' } },
  });
  assert.equal(wrongWallet.status, 401);
  assert.equal(wrongWallet.json.code, 'wrong_wallet');

  assert.equal((await request(app, 'GET', '/api/pads/ai')).json.branding.displayName, 'AI.fun');
  app.registry.close();
});

// --- discovery and listing --------------------------------------------------

test('an empty pad is reachable by URL but absent from discovery', async () => {
  const pads = {
    [PAD_A.toLowerCase()]: {
      address: PAD_A, owner: ALICE, name: 'AI.fun',
      metadataURI: 'https://launchpad.family/p/ai', launchPolicy: 1,
    },
  };
  const app = makeApp({ chain: fakeChain({ pads, knownPads: new Set([PAD_A.toLowerCase()]) }) });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });
  await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: ALICE, padAddress: PAD_A, factoryAddress: '0xf00' },
  });

  assert.deepEqual((await request(app, 'GET', '/api/pads')).json.pads, []);
  const direct = await request(app, 'GET', '/api/pads/ai');
  assert.equal(direct.status, 200);
  assert.equal(direct.json.listing.discoverable, false);

  app.registry.recordFirstLaunch('ai');
  assert.equal((await request(app, 'GET', '/api/pads')).json.pads.length, 1);
  app.registry.close();
});

test('delisting needs the admin token and removes distribution only', async () => {
  const pads = {
    [PAD_A.toLowerCase()]: {
      address: PAD_A, owner: ALICE, name: 'AI.fun',
      metadataURI: 'https://launchpad.family/p/ai', launchPolicy: 1,
    },
  };
  const app = makeApp({
    chain: fakeChain({ pads, knownPads: new Set([PAD_A.toLowerCase()]) }),
    adminToken: 'secret',
  });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });
  await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: ALICE, padAddress: PAD_A, factoryAddress: '0xf00' },
  });
  app.registry.recordFirstLaunch('ai');

  const unauth = await request(app, 'POST', '/api/admin/listing', {
    body: { slug: 'ai', status: 'DELISTED' },
  });
  assert.equal(unauth.status, 401);

  const ok = await request(app, 'POST', '/api/admin/listing', {
    body: { slug: 'ai', status: 'DELISTED', reason: 'phishing frontend' },
    headers: { 'x-admin-token': 'secret' },
  });
  assert.equal(ok.status, 200);

  assert.deepEqual((await request(app, 'GET', '/api/pads')).json.pads, []);
  // The onchain facts and the direct URL are untouched.
  const view = await request(app, 'GET', '/api/pads/ai');
  assert.equal(view.status, 200);
  assert.equal(view.json.listing.status, 'DELISTED');
  assert.equal(view.json.onchain.name, 'AI.fun');
  assert.equal(view.json.padAddress, PAD_A.toLowerCase());
  app.registry.close();
});

test('the pad view keeps the two claims separate', async () => {
  const pads = {
    [PAD_A.toLowerCase()]: {
      address: PAD_A, owner: ALICE, name: 'AI.fun',
      metadataURI: 'https://launchpad.family/p/ai', launchPolicy: 1,
    },
  };
  const app = makeApp({ chain: fakeChain({ pads, knownPads: new Set([PAD_A.toLowerCase()]) }) });
  await request(app, 'POST', '/api/slug/reserve', { body: { slug: 'ai', owner: ALICE } });
  await request(app, 'POST', '/api/pads/confirm', {
    body: { slug: 'ai', owner: ALICE, padAddress: PAD_A, factoryAddress: '0xf00' },
  });
  const view = (await request(app, 'GET', '/api/pads/ai')).json;

  // "Recognised on chain" and "distributed by us" are different objects, and
  // neither implies the other.
  assert.ok(view.onchain, 'onchain facts must be their own object');
  assert.ok(view.listing, 'listing status must be its own object');
  assert.equal(view.listing.status, 'ACTIVE');
  assert.equal(view.onchain.launchPolicyLabel, 'OPEN');
  app.registry.close();
});

test('unknown API routes 404 rather than falling through to HTML', async () => {
  const app = makeApp();
  const r = await request(app, 'GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'unknown_route');
  app.registry.close();
});
