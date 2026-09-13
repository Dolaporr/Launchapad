/**
 * FORK REHEARSAL of the mainnet canary. Runs the complete canary sequence against a Robinhood
 * Chain mainnet fork, through the SAME code path the real run uses (scripts/lib/uniswapCanary.cjs
 * and Uniswap's real UniversalRouter), so nothing about the routing or encoding is discovered for
 * the first time on mainnet.
 *
 *   FORK_RPC=https://rpc.mainnet.chain.robinhood.com npx hardhat run scripts/canaryRehearsal.cjs
 *
 * This spends no real ETH: the fork's accounts are local.
 */
const hre = require('hardhat');
const {
  U, buyThroughUniversalRouter, collectPoolFees, vaultAbi, splitterAbi,
} = require('./lib/uniswapCanary.cjs');

const CANARY_NAME = 'Launchpad Family Canary';
const CANARY_SYMBOL = 'CANARY';
const BUY = process.env.CANARY_BUY_ETH || '0.001';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS ' : 'FAIL '} ${label}${detail ? `  — ${detail}` : ''}`);
}
function step(t) { console.log(`\n=== ${t} ===`); }

/**
 * Gas ledger. Every transaction the canary will send on mainnet is recorded here, so the budget in
 * scripts/canaryPreflight.cjs can be measured rather than modelled.
 */
const gas = {};
async function track(name, promise) {
  const receipt = await (await promise).wait();
  gas[name] = receipt.gasUsed;
  return receipt;
}

async function main() {
  const { ethers, network } = hre;
  if (!process.env.FORK_RPC) throw new Error('FORK_RPC is required — this script must run on a fork.');

  await network.provider.send('evm_mine');
  // A fork reports Hardhat's own chain id, not the forked chain's, so chain identity has to be
  // proven from the forked STATE. The real canary verifies chain id 4663 directly (preflight §1);
  // here, the presence and configuration of Uniswap's mainnet-only deployment is the evidence.
  const splitter = new ethers.Contract(U.feeSplitter, splitterAbi, ethers.provider);
  const splits = await splitter.getSplits();
  check('forked onto Robinhood Chain mainnet state (real FeeSplitter is present)',
    splits.length === 2 && Number(splits[0].nativeBps) === 4000,
    `${splits.length} legs, vault nativeBps=${splits[0].nativeBps}`);

  // Four genuinely distinct parties, exactly as the mainnet canary will have.
  const [deployer, padOwner, creator, treasury, trader] = await ethers.getSigners();
  console.log(`deployer ${deployer.address}`);
  console.log(`padOwner ${padOwner.address}`);
  console.log(`creator  ${creator.address}`);
  console.log(`treasury ${treasury.address}`);

  step('1. Deploy the minimum stack');
  const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
    .deploy(treasury.address, ethers.ZeroAddress);
  gas.deployFactory = (await (await factory.deploymentTransaction()).wait()).gasUsed;

  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predictedRewards = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
  const launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
    await factory.getAddress(), U.liquidityLauncher, U.instantLaunchStrategy,
    U.beneficiaryVault, U.positionManager, predictedRewards,
  );
  gas.deployLauncher = (await (await launcher.deploymentTransaction()).wait()).gasUsed;
  const rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
    .deploy(U.beneficiaryVault, await launcher.getAddress(), treasury.address);
  gas.deployRewards = (await (await rewards.deploymentTransaction()).wait()).gasUsed;

  check('rewards landed at the address the launcher was told to expect',
    (await rewards.getAddress()) === predictedRewards, predictedRewards);
  console.log(`  factory  ${await factory.getAddress()}`);
  console.log(`  launcher ${await launcher.getAddress()}`);
  console.log(`  rewards  ${await rewards.getAddress()}`);

  step('2. One OPEN launchpad, owned by the pad owner');
  await track('createLaunchpad',
    factory.connect(padOwner).createLaunchpad('Launchpad Family Canary Pad', '', 0, 1));
  const padAddress = await factory.launchpads(0);
  const pad = await ethers.getContractAt('Launchpad', padAddress);
  check('pad owner is the pad-owner wallet, not the deployer',
    (await pad.owner()) === padOwner.address, await pad.owner());
  check('policy is OPEN so a different wallet may launch', Number(await pad.launchPolicy()) === 1);
  console.log(`  pad ${padAddress}`);

  step('3. One real market launch by the creator');
  const launchReceipt = await track('marketLaunch',
    launcher.connect(creator).launch(padAddress, CANARY_NAME, CANARY_SYMBOL));
  const token = await launcher.allTokens(0);
  const record = await launcher.launchOf(token);
  const positionTokenId = record.positionTokenId;
  console.log(`  token       ${token}`);
  console.log(`  position id ${positionTokenId}`);
  console.log(`  launch gas  ${launchReceipt.gasUsed}`);

  step('4. Post-launch verification (canary checks 1-5)');
  const erc20 = await ethers.getContractAt('LaunchToken', token);

  // 1. the pool exists
  const stateView = new ethers.Contract(
    '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    ['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'],
    ethers.provider,
  );
  const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [ethers.ZeroAddress, token, 2500, 25, ethers.ZeroAddress],
  ));
  const slot0 = await stateView.getSlot0(poolId);
  check('the v4 pool exists and is initialised', slot0.sqrtPriceX96 > 0n,
    `sqrtPriceX96=${slot0.sqrtPriceX96} tick=${slot0.tick} lpFee=${slot0.lpFee}`);
  check('the pool charges the expected 25 bps', Number(slot0.lpFee) === 2500, `${slot0.lpFee}`);

  // 2. the entire supply is in the locked liquidity path.
  //
  // "In the pool" is very nearly all of it, but not literally all: Uniswap's InstantLaunchStrategy
  // places concentrated liquidity and BURNS the rounding remainder to 0x…dEaD. Traced from the
  // launch tx's Transfer log, the path is
  //   mint -> our launcher -> LiquidityLauncher -> strategy -> PositionManager -> PoolManager,
  // then PoolManager -> strategy -> 0x…dEaD for the remainder. So the correct claim is that every
  // unit is either locked liquidity or burned, and none of it is held by anybody.
  const BURN = '0x000000000000000000000000000000000000dEaD';
  const supply = await erc20.totalSupply();
  const held = {
    creator: await erc20.balanceOf(creator.address),
    padOwner: await erc20.balanceOf(padOwner.address),
    deployer: await erc20.balanceOf(deployer.address),
    treasury: await erc20.balanceOf(treasury.address),
    launcher: await erc20.balanceOf(await launcher.getAddress()),
    rewards: await erc20.balanceOf(await rewards.getAddress()),
    liquidityLauncher: await erc20.balanceOf(U.liquidityLauncher),
    strategy: await erc20.balanceOf(U.instantLaunchStrategy),
    poolManager: await erc20.balanceOf(U.poolManager),
    burned: await erc20.balanceOf(BURN),
  };
  const heldByAnyone = held.creator + held.padOwner + held.deployer + held.treasury
    + held.launcher + held.rewards + held.liquidityLauncher + held.strategy;
  check('not one unit is held by any party — creator, pad owner, deployer, treasury, or us',
    heldByAnyone === 0n, `sum of all holdable balances = ${heldByAnyone}`);
  check('every unit is either locked liquidity or burned',
    held.poolManager + held.burned === supply,
    `pool ${held.poolManager} + burned ${held.burned} = ${held.poolManager + held.burned}`);
  check('the burned remainder is negligible dust (< 1e-12 of supply)',
    held.burned * 1000000000000n < supply,
    `${held.burned} base units (${ethers.formatEther(held.burned)} ${CANARY_SYMBOL}), burned by Uniswap's strategy`);
  console.log(`  locked in pool ${ethers.formatEther(held.poolManager)} ${CANARY_SYMBOL}`);
  console.log(`  burned to dEaD ${held.burned} base units`);

  // 3. the beneficiary NFT belongs to LaunchpadRewards
  const vault = new ethers.Contract(U.beneficiaryVault, vaultAbi, ethers.provider);
  const nftOwner = await vault.ownerOf(positionTokenId);
  check('the beneficiary NFT belongs to LaunchpadRewards',
    nftOwner.toLowerCase() === (await rewards.getAddress()).toLowerCase(), nftOwner);

  // 4. verifyMarketLaunch
  check('verifyMarketLaunch(token) is true', await launcher.verifyMarketLaunch(token) === true);

  // 5. immutable attribution
  const [verified, tokenCreator, launchpadOwner, launchpad] = await launcher.verifiedLaunchOf(token);
  check('attribution names the creator', verified && tokenCreator === creator.address, tokenCreator);
  check('attribution names the pad owner, distinctly', launchpadOwner === padOwner.address, launchpadOwner);
  check('attribution names the pad', launchpad === padAddress, launchpad);
  const attributed = await rewards.attributionOf(positionTokenId);
  check('the protocol treasury is the third, distinct party',
    (await rewards.protocolTreasury()).toLowerCase() === treasury.address.toLowerCase()
    && treasury.address !== creator.address && treasury.address !== padOwner.address,
    await rewards.protocolTreasury());
  check('attribution is recorded against the position id',
    attributed.tokenCreator === creator.address && attributed.launchpadOwner === padOwner.address);

  step(`5. The minimum proving BUY (${BUY} ETH) through Uniswap's real UniversalRouter`);
  const amountIn = ethers.parseEther(BUY);
  const before = await erc20.balanceOf(trader.address);
  const buyReceipt = await buyThroughUniversalRouter({ signer: trader, token, amountIn });
  gas.provingBuy = buyReceipt.gasUsed;
  const after = await erc20.balanceOf(trader.address);
  check('the trader received tokens from the pool', after > before,
    `${ethers.formatEther(after - before)} ${CANARY_SYMBOL}`);
  console.log(`  buy gas ${buyReceipt.gasUsed}`);

  step('6. Collect the fees the trade generated');
  const collected = await collectPoolFees({ signer: deployer, positionTokenId });
  const { nativeFee, tokenFee } = collected;
  gas.collectFees = collected.receipt.gasUsed;
  // The realised LP fee lands within 1 wei of nominal 25 bps, and the direction is not fixed: a
  // 1 ETH buy measured +1 wei, this 0.001 ETH buy measures -1 wei. Assert the band, not a side.
  const expectedLpFee = (amountIn * 25n) / 10000n;
  const feeDelta = nativeFee - expectedLpFee;
  check('the pool charged 25 bps of the ETH input, to within 1 wei',
    feeDelta >= -1n && feeDelta <= 1n,
    `${nativeFee} wei vs nominal ${expectedLpFee} (delta ${feeDelta >= 0n ? '+' : ''}${feeDelta})`);
  check('the token side was not charged on a buy', tokenFee === 0n, `${tokenFee}`);

  // 40% of whatever was ACTUALLY charged, not of the nominal figure.
  const [vaultNative] = await vault.amounts(positionTokenId);
  const expectedStream = (nativeFee * 4000n) / 10000n;
  const streamDelta = vaultNative - expectedStream;
  check('40% of the realised ETH fee is attributed to our position in the vault',
    streamDelta >= -1n && streamDelta <= 1n,
    `${vaultNative} wei vs 40% of realised ${expectedStream} (delta ${streamDelta >= 0n ? '+' : ''}${streamDelta})`);

  step('7. Split it, and verify exact 50 / 30 / 20');
  const rewardsBefore = await ethers.provider.getBalance(await rewards.getAddress());
  await track('collectAndSplit', rewards.connect(deployer).collectAndSplit(positionTokenId));
  const claimed = (await ethers.provider.getBalance(await rewards.getAddress())) - rewardsBefore;
  check('LaunchpadRewards received the real ETH', claimed > 0n, `${claimed} wei`);

  const pending = {
    creator: await rewards.pending(creator.address),
    padOwner: await rewards.pending(padOwner.address),
    treasury: await rewards.pending(treasury.address),
  };
  console.log(`  creator  ${pending.creator} wei`);
  console.log(`  padOwner ${pending.padOwner} wei`);
  console.log(`  treasury ${pending.treasury} wei`);
  // LaunchpadRewards floors the creator and pad-owner legs and gives the protocol the REMAINDER,
  // so conservation is exact while the treasury absorbs up to 2 wei of floor-division dust. On a
  // claimed amount not divisible by 10 the treasury is therefore a hair over 20% — by design, and
  // bounded at 2 wei regardless of size.
  const expectCreator = (claimed * 5000n) / 10000n;
  const expectPadOwner = (claimed * 3000n) / 10000n;
  const nominalProtocol = (claimed * 2000n) / 10000n;
  check('creator is credited exactly 50% (floored)', pending.creator === expectCreator,
    `${pending.creator} vs ${expectCreator}`);
  check('pad owner is credited exactly 30% (floored)', pending.padOwner === expectPadOwner,
    `${pending.padOwner} vs ${expectPadOwner}`);
  check('every wei is conserved — the three legs sum to exactly what was claimed',
    pending.creator + pending.padOwner + pending.treasury === claimed,
    `sums to ${pending.creator + pending.padOwner + pending.treasury} of ${claimed}`);
  check('the protocol absorbs the rounding dust, and it is at most 2 wei',
    pending.treasury - nominalProtocol >= 0n && pending.treasury - nominalProtocol <= 2n,
    `treasury ${pending.treasury}, nominal 20% ${nominalProtocol}, dust +${pending.treasury - nominalProtocol}`);

  step('8. Withdraw all three allocations');
  for (const [name, signer] of [['creator', creator], ['padOwner', padOwner], ['treasury', treasury]]) {
    const owed = await rewards.pending(signer.address);
    const balBefore = await ethers.provider.getBalance(signer.address);
    const r = await track(`withdraw_${name}`, rewards.connect(signer).withdraw());
    const gas = r.gasUsed * r.gasPrice;
    const delta = (await ethers.provider.getBalance(signer.address)) - balBefore + gas;
    check(`${name} withdrew exactly what was owed`, delta === owed, `${delta} vs ${owed} wei`);
    check(`${name} has nothing left pending`, (await rewards.pending(signer.address)) === 0n);
  }
  check('nothing is left unaccounted in the rewards contract',
    await rewards.unaccountedBalance() === 0n, `${await rewards.unaccountedBalance()}`);

  step('9. Measured gas for every transaction the canary will send');
  // Split by who pays: the deployer funds the infrastructure and the keeper calls, while the
  // creator, trader, pad owner and treasury pay their own. The canary uses one funded wallet for
  // all of them, so the budget is the total.
  let total = 0n;
  for (const [name, used] of Object.entries(gas)) {
    total += used;
    console.log(`  ${name.padEnd(20)} ${String(used).padStart(10)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${String(total).padStart(10)}`);
  const fee = await ethers.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  console.log(`\n  Paste into scripts/canaryPreflight.cjs MEASURED_CANARY_GAS:`);
  console.log(`  ${JSON.stringify(Object.fromEntries(
    Object.entries(gas).map(([k, v]) => [k, `${v}n`]),
  ), null, 2).replace(/"/g, '')}`);
  console.log(`\n  at the fork's gas price (${ethers.formatUnits(price, 'gwei')} gwei) that is `
    + `${ethers.formatEther(total * price)} ETH of gas`);

  console.log(`\n${'='.repeat(70)}`);
  console.log(failures ? `REHEARSAL FAILED — ${failures} check(s)` : 'REHEARSAL PASSED — the canary path works end to end');
  console.log('='.repeat(70));
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error('\nREHEARSAL ERRORED:', e.shortMessage || e.message); process.exitCode = 1; });
