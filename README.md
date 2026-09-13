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
2. **There is no NVDA on Robinhood Chain testnet.** Verified 2026-09-12 — see
   "Stock Tokens on testnet" below. Robinhood *does* run official Stock Tokens on testnet, but
   NVDA is not one of them, so the NVDA leg cannot be proven on testnet at all. The canonical
   NVDA (`0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`) is mainnet-only.

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

### Stock Tokens on testnet — what is and is not real

Investigated 2026-09-12 from the chain itself, after funding a wallet from the official faucet.

The faucet (`0x8762F93772c663c6a88Ba50900bd5381df2717Be`, a verified contract named `Faucet`)
sent 0.01 ETH and five Stock Tokens by minting them in one transaction:

| Symbol | Name | Testnet address |
|---|---|---|
| TSLA | Tesla | `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` |
| AMD | AMD | `0x71178BAc73cBeb415514eB542a8995b82669778d` |
| AMZN | Amazon | `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` |
| NFLX | Netflix | `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93` |
| PLTR | Palantir Technologies | `0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0` |

These look like genuine Robinhood testnet infrastructure: each is a **verified `BeaconProxy`** over
a shared implementation named `Stock` (`0xBd14156E05c6AF28ad39aA53a2AB8eB9CDf657DA`), 18 decimals,
implementing ERC-8056 with `uiMultiplier()` returning exactly `1.0`. TSLA alone has ~221k holders.

**There is no NVDA among them**, and the faucet contract holds only those five plus `HODLHOOD`.

The testnet *does* contain many contracts using the `NVDA` ticker — "Mock NVDA Stock Token",
"NVIDIA (Testnet - No Real Value)", two different "Tokenized NVDA", "NVDA Test Stock", and more.
**Every one of them is unverified and none is a proxy over the official `Stock` implementation.**
They are anonymous third-party mocks. Treating any of them as NVDA would be exactly the mistake
Robinhood's docs warn about: a matching ticker at a different address is not a Stock Token.

Robinhood's asset registry (`https://api.robinhood.com/rhj/assets`) lists **194 deployments, all
on chain 4663**, and no testnet addresses at all — so it cannot be used to bless a testnet asset.

**Conclusion: no reserve leg is deployed on testnet, and none should be.** The testnet factory's
`supportsNvdaReserve()` returns `false`, so it is structurally incapable of creating an NVDA pad.

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
| NVDA purchase | **Does not exist.** Not started. |
| 1% fee enforcement | **Not enforced** on the `FeeRouter` path — it has no market. The market path (Milestone 2.5) earns instead through Uniswap's own creator-fee stream, which is enforced by the pool. |
| Trading / bonding curve | **No bonding curve, by design.** Real trading comes from a Uniswap v4 pool created at launch. `Launchpad.launchToken` still mints 100% to the creator and creates **no market** — it is not the production path, and `verifyMarketLaunch` returns false for anything it produces. |
| Market contracts on chain | **Deployed on mainnet by the canary.** See the baseline record. One token only; no second launch without approval. |
| Real-user validation | **None.** The canary's creator and pad owner were our own wallets. The one third-party trade was permissionless bot activity, NOT evidence of demand. |
| NVDA Reserve in the live UI | **Deliberately not offered.** Canonical NVDA does not exist on testnet, so an NVDA pad created there could not do what its name claims. The preset still exists in the contracts. |
| Standard economics | **Alpha default, not final product policy.** 0.60% / 0.50% / 0.10% is a placeholder chosen for legibility, not validated against any market. |
| Launchpad re-branding | `name`/`metadataURI` are fixed at creation; re-brand by re-publishing the content behind the URI. |
| Audit | **None.** Do not put real money near this. |
| Deployments | **Testnet only.** The Milestone 1 factory is live on Robinhood Chain testnet (see "Live deployment"). Nothing is on mainnet. |

---

## Roadmap

1. **Milestone 1 — DONE, live on public Robinhood Chain testnet (chain 46630).**
   See "Live deployment" below. Wallet A created an Open launchpad; wallet B — a different
   wallet — launched a token through it and holds 100% of its supply.
2. **Milestone 3 — MAINNET CANARY EXECUTED, then productised.**
   One controlled canary ran on Robinhood Chain mainnet on 2026-09-13: `$CANARY`
   ([`0xe848A44B…d7F4`](https://robinhoodchain.blockscout.com/address/0xe848A44Bb9ab5Fc9788e2E6D64b5CbBDd114d7F4))
   launched into a real Uniswap v4 pool with liquidity permanently locked, and fees split
   50 / 30 / 20 to three genuinely distinct wallets. It is frozen as the proven baseline and
   re-verifies from chain at **33/33 checks**, reconciling every token unit and every wei.
   On top of it: a deterministic verification command, a launch-record schema, and a product
   layer that shows one launch as Token → Pool → Locked Liquidity → Trading → Fees → Revenue.
   See [`docs/verification-and-product-layer.md`](docs/verification-and-product-layer.md).
   **No second token has been launched and no further mainnet write is planned.**
3. **Milestone 2 + 2.5 — built and validated on a mainnet fork; superseded by the canary above.**
   `LaunchpadFamilyLauncher` + `LaunchpadRewards` launch a token straight into a real Uniswap v4
   pool via Robinhood Chain's official Liquidity Launchpad, with liquidity permanently locked and
   the creator-fee stream split **50 / 30 / 20** between token creator, launchpad owner and
   protocol. Validated by **real swaps** on a fork: the measured rate reaching that stream is
   **10 bps of ETH buy volume** (Uniswap's 25 bps LP fee × the 40% ETH-side share routed to the
   beneficiary vault). Sells pay their fee in the token and earn us nothing.
   See [`docs/milestone-2-market-architecture.md`](docs/milestone-2-market-architecture.md).
   **No mainnet transaction has been sent.**
4. **Next:** the constrained NVDA buyer module — swap into canonical NVDA only, enforce
   minimum output, deposit into `ReserveVault`, emit an explorer-verifiable trail. Mainnet-only,
   since canonical NVDA does not exist on testnet.
5. **Then, and only then:** the general launchpad-building platform.

## Live deployment — Robinhood Chain testnet (chain 46630)

| What | Address / tx |
|---|---|
| `LaunchpadFactory` | [`0x26481da19fC7ac724DE7Dd52f98f7596f2aaBB97`](https://explorer.testnet.chain.robinhood.com/address/0x26481da19fC7ac724DE7Dd52f98f7596f2aaBB97) |
| Factory deploy tx | [`0x259edeba…96c251`](https://explorer.testnet.chain.robinhood.com/tx/0x259edebafb8ba50628bb5ba13113435379337a969f8ec154987103747096c251) |
| Launchpad "Foundry Genesis" (Open) | [`0x1d8731DeE6263C52875247446cb25A8306aBD36f`](https://explorer.testnet.chain.robinhood.com/address/0x1d8731DeE6263C52875247446cb25A8306aBD36f) |
| Launchpad creation tx | [`0x7dad447a…de7901`](https://explorer.testnet.chain.robinhood.com/tx/0x7dad447afe92b14c8b0c2b66295ccd5668d52b30820b836c4ed3c14716de7901) |
| Token "Genesis Coin" ($GEN) | [`0xC988361051F8a233c0eC918b37c7D92c8f86a68e`](https://explorer.testnet.chain.robinhood.com/address/0xC988361051F8a233c0eC918b37c7D92c8f86a68e) |
| Token launch tx (by wallet B) | [`0x3b981df4…157c9e`](https://explorer.testnet.chain.robinhood.com/tx/0x3b981df48f3e07725dcbc7cdcd538e2cdee53d945ab80b983b316594d6157c9e) |

Pad owner (wallet A) `0x90f48E9BFdDe2cbf6B1592741F3C0973e819C461`; token creator (wallet B)
`0x957687fFBd517D52f7825CBdfcf53C6b456d8efa`. Read back from the public RPC: the pad's
`launchPolicy()` is `1` (Open), `canLaunch()` is true for arbitrary addresses, wallet B holds the
entire 1,000,000,000 $GEN supply and **wallet A holds zero of it**.

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
