import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Registry, RESERVATION_TTL_MS, ABANDONED_AFTER_MS, LISTING_ACTIVE, LISTING_DELISTED,
} from '../lib/registry.js';

const CHAIN = 4663;
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const PAD_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PAD_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const fresh = () => new Registry(':memory:');
/** Reserve + confirm, the normal happy path. */
function createPad(reg, { slug, owner = ALICE, pad = PAD_A, now = Date.now() }) {
  const r = reg.reserve({ slug, owner, chainId: CHAIN }, now);
  assert.equal(r.ok, true, `reserve failed: ${r.message}`);
  const c = reg.confirm({ slug, owner, chainId: CHAIN, padAddress: pad }, now);
  assert.equal(c.ok, true, `confirm failed: ${c.message}`);
  return c;
}

test('a name is only finally taken once the pad exists on chain', () => {
  const reg = fresh();
  const now = 1000;
  reg.reserve({ slug: 'ai', owner: ALICE, chainId: CHAIN }, now);

  // Held, but not owned: a form submission alone must not burn the name forever.
  assert.equal(reg.availability('ai', now).code, 'reserved_by_other');
  assert.equal(reg.get('ai', now).confirmed_at, null);

  // After the TTL with no onchain pad, the name is free again.
  const later = now + RESERVATION_TTL_MS + 1;
  assert.equal(reg.availability('ai', later).available, true);
  reg.close();
});

test('a confirmed pad holds its name permanently', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', now: 1000 });
  const farFuture = 1000 + ABANDONED_AFTER_MS * 10;
  assert.equal(reg.availability('ai', farFuture).code, 'taken');
  reg.close();
});

test('two wallets racing for one name: exactly one wins', () => {
  const reg = fresh();
  const now = 1000;
  const first = reg.reserve({ slug: 'ai', owner: ALICE, chainId: CHAIN }, now);
  const second = reg.reserve({ slug: 'ai', owner: BOB, chainId: CHAIN }, now);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'reserved_by_other');
  reg.close();
});

test('the holder may re-reserve their own name without locking themselves out', () => {
  const reg = fresh();
  const now = 1000;
  reg.reserve({ slug: 'ai', owner: ALICE, chainId: CHAIN }, now);
  const again = reg.reserve({ slug: 'ai', owner: ALICE, chainId: CHAIN }, now + 60_000);
  assert.equal(again.ok, true);
  assert.equal(again.renewed, true);
  assert.ok(again.reservedUntil > now + RESERVATION_TTL_MS);
  reg.close();
});

test('a reservation can be released, but a confirmed pad cannot', () => {
  const reg = fresh();
  reg.reserve({ slug: 'ai', owner: ALICE, chainId: CHAIN }, 1000);
  assert.equal(reg.release({ slug: 'ai', owner: ALICE }, 1000).released, true);
  assert.equal(reg.availability('ai', 1000).available, true);

  createPad(reg, { slug: 'bee', now: 2000 });
  const r = reg.release({ slug: 'bee', owner: ALICE }, 2000);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'already_confirmed');
  reg.close();
});

test('another wallet cannot release a reservation it does not hold', () => {
  const reg = fresh();
  reg.reserve({ slug: 'ai', owner: ALICE, chainId: CHAIN }, 1000);
  const r = reg.release({ slug: 'ai', owner: BOB }, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_yours');
  reg.close();
});

test('one hosted pad per wallet, and it is not encoded in the contracts', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', owner: ALICE, pad: PAD_A, now: 1000 });
  const second = reg.reserve({ slug: 'other', owner: ALICE, chainId: CHAIN }, 2000);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'owner_limit');
  assert.equal(second.existingSlug, 'ai');

  // A different wallet is unaffected.
  assert.equal(reg.reserve({ slug: 'other', owner: BOB, chainId: CHAIN }, 2000).ok, true);
  reg.close();
});

test('the same pad address cannot be hosted under two names', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', owner: ALICE, pad: PAD_A, now: 1000 });
  reg.reserve({ slug: 'twin', owner: BOB, chainId: CHAIN }, 2000);
  const c = reg.confirm({ slug: 'twin', owner: BOB, chainId: CHAIN, padAddress: PAD_A }, 2000);
  assert.equal(c.ok, false);
  assert.equal(c.code, 'pad_already_listed');
  reg.close();
});

test('confirming is idempotent for the same pad', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', now: 1000 });
  const again = reg.confirm({ slug: 'ai', owner: ALICE, chainId: CHAIN, padAddress: PAD_A }, 1500);
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  reg.close();
});

test('confirming fails once the reservation has expired', () => {
  const reg = fresh();
  const now = 1000;
  reg.reserve({ slug: 'ai', owner: ALICE, chainId: CHAIN }, now);
  const c = reg.confirm(
    { slug: 'ai', owner: ALICE, chainId: CHAIN, padAddress: PAD_A },
    now + RESERVATION_TTL_MS + 1,
  );
  assert.equal(c.ok, false);
  assert.equal(c.code, 'no_reservation');
  reg.close();
});

test('a wallet cannot confirm against a reservation it does not hold', () => {
  const reg = fresh();
  reg.reserve({ slug: 'ai', owner: ALICE, chainId: CHAIN }, 1000);
  const c = reg.confirm({ slug: 'ai', owner: BOB, chainId: CHAIN, padAddress: PAD_B }, 1000);
  assert.equal(c.ok, false);
  assert.equal(c.code, 'not_yours');
  reg.close();
});

test('invalid and reserved names are refused before any state is written', () => {
  const reg = fresh();
  assert.equal(reg.reserve({ slug: 'admin', owner: ALICE, chainId: CHAIN }).code, 'reserved');
  assert.equal(reg.reserve({ slug: 'a', owner: ALICE, chainId: CHAIN }).code, 'too_short');
  assert.equal(reg.reserve({ slug: 'ai', owner: 'not-an-address', chainId: CHAIN }).code, 'bad_owner');
  assert.equal(reg.get('admin'), null);
  reg.close();
});

test('a name is stored canonically, so spellings converge on one pad', () => {
  const reg = fresh();
  createPad(reg, { slug: 'AI Fun', now: 1000 });
  assert.ok(reg.resolve('ai-fun', 1000));
  assert.equal(reg.availability('AI_FUN', 1000).code, 'taken');
  reg.close();
});

// --- discovery, abandonment and delisting -----------------------------------

test('an empty pad is never discoverable or rankable', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', now: 1000 });
  assert.deepEqual(reg.discoverable(CHAIN, 1000), []);
  assert.equal(reg.resolve('ai', 1000).discoverable, false);
  reg.close();
});

test('a pad becomes discoverable on its first valid launch', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', now: 1000 });
  reg.recordFirstLaunch('ai', 2000);
  assert.equal(reg.discoverable(CHAIN, 2000).length, 1);
  assert.equal(reg.resolve('ai', 2000).discoverable, true);
  reg.close();
});

test('first launch is write-once', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', now: 1000 });
  reg.recordFirstLaunch('ai', 2000);
  const again = reg.recordFirstLaunch('ai', 9000);
  assert.equal(again.already, true);
  assert.equal(reg.get('ai').first_launch_at, 2000);
  reg.close();
});

test('a pad with no launch after 14 days leaves discovery but keeps everything else', () => {
  const reg = fresh();
  const now = 1000;
  createPad(reg, { slug: 'ai', now });
  const after = now + ABANDONED_AFTER_MS + 1;

  const resolved = reg.resolve('ai', after);
  assert.equal(resolved.abandoned, true);
  assert.equal(resolved.discoverable, false);
  assert.deepEqual(reg.discoverable(CHAIN, after), []);

  // The hosted URL still resolves and the onchain pad is untouched.
  assert.equal(resolved.pad_address, PAD_A);
  assert.equal(resolved.listing_status, LISTING_ACTIVE);
  // And the namespace is NOT recycled — reclaiming it is an impersonation vector.
  assert.equal(reg.availability('ai', after).code, 'taken');
  reg.close();
});

test('an abandoned pad becomes discoverable again automatically after its first launch', () => {
  const reg = fresh();
  const now = 1000;
  createPad(reg, { slug: 'ai', now });
  const after = now + ABANDONED_AFTER_MS + 1;
  assert.equal(reg.resolve('ai', after).abandoned, true);

  reg.recordFirstLaunch('ai', after + 10);
  const revived = reg.resolve('ai', after + 20);
  assert.equal(revived.abandoned, false);
  assert.equal(revived.discoverable, true);
  reg.close();
});

test('delisting removes distribution without touching the chain', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', now: 1000 });
  reg.recordFirstLaunch('ai', 1100);
  assert.equal(reg.discoverable(CHAIN, 1200).length, 1);

  reg.setListingStatus('ai', LISTING_DELISTED, 'phishing frontend');
  const row = reg.resolve('ai', 1200);
  assert.equal(row.listing_status, LISTING_DELISTED);
  assert.equal(row.discoverable, false);
  assert.deepEqual(reg.discoverable(CHAIN, 1200), []);

  // Everything onchain-derived is intact, and it stays resolvable by address.
  assert.equal(row.pad_address, PAD_A);
  assert.equal(reg.getByAddress(CHAIN, PAD_A).slug, 'ai');
  assert.equal(row.delisted_reason, 'phishing frontend');
  reg.close();
});

test('delisting is reversible', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', now: 1000 });
  reg.recordFirstLaunch('ai', 1100);
  reg.setListingStatus('ai', LISTING_DELISTED, 'mistake');
  reg.setListingStatus('ai', LISTING_ACTIVE);
  const row = reg.resolve('ai', 1200);
  assert.equal(row.listing_status, LISTING_ACTIVE);
  assert.equal(row.delisted_reason, null);
  assert.equal(row.discoverable, true);
  reg.close();
});

test('resolve returns null for a name that was never confirmed on chain', () => {
  const reg = fresh();
  reg.reserve({ slug: 'ai', owner: ALICE, chainId: CHAIN }, 1000);
  assert.equal(reg.resolve('ai', 1000), null);
  assert.equal(reg.resolve('never-existed', 1000), null);
  reg.close();
});

test('pads are scoped per chain', () => {
  const reg = fresh();
  createPad(reg, { slug: 'ai', owner: ALICE, pad: PAD_A, now: 1000 });
  reg.recordFirstLaunch('ai', 1100);
  assert.equal(reg.discoverable(CHAIN, 1200).length, 1);
  assert.equal(reg.discoverable(999, 1200).length, 0);
  reg.close();
});

test('survives being reopened from disk', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'reg-'));
  const file = join(dir, 'registry.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const a = new Registry(file);
  createPad(a, { slug: 'ai', now: 1000 });
  a.recordFirstLaunch('ai', 1100);
  a.close();

  const b = new Registry(file);
  assert.equal(b.resolve('ai', 1200).pad_address, PAD_A);
  assert.equal(b.discoverable(CHAIN, 1200).length, 1);
  b.close();
});
