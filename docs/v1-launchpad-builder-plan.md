# V1 — Launchpad Builder: implementation plan

**Status:** PLAN ONLY. No code written. No mainnet transaction.
**Baseline preserved:** `fe31fa8`, mainnet contracts unchanged.

The product being built: *"I built AI.fun"* — not *"I created a profile on Launchpad.family."*

---

## 1. What already exists and is reusable

Audited `web/` (8 files, ~119 KB) and the contracts.

| Asset | Reuse |
|---|---|
| `web/chain.js` | **Reuse wholesale.** Hand-rolled ABI codec, all pad/factory/market reads, `readLaunchState`, log reading, wallet plumbing, chain switching. Already CI-guarded against selector drift. |
| `web/launchState.js` | **Reuse wholesale.** Tested display model; the "swapped ETH is never revenue" and "unknown ≠ zero" rules are already enforced here. |
| `web/launchDetail.js` | **Reuse as the token/launch page body.** Already renders Token → Pool → Locked Liquidity → Trading → Fees → Split. |
| `contracts/scripts/lib/launchVerifier.cjs` | **Reuse as the server-side truth oracle** for indexing and for "Onchain Launch Proof". |
| `contracts/schema/launch-record.schema.json` | **Extend** with a pad-record sibling. |
| `web/styles.css` | **Reuse**, plus a themeable accent-colour layer for pad branding. |
| `web/e2e/*.mjs` | **Reuse the harness pattern** (fork node + provider shim + Playwright). |
| `web/app.js` (demo mode) | **Retire from the V1 surface.** It is the pre-chain prototype; keeping it would contradict "one source of truth". Kept in repo, unlinked from V1 routes. |
| `web/live.js` | **Decompose.** 36 KB of hash-routing + views. Its chain-read logic moves into shared modules; its routing is replaced. |

**Contract changes required: none.** Every V1 need maps to existing surface:

| V1 need | Existing surface |
|---|---|
| Pad identity | `Launchpad.name`, `Launchpad.metadataURI` (set at creation) |
| Launch permission | `Launchpad.launchPolicy` (OPEN / OWNER_ONLY, immutable) |
| Pad enumeration | `factory.launchpadsPage`, `factory.launchpadsOf(owner)`, `factory.isLaunchpad` |
| Launches per pad | `launcher.tokensOfLaunchpad(pad)` |
| Attribution | `launcher.verifiedLaunchOf(token)` |
| Pad-owner earnings | `rewards.pending(addr)`, `rewards.lifetimeDistributed(positionId)` |
| Unique creators | `launchOf(token).tokenCreator` per pad token |

One-pad-per-wallet, listing status and slugs are **offchain by instruction** and stay offchain.

### The branding constraint, and why it is already solved

`Launchpad.name` and `metadataURI` have **no setter** — immutable, 256-char limit. The contract's own
doc block anticipates the fix: the *pointer* is immutable, the *content behind it* is not.

```
metadataURI = https://launchpad.family/p/<slug>      (immutable, onchain, ~30 chars)
     └── serves mutable branding JSON: logo, description, accent, socials
```

This gives the slug an **onchain anchor set at creation** — strong against squatting and
impersonation — while letting an owner restyle later. Branding is not economics, so mutability here
does not violate the one-source-of-truth principle.

---

## 2. Information architecture and routes

Two surfaces, one codebase.

### Launchpad.family (apex — the infrastructure)
```
/                     Home: "Build your own launchpad" + Top Launchpads leaderboard
/create               Launchpad Builder (identity → rules → economics → preview → sign)
/pads                 Directory (ACTIVE, non-abandoned, ≥1 valid launch)
/dashboard            My launchpads + my creator earnings (wallet-gated)
/verify?token=0x…     Onchain Launch Proof lookup by address
/t/<token>            Canonical token/launch page
/p/<slug>             Dev-only mirror of the hosted pad (production uses the subdomain)
```

### <slug>.launchpad.family (the pad — the owner's brand, foregrounded)
```
/                     Pad home: brand, description, launches, zero state
/launch               Creator launch flow (gated by launchPolicy + wallet)
/t/<token>            Token page, framed as "launched on AI.fun"
/owner                Pad-owner console: earnings, recruiting tools, embed snippet, export
```

On a pad subdomain the pad's name/logo is the masthead. Launchpad.family appears once, as a small
"infrastructure by" footer mark, never as the header brand.

---

## 3. Launchpad data/config model

Three layers with strictly separated authority.

**Layer 1 — onchain (authoritative, immutable).** Pad address, owner, `launchPolicy`, `name`,
`metadataURI`, launches, attribution, fee split. *Nothing offchain can override any of this.*

**Layer 2 — pad branding document** at `/p/<slug>` (owner-editable, signature-gated):
```jsonc
{ "schemaVersion": 1, "slug": "ai", "padAddress": "0x…", "chainId": 4663,
  "displayName": "AI.fun", "tagline": "…", "description": "…",
  "logo": { "type": "dataurl|url", "value": "…" },     // size-capped, sanitised
  "accentColor": "#7C5CFF",                             // constrained palette + contrast check
  "links": { "website": "…", "x": "…", "telegram": "…", "discord": "…" },
  "updatedAt": "…", "updatedBySignature": "0x…" }
```

**Layer 3 — registry row** (Launchpad.family only, never a truth source for economics):
```
slug PK · pad_address · owner_address · chain_id · created_at · first_launch_at
listing_status ACTIVE|DELISTED · delisted_reason · reserved_until · confirmed_at
```

**Binding rule.** A pad owns slug `S` only if *all* hold: the registry row for `S` names pad `P`;
`P.metadataURI()` read from chain resolves to slug `S`; and `P.owner()` matches the claiming wallet.
A pad that points its URI at someone else's slug is simply not recognised — the registry row is
already taken, and a second pad cannot displace it.

---

## 4. Hosted-pad routing

**Production: wildcard subdomains**, resolved from the `Host` header.

```
Host: ai.launchpad.family → slug "ai" → registry → pad 0x… → render branded shell
Host: launchpad.family    → apex app
```

Routing is **host-driven in the same code path for dev and production**. Locally I prove it by
sending a `Host` header at a local server; deployed, the identical code reads the real header.
`/p/<slug>` exists only as a dev convenience and is never linked in production UI.

> **Infrastructure blocker (reported, not worked around).** Wildcard subdomains need a `*.launchpad.family`
> DNS record and a wildcard TLS certificate on the chosen host. I cannot provision DNS or TLS from
> this container. I am **not** substituting `/pad/ai` as the production UX — I am building the
> host-header path and proving it locally. Going live needs the DNS + cert on your hosting provider.

---

## 5. Backend — the one genuinely new piece

The current app is 100% static. V1 cannot be static, because six requirements need server state:
slug uniqueness, short-lived reservations during signing, one-hosted-pad-per-wallet, listing
status, leaderboard history, and GitHub OAuth (a client secret can never live in a browser).

**Proposal: Node's built-in `node:http` + built-in `node:sqlite`. Zero new runtime dependencies.**
Verified available on Node 22.22 in this environment. This preserves the repo's no-build-step, no-CDN
ethos and keeps the server auditable in a few hundred lines.

```
server/
  index.js        host routing, static serving, API
  registry.js     slug rules, reservations, one-pad-per-wallet, listing status
  branding.js     branding read/write, signature auth, sanitisation
  indexer.js      chain → SQLite (launches, creators, trader events)
  metrics.js      leaderboard + survival, computed from indexed data
  export.js       GitHub repo generation
```

Owner-authenticated writes use **wallet signature auth** (EIP-191 `personal_sign` over a nonce +
action), not passwords or sessions. The server verifies the signer equals `pad.owner()` read from
chain at request time.

---

## 6. Leaderboard and survival metrics — exact definitions

**Valid launch** (the unit everything counts): token `T` where `T ∈ launcher.tokensOfLaunchpad(P)`
**and** `launcher.verifyMarketLaunch(T) == true` **and** `launchOf(T).launchpad == P`.

**Eligibility:** a pad enters the leaderboard only with ≥1 valid launch. Empty pads are never ranked.

**Displayed separately, never compressed into one score:**

| Metric | Definition |
|---|---|
| Unique creators | distinct `tokenCreator` across the pad's valid launches |
| Repeat creators | distinct creators with ≥2 valid launches through this pad |
| Total launches | count of valid launches |
| 7-day survival | see below |
| 30-day survival | see below |
| Volume | **context only**, never the ranking signal |

**Trader identification — a correctness point worth stating.** Uniswap v4's `Swap` event carries
`sender` = the *router*, not the trader. Counting it would count routers. Instead a trader is
derived from the token's own `Transfer` logs: for any transfer where one side is the v4
`PoolManager`, the **other** side is the trader (recipient on a buy, sender on a sell). This is the
same discovery the audited verifier already uses. Limitation, stated plainly: if a trader routes
through an intermediary contract that then forwards, the intermediary is counted.

**Controlled addresses** (excluded): token creator, pad owner, protocol treasury, our deployer and
test wallets, our factory/launcher/rewards, Uniswap's PoolManager / PositionManager / FeeSplitter /
UniversalRouter / InstantLaunchStrategy, and the burn address.

**7-day active:** during `[launch + 6d, launch + 8d]` the launch records swaps from **≥2 distinct
non-controlled trader addresses**. **30-day active:** identical over `[launch + 29d, launch + 31d]`.

**Rates:**
```
7d survival  = (eligible launches that are 7-day active) / (launches where now ≥ launch + 8d)
30d survival = (eligible launches that are 30-day active) / (launches where now ≥ launch + 31d)
```
A launch too young is **excluded from the denominator entirely** and the figure renders
**"Not enough history yet"** — never `0%`.

**These are activity-survival metrics.** Not safety, quality, legitimacy or rug-prevention. Copy
will say so wherever they appear.

> **Reality check:** we have exactly one mainnet launch, days old. Every survival figure on mainnet
> will correctly read "Not enough history yet". I will demonstrate the populated states on a fork
> with time advanced, and label that demonstration as such.

---

## 7. Abandonment, delisting, and the two separate claims

**Abandoned** (no valid launch after 14 days): removed from discovery and leaderboard; hosted URL,
owner dashboard and onchain pad all keep working; **namespace is never recycled** (recycling is an
impersonation vector); becomes discoverable again automatically on its first valid launch.

**DELISTED:** gone from leaderboard, discovery and recommendation surfaces; onchain history intact;
still independently verifiable by contract address. Delisting never touches contracts, fees or funds.

**Two claims the UI must never merge:**

| Claim | Basis |
|---|---|
| **Onchain Launch Proof** | Contract state. Market origin, locked LP position, attribution, fee split. Objective, verifiable by anyone. |
| **Listed on Launchpad.family** | Our discretionary distribution decision. Revocable. |

An exported or custom-domain frontend inherits **neither** automatically. The label is *"Onchain
Launch Proof"* — never "Verified Token", never anything implying the project is safe or good.

---

## 8. GitHub export architecture

The generated repo is a **skin**, never a source of economic truth.

- Contains: static client, `pad.config.json` (chain id, pad address, launcher, rewards, slug),
  branding assets, README, licence.
- Contains **no** keys, secrets, tokens or `.env`.
- Reads pad config and all economics **from chain at runtime**. Fee recipients, attribution,
  provenance and the split are not present as editable values anywhere in the repo.
- If an owner repoints it at unrelated contracts, those launches are simply **not recognised** as
  official launches from their pad — no enforcement needed, just non-recognition.

**Hosted must work with GitHub never connected.** Export is strictly optional.

> **Dependency blocker (reported).** Creating a repo on someone's GitHub needs a registered GitHub
> OAuth App / App with a client secret. **No such credentials exist.** I will build generation plus a
> **download** path that works end to end today, and put the GitHub push path behind configuration.
> Without credentials that path is **unproven**, and I will label it exactly that — not "done".

---

## 9. What needs third-party infrastructure

| Need | Status |
|---|---|
| Wildcard DNS + TLS for `*.launchpad.family` | **You must provision.** Code is host-header-ready. |
| Hosting that passes the `Host` header | **You must choose.** Determines how the server deploys. |
| GitHub OAuth App credentials | **Do not exist.** Export is download-only until provided. |
| RPC endpoint | Public Robinhood RPC works; documented as rate-limited and not for production. |
| Charts / trading terminal | **Out of scope by instruction.** Token page links out to the market. |
| Persistent store | None — `node:sqlite` is built in. |

---

## 10. Build order

1. Server skeleton: host routing, static serving, SQLite registry, slug rules + reserved words.
2. Launchpad Builder: identity → rules → **economics shown before signing** → preview → sign.
3. Hosted pad shell rendering from registry + chain, with a real zero state.
4. Pad profile: launches, unique creators, owner earnings, recruiting tools, embed snippet.
5. Creator launch flow inside a pad.
6. Token page reusing `launchDetail`, relabelled **Onchain Launch Proof**.
7. Indexer + metrics + leaderboard, with "Not enough history yet" as the honest default.
8. GitHub export (generation + download; push behind config).
9. Zero / wallet / failure states as first-class, then tests and browser proof.

**Constraints held throughout:** no contract changes, no mainnet writes, no NVDA, no custom
percentages, no bonding curve, no AMM, no trading terminal, no global search, no Top Creators, no
multi-chain, no unlimited page customisation.
