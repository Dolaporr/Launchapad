/**
 * MAINNET CANARY — executes the approved sequence EXACTLY ONCE on Robinhood Chain mainnet (4663).
 *
 * This spends real ETH. It is gated behind two explicit env flags and it re-verifies every
 * dependency immediately before the first transaction, aborting rather than adapting.
 *
 *   ALLOW_MAINNET=1 CANARY_CONFIRM=EXECUTE \
 *     npx hardhat run scripts/canaryExecute.cjs --network robinhood
 *
 * Guards, all hard aborts:
 *   - chain id must be 4663
 *   - every pinned dependency codehash must match canary-baseline.json
 *   - every pinned address must still be registry status "active"
 *   - the FeeSplitter must still report 40% ETH / 0% token to the beneficiary vault
 *   - the strategy must still report 1e9x1e18 supply and LP_FEE 2500
 *   - before each phase, the remaining cost estimate must still be covered by the live balance
 *   - there must be NO existing launch (this script refuses to create a second token)
 *
 * It never tops up funding. If the balance is short it stops and says so.
 *
 * Writes a full machine-readable record to canary-report.json.
 */
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
require('dotenv').config();
const {
  U, buyThroughUniversalRouter, collectPoolFees, vaultAbi, splitterAbi,
} = require('./lib/uniswapCanary.cjs');

const MAINNET = 4663n;
const REGISTRY_URL = 'https://developers.uniswap.org/deployments.json';
const CANARY_NAME = 'Launchpad Family Canary';
const CANARY_SYMBOL = 'CANARY';
const BURN = '0x000000000000000000000000000000000000dEaD';
const EXPLORER = 'https://robinhoodchain.blockscout.com';

// Measured by scripts/canaryRehearsal.cjs against a mainnet fork.
const GAS = {
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
  // withdrawFor costs marginally more than withdraw (it takes the party as an argument); these are
  // the figures the fork dress rehearsal of THIS script measured, not the rehearsal script's.
  withdrawFor_creator: 38296n,
  withdrawFor_padOwner: 38296n,
  withdrawFor_treasury: 34477n,
};
const PHASE_ORDER = Object.keys(GAS);

const report = { startedAt: new Date().toISOString(), transactions: [], checks: [], notes: [] };
let ledgerTotalGas = 0n;
let ledgerTotalWei = 0n;

function ok(label, condition, detail = '') {
  const passed = Boolean(condition);
  report.checks.push({ label, passed, detail });
  console.log(`  ${passed ? 'PASS ' : 'FAIL '} ${label}${detail ? `  — ${detail}` : ''}`);
  return passed;
}
function abort(why) {
  report.abortedAt = new Date().toISOString();
  report.abortReason = why;
  writeReport();
  throw new Error(`ABORT: ${why}`);
}
function section(t) { console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`); }

function writeReport() {
  report.totals = {
    gasUsed: ledgerTotalGas.toString(),
    ethSpentOnGas: hre.ethers.formatEther(ledgerTotalWei),
  };
  fs.writeFileSync(
    path.join(__dirname, '..', 'canary-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

/** Records a sent transaction in the ledger. */
async function record(name, receipt, valueWei = 0n) {
  const { ethers } = hre;
  const gasCost = receipt.gasUsed * receipt.gasPrice;
  ledgerTotalGas += receipt.gasUsed;
  ledgerTotalWei += gasCost;
  const entry = {
    step: name,
    hash: receipt.hash,
    block: receipt.blockNumber,
    from: receipt.from,
    to: receipt.to,
    gasUsed: receipt.gasUsed.toString(),
    gasPrice: receipt.gasPrice.toString(),
    gasCostEth: ethers.formatEther(gasCost),
    valueEth: ethers.formatEther(valueWei),
    explorer: `${EXPLORER}/tx/${receipt.hash}`,
  };
  report.transactions.push(entry);
  console.log(`     tx ${receipt.hash}`);
  console.log(`        gas ${receipt.gasUsed} @ ${ethers.formatUnits(receipt.gasPrice, 'gwei')} gwei `
    + `= ${ethers.formatEther(gasCost)} ETH${valueWei ? `, value ${ethers.formatEther(valueWei)} ETH` : ''}`);
  writeReport();
  return entry;
}

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;

  // DRESS REHEARSAL: runs this identical script against a fork to prove the sequence before real
  // ETH is spent. It relaxes exactly one gate — the chain-id assertion, which a fork cannot satisfy
  // because Hardhat reports its own id — and it REFUSES to run if the chain really is mainnet, so
  // it can never be used to weaken a live run.
  const dressRehearsal = process.env.CANARY_FORK_DRESS_REHEARSAL === '1';
  if (dressRehearsal) {
    const id = (await provider.getNetwork()).chainId;
    if (id === MAINNET) abort('dress-rehearsal mode refuses to run against real mainnet.');
    // A forked node cannot execute against its own fork block until one local block exists.
    await hre.network.provider.send('evm_mine');
    console.log(`\n*** FORK DRESS REHEARSAL on chain ${id} — no real ETH is at risk ***`);
  } else {
    if (process.env.ALLOW_MAINNET !== '1') abort('ALLOW_MAINNET=1 is required.');
    if (process.env.CANARY_CONFIRM !== 'EXECUTE') abort('CANARY_CONFIRM=EXECUTE is required.');
  }

  const maxBudget = ethers.parseEther(process.env.MAX_ETH_BUDGET || '0.01');
  const buyAmount = ethers.parseEther(process.env.CANARY_BUY_ETH || '0.001');

  // RESUME: an interrupted run must never redeploy, or it would create a second stack and a second
  // pad. Supplying the addresses from the interrupted run attaches to them instead. This is the
  // SAME canary continuing; the launch guard still refuses to create a second token.
  const resume = {
    factory: (process.env.RESUME_FACTORY || '').trim(),
    launcher: (process.env.RESUME_LAUNCHER || '').trim(),
    rewards: (process.env.RESUME_REWARDS || '').trim(),
    pad: (process.env.RESUME_PAD || '').trim(),
  };
  const isResume = Boolean(resume.factory && resume.launcher && resume.rewards && resume.pad);
  // Phases already paid for by the interrupted run must not be counted again when checking whether
  // the remaining work is affordable, or the guard aborts on money that has already been spent.
  const alreadyDone = isResume
    ? new Set(['fundPadOwner', 'fundTokenCreator', 'deployFactory', 'deployLauncher', 'deployRewards', 'createLaunchpad'])
    : new Set();
  if (isResume) report.notes.push('Resumed from an interrupted run; the stack and pad were attached, not redeployed.');

  // =============================================================================================
  section('PHASE 0 — re-verify everything, BEFORE the first transaction');

  const net = await provider.getNetwork();
  if (dressRehearsal) {
    // A fork reports Hardhat's own id, so mainnet identity is proven from forked STATE instead:
    // the codehash and configuration checks immediately below can only pass against real 4663 state.
    ok('running against forked mainnet state (chain-id gate deferred to state checks)', true, `${net.chainId}`);
  } else if (!ok('chain id is 4663', net.chainId === MAINNET, `${net.chainId}`)) {
    abort('wrong chain');
  }

  // Codehashes against the recorded baseline.
  const baselinePath = path.join(__dirname, '..', 'canary-baseline.json');
  if (!fs.existsSync(baselinePath)) abort('canary-baseline.json is missing; cannot prove nothing moved.');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  for (const [name, address] of Object.entries(U)) {
    const code = await provider.getCode(address);
    if (code === '0x') abort(`${name} has no code at ${address}`);
    const hash = ethers.keccak256(code);
    const was = baseline.observed?.[name]?.codehash;
    if (!was) abort(`${name} is absent from the baseline`);
    if (!ok(`${name} codehash unchanged`, was === hash, hash.slice(0, 18))) {
      abort(`${name} bytecode CHANGED since baseline (was ${was}, now ${hash})`);
    }
  }

  // Registry status.
  let registry;
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    registry = await res.json();
  } catch (e) { abort(`could not fetch the Uniswap registry: ${e.message}`); }
  for (const [name, address] of Object.entries(U)) {
    const rows = registry.records.filter((r) => typeof r.address === 'string'
      && r.address.toLowerCase() === address.toLowerCase() && Number(r.chainId) === Number(MAINNET));
    if (rows.length === 0) abort(`${name} is no longer listed in the registry for 4663`);
    const bad = rows.filter((r) => r.status !== 'active' || r.deprecated === true);
    if (!ok(`${name} still registry "active"`, bad.length === 0)) abort(`${name} is deprecated or inactive`);
  }

  // Splitter configuration.
  const splitter = new ethers.Contract(U.feeSplitter, splitterAbi, provider);
  const splits = await splitter.getSplits();
  const vaultLeg = splits.find((s) => s.recipient.toLowerCase() === U.beneficiaryVault.toLowerCase());
  if (!ok('vault is still a split recipient', Boolean(vaultLeg))) abort('creator-fee path is gone');
  if (!ok('vault still 40% of the ETH side', Number(vaultLeg.nativeBps) === 4000, `${vaultLeg.nativeBps}`)) {
    abort('ETH-side split changed');
  }
  if (!ok('vault still 0% of the token side', Number(vaultLeg.tokenBps) === 0, `${vaultLeg.tokenBps}`)) {
    abort('token-side split changed');
  }

  // Strategy constants.
  const strategy = new ethers.Contract(U.instantLaunchStrategy, [
    'function TOTAL_SUPPLY() view returns (uint256)', 'function LP_FEE() view returns (uint24)',
  ], provider);
  const stratSupply = await strategy.TOTAL_SUPPLY();
  const stratFee = await strategy.LP_FEE();
  if (!ok('strategy TOTAL_SUPPLY still 1e9x1e18', stratSupply === 1000000000n * 10n ** 18n)) {
    abort('strategy supply requirement changed');
  }
  if (!ok('strategy LP_FEE still 2500', BigInt(stratFee) === 2500n)) abort('strategy LP fee changed');

  // Roles.
  const [deployer] = await ethers.getSigners();
  const padOwnerKey = (process.env.PAD_OWNER_PRIVATE_KEY || '').trim();
  const creatorKey = (process.env.TOKEN_CREATOR_PRIVATE_KEY || '').trim();
  if (!padOwnerKey || !creatorKey) abort('pad owner and token creator keys are required.');
  const padOwner = new ethers.Wallet(padOwnerKey, provider);
  const creator = new ethers.Wallet(creatorKey, provider);
  const treasury = ethers.getAddress((process.env.PROTOCOL_TREASURY || '').trim());

  const roles = { deployer: deployer.address, padOwner: padOwner.address, tokenCreator: creator.address, protocolTreasury: treasury };
  report.roles = roles;
  const uniq = new Set(Object.values(roles).map((a) => a.toLowerCase()));
  if (!ok('all four roles are distinct', uniq.size === 4, `${uniq.size}/4`)) abort('role collision');
  console.log('\n        role -> address');
  for (const [r, a] of Object.entries(roles)) console.log(`          ${r.padEnd(17)} ${a}`);

  // Budget.
  // Fee strategy. Relying on ethers' default fee data raced the base fee on a live L2 and a
  // transaction was rejected with "max fee per gas less than block base fee". So every transaction
  // now carries an explicit cap computed fresh from the CURRENT base fee, well above it. The cap is
  // only a ceiling — actual cost is base fee plus the tip — so a generous cap costs nothing.
  const TIP = 10000000n; // 0.01 gwei
  async function baseFee() {
    const b = await provider.getBlock('latest');
    return b.baseFeePerGas ?? 0n;
  }
  /** Per-transaction overrides: a cap 4x the live base fee absorbs mid-sequence spikes. */
  async function fees() {
    const base = await baseFee();
    return { maxFeePerGas: base * 4n + TIP, maxPriorityFeePerGas: TIP };
  }
  /** The price used for BUDGETING — what we expect to pay, not the cap. */
  async function expectedPrice() {
    return (await baseFee()) * 2n + TIP;
  }

  const gasPrice = await expectedPrice();
  const balance = await provider.getBalance(deployer.address);
  const allGas = PHASE_ORDER.filter((k) => !alreadyDone.has(k)).reduce((a, k) => a + GAS[k], 0n);
  const estimate = ((allGas * 150n) / 100n) * gasPrice + buyAmount;
  report.preflight = {
    block: await provider.getBlockNumber(),
    gasPriceWei: gasPrice.toString(),
    deployerBalanceEth: ethers.formatEther(balance),
    estimatedTotalEth: ethers.formatEther(estimate),
    maxBudgetEth: ethers.formatEther(maxBudget),
  };
  console.log(`\n        balance   ${ethers.formatEther(balance)} ETH`);
  console.log(`        estimate  ${ethers.formatEther(estimate)} ETH`);
  console.log(`        ceiling   ${ethers.formatEther(maxBudget)} ETH`);
  if (!ok('estimate is within MAX_ETH_BUDGET', estimate <= maxBudget)) abort('over budget ceiling');
  if (!ok('balance covers the estimate', balance >= estimate)) abort('insufficient balance; no top-up will be attempted');

  /** Before each phase: is the REMAINING work still affordable from the live balance? */
  async function guard(fromPhase) {
    const idx = PHASE_ORDER.indexOf(fromPhase);
    const remainingGas = PHASE_ORDER.slice(idx)
      .filter((k) => !alreadyDone.has(k))
      .reduce((a, k) => a + GAS[k], 0n);
    const price = await expectedPrice();
    const stillNeeded = ((remainingGas * 150n) / 100n) * price
      + (PHASE_ORDER.indexOf('provingBuy') >= idx ? buyAmount : 0n);
    const have = await provider.getBalance(deployer.address);
    if (have < stillNeeded) {
      abort(`remaining cost ${ethers.formatEther(stillNeeded)} ETH exceeds remaining balance `
        + `${ethers.formatEther(have)} ETH at ${fromPhase}. No automatic top-up.`);
    }
  }

  // =============================================================================================
  section('PHASE 1 — fund the two wallets that must sign for themselves');
  await guard('fundPadOwner');
  // The pad owner becomes Launchpad.owner via msg.sender, and the creator becomes tokenCreator via
  // msg.sender, so neither can be acted for. Fund each with 2x its measured cost.
  for (const [name, to, needGas] of [
    ['fundPadOwner', padOwner.address, GAS.createLaunchpad],
    ['fundTokenCreator', creator.address, GAS.marketLaunch],
  ]) {
    // Fund against the CAP, not the expected price. A node computes a sender's gas allowance as
    // balance / maxFeePerGas, so funding at the expected price leaves the wallet unable to afford
    // its own transaction once the 4x cap is applied — which is exactly how the first live attempt
    // failed. 2x the needed gas at the cap gives real headroom.
    const capNow = (await fees()).maxFeePerGas;
    const value = needGas * capNow * 2n;
    // Idempotent: a wallet already carrying enough is left alone, so an interrupted run can be
    // resumed without paying twice. This is the same canary continuing, not a second one.
    const have = await provider.getBalance(to);
    if (have >= value) {
      console.log(`  ${name} -> ${to} SKIPPED, already holds ${ethers.formatEther(have)} ETH`);
      report.notes.push(`${name} skipped: wallet already funded with ${ethers.formatEther(have)} ETH`);
      continue;
    }
    const send = value - have;
    console.log(`  ${name} -> ${to} with ${ethers.formatEther(send)} ETH`);
    await record(name, await (await deployer.sendTransaction({ to, value: send, ...(await fees()) })).wait(), send);
  }

  // =============================================================================================
  section('PHASE 2 — deploy the minimum stack');
  if (isResume) {
    console.log('  RESUMING — attaching to the existing stack, not deploying:');
    for (const [k, v] of Object.entries(resume)) console.log(`    ${k.padEnd(9)} ${v}`);
  }
  await guard('deployFactory');
  // reserveReceiver is deliberately address(0): no NVDA, no reserve leg in this canary.
  const factory = isResume
    ? await ethers.getContractAt('LaunchpadFactory', resume.factory)
    : await (await ethers.getContractFactory('LaunchpadFactory'))
      .deploy(treasury, ethers.ZeroAddress, await fees());
  if (!isResume) await record('deployFactory', await (await factory.deploymentTransaction()).wait());
  const factoryAddress = await factory.getAddress();
  console.log(`     LaunchpadFactory ${factoryAddress}`);

  // The rewards address must be predicted, because the launcher takes it as a constructor
  // argument while LaunchpadRewards refuses a registrar with no code. Nothing else may be sent
  // from the deployer between these two deployments or the prediction breaks.
  await guard('deployLauncher');
  let predictedRewards = resume.rewards;
  let launcher;
  if (isResume) {
    launcher = await ethers.getContractAt('LaunchpadFamilyLauncher', resume.launcher);
  } else {
    const nonce = await provider.getTransactionCount(deployer.address);
    predictedRewards = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
      factoryAddress, U.liquidityLauncher, U.instantLaunchStrategy,
      U.beneficiaryVault, U.positionManager, predictedRewards, await fees(),
    );
    await record('deployLauncher', await (await launcher.deploymentTransaction()).wait());
  }
  const launcherAddress = await launcher.getAddress();
  console.log(`     LaunchpadFamilyLauncher ${launcherAddress}`);

  const rewards = isResume
    ? await ethers.getContractAt('LaunchpadRewards', resume.rewards)
    : await (await ethers.getContractFactory('LaunchpadRewards'))
      .deploy(U.beneficiaryVault, launcherAddress, treasury, await fees());
  if (!isResume) await record('deployRewards', await (await rewards.deploymentTransaction()).wait());
  const rewardsAddress = await rewards.getAddress();
  console.log(`     LaunchpadRewards ${rewardsAddress}`);
  if (!ok('rewards landed at the predicted address', rewardsAddress === predictedRewards, predictedRewards)) {
    abort('nonce prediction failed; the launcher points at the wrong registrar');
  }
  if (!ok('protocol treasury on rewards is the approved address',
    (await rewards.protocolTreasury()).toLowerCase() === treasury.toLowerCase())) abort('treasury mismatch');

  report.contracts = {
    LaunchpadFactory: factoryAddress,
    LaunchpadFamilyLauncher: launcherAddress,
    LaunchpadRewards: rewardsAddress,
    explorer: {
      LaunchpadFactory: `${EXPLORER}/address/${factoryAddress}`,
      LaunchpadFamilyLauncher: `${EXPLORER}/address/${launcherAddress}`,
      LaunchpadRewards: `${EXPLORER}/address/${rewardsAddress}`,
    },
  };
  writeReport();

  // =============================================================================================
  section('PHASE 3 — one OPEN launchpad, created by the pad owner');
  await guard('createLaunchpad');
  if (!isResume) {
    await record('createLaunchpad', await (await factory.connect(padOwner)
      .createLaunchpad('Launchpad Family Canary Pad', '', 0, 1, await fees())).wait());
  } else {
    console.log('  attached to the existing launchpad');
  }
  const padAddress = await factory.launchpads(0);
  const pad = await ethers.getContractAt('Launchpad', padAddress);
  console.log(`     launchpad ${padAddress}`);
  if (!ok('pad owner is the pad-owner wallet', (await pad.owner()).toLowerCase() === padOwner.address.toLowerCase())) {
    abort('pad ownership is wrong');
  }
  ok('policy is OPEN', Number(await pad.launchPolicy()) === 1);
  report.launchpad = { address: padAddress, owner: await pad.owner(), explorer: `${EXPLORER}/address/${padAddress}` };

  // =============================================================================================
  section('PHASE 4 — ONE market launch by the token creator');
  if (!ok('no token has been launched yet (refusing a second)', (await launcher.tokenCount()) === 0n)) {
    abort('a launch already exists; this script creates exactly one token');
  }
  await guard('marketLaunch');
  await record('marketLaunch', await (await launcher.connect(creator)
    .launch(padAddress, CANARY_NAME, CANARY_SYMBOL, await fees())).wait());
  const token = await launcher.allTokens(0);
  const launchRecord = await launcher.launchOf(token);
  const positionTokenId = launchRecord.positionTokenId;
  const erc20 = await ethers.getContractAt('LaunchToken', token);
  console.log(`     $${CANARY_SYMBOL} ${token}`);
  console.log(`     position id ${positionTokenId}`);
  report.token = {
    address: token, name: CANARY_NAME, symbol: CANARY_SYMBOL,
    positionTokenId: positionTokenId.toString(),
    explorer: `${EXPLORER}/address/${token}`,
  };
  writeReport();

  // =============================================================================================
  section('PHASE 5 — verification (checks 1-5)');
  const stateView = new ethers.Contract('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    ['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'],
    provider);
  const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [ethers.ZeroAddress, token, 2500, 25, ethers.ZeroAddress],
  ));
  const slot0 = await stateView.getSlot0(poolId);
  ok('the Uniswap v4 pool exists and is initialised', slot0.sqrtPriceX96 > 0n,
    `tick=${slot0.tick} lpFee=${slot0.lpFee}`);
  ok('the pool charges 25 bps', Number(slot0.lpFee) === 2500);

  const supply = await erc20.totalSupply();
  const heldBy = {};
  for (const [k, a] of Object.entries({
    creator: creator.address, padOwner: padOwner.address, deployer: deployer.address,
    treasury, launcher: launcherAddress, rewards: rewardsAddress,
    liquidityLauncher: U.liquidityLauncher, strategy: U.instantLaunchStrategy,
  })) heldBy[k] = await erc20.balanceOf(a);
  const inPool = await erc20.balanceOf(U.poolManager);
  const burned = await erc20.balanceOf(BURN);
  const heldSum = Object.values(heldBy).reduce((a, b) => a + b, 0n);
  ok('not one unit is held by any party', heldSum === 0n, `sum=${heldSum}`);
  ok('every unit is locked liquidity or burned', inPool + burned === supply,
    `pool ${inPool} + burned ${burned} = ${inPool + burned} of ${supply}`);
  console.log(`     locked ${ethers.formatEther(inPool)} ${CANARY_SYMBOL}, burned ${burned} base units`);

  const vault = new ethers.Contract(U.beneficiaryVault, vaultAbi, provider);
  const nftOwner = await vault.ownerOf(positionTokenId);
  ok('beneficiary NFT belongs to LaunchpadRewards', nftOwner.toLowerCase() === rewardsAddress.toLowerCase(), nftOwner);
  ok('verifyMarketLaunch(token) == true', (await launcher.verifyMarketLaunch(token)) === true);

  const [verified, tCreator, lOwner, lPad] = await launcher.verifiedLaunchOf(token);
  ok('attribution: creator', verified && tCreator.toLowerCase() === creator.address.toLowerCase(), tCreator);
  ok('attribution: pad owner', lOwner.toLowerCase() === padOwner.address.toLowerCase(), lOwner);
  ok('attribution: launchpad', lPad.toLowerCase() === padAddress.toLowerCase(), lPad);
  report.supply = {
    totalSupply: supply.toString(), lockedInPool: inPool.toString(), burned: burned.toString(),
    heldByAnyParty: heldSum.toString(),
  };
  report.attribution = { tokenCreator: tCreator, launchpadOwner: lOwner, launchpad: lPad, verified };
  writeReport();

  // =============================================================================================
  section(`PHASE 6 — the minimum proving BUY (${ethers.formatEther(buyAmount)} ETH)`);
  await guard('provingBuy');
  // The deployer is the buyer. The buyer is not an attributed role, and keeping the buy off the
  // pad owner and creator wallets means their final balances show ONLY their fee earnings.
  const tokensBefore = await erc20.balanceOf(deployer.address);
  const buyReceipt = await buyThroughUniversalRouter({ signer: deployer, token, amountIn: buyAmount, overrides: await fees() });
  await record('provingBuy', buyReceipt, buyAmount);
  const received = (await erc20.balanceOf(deployer.address)) - tokensBefore;
  ok('the buy received tokens from the pool', received > 0n, `${ethers.formatEther(received)} ${CANARY_SYMBOL}`);
  report.provingBuy = {
    amountInEth: ethers.formatEther(buyAmount), amountInWei: buyAmount.toString(),
    tokensReceived: received.toString(), tokensReceivedFormatted: ethers.formatEther(received),
    buyer: deployer.address,
  };

  // =============================================================================================
  section('PHASE 7 — collect the LP fees the trade generated');
  await guard('collectFees');
  const collected = await collectPoolFees({ signer: deployer, positionTokenId, overrides: await fees() });
  await record('collectFees', collected.receipt);
  const nominalLpFee = (buyAmount * 25n) / 10000n;
  console.log(`     LP fee realised ${collected.nativeFee} wei (nominal ${nominalLpFee})`);
  ok('LP fee is within 1 wei of nominal 25 bps',
    collected.nativeFee - nominalLpFee >= -1n && collected.nativeFee - nominalLpFee <= 1n,
    `delta ${collected.nativeFee - nominalLpFee}`);
  ok('the token side was not charged on a buy', collected.tokenFee === 0n, `${collected.tokenFee}`);

  const [vaultNative] = await vault.amounts(positionTokenId);
  const expectStream = (collected.nativeFee * 4000n) / 10000n;
  ok('40% of the realised fee is attributed to our position',
    vaultNative - expectStream >= -1n && vaultNative - expectStream <= 1n,
    `${vaultNative} wei vs ${expectStream}`);
  report.fees = {
    lpFeeNativeWei: collected.nativeFee.toString(),
    lpFeeTokenWei: collected.tokenFee.toString(),
    nominalLpFeeWei: nominalLpFee.toString(),
    attributedToVaultWei: vaultNative.toString(),
  };
  writeReport();

  // =============================================================================================
  section('PHASE 8 — split it 50 / 30 / 20');
  await guard('collectAndSplit');
  const rewardsBalBefore = await provider.getBalance(rewardsAddress);
  await record('collectAndSplit', await (await rewards.connect(deployer).collectAndSplit(positionTokenId, await fees())).wait());
  const claimed = (await provider.getBalance(rewardsAddress)) - rewardsBalBefore;
  const credits = {
    creator: await rewards.pending(creator.address),
    padOwner: await rewards.pending(padOwner.address),
    treasury: await rewards.pending(treasury),
  };
  const expectCreator = (claimed * 5000n) / 10000n;
  const expectPad = (claimed * 3000n) / 10000n;
  const nominalProtocol = (claimed * 2000n) / 10000n;
  console.log(`     claimed  ${claimed} wei`);
  console.log(`     creator  ${credits.creator} wei`);
  console.log(`     padOwner ${credits.padOwner} wei`);
  console.log(`     treasury ${credits.treasury} wei`);
  ok('creator credited exactly 50% (floored)', credits.creator === expectCreator, `${credits.creator} vs ${expectCreator}`);
  ok('pad owner credited exactly 30% (floored)', credits.padOwner === expectPad, `${credits.padOwner} vs ${expectPad}`);
  ok('every wei conserved', credits.creator + credits.padOwner + credits.treasury === claimed);
  ok('protocol absorbs <=2 wei of rounding dust',
    credits.treasury - nominalProtocol >= 0n && credits.treasury - nominalProtocol <= 2n,
    `dust +${credits.treasury - nominalProtocol}`);
  report.split = {
    claimedWei: claimed.toString(),
    creatorWei: credits.creator.toString(),
    padOwnerWei: credits.padOwner.toString(),
    treasuryWei: credits.treasury.toString(),
    nominalProtocolWei: nominalProtocol.toString(),
    protocolDustWei: (credits.treasury - nominalProtocol).toString(),
  };
  writeReport();

  // =============================================================================================
  section('PHASE 9 — push all three withdrawals');
  // withdrawFor is permissionless, so the deployer pays the gas and the treasury never needs a key.
  report.withdrawals = {};
  for (const [name, party] of [
    ['creator', creator.address], ['padOwner', padOwner.address], ['treasury', treasury],
  ]) {
    await guard(`withdrawFor_${name}`);
    const owed = await rewards.pending(party);
    const before = await provider.getBalance(party);
    await record(`withdrawFor_${name}`, await (await rewards.connect(deployer).withdrawFor(party, await fees())).wait());
    const delta = (await provider.getBalance(party)) - before;
    ok(`${name} received exactly what was owed`, delta === owed, `${delta} vs ${owed} wei`);
    ok(`${name} has nothing left pending`, (await rewards.pending(party)) === 0n);
    report.withdrawals[name] = { party, owedWei: owed.toString(), receivedWei: delta.toString() };
  }
  ok('nothing unaccounted in rewards', (await rewards.unaccountedBalance()) === 0n);

  // =============================================================================================
  section('FINAL BALANCES');
  report.finalBalances = {};
  for (const [name, a] of Object.entries(roles)) {
    const b = await provider.getBalance(a);
    report.finalBalances[name] = { address: a, eth: ethers.formatEther(b), wei: b.toString() };
    console.log(`  ${name.padEnd(17)} ${ethers.formatEther(b)} ETH   ${a}`);
  }
  const canaryHeld = await erc20.balanceOf(deployer.address);
  report.finalBalances.deployerCanaryTokens = canaryHeld.toString();
  console.log(`  deployer holds ${ethers.formatEther(canaryHeld)} ${CANARY_SYMBOL} from the proving buy`);

  report.completedAt = new Date().toISOString();
  const failed = report.checks.filter((c) => !c.passed);
  report.result = failed.length ? `${failed.length} CHECK(S) FAILED` : 'ALL CHECKS PASSED';
  writeReport();

  console.log(`\n${'='.repeat(78)}`);
  console.log(`total gas ${ledgerTotalGas}, ETH spent on gas ${ethers.formatEther(ledgerTotalWei)}`);
  console.log(report.result);
  console.log('report written to canary-report.json');
  console.log('='.repeat(78));
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  writeReport();
  process.exitCode = 1;
});
