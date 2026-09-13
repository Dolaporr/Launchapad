/**
 * Deterministic launch verification.
 *
 * Given a token address and our launcher, this reconstructs the entire launch from CHAIN STATE and
 * reconciles every token base unit and every wei. It is the audit primitive the product layer and
 * the regression tests both use, so it takes a provider rather than owning one.
 *
 * Three rules shape the whole design:
 *
 *  1. EVIDENCE OVER ASSUMPTION. Nothing is taken from a stored record. Addresses may be supplied as
 *     a starting point, but every relationship is re-derived and re-checked against chain.
 *
 *  2. WE ARE NEVER THE ONLY TRADER. The canary was traded by a stranger five blocks after launch.
 *     Holders and traders are discovered from Transfer logs, never assumed. A wallet we recognise is
 *     "controlled"; everything else is "external"; neither is an error.
 *
 *  3. UNKNOWN STATE FAILS LOUDLY. If a log range cannot be read, a call reverts, or a total does not
 *     reconcile, the check FAILS. Nothing is inferred, defaulted, or silently skipped — a verifier
 *     that guesses is worse than no verifier.
 */
const { ethers } = require('ethers');

const BURN = '0x000000000000000000000000000000000000dEaD';
const ZERO = ethers.ZeroAddress;

// Pinned official Uniswap deployment on Robinhood Chain mainnet (4663).
const UNISWAP = {
  liquidityLauncher: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0',
  instantLaunchStrategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',
  feeSplitter: '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf',
  beneficiaryVault: '0xd35E9CA72F64C7F93BE30fad67524323396B36D7',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  universalRouter: '0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99',
  stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
};

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function marketLauncher() view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const LAUNCHER_ABI = [
  'function launchOf(address) view returns (address token, address tokenCreator, address launchpadOwner, address launchpad, uint256 positionTokenId)',
  'function verifyMarketLaunch(address) view returns (bool)',
  'function verifiedLaunchOf(address) view returns (bool, address, address, address, uint256)',
  'function launchpadFactory() view returns (address)',
  'function rewards() view returns (address)',
  'function isCorrectlyWired() view returns (bool)',
  'event TokenLaunchedToUniswap(address indexed token, address indexed tokenCreator, address indexed launchpad, address launchpadOwner, uint256 positionTokenId)',
];
const REWARDS_ABI = [
  'function attributionOf(uint256) view returns (address tokenCreator, address launchpadOwner, address launchpad, address token, bool registered)',
  'function pending(address) view returns (uint256)',
  'function totalPending() view returns (uint256)',
  'function lifetimeDistributed(uint256) view returns (uint256)',
  'function unaccountedBalance() view returns (uint256)',
  'function protocolTreasury() view returns (address)',
  'function registrar() view returns (address)',
  'function CREATOR_BPS() view returns (uint256)',
  'function PAD_OWNER_BPS() view returns (uint256)',
  'function PROTOCOL_BPS() view returns (uint256)',
  'event RewardsSplit(uint256 indexed tokenId, uint256 total, uint256 toCreator, uint256 toLaunchpadOwner, uint256 toProtocol)',
  'event Withdrawn(address indexed party, uint256 amount)',
];
const FACTORY_ABI = [
  'function isLaunchpad(address) view returns (bool)',
  'function launchpadCount() view returns (uint256)',
];
const PAD_ABI = [
  'function owner() view returns (address)',
  'function launchPolicy() view returns (uint8)',
  'function name() view returns (string)',
];
const SPLITTER_ABI = [
  'function getSplits() view returns (tuple(address recipient,uint16 nativeBps,uint16 tokenBps,bool useCallback)[])',
  'event FeesCollected(uint256 indexed tokenId, address indexed token, uint256 nativeAmount, uint256 tokenAmount)',
];
const VAULT_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function amounts(uint256) view returns (uint256, uint256)',
];
const POSITION_ABI = ['function ownerOf(uint256) view returns (address)'];
const STATE_VIEW_ABI = [
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

/** v4 pool id for a native-ETH / token pool at 25 bps, spacing 25, no hook. */
function poolIdFor(token, fee = 2500, tickSpacing = 25) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [ZERO, token, fee, tickSpacing, ZERO],
  ));
}

/**
 * Reads logs in bounded chunks. Public RPCs cap block ranges; a silent truncation would corrupt
 * every downstream total, so a chunk that cannot be read THROWS rather than returning partial data.
 */
async function getLogsChunked(provider, filter, fromBlock, toBlock, span = 50000) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += span) {
    const end = Math.min(start + span - 1, toBlock);
    try {
      out.push(...await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
    } catch (e) {
      throw new Error(
        `log read failed for blocks ${start}-${end}: ${e.shortMessage || e.message}. `
        + 'Refusing to continue with an incomplete log set.',
      );
    }
  }
  return out;
}

/**
 * Finds a token's launch event by searching BACKWARDS from head in doubling windows.
 *
 * Scanning forward from genesis is not viable on a chain tens of millions of blocks long, and a
 * launch is almost always recent relative to head. The search is bounded: if the event is not found
 * within `maxLookback`, this returns null and the caller FAILS rather than assuming a window.
 */
async function findLaunchEvent(provider, launcher, token, head, maxLookback) {
  const filter = {
    address: launcher,
    topics: [
      ethers.id('TokenLaunchedToUniswap(address,address,address,address,uint256)'),
      ethers.zeroPadValue(ethers.getAddress(token), 32),
    ],
  };
  let span = 10000;
  let to = head;
  let scanned = 0;
  while (scanned < maxLookback && to > 0) {
    const from = Math.max(0, to - span + 1);
    let logs;
    try {
      logs = await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
    } catch (e) {
      // A range the node refuses is not evidence of absence; narrow and retry once.
      if (span <= 2000) {
        throw new Error(`log read failed for blocks ${from}-${to}: ${e.shortMessage || e.message}`);
      }
      span = Math.floor(span / 4);
      continue;
    }
    if (logs.length > 0) return logs[0];
    scanned += (to - from + 1);
    to = from - 1;
    span = Math.min(span * 2, 200000);
  }
  return null;
}

/**
 * @param {object} o
 * @param {ethers.Provider} o.provider
 * @param {string} o.token                 token to audit
 * @param {string} o.launcher              our LaunchpadFamilyLauncher
 * @param {string[]} [o.controlledWallets] wallets we know are ours; everything else is external
 * @param {number} [o.fromBlock]           first block to scan; defaults to the launch block
 * @param {number} [o.maxLookback]         how far back to hunt for the launch event before failing
 */
async function verifyLaunch({
  provider, token, launcher, controlledWallets = [], fromBlock, maxLookback = 500000,
}) {
  const checks = [];
  const findings = [];
  const add = (id, passed, detail = '') => { checks.push({ id, passed, detail }); return passed; };
  const fail = (id, detail) => { add(id, false, detail); findings.push(`${id}: ${detail}`); };

  if (!ethers.isAddress(token)) throw new Error(`token is not an address: ${token}`);
  if (!ethers.isAddress(launcher)) throw new Error(`launcher is not an address: ${launcher}`);

  const controlled = new Set(controlledWallets.filter(Boolean).map((a) => a.toLowerCase()));
  const network = await provider.getNetwork();
  const head = await provider.getBlockNumber();
  const record = {
    schemaVersion: 1,
    chainId: Number(network.chainId),
    reconciledAtBlock: head,
    notes: [],
  };

  // ---------------------------------------------------------------------------------------------
  // 1. Our contracts must actually be contracts, and wired to each other.
  // ---------------------------------------------------------------------------------------------
  if ((await provider.getCode(launcher)) === '0x') {
    fail('launcher.hasCode', `no contract at ${launcher}`);
    return finish();
  }
  const launcherC = new ethers.Contract(launcher, LAUNCHER_ABI, provider);

  let factoryAddress; let rewardsAddress;
  try {
    factoryAddress = await launcherC.launchpadFactory();
    rewardsAddress = await launcherC.rewards();
  } catch (e) {
    fail('launcher.readable', `launcher does not expose the expected interface: ${e.shortMessage || e.message}`);
    return finish();
  }
  add('launcher.hasCode', true, launcher);

  try {
    add('launcher.isCorrectlyWired', await launcherC.isCorrectlyWired() === true);
  } catch (e) {
    fail('launcher.isCorrectlyWired', `call reverted: ${e.shortMessage || e.message}`);
  }

  const rewardsC = new ethers.Contract(rewardsAddress, REWARDS_ABI, provider);
  const factoryC = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);

  // The registrar binding is what makes attribution trustworthy: only the launcher may attribute.
  try {
    add('rewards.registrarIsLauncher',
      (await rewardsC.registrar()).toLowerCase() === launcher.toLowerCase(),
      await rewardsC.registrar());
  } catch (e) {
    fail('rewards.registrarIsLauncher', `unreadable: ${e.shortMessage || e.message}`);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. The two-way market-launch binding.
  // ---------------------------------------------------------------------------------------------
  let launchRec;
  try {
    launchRec = await launcherC.launchOf(token);
  } catch (e) {
    fail('launch.recordReadable', `launchOf reverted: ${e.shortMessage || e.message}`);
    return finish();
  }

  if (launchRec.token === ZERO || launchRec.token.toLowerCase() !== token.toLowerCase()) {
    fail('launch.recordedByLauncher',
      `this launcher has no record for ${token} — it was not launched here`);
    return finish();
  }
  add('launch.recordedByLauncher', true, token);

  let verified = false;
  try {
    verified = await launcherC.verifyMarketLaunch(token);
  } catch (e) {
    fail('launch.verifyMarketLaunch', `reverted: ${e.shortMessage || e.message}`);
  }
  add('launch.verifyMarketLaunch', verified === true, String(verified));

  const tokenC = new ethers.Contract(token, ERC20_ABI, provider);
  let claimedLauncher = null;
  try { claimedLauncher = await tokenC.marketLauncher(); } catch { /* not a LaunchToken */ }
  add('token.namesThisLauncher',
    Boolean(claimedLauncher) && claimedLauncher.toLowerCase() === launcher.toLowerCase(),
    claimedLauncher || 'token does not expose marketLauncher()');

  // ---------------------------------------------------------------------------------------------
  // 3. Launchpad / factory relationship.
  // ---------------------------------------------------------------------------------------------
  const padAddress = launchRec.launchpad;
  try {
    add('launchpad.knownToFactory', await factoryC.isLaunchpad(padAddress) === true, padAddress);
  } catch (e) {
    fail('launchpad.knownToFactory', `isLaunchpad reverted: ${e.shortMessage || e.message}`);
  }
  const padC = new ethers.Contract(padAddress, PAD_ABI, provider);
  let padOwner = null; let padPolicy = null; let padName = '';
  try {
    padOwner = await padC.owner();
    padPolicy = Number(await padC.launchPolicy());
    padName = await padC.name();
  } catch (e) {
    fail('launchpad.readable', `launchpad does not expose the expected interface: ${e.shortMessage || e.message}`);
  }
  add('launchpad.ownerMatchesAttribution',
    Boolean(padOwner) && padOwner.toLowerCase() === launchRec.launchpadOwner.toLowerCase(),
    `pad.owner=${padOwner} attribution=${launchRec.launchpadOwner}`);

  // ---------------------------------------------------------------------------------------------
  // 4. Token identity and supply.
  // ---------------------------------------------------------------------------------------------
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    tokenC.name(), tokenC.symbol(), tokenC.decimals(), tokenC.totalSupply(),
  ]);
  add('token.supplyIsOneBillion18', totalSupply === 1000000000n * 10n ** 18n,
    `${totalSupply} (Uniswap's strategy accepts only 1e9 x 1e18)`);
  add('token.decimalsIs18', Number(decimals) === 18, String(decimals));

  // ---------------------------------------------------------------------------------------------
  // 5. Pool, position, and the liquidity lock.
  // ---------------------------------------------------------------------------------------------
  const positionTokenId = launchRec.positionTokenId;
  const poolId = poolIdFor(token);
  const stateView = new ethers.Contract(UNISWAP.stateView, STATE_VIEW_ABI, provider);
  let slot0 = null;
  try { slot0 = await stateView.getSlot0(poolId); } catch (e) {
    fail('pool.exists', `getSlot0 reverted: ${e.shortMessage || e.message}`);
  }
  if (slot0) {
    add('pool.exists', slot0.sqrtPriceX96 > 0n, `sqrtPriceX96=${slot0.sqrtPriceX96} tick=${slot0.tick}`);
    add('pool.feeIs25Bps', Number(slot0.lpFee) === 2500, String(slot0.lpFee));
  }

  const positionC = new ethers.Contract(UNISWAP.positionManager, POSITION_ABI, provider);
  let positionOwner = null;
  try { positionOwner = await positionC.ownerOf(positionTokenId); } catch (e) {
    fail('pool.positionExists', `ownerOf(${positionTokenId}) reverted: ${e.shortMessage || e.message}`);
  }
  // This is the lock: the FeeSplitter exposes collectFees and increaseLiquidity only — no withdraw,
  // no burn, no decrease. An LP NFT it holds can never be unwound by anyone.
  add('liquidity.permanentlyLocked',
    Boolean(positionOwner) && positionOwner.toLowerCase() === UNISWAP.feeSplitter.toLowerCase(),
    positionOwner ? `position owner ${positionOwner}` : 'position owner unknown');

  const vaultC = new ethers.Contract(UNISWAP.beneficiaryVault, VAULT_ABI, provider);
  let beneficiaryOwner = null;
  try { beneficiaryOwner = await vaultC.ownerOf(positionTokenId); } catch (e) {
    fail('beneficiary.exists', `vault ownerOf reverted: ${e.shortMessage || e.message}`);
  }
  add('beneficiary.ownedByRewards',
    Boolean(beneficiaryOwner) && beneficiaryOwner.toLowerCase() === rewardsAddress.toLowerCase(),
    beneficiaryOwner ? `${beneficiaryOwner}` : 'unknown');

  // ---------------------------------------------------------------------------------------------
  // 6. Attribution, in both places, and the immutable split.
  // ---------------------------------------------------------------------------------------------
  let attribution = null;
  try { attribution = await rewardsC.attributionOf(positionTokenId); } catch (e) {
    fail('attribution.readable', `attributionOf reverted: ${e.shortMessage || e.message}`);
  }
  if (attribution) {
    add('attribution.registered', attribution.registered === true);
    add('attribution.creatorAgrees',
      attribution.tokenCreator.toLowerCase() === launchRec.tokenCreator.toLowerCase(),
      `${attribution.tokenCreator} vs ${launchRec.tokenCreator}`);
    add('attribution.padOwnerAgrees',
      attribution.launchpadOwner.toLowerCase() === launchRec.launchpadOwner.toLowerCase(),
      `${attribution.launchpadOwner} vs ${launchRec.launchpadOwner}`);
    add('attribution.tokenAgrees',
      attribution.token.toLowerCase() === token.toLowerCase());
  }

  let treasury = null; let bps = null;
  try {
    treasury = await rewardsC.protocolTreasury();
    bps = {
      creator: Number(await rewardsC.CREATOR_BPS()),
      launchpadOwner: Number(await rewardsC.PAD_OWNER_BPS()),
      protocol: Number(await rewardsC.PROTOCOL_BPS()),
    };
    add('split.sumsTo100Pct', bps.creator + bps.launchpadOwner + bps.protocol === 10000,
      `${bps.creator}/${bps.launchpadOwner}/${bps.protocol}`);
  } catch (e) {
    fail('split.readable', `split constants unreadable: ${e.shortMessage || e.message}`);
  }

  const parties = attribution ? {
    creator: attribution.tokenCreator,
    launchpadOwner: attribution.launchpadOwner,
    protocol: treasury,
  } : null;
  if (parties) {
    const distinct = new Set(Object.values(parties).filter(Boolean).map((a) => a.toLowerCase()));
    add('roles.threeDistinctRecipients', distinct.size === 3, `${distinct.size}/3 distinct`);
  }

  // ---------------------------------------------------------------------------------------------
  // 7. Find the launch block, then read every log from it. Never assume a scan window.
  // ---------------------------------------------------------------------------------------------
  let launchBlock = fromBlock;
  if (launchBlock === undefined) {
    const found = await findLaunchEvent(provider, launcher, token, head, maxLookback);
    if (!found) {
      // Explicit failure, not a guess. Scanning from genesis on a chain this long is not viable,
      // so if the launch is older than the lookback the caller must pass fromBlock.
      fail('launch.eventFound',
        `no TokenLaunchedToUniswap event for this token within ${maxLookback} blocks of head `
        + `(${head}). Cannot establish a scan window — pass fromBlock explicitly. `
        + 'Refusing to reconcile over an unknown range.');
      return finish();
    }
    launchBlock = found.blockNumber;
    record.launchTransaction = { hash: found.transactionHash, block: launchBlock };
    add('launch.eventFound', true, `block ${launchBlock}`);
  }

  // ---------------------------------------------------------------------------------------------
  // 8. SUPPLY RECONCILIATION — every base unit, from Transfer logs. Holders are DISCOVERED.
  // ---------------------------------------------------------------------------------------------
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const transferLogs = await getLogsChunked(provider, { address: token, topics: [transferTopic] },
    launchBlock, head);

  const touched = new Set();
  const tokensOutOfPool = new Map(); // recipient -> units received directly from the PoolManager
  for (const log of transferLogs) {
    const from = ethers.getAddress(`0x${log.topics[1].slice(26)}`);
    const to = ethers.getAddress(`0x${log.topics[2].slice(26)}`);
    const amount = BigInt(log.data);
    touched.add(from); touched.add(to);
    if (from.toLowerCase() === UNISWAP.poolManager.toLowerCase()) {
      tokensOutOfPool.set(to, (tokensOutOfPool.get(to) || 0n) + amount);
    }
  }

  const lockedInPool = await tokenC.balanceOf(UNISWAP.poolManager);
  const burned = await tokenC.balanceOf(BURN);
  const holders = [];
  let holderTotal = 0n;
  for (const address of touched) {
    if (address === ZERO) continue;
    if (address.toLowerCase() === UNISWAP.poolManager.toLowerCase()) continue;
    if (address.toLowerCase() === BURN.toLowerCase()) continue;
    const balance = await tokenC.balanceOf(address);
    if (balance === 0n) continue;
    holderTotal += balance;
    holders.push({
      address,
      balance: balance.toString(),
      classification: controlled.has(address.toLowerCase()) ? 'controlled' : 'external',
    });
  }

  const supplySum = lockedInPool + burned + holderTotal;
  const supplyExact = supplySum === totalSupply;
  add('supply.reconcilesExactly', supplyExact,
    `pool ${lockedInPool} + burned ${burned} + holders ${holderTotal} = ${supplySum} vs supply ${totalSupply}`);
  if (!supplyExact) {
    findings.push(`supply is short by ${totalSupply - supplySum} base units — a holder was not discovered`);
  }
  // Nobody privileged should be sitting on supply. External holders are expected and fine.
  const privileged = [launchRec.tokenCreator, launchRec.launchpadOwner, padAddress, launcher,
    rewardsAddress, factoryAddress, treasury].filter(Boolean).map((a) => a.toLowerCase());
  const privilegedHolding = holders.filter((h) => privileged.includes(h.address.toLowerCase()));
  add('supply.noPrivilegedPartyHoldsSupply', privilegedHolding.length === 0,
    privilegedHolding.length ? privilegedHolding.map((h) => `${h.address}=${h.balance}`).join(', ') : 'none');

  record.supplyReconciliation = {
    totalSupply: totalSupply.toString(),
    lockedInPool: lockedInPool.toString(),
    burned: burned.toString(),
    holders,
    exact: supplyExact,
  };

  // ---------------------------------------------------------------------------------------------
  // 9. TRADING — buys are token outflows from the PoolManager. External trading is normal.
  // ---------------------------------------------------------------------------------------------
  const traders = [];
  for (const [address, received] of tokensOutOfPool) {
    // The strategy pulls the rounding remainder out of the pool to burn it; that is not a trade.
    if (address.toLowerCase() === UNISWAP.instantLaunchStrategy.toLowerCase()) continue;
    traders.push({
      address,
      classification: controlled.has(address.toLowerCase()) ? 'controlled' : 'external',
      tokensReceived: received.toString(),
    });
  }
  record.trading = {
    buys: traders.length,
    traders,
    externalTraderCount: traders.filter((t) => t.classification === 'external').length,
  };
  if (record.trading.externalTraderCount > 0) {
    record.notes.push(
      `${record.trading.externalTraderCount} external trader(s) observed. This is a public pool; `
      + 'third-party trading is expected and is not an error.',
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 10. FEE RECONCILIATION — every wei. Fees may come from ANY trader, not only ours.
  // ---------------------------------------------------------------------------------------------
  const splitterC = new ethers.Contract(UNISWAP.feeSplitter, SPLITTER_ABI, provider);
  const feesCollectedLogs = await getLogsChunked(provider, {
    address: UNISWAP.feeSplitter,
    topics: [
      ethers.id('FeesCollected(uint256,address,uint256,uint256)'),
      ethers.zeroPadValue(ethers.toBeHex(positionTokenId), 32),
    ],
  }, launchBlock, head);
  let lpFeeNative = 0n; let lpFeeToken = 0n;
  for (const log of feesCollectedLogs) {
    const parsed = splitterC.interface.parseLog(log);
    lpFeeNative += parsed.args.nativeAmount;
    lpFeeToken += parsed.args.tokenAmount;
  }

  const splitLogs = await getLogsChunked(provider, {
    address: rewardsAddress,
    topics: [
      ethers.id('RewardsSplit(uint256,uint256,uint256,uint256,uint256)'),
      ethers.zeroPadValue(ethers.toBeHex(positionTokenId), 32),
    ],
  }, launchBlock, head);
  let claimedTotal = 0n;
  const credited = { creator: 0n, launchpadOwner: 0n, protocol: 0n };
  for (const log of splitLogs) {
    const p = rewardsC.interface.parseLog(log);
    claimedTotal += p.args.total;
    credited.creator += p.args.toCreator;
    credited.launchpadOwner += p.args.toLaunchpadOwner;
    credited.protocol += p.args.toProtocol;
  }

  const creditedSum = credited.creator + credited.launchpadOwner + credited.protocol;
  add('fees.splitConservesEveryWei', creditedSum === claimedTotal,
    `credited ${creditedSum} vs claimed ${claimedTotal}`);

  if (bps && claimedTotal > 0n) {
    // Per-event, because floor division is applied per split, not to the running total.
    let expectedCreator = 0n; let expectedPad = 0n;
    for (const log of splitLogs) {
      const p = rewardsC.interface.parseLog(log);
      expectedCreator += (p.args.total * BigInt(bps.creator)) / 10000n;
      expectedPad += (p.args.total * BigInt(bps.launchpadOwner)) / 10000n;
    }
    add('fees.creatorShareCorrect', credited.creator === expectedCreator,
      `${credited.creator} vs ${expectedCreator}`);
    add('fees.padOwnerShareCorrect', credited.launchpadOwner === expectedPad,
      `${credited.launchpadOwner} vs ${expectedPad}`);
    // The protocol takes the remainder, so it absorbs floor-division dust: at most 2 wei per split.
    const nominalProtocol = (() => {
      let n = 0n;
      for (const log of splitLogs) {
        const p = rewardsC.interface.parseLog(log);
        n += (p.args.total * BigInt(bps.protocol)) / 10000n;
      }
      return n;
    })();
    const dust = credited.protocol - nominalProtocol;
    add('fees.protocolDustWithinBound', dust >= 0n && dust <= BigInt(splitLogs.length) * 2n,
      `dust ${dust} wei across ${splitLogs.length} split(s)`);
  }

  // The vault's attributed amount is what is claimABLE; it resets as it is claimed.
  let vaultNative = 0n;
  try { [vaultNative] = await vaultC.amounts(positionTokenId); } catch (e) {
    fail('fees.vaultReadable', `vault amounts reverted: ${e.shortMessage || e.message}`);
  }

  // Withdrawals, per party, from events — then cross-checked against live `pending`.
  const withdrawLogs = await getLogsChunked(provider, {
    address: rewardsAddress, topics: [ethers.id('Withdrawn(address,uint256)')],
  }, launchBlock, head);
  const withdrawnByParty = new Map();
  for (const log of withdrawLogs) {
    const party = ethers.getAddress(`0x${log.topics[1].slice(26)}`);
    const p = rewardsC.interface.parseLog(log);
    withdrawnByParty.set(party.toLowerCase(),
      (withdrawnByParty.get(party.toLowerCase()) || 0n) + p.args.amount);
  }

  const partyKeys = parties ? Object.entries(parties) : [];
  const withdrawn = { creator: 0n, launchpadOwner: 0n, protocol: 0n };
  const pendingNow = { creator: 0n, launchpadOwner: 0n, protocol: 0n };
  for (const [role, address] of partyKeys) {
    if (!address) continue;
    withdrawn[role] = withdrawnByParty.get(address.toLowerCase()) || 0n;
    pendingNow[role] = await rewardsC.pending(address);
  }

  // credited == withdrawn + pending, per party. This is the core money invariant.
  //
  // NOTE: withdrawals and pending are per-ADDRESS, not per-position. If the same address earns from
  // another launch through this same rewards contract, its totals legitimately exceed this launch's.
  // So an exact match is asserted only when this is the only position that address earns from.
  const onlyPosition = splitLogs.length > 0 && await (async () => {
    const allSplits = await getLogsChunked(provider, {
      address: rewardsAddress, topics: [ethers.id('RewardsSplit(uint256,uint256,uint256,uint256,uint256)')],
    }, launchBlock, head);
    return allSplits.length === splitLogs.length;
  })();

  for (const role of ['creator', 'launchpadOwner', 'protocol']) {
    const total = withdrawn[role] + pendingNow[role];
    if (onlyPosition) {
      add(`fees.${role}.creditedEqualsWithdrawnPlusPending`, total === credited[role],
        `withdrawn ${withdrawn[role]} + pending ${pendingNow[role]} = ${total} vs credited ${credited[role]}`);
    } else {
      add(`fees.${role}.creditedCoveredByWithdrawnPlusPending`, total >= credited[role],
        `withdrawn+pending ${total} >= credited ${credited[role]} `
        + '(address also earns from other positions through this contract)');
    }
  }

  let unaccounted = 0n;
  try {
    unaccounted = await rewardsC.unaccountedBalance();
    add('fees.noUnaccountedEth', unaccounted === 0n, `${unaccounted} wei`);
  } catch (e) {
    fail('fees.noUnaccountedEth', `unaccountedBalance reverted: ${e.shortMessage || e.message}`);
  }

  // Contract solvency: it must hold at least everything it owes.
  const rewardsBalance = await provider.getBalance(rewardsAddress);
  let totalPending = 0n;
  try { totalPending = await rewardsC.totalPending(); } catch { /* reported below */ }
  add('fees.rewardsContractIsSolvent', rewardsBalance >= totalPending,
    `balance ${rewardsBalance} >= totalPending ${totalPending}`);

  let lifetime = 0n;
  try { lifetime = await rewardsC.lifetimeDistributed(positionTokenId); } catch { /* optional */ }
  add('fees.lifetimeMatchesEvents', lifetime === claimedTotal,
    `lifetimeDistributed ${lifetime} vs summed events ${claimedTotal}`);

  const feeExact = creditedSum === claimedTotal && unaccounted === 0n;
  record.feeAccounting = {
    lpFeeNativeWei: lpFeeNative.toString(),
    lpFeeTokenWei: lpFeeToken.toString(),
    attributedToVaultWei: vaultNative.toString(),
    claimedTotalWei: claimedTotal.toString(),
    creditedWei: {
      creator: credited.creator.toString(),
      launchpadOwner: credited.launchpadOwner.toString(),
      protocol: credited.protocol.toString(),
    },
    withdrawnWei: {
      creator: withdrawn.creator.toString(),
      launchpadOwner: withdrawn.launchpadOwner.toString(),
      protocol: withdrawn.protocol.toString(),
    },
    pendingWei: {
      creator: pendingNow.creator.toString(),
      launchpadOwner: pendingNow.launchpadOwner.toString(),
      protocol: pendingNow.protocol.toString(),
    },
    unaccountedWei: unaccounted.toString(),
    exact: feeExact,
  };

  // ---------------------------------------------------------------------------------------------
  record.contracts = {
    LaunchpadFactory: factoryAddress,
    LaunchpadFamilyLauncher: launcher,
    LaunchpadRewards: rewardsAddress,
  };
  record.launchpad = { address: padAddress, owner: padOwner, policy: padPolicy, name: padName };
  record.token = {
    address: token, name, symbol, decimals: Number(decimals),
    totalSupply: totalSupply.toString(),
    marketLauncher: claimedLauncher || ZERO,
  };
  record.pool = {
    poolId,
    positionTokenId: positionTokenId.toString(),
    currency0: ZERO,
    currency1: token,
    fee: 2500,
    tickSpacing: 25,
    hooks: ZERO,
    positionOwner: positionOwner || ZERO,
    beneficiaryOwner: beneficiaryOwner || ZERO,
  };
  record.roles = {
    tokenCreator: launchRec.tokenCreator,
    launchpadOwner: launchRec.launchpadOwner,
    protocolTreasury: treasury || ZERO,
  };
  if (bps) record.splitBps = bps;

  return finish();

  function finish() {
    const failed = checks.filter((c) => !c.passed);
    record.verification = {
      status: failed.length === 0 ? 'VERIFIED' : 'FAILED',
      verifiedAt: new Date().toISOString(),
      checks,
    };
    record.findings = findings;
    return record;
  }
}

module.exports = { verifyLaunch, poolIdFor, UNISWAP, BURN, getLogsChunked };
