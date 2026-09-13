# Verification and product layer

Built on top of the proven mainnet canary (commit `e151f86`). Everything here is **read-only**:
no script in this layer sends a transaction.

---

## 1. The frozen baseline

The one successful mainnet canary is frozen at
[`contracts/baseline/canary-2026-09-13.json`](../contracts/baseline/canary-2026-09-13.json).

| | |
|---|---|
| Chain | 4663 (Robinhood Chain mainnet) |
| `LaunchpadFactory` | `0xB314cd4731c4F3B4025FCcF5B8E0a3072E8BCbde` |
| `LaunchpadFamilyLauncher` | `0x4FFbCb9395a839F02f8baeDc02b42CB6E64d9ea6` |
| `LaunchpadRewards` | `0xC2fE1c6730cc029DcBaC04a04D80baFfC7ed530b` |
| Launchpad (OPEN) | `0x755b0d58Db11c845FB19a28CD5F0717c24098681` |
| `$CANARY` | `0xe848A44Bb9ab5Fc9788e2E6D64b5CbBDd114d7F4` |
| Uniswap v4 position | `2635400` |
| Launch tx | `0x2510145068dcdcfe7a266966a31b60a4ab1c984d7c0b8e9d6d042f693ae3c075` (block 62,053,834) |
| Split | 50 / 30 / 20, immutable |

**Deployed-contract assumptions cannot change silently.**
`test/product/BaselineFrozen.test.js` pins every address, role, split constant, position id, launch
transaction and external dependency code hash as literal values, plus a SHA-256 over that semantic
subset. Adding a note is allowed; moving an address is not — that is a *new* baseline, not an edit.

### Evidence is preserved, corrections are additive

`contracts/canary-report.json` is the contemporaneous record and still reports **2 of 52 assertions
as FAILED**. Those are not rewritten. `canaryExecute.cjs` no longer writes to that path at all —
each run gets `evidence/canary-run-<timestamp>.json` and refuses to overwrite an existing file.

The reconciliation lives separately in
[`canary-2026-09-13.postmortem.json`](../contracts/baseline/canary-2026-09-13.postmortem.json),
which points *at* the primary evidence rather than replacing it. Both failures are recorded as **the
assertion being wrong, not the protocol**.

### Key custody

The canary's pad-owner and token-creator keys are **retained, never rotated or deleted**. Their
attribution is immutable on chain and they may receive `$CANARY` fee rewards indefinitely.

```
npm run custody:check
```

Confirms both keys are present and derive the recorded addresses. It prints booleans and public
addresses only — key material is never printed, logged or written — and it moves no funds.

---

## 2. Deterministic verification

```
TOKEN=0x… LAUNCHER=0x… npm run verify:launch
npm run verify:baseline      # verifies $CANARY from the frozen record
```

`scripts/lib/launchVerifier.cjs` reconstructs a launch **entirely from chain state** and reconciles
every token base unit and every wei. Three rules shape it:

1. **Evidence over assumption.** Addresses may be supplied as a starting point, but every
   relationship is re-derived and re-checked on chain. Nothing is trusted from a stored record.
2. **We are never the only trader.** Holders and traders are *discovered* from `Transfer` logs. A
   wallet we recognise is `controlled`; everything else is `external`. Neither is an error.
3. **Unknown state fails loudly.** An unreadable log range, a reverted call, or a total that does
   not balance FAILS. The launch-event search is bounded and fails rather than guessing a window.

### What it checks

launchpad↔factory relationship · token supply and decimals · pool existence and fee tier ·
**LP ownership / lock status** · `verifyMarketLaunch` · beneficiary NFT ownership ·
creator / pad-owner / treasury attribution in both places · three distinct recipients ·
accrued and collected fees · per-party credited = withdrawn + pending · protocol dust bound ·
contract solvency · `lifetimeDistributed` against summed events · **supply reconciled exactly**.

### Result against live mainnet

```
VERIFIED — 33/33 checks passed, reconciled at block 62081910

SUPPLY RECONCILIATION
  total supply      1000000000000000000000000000
  locked in pool     999601544770340127288452187
  burned                                   17786
  holder              795456757487108587460  0x2be87aD7…4874  [external]
  holder           397659772902385602942567  0x90f48E9B…C461  [controlled]
  EXACT             true

FEE ACCOUNTING  (this is the revenue)
  LP fee collected (native)   0.00000250499887 ETH
  claimed into rewards        0.000001001999548 ETH
  creator         credited 500999774000  withdrawn 500999774000  pending 0
  launchpadOwner  credited 300599864400  withdrawn 300599864400  pending 0
  protocol        credited 200399909600  withdrawn 200399909600  pending 0
  EXACT                       true
```

---

## 3. The launch record schema

[`contracts/schema/launch-record.schema.json`](../contracts/schema/launch-record.schema.json)
defines what must be persisted for a launch to be independently auditable later: chain id, contract
addresses, token, pool/position, immutable roles, launch transaction, dependency code hashes,
verification status, supply reconciliation, fee accounting, trading, and `reconciledAtBlock`.

All integers are decimal **strings** — wei and 18-decimal balances exceed `Number.MAX_SAFE_INTEGER`
and must never pass through a JS number.

A record is **evidence, not configuration**: nothing in it is trusted without re-verification.

---

## 4. The product layer

`web/launchState.js` (model) and `web/launchDetail.js` (view) present one launch as:

**Token → Pool → Locked Liquidity → Trading Activity → Fees → Revenue Split**

Shown separately: total activity, creator fees, pad-owner fees, protocol fees, claimable,
withdrawn, and external vs controlled trading.

### Two rules the product must never break

**Swapped ETH is never revenue.** A buyer's ETH bought tokens; it was never ours. Trading activity
and fee capture are separate structures with separate language, `revenue` never derives from
`volume` in code, and the summary line leads with fee capture. For the canary that is **0.001 ETH
swapped versus 0.000001001 ETH actually captured** — a thousandfold difference that any conflation
would hide.

**Unknown renders as unknown.** A value that could not be established shows as *"not established"*,
never as `0`. An unprovable liquidity lock is marked unknown, not "unlocked". A failed verification
replaces the page banner rather than rendering clean-looking figures. ETH volume is not derivable
from `Transfer` logs alone, so it stays null rather than being estimated.

Formatting truncates rather than rounds, so a revenue figure is never displayed larger than it is.

### On third-party trading

External trading is **permissionless activity on a public pool**. It is displayed, labelled
*"third party (permissionless)"*, and explicitly disclaimed:

> Third-party trading is permissionless activity on a public pool. It is not evidence of organic
> demand or of a real user choosing this token.

The $CANARY buyer was almost certainly an automated launch sniper. It proves the pool is reachable
and that fee capture works on volume we did not create — and nothing about demand.

---

## 5. Regression tests

Every failure the live run produced is now a test.

| Failure | Test |
|---|---|
| Third-party trade before verification | `test/fork/VerifyLaunch.fork.test.js` |
| Fee reconciliation with multiple buyers | `test/fork/VerifyLaunch.fork.test.js` |
| Repeated verification after more trades | `test/fork/VerifyLaunch.fork.test.js` |
| Base-fee rise between estimation and send | `test/product/CanaryPlan.test.js` |
| Signer underfunded under `maxFeePerGas` | `test/product/CanaryPlan.test.js` |
| Interrupted deployment | `test/product/CanaryPlan.test.js` |
| Idempotent resume | `test/product/CanaryPlan.test.js` |
| Partially completed stack | `test/product/CanaryPlan.test.js` |
| Resume-aware budget accounting | `test/product/CanaryPlan.test.js` |

The two operational bugs are reproduced with their **exact live numbers**: `maxFeePerGas 117700593`
against `baseFee 131992000`, and the allowance calculation that produced
`gas required exceeds allowance (1290580)`.

---

## 6. Commands

| Command | What it does |
|---|---|
| `npm test` | Full hermetic suite |
| `npm run verify:baseline` | Verify $CANARY from the frozen record (read-only) |
| `npm run verify:launch` | Verify any launch: `TOKEN=… LAUNCHER=…` |
| `npm run custody:check` | Confirm canary keys are retained |
| `npm run test:verify` | Verifier regression tests on a mainnet fork |
| `npm run test:swaps` | Real-swap fee measurement on a fork |
| `npm run canary:rehearse` | Full canary sequence on a fork |
