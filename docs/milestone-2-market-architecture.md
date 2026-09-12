# Milestone 2 — Market Architecture Memo

**Status:** research + proof-of-concept complete. Awaiting an economic decision. No production
contracts written, nothing deployed, no mainnet transaction sent.
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
