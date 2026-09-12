# Launchpad Factory — alpha

A permissionless **launchpad factory** for [Robinhood Chain](https://docs.robinhood.com/chain/).

Most launchpads let you launch a coin. This one is a level up: anyone can create their own
**branded launchpad**, choose its **economic module**, and launch tokens underneath it.

The first differentiated economic module is **NVDA Reserve**.

---

## Read this before you read anything else

**Nothing in this repository buys NVDA.** Not the contracts, not the web app, not the scripts.

The NVDA Reserve module is currently an *accounting* template: it splits a native-currency fee
80/20 and credits the 80% to a reserve receiver address. Turning that credit into real,
verifiable NVDA needs a constrained buyer module (swap into the canonical NVDA token, enforce
minimum output, deposit into `ReserveVault`) **which has not been written yet**.

Two further facts worth knowing up front, both verified on 2026-09-12:

1. **There is no mandatory 1% fee on chain.** The launched tokens are plain ERC-20s with no
   transfer hook, and there is no on-chain market. Nothing forces a trade to pay `FeeRouter`.
   The fee is real arithmetic in a real contract; it just has no enforcement point yet.
2. **Canonical NVDA exists on mainnet only.** Robinhood's live asset registry lists Stock Tokens
   on chain `4663` and nothing on testnet `46630`. The NVDA leg therefore *cannot* be proven on
   testnet with the real asset — a testnet run needs a clearly-labelled mock.

Everything in this README that says "works" has a test or a command behind it.

---

## What actually works today

### Contracts (`contracts/`) — compiled, tested, not audited, not deployed

| Contract | What it does | Privileged powers |
|---|---|---|
| `LaunchpadFactory` | Anyone creates a launchpad; each gets its own `FeeRouter` | **none** |
| `Launchpad` | Immutable owner/preset/branding; deploys fixed-supply tokens | owner-only `launchToken` |
| `LaunchToken` | Minimal fixed-supply ERC-20, 18 decimals | **none** — no mint, burn, pause or owner |
| `FeeRouter` | Deterministic fee split, pull-based payouts | **none** |
| `ReserveVault` | Permanently locks the configured reserve ERC-20 | owner may sweep **non**-reserve tokens only |

`63 passing` tests. Run them yourself: `cd contracts && npm test`.

### Web (`web/`) — a design and flow prototype, no chain connection

Static HTML/CSS/JS, no build step. It creates pads, launches tokens, shows an owner dashboard
and simulates fee accounting, all in `localStorage`. There is **no wallet, no RPC call and no
contract read anywhere in it**, and the UI says so on every screen. All figures start at zero
and only move when you press "Simulate a 1k trade".

---

## Run it locally

Requires Node.js 20+.

### Contracts

```bash
cd contracts
npm install
npm run compile
npm test
```

To exercise the whole flow against a local chain:

```bash
npx hardhat node                       # terminal 1
# terminal 2:
npx hardhat run scripts/deploy.cjs --network localhost
FACTORY_ADDRESS=0x... PAD_NAME="My Pad" PAD_PRESET=standard \
  TOKEN_NAME="Alpha" TOKEN_SYMBOL="ALPHA" TOKEN_SUPPLY=1000000000 \
  npx hardhat run scripts/createLaunchpad.cjs --network localhost
```

### Web

```bash
cd web
npx http-server -p 4173
```

Open <http://localhost:4173>.

---

## Deploying to Robinhood Chain testnet

```bash
cd contracts
cp .env.example .env     # then fill it in — .env is gitignored and must stay that way
npm run deploy:testnet
```

`.env` needs `DEPLOYER_PRIVATE_KEY` (a throwaway wallet), `PROTOCOL_TREASURY`,
`RESERVE_RECEIVER` and `NVDA_ADDRESS`.

The deploy script deliberately refuses to do the wrong thing:

- **Refuses mainnet** unless `ALLOW_MAINNET=1` is set explicitly.
- **Refuses an unverified reserve asset.** It fetches Robinhood's live asset registry
  (`https://api.robinhood.com/rhj/assets`) at deploy time and aborts if `NVDA_ADDRESS` is not the
  canonical NVDA entry, or is registered on a different chain than the one you are deploying to.
  No address is hard-coded anywhere in this repo. Override only with `SKIP_NVDA_VERIFY=1`, which
  prints a loud warning and records `reserveTokenVerified: false` in the deployment record.
- **Refuses to wire `ReserveVault` as `RESERVE_RECEIVER`.** The vault holds the reserve ERC-20 and
  rejects native currency by design; pointing fees at it made every NVDA-preset route revert.

Because there is no canonical NVDA on testnet, a testnet run means deploying a mock reserve token
and passing `SKIP_NVDA_VERIFY=1`. **A mock must never be described as NVDA anywhere in the product.**

### Network details

Verified 2026-09-12 against <https://docs.robinhood.com/chain/connecting>:

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `4663` | `46630` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| Gas token | ETH | ETH |

Robinhood documents these public RPCs as rate-limited and *not recommended for production*;
Alchemy and QuickNode endpoints are the documented production path. Re-verify before any
deployment rather than trusting this table.

---

## The economics

### Standard preset

Of a 0.60% trade fee: **0.50% to the pad owner, 0.10% to the protocol.** Implemented as exact
sixths (`amount / 6` to protocol, remainder to owner) so no wei is lost to rounding.

### NVDA Reserve preset

Of a mandatory 1.00% trade fee:

```
0.80%  ->  reserve leg   (intended: buys canonical tokenized NVDA -> locked vault)
0.20%  ->  execution/keeper costs
0.00%  ->  team/creator
```

There is no creator allocation out of the reserve fee, and a test asserts it.

`FeeRouter` **credits** these amounts rather than pushing them. That is deliberate: pushing meant
one beneficiary that rejects native currency could brick fee routing for an entire launchpad.
Beneficiaries call `withdraw()`, or anyone may call `withdrawFor(beneficiary)` — value can only
ever move to the beneficiary, so the caller gains nothing.

### The proof gate

Before any reserve number may be shown to a user as a reserve, all four must exist:

1. the canonical NVDA contract address, verified against the live registry,
2. the vault address holding it,
3. an explorer link to the actual buy transaction,
4. a reserve balance read from chain, **scaled by the ERC-8056 `uiMultiplier`** — Robinhood Stock
   Tokens carry a multiplier, so raw `balanceOf` misreports the holding. `ReserveVault` exposes
   `reserveUIMultiplier()` so a frontend cannot get this wrong by accident.

---

## Known gaps and mocks

| Thing | Status |
|---|---|
| NVDA purchase | **Does not exist.** No DEX integration anywhere. |
| 1% fee enforcement | **Not enforced.** No on-chain market; nothing calls `FeeRouter`. |
| Trading / bonding curve | **Does not exist.** `launchToken` mints 100% of supply to the creator. |
| Web ↔ chain | **Not connected.** The web app is `localStorage` only. |
| Token launch permissions | Owner-only. A public launch path is a later decision. |
| Launchpad re-branding | `name`/`metadataURI` are fixed at creation; re-brand by re-publishing the content behind the URI. |
| Audit | **None.** Do not put real money near this. |
| Deployments | **None.** Nothing has been deployed to any public network. |

---

## Roadmap

1. **Milestone 1 (next):** wallet → create a real launchpad on testnet → launch a real token →
   see both on the explorer. `scripts/createLaunchpad.cjs` already does the chain half; the web
   app needs wallet wiring.
2. **Milestone 2:** a real trading path, so the fee has something to be charged on.
3. **Milestone 3:** the constrained NVDA buyer module — swap into canonical NVDA only, enforce
   minimum output, deposit into `ReserveVault`, emit an explorer-verifiable trail. Mainnet-only,
   since canonical NVDA does not exist on testnet.
4. **Then, and only then:** the general launchpad-building platform.

## Layout

```
contracts/
  contracts/        LaunchpadFactory, Launchpad, LaunchToken, FeeRouter, ReserveVault, IERC20
  contracts/mocks/  test-only helpers (never deploy these)
  scripts/          deploy.cjs, createLaunchpad.cjs
  test/             63 tests
web/                index.html, styles.css, app.js — static demo, no build step
```

## Licence

MIT.
