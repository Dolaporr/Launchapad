// ---------------------------------------------------------------------------
// LAUNCH STATE — the product data model for displaying ONE launch.
//
//   Token -> Pool -> Locked Liquidity -> Trading Activity -> Fees -> Revenue Split
//
// This module is pure: it takes a verification record (the shape produced by
// contracts/scripts/lib/launchVerifier.cjs) and returns display-ready values.
// It performs no I/O, so it is testable and cannot invent data.
//
// THE RULE THAT SHAPES EVERYTHING HERE:
//
//   ETH paid into the pool by a buyer is EXCHANGED FOR TOKENS. It is not revenue.
//   It is not ours. It never was. Only fee capture is revenue.
//
// Volume and revenue are therefore kept in separate structures with separate
// labels, and `revenue` never derives from `volume`. A reader who only glances
// at the page must not be able to come away thinking swapped ETH was income.
// ---------------------------------------------------------------------------

/** What we can say about who traded. `unknown` is a real answer, not a guess. */
export const TRADER_CLASS = {
  CONTROLLED: 'controlled',
  EXTERNAL: 'external',
  UNKNOWN: 'unknown',
};

/**
 * Human wording for each trader class. External trading is PERMISSIONLESS ACTIVITY —
 * it is not evidence that a real user wanted the token.
 */
export const TRADER_CLASS_LABEL = {
  controlled: 'ours (test wallet)',
  external: 'third party (permissionless)',
  unknown: 'unclassified',
};

const ZERO = '0x0000000000000000000000000000000000000000';

function big(v) {
  if (v === null || v === undefined) return 0n;
  return typeof v === 'bigint' ? v : BigInt(v);
}

/** 18-decimal formatting without floating point. Returns a string, never a number. */
export function formatUnits(value, decimals = 18, maxFractionDigits = 6) {
  const v = big(value);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0');
  frac = frac.slice(0, maxFractionDigits).replace(/0+$/, '');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** ETH with enough precision that sub-microether fee capture is still legible. */
export function formatEth(wei, maxFractionDigits = 9) {
  return formatUnits(wei, 18, maxFractionDigits);
}

/**
 * Builds the display model for one launch.
 *
 * @param {object} record  a verification record from launchVerifier
 * @returns {object} display model; `null` fields mean UNKNOWN and must render as unknown,
 *                   never as zero.
 */
export function buildLaunchState(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('buildLaunchState requires a verification record');
  }

  const checks = record.verification?.checks ?? [];
  const checkById = new Map(checks.map((c) => [c.id, c]));
  const failed = checks.filter((c) => !c.passed);

  // --- 1. TOKEN -----------------------------------------------------------
  const token = {
    address: record.token?.address ?? null,
    name: record.token?.name ?? null,
    symbol: record.token?.symbol ?? null,
    decimals: record.token?.decimals ?? null,
    totalSupply: record.token?.totalSupply ? big(record.token.totalSupply) : null,
    totalSupplyFormatted: record.token?.totalSupply
      ? formatUnits(record.token.totalSupply, record.token.decimals ?? 18, 0)
      : null,
  };

  // --- 2. POOL ------------------------------------------------------------
  const pool = {
    poolId: record.pool?.poolId ?? null,
    positionTokenId: record.pool?.positionTokenId ?? null,
    feeBps: record.pool?.fee != null ? record.pool.fee / 100 : null,
    pairedWith: 'ETH',
    hooks: record.pool?.hooks ?? null,
    hookless: record.pool?.hooks === ZERO,
    exists: checkById.get('pool.exists')?.passed ?? null,
  };

  // --- 3. LOCKED LIQUIDITY ------------------------------------------------
  // "Locked" is a strong claim, so it is only ever asserted from the check that
  // actually proves it: the LP position is owned by Uniswap's FeeSplitter, which
  // exposes no withdraw, burn or decrease.
  const lockedCheck = checkById.get('liquidity.permanentlyLocked');
  const supply = record.supplyReconciliation;
  const liquidity = {
    locked: lockedCheck ? lockedCheck.passed : null,
    positionOwner: record.pool?.positionOwner ?? null,
    lockedAmount: supply ? big(supply.lockedInPool) : null,
    lockedAmountFormatted: supply ? formatUnits(supply.lockedInPool, token.decimals ?? 18, 6) : null,
    burned: supply ? big(supply.burned) : null,
    lockedPercentOfSupply: supply && token.totalSupply
      ? Number((big(supply.lockedInPool) * 10000n) / token.totalSupply) / 100
      : null,
    reconciles: supply ? supply.exact === true : null,
    explanation: 'The LP position is held by Uniswap\'s FeeSplitter, which has no withdraw, '
      + 'burn or decrease function. Nobody — not the creator, not the launchpad owner, not us — '
      + 'can remove this liquidity.',
  };

  // --- 4. TRADING ACTIVITY ------------------------------------------------
  // Volume is presented as ACTIVITY, deliberately in its own section, and never
  // summed into anything called revenue or earnings.
  const traders = (record.trading?.traders ?? []).map((t) => ({
    address: t.address,
    classification: t.classification ?? TRADER_CLASS.UNKNOWN,
    classificationLabel: TRADER_CLASS_LABEL[t.classification ?? TRADER_CLASS.UNKNOWN],
    tokensReceived: big(t.tokensReceived),
    tokensReceivedFormatted: formatUnits(t.tokensReceived, token.decimals ?? 18, 6),
  }));

  const externalTraders = traders.filter((t) => t.classification === TRADER_CLASS.EXTERNAL);
  const controlledTraders = traders.filter((t) => t.classification === TRADER_CLASS.CONTROLLED);

  const trading = {
    buyCount: traders.length,
    traders,
    externalTraderCount: externalTraders.length,
    controlledTraderCount: controlledTraders.length,
    hasExternalActivity: externalTraders.length > 0,
    // Tokens bought is measurable from Transfer logs. ETH volume is NOT derivable
    // from those logs alone, so it stays null rather than being estimated.
    tokensBoughtTotal: traders.reduce((a, t) => a + t.tokensReceived, 0n),
    tokensBoughtExternal: externalTraders.reduce((a, t) => a + t.tokensReceived, 0n),
    tokensBoughtControlled: controlledTraders.reduce((a, t) => a + t.tokensReceived, 0n),
    nativeVolumeWei: record.trading?.grossNativeVolumeInWei
      ? big(record.trading.grossNativeVolumeInWei) : null,
    volumeCaveat: 'ETH spent by buyers was exchanged for tokens. It is NOT revenue and was '
      + 'never ours.',
    externalCaveat: 'Third-party trading is permissionless activity on a public pool. It is not '
      + 'evidence of organic demand or of a real user choosing this token.',
  };

  // --- 5. FEES (this, and only this, is revenue) --------------------------
  const f = record.feeAccounting;
  const fees = f ? {
    lpFeeNativeWei: big(f.lpFeeNativeWei),
    lpFeeTokenWei: big(f.lpFeeTokenWei),
    // What Uniswap has attributed to our position but which has not been claimed yet.
    claimableInVaultWei: big(f.attributedToVaultWei),
    // What has actually been pulled into our splitter and divided.
    capturedWei: big(f.claimedTotalWei),
    reconciles: f.exact === true,
    unaccountedWei: big(f.unaccountedWei),
    note: 'The creator-fee stream is 40% of the ETH side of a 25 bps LP fee — about 10 bps of '
      + 'ETH buy volume. Sells pay their fee in the token, of which our stream receives none.',
  } : null;

  // --- 6. REVENUE SPLIT ---------------------------------------------------
  // Three parties, each shown separately, each with credited / withdrawn / claimable.
  const roleMeta = [
    ['creator', 'Token creator', record.roles?.tokenCreator, record.splitBps?.creator],
    ['launchpadOwner', 'Launchpad owner', record.roles?.launchpadOwner, record.splitBps?.launchpadOwner],
    ['protocol', 'Protocol', record.roles?.protocolTreasury, record.splitBps?.protocol],
  ];

  const split = f ? roleMeta.map(([key, label, address, shareBps]) => {
    const credited = big(f.creditedWei?.[key]);
    const withdrawn = big(f.withdrawnWei?.[key]);
    const claimable = big(f.pendingWei?.[key]);
    return {
      key,
      label,
      address: address ?? null,
      shareBps: shareBps ?? null,
      sharePercent: shareBps != null ? shareBps / 100 : null,
      creditedWei: credited,
      withdrawnWei: withdrawn,
      claimableWei: claimable,
      creditedEth: formatEth(credited),
      withdrawnEth: formatEth(withdrawn),
      claimableEth: formatEth(claimable),
      // A party whose credited total does not equal withdrawn + claimable is a red flag.
      balances: credited === withdrawn + claimable,
    };
  }) : null;

  const totals = split ? {
    creditedWei: split.reduce((a, r) => a + r.creditedWei, 0n),
    withdrawnWei: split.reduce((a, r) => a + r.withdrawnWei, 0n),
    claimableWei: split.reduce((a, r) => a + r.claimableWei, 0n),
  } : null;

  // --- VERIFICATION -------------------------------------------------------
  const verification = {
    status: record.verification?.status ?? 'UNVERIFIED',
    verified: record.verification?.status === 'VERIFIED',
    checkCount: checks.length,
    passedCount: checks.length - failed.length,
    failed: failed.map((c) => ({ id: c.id, detail: c.detail })),
    reconciledAtBlock: record.reconciledAtBlock ?? null,
    // Everything must reconcile for the numbers above to mean anything.
    reconciled: (supply?.exact === true) && (f?.exact === true),
  };

  return {
    chainId: record.chainId ?? null,
    token,
    pool,
    liquidity,
    trading,
    fees,
    split,
    totals,
    verification,
    roles: {
      tokenCreator: record.roles?.tokenCreator ?? null,
      launchpadOwner: record.roles?.launchpadOwner ?? null,
      protocolTreasury: record.roles?.protocolTreasury ?? null,
    },
    launchpad: record.launchpad ?? null,
    findings: record.findings ?? [],
    notes: record.notes ?? [],
  };
}

/**
 * One-line summary for a list view. Deliberately leads with fee capture, never volume,
 * so a scannable list cannot imply that trading activity equals income.
 */
export function summariseLaunch(state) {
  if (!state.verification.verified) {
    return `${state.token.symbol ?? 'token'} — NOT VERIFIED (${state.verification.failed.length} failing)`;
  }
  const captured = state.fees ? formatEth(state.fees.capturedWei) : '0';
  const external = state.trading.externalTraderCount;
  return `${state.token.symbol} — ${captured} ETH captured in fees`
    + `, ${state.trading.buyCount} buy(s)`
    + `${external ? `, ${external} third-party` : ''}`;
}
