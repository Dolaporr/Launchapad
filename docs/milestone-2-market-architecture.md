# Milestone 2 — Market Architecture Memo

**Status:** IMPLEMENTED AND PROVEN ON A MAINNET FORK. Economics approved at 50/30/20.
Production contracts written and tested; nothing deployed, no mainnet transaction sent.
See "Implementation" at the end for what was built and what the fork tests prove.
**Date of on-chain readings:** 2026-09-12. Every address below was read from chain or from
Uniswap's published deployment registry, never from memory.

---

## Recommendation, up front

**Use Uniswap's Liquidity Launchpad. Do not build a bonding curve or an AMM.**

The infrastructure you asked about is real, deployed on Robinhood Chain mainnet, permissionless,
and already does the hard part: it creates a Uniswap v4 pool, seeds it with the entire token
supply as a single-sided position, permanently locks that position, and streams a share of the
trading fees to a per-token beneficiary.

It does **not** support our three-party model directly. Closing that gap needs **one small
contract that we own** — roughly 150 lines, no Uniswap code modified, no v4 hook. That contract
is prototyped and tested in this repo (13 tests).

The one thing that genuinely blocks us: **the Liquidity Launchpad is not deployed on Robinhood
Chain testnet.** Details in "Testnet vs mainnet" below. This is the most important finding in
this memo and it shapes the whole plan.

---

## 1. Exact official contracts we would call

Chain **4663 (Robinhood Chain mainnet)**. Source: Uniswap's own machine-readable registry at
`https://developers.uniswap.org/deployments.json`, cross-checked by reading bytecode and state
from `https://rpc.mainnet.chain.robinhood.com`. All 8 contracts I probed returned live bytecode.

### Liquidity Launchpad

| Contract | Address | Role |
|---|---|---|
| `LiquidityLauncher` | `0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0` | **Entry point.** Permissionless. |
| `InstantLaunchStrategy#creator-fees` | `0x23f8209572b4a1C2AD88A42749E830791Fb027f1` | The launch we want |
| `InstantLaunchStrategy#no-creator-fees` | `0xAD44D55E7f8337C3cE113fBb591486E85be104b2` | Same code, no creator stream |
| `FeeSplitter#creator-fees` | `0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf` | Holds LP NFTs, splits fees |
| `FeeSplitter#no-creator-fees` | `0x222D6d4f1ce59b0d48D5505114eC8Addc90A4359` | |
| `UERC20BeneficiaryVault` | `0xd35E9CA72F64C7F93BE30fad67524323396B36D7` | **Per-token creator stream** |
| `UniversalRouterStrategy` | `0x1242c9439d589cAE85E121B1f79f2aF51e91DCEE` | Alternative strategy |
| `LBPStrategy` | `0x05d552391067389EE44fec3924157ed33F976000` | Liquidity bootstrapping |
| `ContinuousClearingAuctionFactory` | `0x000000001F26a0044BaA66024e7b6599c61963F8` | Auction launches |
| `InitializerHook` | `0xD462a559337859369EF271814851A18F496ba000` | Used by *other* strategies |
| `TokenSplitter` | `0x4F5E3FBb9745358A92Da5674305FAb8D2B8a73cE` | |
| `CompoundingClaimRecipient` | `0xf9526Dd3361fe0ba6b7a99533ed471D3E808E99a` | Uniswap's own fee sink |
| `BuybackAndBurnClaimRecipient` | `0xa1ba4CC12654D2b188e3ba77dc86c75cA47f1A4e` | Reference pattern |
| `VestingClaimRecipient` | `0xeF451B293ED8C61d20f7d13ef336a496F0cc2c26` | Reference pattern |

### v4 core / periphery

| Contract | Address |
|---|---|
| `PoolManager` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| `PositionManager` | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| `StateView` | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| `V4Quoter` | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| `UniversalRouter` | `0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99` |
| `Permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

`Permit2` is independently confirmed by Robinhood's own docs for both 4663 and 46630.

**Deprecated — do not use:** `LiquidityLauncher#v3.0.0` `0x00004c4ccc709Ef590F7C81102C0689F0263D4e9`,
`LBPStrategy#v3.0.0`, `TokenSplitter#v3.0.0`. Uniswap marks these `deprecated` in the registry
while leaving them on chain. Pin addresses explicitly; never resolve them by name at runtime.

---

## 2. Launch lifecycle

`LiquidityLauncher` has **no owner, no allowlist, no pause, and no access control of any kind.**
Anyone can call it. Its whole body is four functions plus a multicall. This is what makes it
usable underneath an OPEN pad.

```
Launchpad.family launch contract
  └─ LiquidityLauncher.multicall([
       permit(...)                                    // Permit2 approval, first time only
       depositToken(token, amount)                    // pulls supply via Permit2
       distributeToken(token, Distribution{
           strategy:  InstantLaunchStrategy#creator-fees,
           amount:    1_000_000_000e18,
           configData: abi.encode(InstantLaunchConfig{ feeBeneficiary })
       }, salt)
     ])
```

Inside `initializeDistribution`, the strategy:

1. rejects any caller that is not the launcher;
2. **requires `totalSupply` to be exactly `1_000_000_000e18` and `decimals()` to be 18** — a hard
   constraint on our token contract;
3. pulls the entire supply (reverts on fee-on-transfer tokens);
4. initializes a v4 pool: `currency0 = native ETH`, `currency1 = token`, `fee = 2500` (25 bps),
   `tickSpacing = 25`, **`hooks = address(0)`**;
5. mints **one single-sided LP position** holding the whole supply, from `MIN_LAUNCH_TICK`
   (−160,100) up to `initialTick` (**198,050** on the live deployment);
6. calls `beneficiaryVault.registerBeneficiary(tokenId, feeBeneficiary)`, minting a transferable
   ERC-721 (`Fee Beneficiary` / `FEEB`) whose id **is** the LP position id;
7. transfers the LP NFT to the `FeeSplitter` — **permanently**.

Our existing `LaunchToken` needs one change to qualify: a fixed 1e9 supply at 18 decimals.

---

## 3. Liquidity lifecycle

- **Entirely single-sided at launch.** No ETH is seeded. The pool opens at a price set by
  `initialTick` and the first buyers walk the price up the curve. This *is* the bonding-curve-like
  behaviour — implemented as a concentrated-liquidity range, not a custom curve.
- **Liquidity is permanent.** The LP NFT lives in the `FeeSplitter`, which exposes only
  `collectFees` and `increaseLiquidity`. There is **no withdraw, no burn, no decrease**. Nobody —
  not the creator, not us, not Uniswap — can pull the launch liquidity. This is a strong,
  verifiable product claim we can make honestly.
- **Fee collection is permissionless:** `FeeSplitter.collectFees(uint256[] tokenIds)`. Anyone can
  trigger it; the fees can only go where the immutable splits say.

---

## 4. How creator fees actually work (measured, not assumed)

The pool charges a **static 25 bps LP fee**. Those fees accrue to the locked position, and
`FeeSplitter.getSplits()` is immutable. Read live from mainnet:

**`FeeSplitter#creator-fees`:**

| Recipient | Native (ETH) side | Token side |
|---|---|---|
| `UERC20BeneficiaryVault` | **40%** | 0% |
| `CompoundingClaimRecipient` (Uniswap) | 60% | 100% |

**`FeeSplitter#no-creator-fees`:** `CompoundingClaimRecipient` takes 100% / 100%.

So the creator stream is **40% of the ETH side of a 25 bps LP fee**, and nothing of the token
side. The `UERC20BeneficiaryVault` then attributes that per position, and the holder of the
beneficiary NFT calls `claim(tokenId, minCurrency0Amount, minCurrency1Amount)` to collect.

Unregistered positions fall back to `nativeFallback = 0x2aC03e14Cfe755426DaAEe0a4994184Ce81482F8`
and `tokenFallback = 0x000000000000000000000000000000000000dEaD` (burned).

**The load-bearing fact:** the beneficiary claim is a *transferable ERC-721*, and
`feeBeneficiary` is just an address. It can be a contract. That is the entire basis of the design
below.

---

## 5. Can Uniswap's FeeSplitter serve our three-party model directly?

**No.** Two independent reasons:

1. `FeeSplitter`'s splits are **immutable and global** — one configuration for every launch that
   uses it. Our launchpad-owner share varies per launchpad and our creator share varies per token.
2. `InstantLaunchConfig` exposes exactly **one** per-launch address. There is no second slot.

We also cannot deploy our own `FeeSplitter` with three recipients, because the recipients would
still be fixed globally, and because the strategy hard-codes which splitter it uses.

### The smallest adapter that closes the gap

One contract, named as `feeBeneficiary` on every Launchpad.family launch:

```
        25 bps LP fee on every swap
                  │
         Uniswap FeeSplitter          (immutable, Uniswap's)
          ├── 60% ETH + 100% token → Uniswap
          └── 40% ETH ──────────────→ UERC20BeneficiaryVault  (Uniswap's)
                                          │  per-tokenId, paid to NFT holder
                                          ▼
                              LaunchpadRewards   ◄── we own this, ONE deployment
                                          │
                      ┌───────────────────┼───────────────────┐
                      ▼                   ▼                   ▼
                token creator      launchpad owner     Launchpad.family
```

`LaunchpadRewards` holds the beneficiary NFT for every token we launch, keeps a
`tokenId → {creator, padOwner}` registry written once at launch, claims from the vault, and
sub-splits the proceeds. **No Uniswap contract is modified, forked, or wrapped.**

---

## 6. Can one module service many pools?

**Yes — and Uniswap already proves the pattern.** Their `FeeSplitter` is explicitly described in
its own source as "the **singleton** fee splitter that permanently locks every launch position",
and one `UERC20BeneficiaryVault` serves every launch on the chain, keyed by position id.

Our adapter uses the same shape: state keyed by `tokenId`, one deployment, unbounded pools. The
PoC test *"scales to many pools without redeploying anything"* runs 12 independent pools with
distinct creators and pad owners through a single contract and checks the accounting.

**Bespoke per-token fee contracts are unnecessary and would be strictly worse** — more gas per
launch, more deploy failure modes, more addresses to index, and no benefit.

---

## 7. Is a v4 hook required?

**No.** The InstantLaunch pool is created with `hooks = IHooks(address(0))`. Uniswap's own
launchpad is hookless.

A hook would only be needed to tax swaps *beyond* the LP fee — e.g. to enforce a protocol fee on
every trade regardless of liquidity. That would mean deploying our own pool with our own hook,
which means **not** using the Liquidity Launchpad at all, and taking on hook-address mining, hook
security review, and liquidity fragmentation.

**Recommendation: no hook.** Take revenue from the creator-fee stream we already control. Revisit
only if the economics genuinely cannot be expressed as a share of that stream.

---

## 8. Where fee enforcement occurs

Four distinct layers, only the last of which is ours:

| Layer | Enforced by | Mutable? |
|---|---|---|
| 25 bps LP fee on every swap | Uniswap v4 `PoolManager` (static pool fee) | No — fixed at pool creation |
| 40/60 ETH, 0/100 token split | Uniswap `FeeSplitter` | No — immutable config |
| Per-token attribution of the 40% | Uniswap `UERC20BeneficiaryVault` | Only by transferring the NFT |
| **Creator / pad owner / protocol split** | **`LaunchpadRewards` (ours)** | **No — immutable by design** |

Our enforcement point is the moment of launch: whoever is written into `attributeLaunch` earns
for the life of the pool. This is on-chain, not frontend state — consistent with the rule we
adopted in Milestone 1.

---

## 9. What we need to own and write

| Contract | Size | Purpose |
|---|---|---|
| `LaunchpadRewards` | ~150 lines | Beneficiary-NFT holder + three-way splitter. **Prototyped.** |
| `LaunchpadFamilyLauncher` | ~100 lines | Creates token, calls `LiquidityLauncher`, attributes the launch atomically |
| `LaunchToken` (modify) | small | Fix supply at 1e9 × 18 decimals to satisfy the strategy |

**What we delete from the Milestone 1 design:** `FeeRouter` and `ReserveVault` have no role in
this path. `FeeRouter` was accounting for a fee that no market charged; Uniswap now charges a real
one. Keep `LaunchpadFactory` and `Launchpad` for branding, ownership, launch policy and the
registry — they remain correct and are unaffected.

---

## 10. Attack surfaces and privileges

**Ours:**

- **`registrar` is trusted.** Only it can attribute a launch. If its key leaks, an attacker can
  attribute *future* launches to themselves. Mitigation: the registrar should be the launcher
  contract itself, not an EOA, so attribution is atomic with the launch and no key exists.
- **Attribution is write-once.** A pad owner can never redirect a creator's stream after the
  fact. Tested.
- **Pull payments.** A creator or pad owner that cannot receive ETH cannot block the other two.
  Tested. (This is the Milestone 0 push-payment bug, not repeated.)
- **No setters, no owner, no upgrade path** in the adapter. Percentages are immutable at
  construction; changing them means a new deployment that only affects future launches.

**Theirs (Uniswap's):**

- `LiquidityLauncher` has **no owner and no admin**. Good.
- `InstantLaunchStrategy` and `FeeSplitter` configurations are immutable.
- **Versioning is the real risk:** Uniswap already marks a previous `LiquidityLauncher`,
  `LBPStrategy` and `TokenSplitter` as `deprecated`. They can ship a v4 and deprecate today's
  addresses. We must pin addresses, monitor the registry, and treat a migration as a product
  event. Old launches keep working; only new launches would move.

**Market-level:**

- **Launch sniping.** The pool opens at a fixed, publicly known tick with the entire supply on
  one side. The first buyer in the block gets the best price. This is inherent to the design and
  is a UX/economic issue to disclose, not a bug we can fix from outside.
- **Spam under OPEN pads** — unchanged from Milestone 1, and now it costs real gas plus a real
  pool, which raises the spam floor.
- **The beneficiary NFT is transferable.** Our adapter deliberately exposes **no** transfer
  function, so the stream cannot be moved out once it arrives. Verify this stays true in review.

---

## 11. Test strategy

1. **Unit, with test doubles — done.** 13 tests over the adapter: three-way split, wei
   conservation across awkward amounts, many-pools-one-contract, write-once attribution,
   registrar-only, NFT provenance, pull payments, DoS resistance. Runs in CI today.
2. **Mainnet fork tests — the critical gap.** Fork chain 4663 and run a real launch against the
   real `LiquidityLauncher`, real strategy, real `FeeSplitter` and real vault, then simulate swaps
   and assert our adapter receives and splits actual fees. This is the only way to validate the
   integration before spending real money. Needs an archive-capable RPC (Alchemy/QuickNode —
   Robinhood documents the public RPC as rate-limited and not for production).
3. **Testnet integration — not available against official contracts.** See below.
4. **Mainnet dry run** — one token, minimum viable size, after explicit approval. Not now.

---

## 12. Testnet vs mainnet — the blocker

**Uniswap's Liquidity Launchpad is not deployed on Robinhood Chain testnet.**

Evidence:

- Uniswap's registry contains **78 liquidity-launchpad deployments across 11 chains** — Ethereum,
  Arbitrum, Base, Unichain, Avalanche, X Layer, Ink, Sepolia, Base Sepolia, Unichain Sepolia, and
  **Robinhood Chain 4663**. It contains **zero entries for chain 46630**.
- The official mainnet `LiquidityLauncher` address returns **`0x` (no code)** on the testnet RPC.

There *is* a working `LiquidityLauncher` + `InstantLaunchStrategy` + `FeeSplitter` +
`BeneficiaryVault` set on testnet (launcher `0xEB48D700545AA68e703207A44D51732A39817ebD`, strategy
`0x2c06bE3D6ec3d4b6aD2816E54D9c838E6A804B32`), verified and byte-identical in size to mainnet. But
it is **not listed by Uniswap**, sits at different addresses, and was deployed by an ordinary EOA
(`0x330c976a193D793B6e2435d91FB158C2ce4907e4`). Its `FeeSplitter` pays **100% of both sides to
that same EOA** — so it is a staging instance and **its economics are not representative**.

**Consequences:**

| Question | Testnet | Mainnet |
|---|---|---|
| Does our adapter's logic work? | ✅ local unit tests | ✅ |
| Does the launch call sequence work end to end? | ⚠️ only against the unofficial deployment | ✅ |
| Are the fee percentages real? | ❌ no (100% to one EOA) | ✅ measured |
| Can we prove the whole flow safely? | ❌ | via **fork**, then a small live run |

So: **Milestone 1's testnet-first pattern does not carry over.** Milestone 2 has to be proven on a
mainnet fork, and eventually with a small real mainnet launch. That needs your approval and real
ETH, and it is the main reason this memo stops here.

---

## Proof-of-concept results

Code: `contracts/contracts/poc/` (`LaunchpadRewardsPoC`, `MockBeneficiaryVault`, transcribed
Uniswap interfaces). Tests: `contracts/test/poc/LaunchpadRewards.test.js`.

**13 passing / 124 total in the suite.** What it establishes:

- ✅ A single contract can hold many beneficiary NFTs and split each pool's stream three ways.
- ✅ Every wei is conserved; truncation favours the protocol leg by at most 2 wei per collection.
- ✅ 12 pools with distinct creators and pad owners run through one deployment.
- ✅ Attribution is write-once; a pad owner cannot steal a creator's stream.
- ✅ A party that rejects ETH cannot block the others.

**What it does not establish** — and a test asserts this honestly: it runs against a *test double*
of Uniswap's vault, not the real one. Real integration is unproven until the fork tests in step 2.

---

## Decisions I need from you

Percentages are deliberately left open — they are constructor arguments in the PoC, and the test
values (50/30/20) were chosen to make arithmetic readable, **not** as a proposal.

1. **Split of the creator-fee stream** between token creator, launchpad owner, and
   Launchpad.family. Remember the stream being split is *40% of the ETH side of a 25 bps LP fee* —
   so the headline percentage is of a fairly small number. Worth modelling before choosing.
2. **Creator fees on or off** — do we always use `InstantLaunchStrategy#creator-fees`, or expose
   the no-creator-fees variant as a pad option?
3. **Can a launchpad owner set their own share**, or is it fixed protocol-wide? Per-pad rates mean
   per-pad configuration and a materially larger contract.
4. **Do we accept the 1e9 × 18-decimal supply constraint** for all launched tokens? It is
   non-negotiable if we use InstantLaunch.
5. **Approval to run mainnet fork tests**, and later a single minimal real launch.

Not started, as instructed: DEX integration beyond this research, bonding curves, creator-reward
production contracts, fee enforcement changes, and the NVDA buyer.


---

# Implementation (approved 2026-09-13)

## Approved economics — and what they actually mean

**50% token creator / 30% launchpad owner / 20% Launchpad.family**, fixed in `LaunchpadRewards`
bytecode with no setter.

These are shares **of the Uniswap creator-fee stream only**. That stream is 40% of the ETH side of
a 25 bps LP fee. Stated as effective rates:

| | On BUY volume (ETH in) | On SELL volume (token in) |
|---|---|---|
| Pool LP fee | 25 bps | 25 bps |
| Uniswap keeps | 15 bps | **25 bps (all of it)** |
| Reaches our stream | **10 bps** | **0 bps** |
| → token creator (50%) | **5 bps** | 0 |
| → launchpad owner (30%) | **3 bps** | 0 |
| → Launchpad.family (20%) | **2 bps** | 0 |

**Sells earn us nothing.** A v4 pool charges its fee in the input currency, and Uniswap takes 100%
of the token side. Any projection that multiplies *total* volume by 10 bps is roughly 2x too high.

At a 50/50 buy-sell mix the protocol earns **1 bp of total traded volume** — $1,000,000 of volume
is **$100** of protocol revenue. Run `npm run model:economics` for the full table; the figures are
locked to the contracts by `test/market/Economics.test.js`.

## Contracts built

| Contract | Privileged capability |
|---|---|
| `LaunchpadRewards` | none that moves value; `registrar` may attribute a position once, never change one |
| `LaunchpadFamilyLauncher` | none — no owner, no pause, no allowlist |
| `LaunchToken` (modified) | none; supply now fixed at 1,000,000,000 × 18 decimals |
| `UniswapRobinhood` | library of pinned mainnet addresses |

Design points that were requirements:

- **The registrar is the launcher contract, enforced in bytecode.** `LaunchpadRewards` rejects a
  registrar with no code, so attribution can only ever happen inside a launch transaction.
- **Deployment order is forced** by that check: launcher first (pointing at the address rewards
  will occupy), rewards second. A mis-wired pair cannot silently operate — the first launch
  reverts. `isCorrectlyWired()` lets an operator confirm before spending one.
- **Attribution is write-once.** No reassign, redirect or update path exists for anyone.
- **Addresses are pinned.** On chain 4663 the constructor rejects any Uniswap address that is not
  the official one, so a production deployment cannot point at a substitute.
- **The launch is one atomic call.** `LiquidityLauncher` is permissionless and holds tokens
  between deposit and distribute; splitting those steps across transactions would let someone
  hijack the launch with their own `feeBeneficiary`.
- **The launcher verifies the outcome** rather than trusting it: after the launch it checks the
  beneficiary NFT actually landed on `LaunchpadRewards`, and reverts if not.
- **Pull-based payouts**, so one broken recipient cannot block the other two.

## Supply is no longer configurable

`LaunchToken` has no supply argument. Uniswap's strategy reverts on anything but 1e9 × 18, so a
supply parameter would have been a lie in the ABI. `Launchpad.launchToken(name, symbol)` lost its
third argument, and the web app shows supply as a disabled, explained field.

## What the fork tests prove

`npm run test:fork` — **14 tests against the real mainnet Liquidity Launchpad** (chain 4663):

- a real Uniswap v4 pool is created, and the LP position ends up owned by the **real FeeSplitter**
  (liquidity permanently locked — nobody can withdraw it);
- the beneficiary NFT is issued to **our** `LaunchpadRewards`;
- the entire supply goes into the pool — creator, pad owner, launcher and rewards all hold zero;
- attribution records creator / pad owner / launchpad / token correctly;
- `OWNER_ONLY` is still enforced against a real launch;
- fees injected at Uniswap's own FeeSplitter→vault boundary are claimed from the **real vault**
  and split exactly 50/30/20, and all three parties withdraw real ETH;
- a second launch from a different creator is serviced independently by the same singleton.

**What they do NOT prove:** fees are injected by impersonating the real FeeSplitter rather than
generated by executing swaps. The claim and split run against real vault code; the rate at which a
new pool actually accrues fees is not measured.

## Test counts

- `172 passing` in the hermetic suite (was 124), including 22 adversarial tests.
- `14 passing` on the mainnet fork (skipped automatically without `FORK_RPC`, so CI stays hermetic).
- `37/37` browser end-to-end checks still pass after the fixed-supply change.

## Still not done, deliberately

No mainnet transaction. No DEX/bonding-curve work of our own. No v4 hook. No NVDA buyer. Fee
percentages are not configurable and per-pad rates do not exist in v1.

---

# Milestone 2.5 — real-swap validation (2026-09-13)

Milestone 2 claimed the split worked but injected the fees by impersonating Uniswap's FeeSplitter.
That left the most important number unmeasured: **how much actually arrives**. Milestone 2.5 removes
the injection entirely. Every wei in `test/fork/RealSwaps.fork.test.js` originates from a swap
executed against the real Uniswap v4 `PoolManager` on a Robinhood Chain mainnet fork.

Run it with `npm run test:swaps`. It is skipped without `FORK_RPC`, so CI stays hermetic.

## How the swaps are executed

`contracts/mocks/V4TestSwapRouter.sol` is a **test-only** router. It is not part of the deployed
system and is never referenced by production code. It does what any v4 integrator does:
`poolManager.unlock` → `unlockCallback` → `swap` → `settle`/`take`, with `sync` + `transferFrom` on
the ERC-20 side. Nothing about the pool, the fee tier, the position or the vault is simulated.

## Measured fee deltas

Numbers below are **measured on the fork**, not derived from documentation.

| Step | Rate | On a 1 ETH buy |
| --- | --- | --- |
| Pool LP fee (`LP_FEE = 2500` = 25 bps) | 0.25% of input | 0.0025 ETH |
| Share of the ETH-side LP fee routed to the beneficiary vault | 40% | 0.001 ETH |
| → creator (50% of our stream) | | 0.0005 ETH |
| → launchpad owner (30%) | | 0.0003 ETH |
| → protocol (20%) | | 0.0002 ETH |

**The effective rate reaching the creator-fee stream is 10 bps of ETH buy volume** (0.25% × 40%).
The 50 / 30 / 20 split applies only to that 10 bps — it is not a share of swap volume and not a
share of total LP fees. 60% of the ETH-side LP fee stays with Uniswap.

One measurement that only a real swap could have surfaced: **Uniswap rounds the LP fee up.** A
1 ETH buy charges `2500000000000001` wei, not `2500000000000000`. The tests assert a one-wei band
rather than exact equality. Documentation would not have told us this.

### Sells earn us nothing

A sell pays its LP fee in the **token**, not in ETH. The FeeSplitter is configured to send **0%**
of the token side to the beneficiary vault — the token side is 100% Uniswap's. Measured directly:
after a real sell, `pending` for all three parties is unchanged. So creator revenue is a function of
**ETH-denominated buy volume only**, which is roughly half of total volume in a normal market.
Any revenue projection that uses total volume overstates income by about 2×.

## The eight proofs

1. **A real buy charges 25 bps of the ETH input.** Measured, with the +1 wei rounding.
2. **Exactly 40% of that ETH fee is attributed to our position** in the real beneficiary vault.
3. **A real sell produces zero creator stream.** Token-side fees never reach us.
4. **`LaunchpadRewards` holds the claim and receives the real ETH** — balance delta measured around
   the real `vault.claim`, not assumed.
5. **The claimed amount is credited 50 / 30 / 20** and **each party withdraws exactly that in real
   ETH** (5b).
6. **Wei conservation** across dust (1e-6 ETH), non-round (0.3333333333 ETH), large (7 ETH) and
   repeated buys with sells interleaved; a second collect with nothing new accrued **reverts**
   rather than silently splitting zero; collect → trade → collect settles correctly.
7. **A reverting recipient cannot block the others** — proven with real fees, not injected ones.
8. **Three real pools settle independently through the same singleton**, each crediting its own
   creator and pad owner.

16 tests, all passing against real mainnet state.

## Resolving the direct-launch ambiguity

`Launchpad.launchToken` (a bare ERC-20, whole supply in one wallet, **no market**) and
`LaunchpadFamilyLauncher.launch` (a real Uniswap pool with permanently locked liquidity) used to be
indistinguishable on chain. An indexer or frontend could have presented one as the other.

The fix is a **two-way cryptographic binding**, chosen over any admin control:

1. `LaunchToken.marketLauncher` — immutable, set in the constructor, no setter. `address(0)` for a
   token-only deployment. This is the token's **claim**, and on its own it is forgeable: anyone can
   deploy an ERC-20 naming our launcher.
2. `LaunchpadFamilyLauncher.launchOf[token]` — written only by a real launch, only after the pool
   exists and the beneficiary NFT is confirmed to be owned by `LaunchpadRewards`.

`verifyMarketLaunch(token)` returns true only when **both** halves agree. `verifiedLaunchOf(token)`
returns the attribution alongside that boolean, so a consumer cannot read attribution without also
reading whether it is verified.

Properties this gives us:

- **No new privilege.** Both functions are `view`. There is no allowlist, no admin verifier, no
  pause. A test asserts the launcher exposes no function matching `set|owner|pause|allow|deny|
  block|verifyAs|admin`.
- **Not forgeable.** Tested: a token that merely claims the launcher, an arbitrary contract, an EOA,
  the zero address, and a token launched through a *different* launcher all fail verification.
- **The market launcher is the canonical path**, exactly as requested — `Launchpad.launchToken`
  keeps working for token-only deployments but its doc block states it is not the production path,
  and the UI labels its output "Token-only (no market)".

11 provenance tests cover this.

## Frontend

Updated only enough to demonstrate the lifecycle: a market section on the pad page, a
"verified market" badge driven by re-verifying each entry on chain (never by trusting local state),
the immutable 50 / 30 / 20 copy, lifetime-split display, a claimable-rewards banner and a withdraw
action. Token-only deployments render in a separately headed table.

`web/e2e/market-lifecycle.mjs` proves it in a real browser against the fork: **21/21 checks pass**,
including that the creator and pad owner each see their own balance, that the ratio is exactly
50 : 30, and that every token-only deployment fails market verification. The only substituted piece
is `window.ethereum` (no extension exists in a headless container); it stubs no responses.

## Test counts after 2.5

- `184 passing` hermetic (up from 172).
- `16 passing` real-swap fork tests (`npm run test:swaps`).
- `14 passing` Milestone 2 fork tests (`npm run test:fork`).
- `21/21` browser lifecycle checks.

## Remaining risks

- **Nothing has run on public mainnet.** Fork state is real but historical and pinned; gas,
  congestion and MEV on a live launch are unmeasured.
- **Revenue depends on buy volume, and buy volume is unknown.** The 10 bps figure is solid; the
  volume it applies to is not something we control or have data for.
- **`collectAndSplit` is permissionless but not automatic.** Nobody is paid to call it. Fees sit in
  the vault until someone does. A keeper is not built.
- **We depend on Uniswap's deployment being immutable.** The addresses are pinned constants, but
  `FeeSplitter`'s 40/0 configuration is Uniswap's, not ours. If they ever deploy a new splitter for
  new launches, existing positions keep their terms — new ones would need a re-audit.
- **The fork is pinned to one block.** A `FeeSplitter` upgrade upstream would not be caught until
  the pin is moved.
- **No mainnet gas figures.** Launch cost is measured on a fork, which approximates but does not
  guarantee live cost.

## Still not done, deliberately

No mainnet transaction and no real ETH spent. No configurable fee percentages. No v4 hook. No NVDA.
No new economic templates.
