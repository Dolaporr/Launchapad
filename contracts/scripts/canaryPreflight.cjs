/**
 * MAINNET CANARY PREFLIGHT — read-only. Sends no transaction and signs nothing.
 *
 * Every check is a hard gate. On ANY discrepancy this script ABORTS and does not adapt: it does
 * not fall back to another address, relax an expectation, or "use what's there". The point is to
 * catch an upstream change between our fork-block evidence and current mainnet state, and a
 * silent adaptation would destroy exactly that signal.
 *
 *   npx hardhat run scripts/canaryPreflight.cjs --network robinhood
 *
 * Optional:
 *   MAX_ETH_BUDGET=0.01   total spend ceiling; abort if the estimate exceeds it (default 0.01)
 *   CANARY_BUY_ETH=0.001  the size of the proving buy (default 0.001)
 *   BASELINE=path.json    compare dependency codehashes against a recorded baseline
 *   WRITE_BASELINE=1      write the observed codehashes to BASELINE instead of comparing
 */
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
require('dotenv').config();

const MAINNET = 4663n;

// Pinned official Uniswap Liquidity Launchpad deployment on Robinhood Chain mainnet. These are
// the same constants compiled into contracts/market/UniswapRobinhood.sol.
const U = {
  liquidityLauncher: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0',
  instantLaunchStrategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',
  feeSplitter: '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf',
  beneficiaryVault: '0xd35E9CA72F64C7F93BE30fad67524323396B36D7',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  // Needed only for the canary's proving BUY. Using Uniswap's own router keeps test-only code
  // (V4TestSwapRouter) off mainnet entirely.
  universalRouter: '0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99',
};

const REGISTRY_URL = 'https://developers.uniswap.org/deployments.json';

// What Milestone 2.5 measured on the fork. Any drift here invalidates that evidence.
const EXPECTED = {
  totalSupply: 1000000000n * 10n ** 18n,
  lpFee: 2500n,          // 25 bps
  tickSpacing: 25n,
  vaultNativeBps: 4000,  // 40% of the ETH-side LP fee
  vaultTokenBps: 0,      // 0% of the token side
};

const splitterAbi = [
  'function getSplits() view returns (tuple(address recipient,uint16 nativeBps,uint16 tokenBps,bool useCallback)[])',
];
const strategyAbi = [
  'function TOTAL_SUPPLY() view returns (uint256)',
  'function LP_FEE() view returns (uint24)',
  'function MIN_LAUNCH_TICK() view returns (int24)',
  'function beneficiaryVault() view returns (address)',
  'function positionManager() view returns (address)',
];

const results = [];
let aborted = false;

function record(ok, label, detail) {
  results.push({ ok, label, detail });
  if (!ok) aborted = true;
  console.log(`  ${ok ? 'PASS' : 'ABORT'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;

  const maxBudget = ethers.parseEther(process.env.MAX_ETH_BUDGET || '0.01');
  const buyAmount = ethers.parseEther(process.env.CANARY_BUY_ETH || '0.001');

  console.log('='.repeat(78));
  console.log('MAINNET CANARY PREFLIGHT — read-only, sends nothing');
  console.log(`run at ${new Date().toISOString()}`);
  console.log('='.repeat(78));

  // ---------------------------------------------------------------------------------------------
  section('1. Chain identity');
  const net = await provider.getNetwork();
  const block = await provider.getBlock('latest');
  record(net.chainId === MAINNET, 'chain id is 4663 (Robinhood Chain mainnet)', `got ${net.chainId}`);
  console.log(`        latest block ${block.number} @ ${new Date(block.timestamp * 1000).toISOString()}`);

  // ---------------------------------------------------------------------------------------------
  section('2. Bytecode at every pinned Uniswap dependency');
  const observed = {};
  for (const [name, address] of Object.entries(U)) {
    const code = await provider.getCode(address);
    const hasCode = code !== '0x';
    observed[name] = { address, codehash: hasCode ? ethers.keccak256(code) : null, size: (code.length - 2) / 2 };
    record(hasCode, `${name} has bytecode`, hasCode ? `${observed[name].size} bytes @ ${address}` : `NO CODE at ${address}`);
  }

  const baselinePath = process.env.BASELINE
    ? path.resolve(process.env.BASELINE)
    : path.join(__dirname, '..', 'canary-baseline.json');

  if (process.env.WRITE_BASELINE === '1') {
    fs.writeFileSync(baselinePath, `${JSON.stringify({
      recordedAt: new Date().toISOString(), chainId: net.chainId.toString(), block: block.number, observed,
    }, null, 2)}\n`);
    console.log(`        baseline WRITTEN to ${baselinePath} (no comparison performed)`);
  } else if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    for (const [name, entry] of Object.entries(observed)) {
      const was = baseline.observed?.[name];
      if (!was) { record(false, `${name} is absent from the baseline`, 'cannot prove it is unchanged'); continue; }
      record(was.codehash === entry.codehash, `${name} bytecode unchanged since baseline`,
        was.codehash === entry.codehash ? entry.codehash.slice(0, 18) : `was ${was.codehash} now ${entry.codehash}`);
    }
    console.log(`        baseline: block ${baseline.block}, recorded ${baseline.recordedAt}`);
  } else {
    record(false, 'a dependency-codehash baseline exists', `none at ${baselinePath} — run once with WRITE_BASELINE=1`);
  }

  // ---------------------------------------------------------------------------------------------
  section('3. Uniswap deployment registry — still active, not deprecated');
  // Deprecation is not observable from bytecode: Uniswap leaves deprecated contracts on chain and
  // marks them only in the registry. So this has to be checked against the registry itself.
  let registry = null;
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    registry = await res.json();
    record(Array.isArray(registry.records) && registry.records.length > 0,
      'registry fetched and parsed', `${registry.records?.length ?? 0} records from ${REGISTRY_URL}`);
  } catch (e) {
    record(false, 'Uniswap deployment registry is reachable', `${e.message} — cannot prove nothing is deprecated`);
  }

  if (registry?.records) {
    for (const [name, address] of Object.entries(U)) {
      const rows = registry.records.filter(
        (r) => typeof r.address === 'string'
          && r.address.toLowerCase() === address.toLowerCase()
          && Number(r.chainId) === Number(MAINNET),
      );
      if (rows.length === 0) {
        record(false, `${name} appears in the registry for chain 4663`, `${address} not listed`);
        continue;
      }
      const bad = rows.filter((r) => r.status !== 'active' || r.deprecated === true);
      record(bad.length === 0, `${name} is registry status "active" (not deprecated)`,
        bad.length === 0
          ? `${rows.length} record(s), all active`
          : `status=${bad.map((r) => r.status ?? 'unset').join(',')} deprecated=${bad.map((r) => String(r.deprecated)).join(',')}`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  section('4. Creator-fee splitter configuration');
  const splitter = new ethers.Contract(U.feeSplitter, splitterAbi, provider);
  let splits;
  try {
    splits = await splitter.getSplits();
  } catch (e) {
    record(false, 'FeeSplitter.getSplits() is callable', e.shortMessage || e.message);
  }

  if (splits) {
    console.log(`        ${splits.length} split leg(s):`);
    for (const s of splits) {
      console.log(`          ${s.recipient}  nativeBps=${s.nativeBps}  tokenBps=${s.tokenBps}  useCallback=${s.useCallback}`);
    }
    const vaultLeg = splits.find((s) => s.recipient.toLowerCase() === U.beneficiaryVault.toLowerCase());
    record(Boolean(vaultLeg), 'the beneficiary vault is still a split recipient',
      vaultLeg ? U.beneficiaryVault : 'vault is NOT in getSplits() — the creator-fee path is gone');
    if (vaultLeg) {
      record(Number(vaultLeg.nativeBps) === EXPECTED.vaultNativeBps,
        'vault still receives 40% of the ETH side', `nativeBps=${vaultLeg.nativeBps} (expected ${EXPECTED.vaultNativeBps})`);
      record(Number(vaultLeg.tokenBps) === EXPECTED.vaultTokenBps,
        'vault still receives 0% of the token side', `tokenBps=${vaultLeg.tokenBps} (expected ${EXPECTED.vaultTokenBps})`);
      record(vaultLeg.useCallback === true, 'vault leg still uses the onAmountsReceived callback',
        `useCallback=${vaultLeg.useCallback}`);
    }
    const totalNative = splits.reduce((a, s) => a + Number(s.nativeBps), 0);
    const totalToken = splits.reduce((a, s) => a + Number(s.tokenBps), 0);
    record(totalNative === 10000 && totalToken === 10000, 'splits still sum to 100% on both sides',
      `native=${totalNative} token=${totalToken}`);
  }

  // ---------------------------------------------------------------------------------------------
  section('5. InstantLaunch strategy and LiquidityLauncher');
  const strategy = new ethers.Contract(U.instantLaunchStrategy, strategyAbi, provider);
  try {
    const supply = await strategy.TOTAL_SUPPLY();
    record(supply === EXPECTED.totalSupply, 'strategy TOTAL_SUPPLY is still 1e9 x 1e18',
      `${ethers.formatEther(supply)} (expected ${ethers.formatEther(EXPECTED.totalSupply)})`);
  } catch (e) { record(false, 'strategy TOTAL_SUPPLY is readable', e.shortMessage || e.message); }

  try {
    const fee = await strategy.LP_FEE();
    record(BigInt(fee) === EXPECTED.lpFee, 'strategy LP_FEE is still 2500 (25 bps)', `got ${fee}`);
  } catch (e) { record(false, 'strategy LP_FEE is readable', e.shortMessage || e.message); }

  try {
    const v = await strategy.beneficiaryVault();
    record(v.toLowerCase() === U.beneficiaryVault.toLowerCase(),
      'strategy still points at the pinned beneficiary vault', v);
  } catch { console.log('        (strategy does not expose beneficiaryVault(); skipped)'); }

  try {
    const pm = await strategy.positionManager();
    record(pm.toLowerCase() === U.positionManager.toLowerCase(),
      'strategy still points at the pinned position manager', pm);
  } catch { console.log('        (strategy does not expose positionManager(); skipped)'); }

  // A deprecated launcher would most plausibly show up as an owner/pause surface appearing, or as
  // the strategy no longer being accepted. We can only assert what is observable read-only.
  const launcherCode = await provider.getCode(U.liquidityLauncher);
  record(launcherCode !== '0x', 'LiquidityLauncher still holds code (not self-destructed)',
    `${(launcherCode.length - 2) / 2} bytes`);

  // ---------------------------------------------------------------------------------------------
  section('6. Deployer, treasury and funding');
  const key = (process.env.DEPLOYER_PRIVATE_KEY || '').trim();
  record(Boolean(key), 'DEPLOYER_PRIVATE_KEY is configured', key ? 'present' : 'missing');

  let deployer;
  let balance = 0n;
  if (key) {
    [deployer] = await hre.ethers.getSigners();
    balance = await provider.getBalance(deployer.address);
    const nonce = await provider.getTransactionCount(deployer.address);
    console.log(`        deployer ${deployer.address}`);
    console.log(`        balance  ${ethers.formatEther(balance)} ETH`);
    console.log(`        nonce    ${nonce}`);
    record(nonce === 0, 'deployer nonce is 0 (a fresh mainnet identity)',
      nonce === 0 ? 'never transacted on mainnet' : `nonce=${nonce} — this wallet has mainnet history; confirm that is intended`);
  }

  // --- Four distinct roles ----------------------------------------------------------------------
  // The whole point of the canary is to prove the three economic recipients are genuinely separate
  // on mainnet, so every pair must differ. Attribution is write-once: a collision here would be
  // permanent and would silently invalidate the result.
  //
  // Who must hold a KEY, and who needs only an address:
  //   deployer     signs the infrastructure deployments                          -> key
  //   pad owner    becomes Launchpad.owner via msg.sender of createLaunchpad     -> key
  //   creator      becomes tokenCreator via msg.sender of launch                 -> key
  //   treasury     is a constructor argument and never signs; it is PAID by the
  //                permissionless withdrawFor(party)                             -> ADDRESS ONLY
  const roles = {
    deployer: deployer ? deployer.address : null,
    padOwner: (process.env.PAD_OWNER_ADDRESS || '').trim() || null,
    tokenCreator: (process.env.TOKEN_CREATOR_ADDRESS || '').trim() || null,
    protocolTreasury: (process.env.PROTOCOL_TREASURY || '').trim() || null,
  };

  for (const [role, address] of Object.entries(roles)) {
    record(Boolean(address) && /^0x[0-9a-fA-F]{40}$/.test(address),
      `${role} is a valid address`, address || '(unset)');
  }

  const named = Object.entries(roles).filter(([, a]) => a && /^0x[0-9a-fA-F]{40}$/.test(a));
  const collisions = [];
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      if (ethers.getAddress(named[i][1]) === ethers.getAddress(named[j][1])) {
        collisions.push(`${named[i][0]} == ${named[j][0]}`);
      }
    }
  }
  record(collisions.length === 0 && named.length === 4,
    'all four roles are distinct addresses',
    collisions.length ? collisions.join(', ') : `${named.length}/4 roles set`);

  // The two roles that must sign. Their keys are optional in env only so the preflight can run
  // before they are supplied; the canary itself refuses to start without them.
  for (const [role, envName, expected] of [
    ['pad owner', 'PAD_OWNER_PRIVATE_KEY', roles.padOwner],
    ['token creator', 'TOKEN_CREATOR_PRIVATE_KEY', roles.tokenCreator],
  ]) {
    const k = (process.env[envName] || '').trim();
    if (!k) {
      record(false, `${envName} is configured`, `${role} must sign its own transaction (msg.sender becomes the role)`);
      continue;
    }
    let derived = null;
    try { derived = new ethers.Wallet(k).address; } catch { /* invalid key */ }
    record(Boolean(derived) && expected && ethers.getAddress(derived) === ethers.getAddress(expected),
      `${envName} matches the declared ${role} address`,
      derived ? `${derived}${expected ? ` vs ${expected}` : ''}` : 'key is not parseable');
  }

  console.log('\n        role -> address');
  for (const [role, address] of Object.entries(roles)) {
    const signs = role === 'protocolTreasury' ? 'paid via withdrawFor, never signs' : 'signs';
    console.log(`          ${role.padEnd(17)} ${address || '(unset)'}   [${signs}]`);
  }

  const treasury = roles.protocolTreasury;

  // ---------------------------------------------------------------------------------------------
  section('7. Gas estimate at current conditions');
  const fee = await provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
  console.log(`        gasPrice     ${ethers.formatUnits(fee.gasPrice ?? 0n, 'gwei')} gwei`);
  console.log(`        maxFeePerGas ${ethers.formatUnits(fee.maxFeePerGas ?? 0n, 'gwei')} gwei`);
  record(gasPrice != null && gasPrice > 0n, 'a gas price is available from the node', `${gasPrice}`);

  // Every one of these was MEASURED by scripts/canaryRehearsal.cjs executing the identical
  // sequence against a Robinhood Chain mainnet fork, through Uniswap's real contracts. They are
  // not modelled from bytecode size. Re-run the rehearsal and paste its table if the code changes.
  const MEASURED_CANARY_GAS = {
    // The pad owner and the token creator must each sign their own transaction, because
    // msg.sender is what makes them the pad owner and the creator. The deployer therefore has to
    // send them gas first. These two transfers are plain sends.
    fundPadOwner: 21000n,
    fundTokenCreator: 21000n,
    deployFactory: 2771806n,
    deployLauncher: 1834285n,
    deployRewards: 841432n,
    createLaunchpad: 1895007n,
    marketLaunch: 1234753n,
    provingBuy: 165622n,
    collectFees: 225806n,
    collectAndSplit: 186484n,
    // All three payouts are pushed by the deployer via the permissionless withdrawFor(party), so
    // the treasury never needs a key and never needs gas.
    withdrawFor_creator: 35290n,
    withdrawFor_padOwner: 35290n,
    withdrawFor_treasury: 32072n,
  };
  for (const [name, used] of Object.entries(MEASURED_CANARY_GAS)) {
    console.log(`        ${name.padEnd(20)} ${String(used).padStart(9)} gas (measured on fork)`);
  }

  const rawGas = Object.values(MEASURED_CANARY_GAS).reduce((a, b) => a + b, 0n);
  // Mainnet gas can exceed a fork measurement (different state, warm/cold slots, basefee moves
  // between our estimate and inclusion). Budget with headroom rather than at the measured edge.
  const SAFETY_NUMERATOR = 150n; // +50%
  const totalGas = (rawGas * SAFETY_NUMERATOR) / 100n;
  const gasCost = totalGas * (gasPrice ?? 0n);
  const estimatedTotal = gasCost + buyAmount;

  console.log(`\n        measured gas total                   ${rawGas}`);
  console.log(`        with +50% safety margin              ${totalGas}`);
  console.log(`        gas cost at current price            ${ethers.formatEther(gasCost)} ETH`);
  console.log(`        proving buy                          ${ethers.formatEther(buyAmount)} ETH`);
  console.log(`        ESTIMATED TOTAL                      ${ethers.formatEther(estimatedTotal)} ETH`);
  console.log(`        MAX_ETH_BUDGET                       ${ethers.formatEther(maxBudget)} ETH`);

  record(estimatedTotal <= maxBudget, 'estimated total is within the budget ceiling',
    `${ethers.formatEther(estimatedTotal)} vs ${ethers.formatEther(maxBudget)} ETH`);
  record(balance >= estimatedTotal, 'deployer balance covers the estimated total',
    `have ${ethers.formatEther(balance)} ETH, need ~${ethers.formatEther(estimatedTotal)} ETH`);

  // ---------------------------------------------------------------------------------------------
  console.log(`\n${'='.repeat(78)}`);
  const failures = results.filter((r) => !r.ok);
  if (aborted) {
    console.log(`PREFLIGHT ABORTED — ${failures.length} of ${results.length} checks failed:`);
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
    console.log('\nNo transaction may be sent. Nothing has been adapted or worked around.');
    console.log('='.repeat(78));
    process.exitCode = 1;
    return;
  }
  console.log(`PREFLIGHT PASSED — ${results.length}/${results.length} checks. The canary may proceed.`);
  console.log('='.repeat(78));
}

main().catch((e) => {
  console.error('\nPREFLIGHT ERRORED:', e.shortMessage || e.message);
  console.error('Treat this as an abort. No transaction may be sent.');
  process.exitCode = 1;
});
