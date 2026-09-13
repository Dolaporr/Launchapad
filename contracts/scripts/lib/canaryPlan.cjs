/**
 * Fee, funding and resume arithmetic for a controlled mainnet run.
 *
 * This is deliberately a pure module with no provider and no I/O, because every rule in it was
 * learned by losing a real transaction on mainnet:
 *
 *   - `capFor` exists because relying on a wallet library's default fee data raced the base fee and
 *     a send was rejected with "max fee per gas less than block base fee".
 *   - `fundingAmountFor` and `gasAllowanceFor` exist because a node computes a sender's gas
 *     allowance as balance / maxFeePerGas. Funding a signer at the EXPECTED price leaves it unable
 *     to afford its own transaction once the higher cap is applied.
 *   - `remainingPhases` exists because a resumed run must not be charged for phases an interrupted
 *     run already paid for, or the budget guard aborts on money that is already spent.
 *
 * Keeping them here means those three failures are covered by fast unit tests instead of by
 * spending ETH again.
 */

/** Priority fee. Small and fixed: this is an L2 where the base fee dominates. */
const TIP = 10000000n; // 0.01 gwei

/** Multiplier on the live base fee used as maxFeePerGas. A cap is a ceiling, not a cost. */
const CAP_MULTIPLIER = 4n;
/** Multiplier used for BUDGETING — what we expect to actually pay. */
const EXPECTED_MULTIPLIER = 2n;
/** Safety margin applied to measured gas when estimating a budget. */
const GAS_MARGIN_PCT = 150n;
/** How many times the needed gas a signing wallet is funded for, at the cap. */
const FUNDING_HEADROOM = 2n;

/**
 * The maxFeePerGas to put on a transaction, given the CURRENT base fee.
 * Must exceed the base fee at inclusion time, not merely at estimation time.
 */
function capFor(baseFee) {
  return baseFee * CAP_MULTIPLIER + TIP;
}

/** The price to budget with: what we expect to pay, which is far below the cap. */
function expectedPriceFor(baseFee) {
  return baseFee * EXPECTED_MULTIPLIER + TIP;
}

/**
 * How much gas a wallet can afford, as a node computes it: balance / maxFeePerGas.
 * This is the calculation that rejected the canary's launch.
 */
function gasAllowanceFor(balance, maxFeePerGas) {
  if (maxFeePerGas <= 0n) throw new Error('maxFeePerGas must be positive');
  return balance / maxFeePerGas;
}

/**
 * How much to send a wallet that must sign its own transaction.
 * Priced at the CAP, with headroom — never at the expected price.
 */
function fundingAmountFor(needGas, cap) {
  return needGas * cap * FUNDING_HEADROOM;
}

/**
 * Can `balance` actually pay for a transaction using `needGas` at `cap`?
 * True only if the node's own allowance calculation clears the required gas.
 */
function canAfford(balance, needGas, cap) {
  return gasAllowanceFor(balance, cap) >= needGas;
}

/** Top-up needed to bring `balance` to the funding target. Zero when already sufficient. */
function topUpFor(balance, needGas, cap) {
  const target = fundingAmountFor(needGas, cap);
  return balance >= target ? 0n : target - balance;
}

/**
 * The phases still to pay for, from `fromPhase` onward, excluding anything already completed.
 * `alreadyDone` is non-empty only on a resumed run.
 */
function remainingPhases(phaseOrder, fromPhase, alreadyDone = new Set()) {
  const idx = phaseOrder.indexOf(fromPhase);
  if (idx < 0) throw new Error(`unknown phase: ${fromPhase}`);
  return phaseOrder.slice(idx).filter((p) => !alreadyDone.has(p));
}

/**
 * Cost of the remaining work: gas (with margin) at the expected price, plus any ETH value still to
 * be sent. A resumed run must not be charged for completed phases.
 */
function remainingCost({
  phaseOrder, gas, fromPhase, alreadyDone = new Set(), baseFee, valueStillToSend = 0n,
}) {
  const phases = remainingPhases(phaseOrder, fromPhase, alreadyDone);
  const totalGas = phases.reduce((a, p) => {
    if (gas[p] === undefined) throw new Error(`no measured gas for phase: ${p}`);
    return a + gas[p];
  }, 0n);
  const withMargin = (totalGas * GAS_MARGIN_PCT) / 100n;
  return {
    phases,
    gas: totalGas,
    gasWithMargin: withMargin,
    cost: withMargin * expectedPriceFor(baseFee) + valueStillToSend,
  };
}

/** Phases an interrupted run has already paid for, when resuming from an existing stack. */
const RESUMABLE_PHASES = [
  'fundPadOwner', 'fundTokenCreator', 'deployFactory', 'deployLauncher',
  'deployRewards', 'createLaunchpad',
];

/**
 * Interprets resume inputs. A resume is all-or-nothing: a PARTIALLY completed stack is not a valid
 * resume target, because attaching to some contracts and deploying others would silently produce a
 * mismatched system. Missing pieces are reported so the caller can abort with a real reason.
 */
function resumePlan({ factory, launcher, rewards, pad } = {}) {
  const given = { factory, launcher, rewards, pad };
  const present = Object.entries(given).filter(([, v]) => Boolean(v && String(v).trim()));
  const missing = Object.entries(given).filter(([, v]) => !(v && String(v).trim())).map(([k]) => k);

  if (present.length === 0) {
    return { isResume: false, partial: false, missing: [], alreadyDone: new Set() };
  }
  if (missing.length > 0) {
    return { isResume: false, partial: true, missing, alreadyDone: new Set() };
  }
  return { isResume: true, partial: false, missing: [], alreadyDone: new Set(RESUMABLE_PHASES) };
}

module.exports = {
  TIP,
  CAP_MULTIPLIER,
  EXPECTED_MULTIPLIER,
  GAS_MARGIN_PCT,
  FUNDING_HEADROOM,
  RESUMABLE_PHASES,
  capFor,
  expectedPriceFor,
  gasAllowanceFor,
  fundingAmountFor,
  canAfford,
  topUpFor,
  remainingPhases,
  remainingCost,
  resumePlan,
};
