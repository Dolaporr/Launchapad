# Production readiness report

**Date:** 2026-09-13 · **Baseline:** commit `e151f86`, `contracts/baseline/canary-2026-09-13.json`

No mainnet write was made while building this layer. No second token was launched. No contract was
deployed. Every command added here is read-only.

---

## 1. What is now production-ready

### The economic primitive
Proven once on mainnet and re-verifiable from chain at any time.

- A token launches into a **real Uniswap v4 pool** with the entire supply as **permanently locked
  liquidity** — the LP position is owned by Uniswap's `FeeSplitter`, which has no withdraw, burn or
  decrease function. Nobody can unwind it.
- The **creator-fee stream splits 50 / 30 / 20** between three genuinely distinct wallets, every
  wei conserved, with the protocol absorbing at most 2 wei of floor-division dust per split.
- **Payouts are pull-based** via permissionless `withdrawFor`, so the treasury never needs a key,
  never needs gas, and a broken recipient cannot block the others.
- **Attribution is write-once and immutable.** No admin, no allowlist, no pause anywhere in the
  launcher or the rewards contract.

### The verification command
`npm run verify:launch` / `npm run verify:baseline` reconstruct a launch entirely from chain state
and reconcile **every token base unit and every wei**. Against live mainnet: **33/33 VERIFIED**.

It is production-ready in the specific sense that matters: it is correct when the world is messy.
Holders and traders are discovered from logs rather than assumed, so unrelated third-party trading
never breaks it; unreadable ranges and unbalanced totals fail loudly instead of being inferred.

### The frozen baseline and evidence chain
Addresses, roles, split constants, position id, launch transaction and external dependency code
hashes are pinned by literal value plus a semantic hash. The original run record — including its two
failed assertions — is preserved and can no longer be overwritten by any future run.

### Key custody
`npm run custody:check` confirms the canary's creator and pad-owner keys are retained and derive the
recorded addresses, without printing key material. Those wallets hold immutable attribution and may
receive `$CANARY` rewards indefinitely, so they must never be rotated.

### The product data model
`web/launchState.js` and `web/launchDetail.js` present Token → Pool → Locked Liquidity → Trading →
Fees → Revenue Split, with swapped ETH structurally prevented from being presented as revenue and
unknown values rendered as unknown. Both are pure and covered by unit tests.

---

## 2. What remains canary-only

| Thing | Status |
|---|---|
| **Scale** | Exactly **one** token has ever been launched on mainnet. Nothing is proven about a second, concurrent launches, or many pads. |
| **The deployed stack** | The mainnet `LaunchpadFactory` / `Launcher` / `Rewards` were deployed for the canary. They work, but they have served one launch by one wallet. |
| **The web app against mainnet** | `web/config.js` still points at the **testnet** factory. The mainnet market contracts are not wired into the shipped frontend. |
| **Fee collection** | `collectAndSplit` is permissionless but **nobody is paid to call it**. Fees sit in Uniswap's vault until someone does. No keeper exists. |
| **The deployer wallet** | A key generated for public testnet, living in a container `.env`. Fine for ~0.005 ETH; **must not** become the production deployer. |
| **Pad-owner and creator wallets** | Throwaway keys generated in-container. Adequate for a canary, not for anyone's real earnings. |
| **Audit** | **None.** No third party has reviewed these contracts. |
| **Gas figures** | Measured once, at ~0.085 gwei on a quiet chain. Congested-chain behaviour is unmeasured. |

---

## 3. Assumptions that still need a real-user launch

These cannot be settled by more testing. They need a person who is not us.

1. **That a creator will complete the flow unaided.** Every launch so far was driven by a script we
   wrote. Nobody has used the UI to launch a token without the author present.
2. **That the 50 / 30 / 20 split is acceptable to a real creator.** It was approved as a product
   decision and proven mechanically. No creator has ever agreed to it in exchange for launching.
3. **That "you get no tokens, you get a fee stream" is understandable.** This is the single most
   counterintuitive part of the product: the creator's entire supply goes into locked liquidity and
   they receive 50% of a ~10 bps stream on ETH buy volume instead. Whether that reads as generous or
   alarming to a stranger is unknown.
4. **That a pad owner sees value in hosting other people's launches.** Nobody has created a pad for
   anyone but themselves.
5. **That the numbers are legible at real scale.** The canary captured 0.000001 ETH. A real launch
   might capture thousands of times more, or nothing at all, and the UI has never rendered either.
6. **That revenue is non-trivial.** The measured rate is **10 bps of ETH buy volume** and sells earn
   nothing. Whether any token attracts enough buy volume for that to matter is entirely unproven.

**The one third-party trade proves none of this.** An address bought 795 CANARY five blocks after
launch for ~0.000002 ETH — almost certainly an automated launch sniper. It demonstrates the pool is
reachable and that fee capture works on volume we did not create. It is **permissionless activity,
not a user**, and it is recorded that way everywhere in this repository.

---

## 4. Exact results

All captured 2026-09-13. No mainnet write was made.

| Command | Result |
|---|---|
| `npm test` (hermetic) | **274 passing**, 48 pending |
| `npm run test:verify` (mainnet fork) | **18 passing** |
| `npm run test:swaps` (mainnet fork) | **16 passing** |
| `npm run test:fork` (mainnet fork) | **14 passing** |
| `npm run verify:baseline` (live mainnet, read-only) | **VERIFIED — 33/33**, reconciled at block 62,098,262 |
| `node scripts/checkPrivileged.cjs` | **passed** — no undocumented admin surface |
| `npm run custody:check` | **CUSTODY OK** — both canary keys retained |
| `node web/e2e/launch-detail.mjs` (browser, fork) | **ALL CHECKS PASSED** (28 checks) |
| Compile | clean |

There is no typecheck step: the project is plain JavaScript with no TypeScript, deliberately kept
build-step-free so the web app needs no bundler and no CDN.

### The 18 fork regressions

```
a launch with no trading at all
  ✔ verifies, and reconciles the whole supply into pool + burn
  ✔ reports zero fees without claiming anything was earned
REGRESSION: a third party trades BEFORE we verify
  ✔ still reconciles every base unit of supply
  ✔ discovers the stranger and classifies them EXTERNAL, not as an error
  ✔ does not treat an external holder as a privileged party holding supply
  ✔ counts their ETH as volume, never as revenue
REGRESSION: fee reconciliation with MULTIPLE buyers
  ✔ reconciles fees generated by controlled AND external buyers together
  ✔ splits external volume to the same three parties, 50 / 30 / 20
  ✔ separates controlled from external traders
  ✔ still reconciles supply across three separate buyers
  ✔ lifetimeDistributed agrees with the summed split events
REGRESSION: repeated verification after MORE trades
  ✔ remains VERIFIED after additional external trading
  ✔ fees only ever grow, and the earlier snapshot is not contradicted
  ✔ credited still equals withdrawn plus pending for every party
  ✔ survives withdrawals happening between verifications
unverifiable state FAILS rather than being inferred
  ✔ a token this launcher never launched is reported as such
  ✔ an address with no code as the launcher fails instead of throwing
  ✔ refuses a malformed address outright
```

### Three defects the new tests caught in my own work

1. The postmortem stated the third party's implied volume **1000× too small**. Caught by a test
   asserting the residual fee equals 25 bps of that volume. Corrected to 1,999,548,000,000 wei.
2. `readLaunchState` passed pre-encoded ABI words where `encodeCall` expects typed argument
   objects, so the browser view built no state at all. Caught by the browser proof.
3. The verifier fork test called `buyExactIn` without its `recipient` argument, silently failing
   three setup hooks.

---

## 5. Is a real controlled creator launch the next safe milestone?

**Yes — with three conditions, and one honest caveat.**

The mechanism is proven end-to-end on mainnet and is now independently verifiable from chain by
anyone. The remaining unknowns in §3 are all *human* unknowns, and no further engineering resolves
them. A controlled launch by a real creator is exactly the right instrument.

**Conditions before inviting anyone:**

1. **Wire the mainnet contracts into the frontend**, or the creator cannot complete the flow without
   a script. Today `web/config.js` points at testnet.
2. **Replace the container-held keys.** The deployer is a testnet throwaway in a `.env`. A real
   creator must use their own wallet, and the protocol treasury must be a wallet you control
   properly — it already is (`0x82Eb14F2…F1Ef`), which is why the canary used it.
3. **Decide who calls `collectAndSplit`.** A creator who earns fees and cannot see them arrive will
   reasonably conclude the product does not work. Either ship a keeper or make the UI's "Collect"
   action prominent and explain that anyone may call it.

**The caveat:** tell the creator plainly, before they launch, that their entire supply becomes
permanently locked liquidity they cannot reclaim, that their return is a fee stream measured in
basis points of ETH buy volume, and that this has been run exactly once. Anything less is
overselling a one-sample result.

**Not recommended yet:** a public launch, any promotion, or a second canary of our own. The next
launch should be someone else's, or it teaches nothing new.
