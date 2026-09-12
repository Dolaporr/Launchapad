# Contracts

Hardhat project. Solidity `0.8.24`, optimizer on (200 runs).

```bash
npm install
npm run compile
npm test          # 63 tests
```

## What is here

| File | Role |
|---|---|
| `LaunchpadFactory.sol` | Permissionless launchpad creation. No owner, no admin. |
| `Launchpad.sol` | One branded pad. Immutable owner/preset/branding. Deploys tokens. |
| `LaunchToken.sol` | Minimal fixed-supply ERC-20. No mint, burn, pause or owner. |
| `FeeRouter.sol` | Deterministic fee split with pull-based payouts. No admin. |
| `ReserveVault.sol` | Locks the configured reserve ERC-20 permanently. |
| `IERC20.sol` | ERC-20 plus the ERC-8056 scaled-UI subset used by Robinhood Stock Tokens. |
| `mocks/TestHelpers.sol` | **Test only.** Never deploy. |

## Every privileged capability in the system

This is the complete list. If it is not here, it does not exist.

1. **`Launchpad.launchToken` is owner-only.** The owner is immutable: it cannot be transferred or
   renounced. A lost key means the pad can never launch another token.
2. **`ReserveVault.sweepNonReserve` is owner-only.** It can move any ERC-20 *except* the reserve
   token, which it explicitly rejects. The vault owner is immutable.

That is all. No contract here has a pause, an upgrade path, a proxy, a `delegatecall`, a fee
switch, a mint function or an admin role. Tests assert the absence of these by inspecting each
ABI, so adding one silently will fail CI.

## What is immutable, and actually immutable

`Launchpad.owner`, `Launchpad.feeRouter`, `Launchpad.preset`, `FeeRouter`'s four addresses/preset,
`ReserveVault.owner` and `ReserveVault.reserveToken` are Solidity `immutable` — baked into
bytecode. `Launchpad.name`, `Launchpad.metadataURI`, `LaunchToken.name` and `LaunchToken.symbol`
are set once in a constructor and have no setter, so they are fixed too.

## The honesty boundary

`FeeRouter` does **not** perform a swap into NVDA. Under the `NvdaReserve` preset it credits 80%
of the routed fee to `reserveReceiver` and 20% to `protocolTreasury`, and that is the whole
mechanism. `reserveReceiver` must eventually become an audited buyer module that can only output
canonical NVDA into `ReserveVault`.

`reserveReceiver` **must not be the `ReserveVault`.** The vault rejects native currency by design,
so wiring fees at it makes every NVDA-preset route revert. `scripts/deploy.cjs` refuses to do it.

## Changes made during the audit (2026-09-12)

- **`FeeRouter` push → pull.** Fees are credited and withdrawn, not force-pushed. The old code
  used `call` + `require(ok)` per beneficiary, so any beneficiary that rejects native currency
  bricked all fee routing for that launchpad. With the shipped deploy wiring
  (`reserveReceiver` = `ReserveVault`) this meant **every NVDA-preset fee route reverted**.
  Split arithmetic is unchanged.
- **`ReserveVault` rejects native explicitly** rather than trapping value with no withdrawal path,
  gained `reserveUIMultiplier()` for ERC-8056 correctness, tolerates non-standard ERC-20 returns,
  and rejects empty/zero-address sweeps.
- **Metadata bounds** on launchpad and token names/symbols; pagination on both growing arrays.
- **Custom errors** throughout, replacing string reverts.
- **`deploy.cjs`** now verifies the reserve asset against the live Robinhood registry, blocks
  mainnet behind `ALLOW_MAINNET=1`, refuses the vault as fee sink, and writes a deployment record.
- **`.env.example`** no longer ships a hard-coded NVDA address.

## Not done

No audit. No deployment. No NVDA purchase path. No on-chain market, so no fee enforcement.
