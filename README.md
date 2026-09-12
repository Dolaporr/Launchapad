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
| `Launchpad` | Immutable owner/preset/policy/branding; deploys fixed-supply tokens | `launchToken` gated by the pad's immutable launch policy |
| `LaunchToken` | Minimal fixed-supply ERC-20, 18 decimals | **none** — no mint, burn, pause or owner |
| `FeeRouter` | Deterministic fee split, pull-based payouts | **none** |
| `ReserveVault` | Permanently locks the configured reserve ERC-20 | owner may sweep **non**-reserve tokens only |

`111 passing` tests. Run them yourself: `cd contracts && npm test`.

#### Launch policy — who can launch through a pad

Every launchpad picks one of exactly two policies at creation, and it is **immutable**:

| Policy | Who may call `launchToken` | Who owns the new token's supply |
|---|---|---|
| `Open` | **anyone** | the wallet that launched it, not the pad owner |
| `OwnerOnly` | only the pad owner | the pad owner |

`Open` is the mode the product is built around: you create a launchpad, other people launch
tokens through it. A pad owner cannot later close an open pad, cannot seize a token somebody
else launched, and gets no allocation from it — all asserted in `test/LaunchPolicy.test.js`.

The cost of `Open` is spam: anyone can launch anything, including offensive or impersonating
names. There is deliberately no moderation hook on chain; curation belongs in the indexer and
frontend, not in an immutable contract.

### Web (`web/`) — two strictly separated modes, no build step

Static HTML/CSS/JS. A persistent banner always says which mode you are in, and the two never
share state:

**Live mode (`#live`)** — real chain, real transactions.
Connect an injected EVM wallet, detect/switch/add Robinhood Chain testnet, create a launchpad,
launch a token, and watch pending → success/failure with explorer links. Every launchpad, token,
supply and count on these screens is read from chain; addresses come from the events the
contracts actually emitted. `web/chain.js` is the only file that touches a chain.

**Demo mode (everything else)** — `localStorage` only, zero chain access.
The original prototype, for exploring the UX without gas. Every figure starts at zero, is
prefixed `sim $`, and only moves when you press "Simulate a 1k trade".

There is no build step and no CDN: `web/chain.js` hand-rolls its ABI codec with precomputed
selectors, and `contracts/test/WebCodec.test.js` checks every encoding byte-for-byte against
ethers while `WebAbi.test.js` fails CI if any selector drifts from the compiled contracts.

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

### Testnet deploys the factory only

Because canonical NVDA does not exist on testnet, the testnet deployment uses `SKIP_VAULT=1`:

```bash
SKIP_VAULT=1 PROTOCOL_TREASURY=0x… npm run deploy:testnet
```

That deploys the `LaunchpadFactory` alone — no `ReserveVault`, no reserve receiver. The factory's
`supportsNvdaReserve()` then returns **false**, so it is *incapable* of creating an NVDA-preset
launchpad. The honesty boundary is enforced by the contract, not just by the UI copy.

If you do want a reserve leg on a test network, you must deploy a clearly-labelled mock and pass
`SKIP_NVDA_VERIFY=1`. **A mock must never be described as NVDA anywhere in the product.**

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

### Standard preset — ALPHA DEFAULT, NOT FINAL PRODUCT POLICY

Of a 0.60% trade fee: **0.50% to the pad owner, 0.10% to the protocol.** Implemented as exact
sixths (`amount / 6` to protocol, remainder to owner) so no wei is lost to rounding.

**These numbers are a placeholder.** They were chosen to make the accounting legible in the
alpha. They have not been validated against any market, have not been agreed as the product's
real fee policy, and should be expected to change. They are deliberately **not configurable**:
adding knobs before the policy is decided would bake in the wrong abstraction. When a real
policy is chosen it arrives as a new preset, not as a setter.

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
| NVDA Reserve in the live UI | **Deliberately not offered.** Canonical NVDA does not exist on testnet, so an NVDA pad created there could not do what its name claims. The preset still exists in the contracts. |
| Standard economics | **Alpha default, not final product policy.** 0.60% / 0.50% / 0.10% is a placeholder chosen for legibility, not validated against any market. |
| Launchpad re-branding | `name`/`metadataURI` are fixed at creation; re-brand by re-publishing the content behind the URI. |
| Audit | **None.** Do not put real money near this. |
| Deployments | **None.** Nothing has been deployed to any public network. |

---

## Roadmap

1. **Milestone 1 (current):** wallet → create a real launchpad → launch a real token from a
   second wallet → see both on the explorer. The browser flow is built and proven end to end
   (`web/e2e/vertical-slice.mjs`, 37 checks). Public-testnet deployment is pending gas funds.
2. **Milestone 2:** a real trading path, so the fee has something to be charged on.
3. **Milestone 3:** the constrained NVDA buyer module — swap into canonical NVDA only, enforce
   minimum output, deposit into `ReserveVault`, emit an explorer-verifiable trail. Mainnet-only,
   since canonical NVDA does not exist on testnet.
4. **Then, and only then:** the general launchpad-building platform.

## Layout

```
.github/workflows/  ci.yml — clean install, compile, test, privileged-surface + secret scans
contracts/
  contracts/        LaunchpadFactory, Launchpad, LaunchToken, FeeRouter, ReserveVault, IERC20
  contracts/mocks/  test-only helpers (never deploy these)
  scripts/          deploy.cjs, createLaunchpad.cjs, checkPrivileged.cjs
  test/             111 tests
web/
  index.html        shell, mode banner
  app.js            DEMO mode only — localStorage, never touches a chain
  chain.js          the only file that talks to a chain (wallet, ABI codec, reads/writes)
  live.js           LIVE mode UI — every value read from chain
  config.js         deployed factory address (or ?factory=0x… / localStorage)
  e2e/              browser proof of the full vertical slice
```

## End-to-end proof

```bash
# terminal 1 — local chain that reports the testnet chain id
cd contracts && HARDHAT_CHAIN_ID=46630 npx hardhat node
# terminal 2
cd contracts && HARDHAT_CHAIN_ID=46630 SKIP_NVDA_VERIFY=1 NVDA_ADDRESS=0x… \
  PROTOCOL_TREASURY=0x… RESERVE_RECEIVER=0x… \
  npx hardhat run scripts/deploy.cjs --network localhost
cd web && npx http-server -p 4173 &
FACTORY=0x… WALLET_A=0x… WALLET_B=0x… node web/e2e/vertical-slice.mjs
```

The test drives the real UI with a real wallet provider shim (it forwards JSON-RPC to the node
and lets the test pick the active account, so the two-wallet case is genuine — it stubs no
responses). It asserts, among other things, that a token launched by wallet B through wallet A's
open pad is owned **entirely by B**, and that A holds zero of it.

## Licence

MIT.
