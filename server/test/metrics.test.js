import test from 'node:test';
import assert from 'node:assert/strict';
import {
  padMetrics, survivalRate, isActiveInWindow, rankPads,
  SURVIVAL_WINDOWS, MIN_DISTINCT_TRADERS, controlledAddressesFor, DAY_MS,
} from '../lib/metrics.js';

const NOW = 1_000_000_000_000;
const CREATOR = '0xc0ffee0000000000000000000000000000000001';
const CREATOR_2 = '0xc0ffee0000000000000000000000000000000002';
const PAD_OWNER = '0xpad00000000000000000000000000000000000a'.replace('pad', 'dad');
const TREASURY = '0x7777777777777777777777777777777777777777';
const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const CAROL = '0xca401000000000000000000000000000000000003'.slice(0, 42);

const ctx = { padOwner: PAD_OWNER, protocolTreasury: TREASURY };

/** A launch that is `ageDays` old, with the given trades. */
function launch({ creator = CREATOR, ageDays, trades = [] }) {
  const launchedAt = NOW - ageDays * DAY_MS;
  return {
    token: `0xtok${creator.slice(-4)}${ageDays}`,
    tokenCreator: creator,
    launchedAt,
    trades: trades.map(({ trader, atDays }) => ({ trader, at: launchedAt + atDays * DAY_MS })),
  };
}

const controlledFor = (l) => controlledAddressesFor({
  tokenCreator: l.tokenCreator, padOwner: PAD_OWNER, protocolTreasury: TREASURY,
});

// --- the "too young" rule ---------------------------------------------------

test('a launch too young to judge is NOT zero — it is unmeasurable', () => {
  const young = launch({ ageDays: 3, trades: [] });
  assert.equal(isActiveInWindow(young, SURVIVAL_WINDOWS.d7, controlledFor(young), NOW), null);
});

test('a launch one day short of maturity is still unmeasurable', () => {
  const almost = launch({ ageDays: 7.9, trades: [] });
  assert.equal(isActiveInWindow(almost, SURVIVAL_WINDOWS.d7, controlledFor(almost), NOW), null);
});

test('a pad whose launches are all too young reports null, never 0%', () => {
  const m = padMetrics([launch({ ageDays: 2 }), launch({ ageDays: 5 })], ctx, NOW);
  assert.equal(m.survival7d, null);
  assert.equal(m.survival30d, null);
  assert.equal(m.survival7dSample.eligible, 0);
  // Launch and creator counts are still real.
  assert.equal(m.totalLaunches, 2);
  assert.equal(m.uniqueCreators, 1);
});

test('young launches are excluded from the denominator, not counted as failures', () => {
  const mature = launch({
    ageDays: 10,
    trades: [{ trader: ALICE, atDays: 7 }, { trader: BOB, atDays: 7 }],
  });
  const young = launch({ ageDays: 1 });
  const m = padMetrics([mature, young], ctx, NOW);
  // One eligible, one active: 100%, not 50%.
  assert.equal(m.survival7d, 1);
  assert.equal(m.survival7dSample.eligible, 1);
});

// --- the window -------------------------------------------------------------

test('only trades inside the window count', () => {
  const l = launch({
    ageDays: 10,
    trades: [
      { trader: ALICE, atDays: 1 },   // too early
      { trader: BOB, atDays: 9.5 },   // too late
    ],
  });
  assert.equal(isActiveInWindow(l, SURVIVAL_WINDOWS.d7, controlledFor(l), NOW), false);
});

test('the window is the closed interval from day 6 to day 8', () => {
  const inside = launch({
    ageDays: 10,
    trades: [{ trader: ALICE, atDays: 6 }, { trader: BOB, atDays: 8 }],
  });
  assert.equal(isActiveInWindow(inside, SURVIVAL_WINDOWS.d7, controlledFor(inside), NOW), true);
});

test('30-day activity uses its own window and maturity', () => {
  const l = launch({
    ageDays: 32,
    trades: [{ trader: ALICE, atDays: 30 }, { trader: BOB, atDays: 30 }],
  });
  assert.equal(isActiveInWindow(l, SURVIVAL_WINDOWS.d30, controlledFor(l), NOW), true);

  const tooYoung = launch({ ageDays: 20, trades: [] });
  assert.equal(isActiveInWindow(tooYoung, SURVIVAL_WINDOWS.d30, controlledFor(tooYoung), NOW), null);
});

// --- controlled addresses ---------------------------------------------------

test('the creator and pad owner trading their own launch proves nothing', () => {
  const l = launch({
    ageDays: 10,
    trades: [
      { trader: CREATOR, atDays: 7 },
      { trader: PAD_OWNER, atDays: 7 },
      { trader: TREASURY, atDays: 7 },
    ],
  });
  assert.equal(isActiveInWindow(l, SURVIVAL_WINDOWS.d7, controlledFor(l), NOW), false);
});

test('one independent trader is not enough; two are', () => {
  const one = launch({ ageDays: 10, trades: [{ trader: ALICE, atDays: 7 }] });
  assert.equal(isActiveInWindow(one, SURVIVAL_WINDOWS.d7, controlledFor(one), NOW), false);

  const two = launch({
    ageDays: 10, trades: [{ trader: ALICE, atDays: 7 }, { trader: BOB, atDays: 7 }],
  });
  assert.equal(isActiveInWindow(two, SURVIVAL_WINDOWS.d7, controlledFor(two), NOW), true);
  assert.equal(MIN_DISTINCT_TRADERS, 2);
});

test('one trader trading repeatedly is still one trader', () => {
  // Otherwise a single wallet could manufacture "survival" with a loop.
  const l = launch({
    ageDays: 10,
    trades: [
      { trader: ALICE, atDays: 6.1 }, { trader: ALICE, atDays: 6.5 },
      { trader: ALICE, atDays: 7 }, { trader: ALICE, atDays: 7.9 },
    ],
  });
  assert.equal(isActiveInWindow(l, SURVIVAL_WINDOWS.d7, controlledFor(l), NOW), false);
});

test('address comparison is case-insensitive', () => {
  const l = launch({
    ageDays: 10,
    trades: [{ trader: CREATOR.toUpperCase(), atDays: 7 }, { trader: ALICE, atDays: 7 }],
  });
  // The creator is still controlled despite the casing, leaving one real trader.
  assert.equal(isActiveInWindow(l, SURVIVAL_WINDOWS.d7, controlledFor(l), NOW), false);
});

// --- rates ------------------------------------------------------------------

test('survival rate divides active by eligible only', () => {
  const active = launch({
    creator: CREATOR, ageDays: 10,
    trades: [{ trader: ALICE, atDays: 7 }, { trader: BOB, atDays: 7 }],
  });
  const dead = launch({ creator: CREATOR, ageDays: 10, trades: [] });
  const young = launch({ creator: CREATOR, ageDays: 1 });

  const r = survivalRate([active, dead, young], SURVIVAL_WINDOWS.d7, controlledFor, NOW);
  assert.equal(r.eligible, 2);
  assert.equal(r.active, 1);
  assert.equal(r.rate, 0.5);
});

test('a genuinely dead launch does report 0%, once it is old enough', () => {
  const dead = launch({ ageDays: 10, trades: [] });
  const m = padMetrics([dead], ctx, NOW);
  assert.equal(m.survival7d, 0);
  assert.equal(m.survival7dSample.eligible, 1);
});

// --- creator counts ---------------------------------------------------------

test('counts unique and repeat creators', () => {
  const m = padMetrics([
    launch({ creator: CREATOR, ageDays: 1 }),
    launch({ creator: CREATOR, ageDays: 2 }),
    launch({ creator: CREATOR_2, ageDays: 3 }),
  ], ctx, NOW);
  assert.equal(m.totalLaunches, 3);
  assert.equal(m.uniqueCreators, 2);
  assert.equal(m.repeatCreators, 1);
});

test('an empty pad has no metrics to speak of', () => {
  const m = padMetrics([], ctx, NOW);
  assert.equal(m.totalLaunches, 0);
  assert.equal(m.uniqueCreators, 0);
  assert.equal(m.survival7d, null);
});

// --- ranking ----------------------------------------------------------------

test('ranking prefers unique creators over raw launch count', () => {
  const many = { slug: 'solo', metrics: { uniqueCreators: 1, repeatCreators: 1, totalLaunches: 50 } };
  const varied = { slug: 'community', metrics: { uniqueCreators: 9, repeatCreators: 2, totalLaunches: 12 } };
  assert.equal(rankPads([many, varied])[0].slug, 'community');
});

test('ties break on repeat creators, then launches, then name', () => {
  const a = { slug: 'a', metrics: { uniqueCreators: 3, repeatCreators: 1, totalLaunches: 5 } };
  const b = { slug: 'b', metrics: { uniqueCreators: 3, repeatCreators: 2, totalLaunches: 4 } };
  assert.equal(rankPads([a, b])[0].slug, 'b');

  const c = { slug: 'c', metrics: { uniqueCreators: 3, repeatCreators: 2, totalLaunches: 9 } };
  assert.equal(rankPads([b, c])[0].slug, 'c');
});

test('empty pads are never ranked', () => {
  const empty = { slug: 'empty', metrics: { uniqueCreators: 0, repeatCreators: 0, totalLaunches: 0 } };
  const real = { slug: 'real', metrics: { uniqueCreators: 1, repeatCreators: 0, totalLaunches: 1 } };
  const ranked = rankPads([empty, real]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].slug, 'real');
});

test('volume is not consulted anywhere in ranking', () => {
  const whale = {
    slug: 'whale',
    metrics: { uniqueCreators: 1, repeatCreators: 0, totalLaunches: 1, volumeWei: '9'.repeat(30) },
  };
  const community = {
    slug: 'community',
    metrics: { uniqueCreators: 5, repeatCreators: 3, totalLaunches: 6, volumeWei: '1' },
  };
  assert.equal(rankPads([whale, community])[0].slug, 'community');
});

test('external trader count excludes controlled addresses', () => {
  const m = padMetrics([launch({
    ageDays: 10,
    trades: [
      { trader: CREATOR, atDays: 7 }, { trader: PAD_OWNER, atDays: 7 },
      { trader: ALICE, atDays: 7 }, { trader: BOB, atDays: 7 }, { trader: CAROL, atDays: 7 },
    ],
  })], ctx, NOW);
  assert.equal(m.externalTraderCount, 3);
});
