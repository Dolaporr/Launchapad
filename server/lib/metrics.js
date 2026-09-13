// ---------------------------------------------------------------------------
// Leaderboard and survival metrics.
//
// Every definition here was fixed BEFORE implementation, because a metric
// invented to fit whatever data happens to exist is not a metric.
//
// Three rules:
//
//   1. A LAUNCH IS ONLY COUNTED IF THE CHAIN VOUCHES FOR IT. `verifyMarketLaunch`
//      must be true and the launch must name this pad. Nothing is counted on the
//      strength of a registry row.
//   2. TOO YOUNG IS NOT ZERO. A launch that has not lived long enough to be
//      judged is excluded from the DENOMINATOR entirely, and the rate renders as
//      "not enough history yet". Putting it in the denominator would punish a pad
//      for being new.
//   3. THESE ARE ACTIVITY METRICS. They say a token still had independent
//      traders later. They are not safety, quality or rug-prevention claims.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Observation windows, closed intervals around the 7- and 30-day marks. */
export const SURVIVAL_WINDOWS = {
  d7: { fromDays: 6, toDays: 8, maturesAfterDays: 8 },
  d30: { fromDays: 29, toDays: 31, maturesAfterDays: 31 },
};

/** Distinct non-controlled traders required inside the window for a launch to count as active. */
export const MIN_DISTINCT_TRADERS = 2;

/**
 * Addresses whose trading proves nothing about independent interest.
 *
 * The token creator and pad owner have an obvious incentive to trade their own
 * launch; our own infrastructure is not a market participant at all.
 */
export function controlledAddressesFor({
  tokenCreator, padOwner, protocolTreasury, protocolAddresses = [], uniswapAddresses = [],
}) {
  return new Set([
    tokenCreator, padOwner, protocolTreasury,
    ...protocolAddresses, ...uniswapAddresses,
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dEaD',
  ].filter(Boolean).map((a) => String(a).toLowerCase()));
}

/**
 * Is a launch "active" in a window?
 *
 * @param {object} launch  { launchedAt, trades: [{ trader, at }] }
 * @param {object} window  one of SURVIVAL_WINDOWS
 * @param {Set<string>} controlled
 * @param {number} now
 * @returns {true | false | null}  null means NOT YET MEASURABLE, never "failed"
 */
export function isActiveInWindow(launch, window, controlled, now = Date.now()) {
  const matureAt = launch.launchedAt + window.maturesAfterDays * DAY_MS;
  if (now < matureAt) return null;

  const from = launch.launchedAt + window.fromDays * DAY_MS;
  const to = launch.launchedAt + window.toDays * DAY_MS;

  const traders = new Set();
  for (const trade of launch.trades ?? []) {
    if (trade.at < from || trade.at > to) continue;
    const trader = String(trade.trader).toLowerCase();
    if (controlled.has(trader)) continue;
    traders.add(trader);
  }
  return traders.size >= MIN_DISTINCT_TRADERS;
}

/**
 * Survival rate over a pad's launches.
 *
 * Denominator counts ONLY launches old enough to have completed the observation
 * window. Returns null when none have, so the UI can say "not enough history"
 * instead of rendering a misleading 0%.
 */
export function survivalRate(launches, window, controlledFor, now = Date.now()) {
  let eligible = 0;
  let active = 0;
  for (const launch of launches) {
    const verdict = isActiveInWindow(launch, window, controlledFor(launch), now);
    if (verdict === null) continue;
    eligible += 1;
    if (verdict) active += 1;
  }
  if (eligible === 0) return { rate: null, eligible: 0, active: 0 };
  return { rate: active / eligible, eligible, active };
}

/**
 * All V1 metrics for one pad.
 *
 * @param {object[]} launches  verified launches: { token, tokenCreator, launchedAt, trades }
 */
export function padMetrics(launches, { padOwner, protocolTreasury, protocolAddresses = [], uniswapAddresses = [] }, now = Date.now()) {
  const controlledFor = (launch) => controlledAddressesFor({
    tokenCreator: launch.tokenCreator,
    padOwner,
    protocolTreasury,
    protocolAddresses,
    uniswapAddresses,
  });

  const launchesPerCreator = new Map();
  for (const launch of launches) {
    const creator = String(launch.tokenCreator).toLowerCase();
    launchesPerCreator.set(creator, (launchesPerCreator.get(creator) ?? 0) + 1);
  }

  const d7 = survivalRate(launches, SURVIVAL_WINDOWS.d7, controlledFor, now);
  const d30 = survivalRate(launches, SURVIVAL_WINDOWS.d30, controlledFor, now);

  return {
    totalLaunches: launches.length,
    uniqueCreators: launchesPerCreator.size,
    repeatCreators: [...launchesPerCreator.values()].filter((n) => n >= 2).length,
    survival7d: d7.rate,
    survival7dSample: { eligible: d7.eligible, active: d7.active },
    survival30d: d30.rate,
    survival30dSample: { eligible: d30.eligible, active: d30.active },
    // Context only. Never a ranking signal: a single wallet can manufacture it.
    externalTraderCount: countExternalTraders(launches, controlledFor),
    measuredAt: now,
  };
}

function countExternalTraders(launches, controlledFor) {
  const traders = new Set();
  for (const launch of launches) {
    const controlled = controlledFor(launch);
    for (const trade of launch.trades ?? []) {
      const trader = String(trade.trader).toLowerCase();
      if (!controlled.has(trader)) traders.add(trader);
    }
  }
  return traders.size;
}

/**
 * Leaderboard ordering.
 *
 * Unique creators first, because recruiting distinct people is the thing a good
 * launchpad actually does and the thing hardest to fake cheaply. Volume is never
 * consulted.
 */
export function rankPads(pads) {
  return [...pads]
    // A pad must have at least one verified launch to be ranked at all.
    .filter((pad) => (pad.metrics?.totalLaunches ?? 0) > 0)
    .sort((a, b) => (b.metrics.uniqueCreators - a.metrics.uniqueCreators)
      || (b.metrics.repeatCreators - a.metrics.repeatCreators)
      || (b.metrics.totalLaunches - a.metrics.totalLaunches)
      || String(a.slug).localeCompare(String(b.slug)));
}

export { DAY_MS };
