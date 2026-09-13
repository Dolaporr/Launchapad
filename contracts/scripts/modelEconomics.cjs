/**
 * Models what the approved 50 / 30 / 20 split actually earns.
 *
 * Every input below is either (a) read from the live mainnet contracts, or (b) an explicitly
 * labelled assumption. Nothing is invented silently.
 *
 *   node scripts/modelEconomics.cjs [--eth-price 3000]
 *
 * THE CHAIN OF CUTS — this is the whole point of the model:
 *
 *   swap volume
 *     -> 25 bps  LP fee                     (Uniswap pool, fixed at launch)
 *        -> ETH side only reaches us. Uniswap's FeeSplitter sends 40% of the ETH side and
 *           0% of the TOKEN side to the beneficiary vault.
 *           -> 50 / 30 / 20 of THAT is creator / pad owner / protocol.
 *
 * A v4 pool charges its fee in the INPUT currency. So a BUY (ETH -> token) pays the fee in ETH
 * and is the only kind of trade that produces revenue for us. A SELL (token -> ETH) pays its fee
 * in the token, and 100% of the token side goes to Uniswap.
 */
const LP_FEE_BPS = 25; // read from InstantLaunchStrategy.LP_FEE = 2500 (hundredths of a bip)
const VAULT_SHARE_OF_ETH_BPS = 4000; // read from FeeSplitter#creator-fees.getSplits()
const VAULT_SHARE_OF_TOKEN_BPS = 0; // read from the same call
const SPLIT = { creator: 5000, padOwner: 3000, protocol: 2000 }; // approved, fixed in bytecode

const args = process.argv.slice(2);
const priceFlag = args.indexOf('--eth-price');
// ASSUMPTION, not market data. Override with --eth-price.
const ETH_PRICE_USD = priceFlag >= 0 ? Number(args[priceFlag + 1]) : 3000;

const bps = (x) => `${x.toFixed(4)} bps`;
const usd = (x) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Effective basis points captured on BUY volume (the ETH side). */
function ethSideBps() {
  const toVault = LP_FEE_BPS * (VAULT_SHARE_OF_ETH_BPS / 10000);
  return {
    lpFee: LP_FEE_BPS,
    toUniswap: LP_FEE_BPS - toVault,
    toVault,
    creator: toVault * (SPLIT.creator / 10000),
    padOwner: toVault * (SPLIT.padOwner / 10000),
    protocol: toVault * (SPLIT.protocol / 10000),
  };
}

/** Effective basis points captured on SELL volume (the token side). */
function tokenSideBps() {
  const toVault = LP_FEE_BPS * (VAULT_SHARE_OF_TOKEN_BPS / 10000);
  return {
    lpFee: LP_FEE_BPS,
    toUniswap: LP_FEE_BPS - toVault,
    toVault,
    creator: toVault * (SPLIT.creator / 10000),
    padOwner: toVault * (SPLIT.padOwner / 10000),
    protocol: toVault * (SPLIT.protocol / 10000),
  };
}

function line(char = '─', n = 78) { return char.repeat(n); }

console.log(line('═'));
console.log('LAUNCHPAD.FAMILY — ECONOMIC MODEL FOR THE APPROVED 50 / 30 / 20 SPLIT');
console.log(line('═'));
console.log();
console.log('Inputs read from live mainnet contracts (chain 4663, 2026-09-12):');
console.log(`  Pool LP fee                          ${LP_FEE_BPS} bps (InstantLaunchStrategy.LP_FEE = 2500)`);
console.log(`  FeeSplitter -> vault, ETH side       ${VAULT_SHARE_OF_ETH_BPS / 100}%`);
console.log(`  FeeSplitter -> vault, TOKEN side     ${VAULT_SHARE_OF_TOKEN_BPS / 100}%`);
console.log('Approved policy (fixed in LaunchpadRewards bytecode):');
console.log(`  creator / pad owner / protocol       ${SPLIT.creator / 100}% / ${SPLIT.padOwner / 100}% / ${SPLIT.protocol / 100}%`);
console.log(`ASSUMPTION (not market data):           ETH = ${usd(ETH_PRICE_USD)}`);
console.log();

const eth = ethSideBps();
const tok = tokenSideBps();

console.log(line());
console.log('EFFECTIVE BASIS POINTS — ETH SIDE (buys: ETH -> token)');
console.log(line());
console.log(`  LP fee charged by the pool           ${bps(eth.lpFee)}`);
console.log(`  ... of which Uniswap keeps           ${bps(eth.toUniswap)}`);
console.log(`  ... of which reaches our stream      ${bps(eth.toVault)}   <- everything below splits this`);
console.log();
console.log(`  -> token creator   (50%)             ${bps(eth.creator)}`);
console.log(`  -> launchpad owner (30%)             ${bps(eth.padOwner)}`);
console.log(`  -> Launchpad.family (20%)            ${bps(eth.protocol)}`);
console.log();
console.log(line());
console.log('EFFECTIVE BASIS POINTS — TOKEN SIDE (sells: token -> ETH)');
console.log(line());
console.log(`  LP fee charged by the pool           ${bps(tok.lpFee)}`);
console.log(`  ... of which Uniswap keeps           ${bps(tok.toUniswap)}  (100% of the token side)`);
console.log(`  ... of which reaches our stream      ${bps(tok.toVault)}`);
console.log();
console.log('  -> token creator                     0 bps');
console.log('  -> launchpad owner                   0 bps');
console.log('  -> Launchpad.family                  0 bps');
console.log();
console.log('  SELLS EARN US NOTHING. Uniswap takes 100% of the token-side fee. Any revenue');
console.log('  projection that multiplies TOTAL volume by 10 bps is overstated by roughly 2x.');
console.log();

// --- Sample trade sets ----------------------------------------------------------------------
const scenarios = [
  { name: 'Quiet launch',      buyVolumeUsd: 25_000,     sellVolumeUsd: 25_000 },
  { name: 'Modest launch',     buyVolumeUsd: 250_000,    sellVolumeUsd: 250_000 },
  { name: 'Busy launch',       buyVolumeUsd: 2_500_000,  sellVolumeUsd: 2_500_000 },
  { name: 'Breakout',          buyVolumeUsd: 25_000_000, sellVolumeUsd: 25_000_000 },
  { name: 'Buy-heavy (80/20)', buyVolumeUsd: 8_000_000,  sellVolumeUsd: 2_000_000 },
  { name: 'Sell-heavy (20/80)', buyVolumeUsd: 2_000_000, sellVolumeUsd: 8_000_000 },
];

console.log(line('═'));
console.log('REVENUE PER TOKEN, BY SCENARIO');
console.log(line('═'));
console.log();
console.log(
  'Scenario'.padEnd(20)
  + 'Buy vol'.padStart(12) + 'Sell vol'.padStart(12)
  + 'Creator'.padStart(11) + 'Pad owner'.padStart(11) + 'Protocol'.padStart(11),
);
console.log(line());

const totals = { creator: 0, padOwner: 0, protocol: 0 };
for (const s of scenarios) {
  // Only buy volume produces revenue for us.
  const streamUsd = s.buyVolumeUsd * (eth.toVault / 10000);
  const creator = streamUsd * (SPLIT.creator / 10000);
  const padOwner = streamUsd * (SPLIT.padOwner / 10000);
  const protocol = streamUsd * (SPLIT.protocol / 10000);
  totals.creator += creator; totals.padOwner += padOwner; totals.protocol += protocol;

  console.log(
    s.name.padEnd(20)
    + `$${(s.buyVolumeUsd / 1000).toLocaleString()}k`.padStart(12)
    + `$${(s.sellVolumeUsd / 1000).toLocaleString()}k`.padStart(12)
    + usd(creator).padStart(11) + usd(padOwner).padStart(11) + usd(protocol).padStart(11),
  );
}
console.log(line());
console.log(
  'TOTAL across scenarios'.padEnd(44)
  + usd(totals.creator).padStart(11) + usd(totals.padOwner).padStart(11) + usd(totals.protocol).padStart(11),
);
console.log();

// --- Blended rate ---------------------------------------------------------------------------
console.log(line('═'));
console.log('BLENDED RATE ON *TOTAL* VOLUME (the number not to quote carelessly)');
console.log(line('═'));
console.log();
for (const buyShare of [0.5, 0.6, 0.8]) {
  const blended = eth.toVault * buyShare;
  console.log(
    `  ${(buyShare * 100).toFixed(0)}% of volume is buys -> our stream is ${bps(blended)} of total volume`
    + `  (creator ${bps(blended * 0.5)}, pad ${bps(blended * 0.3)}, protocol ${bps(blended * 0.2)})`,
  );
}
console.log();
console.log('  At a 50/50 buy-sell mix the protocol earns 1 bp of TOTAL traded volume.');
console.log(`  $1,000,000 of total volume at that mix -> ${usd(1_000_000 * (eth.toVault * 0.5 / 10000) * 0.2)} to the protocol.`);
console.log();

// --- What it takes to matter ------------------------------------------------------------------
console.log(line('═'));
console.log('VOLUME REQUIRED FOR A GIVEN PROTOCOL REVENUE (50/50 buy-sell mix)');
console.log(line('═'));
console.log();
const protocolBpsOfTotal = eth.toVault * 0.5 * (SPLIT.protocol / 10000);
for (const target of [1_000, 10_000, 100_000, 1_000_000]) {
  const volumeNeeded = target / (protocolBpsOfTotal / 10000);
  console.log(`  ${usd(target).padStart(14)} of protocol revenue needs ${usd(volumeNeeded)} of total volume`);
}
console.log();
console.log('Caveats that belong next to every number above:');
console.log('  1. Fees accrue as LP fees on a permanently locked position. They are claimable, not');
console.log('     auto-compounded into anyone\'s wallet — somebody must call collectAndSplit.');
console.log('  2. The token side is worth nothing to us. Half of a token\'s trading is typically sells.');
console.log('  3. Uniswap can deploy a new launchpad version and deprecate this one; the 40% ETH-side');
console.log('     share is immutable per splitter but not a promise about future versions.');
console.log(`  4. ETH price is an input assumption (${usd(ETH_PRICE_USD)}), not a reading.`);
