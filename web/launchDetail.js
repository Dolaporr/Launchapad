// ---------------------------------------------------------------------------
// LAUNCH DETAIL VIEW
//
//   Token -> Pool -> Locked Liquidity -> Trading Activity -> Fees -> Revenue Split
//
// Renders the display model from launchState.js. Pure: it takes a state object
// and returns an HTML string, so it can be tested without a browser.
//
// Two rules it exists to enforce visually:
//
//   1. Swapped ETH is NEVER shown as revenue. Trading activity and fee capture
//      are separate sections with separate language, and the revenue section
//      says in plain words where the money actually came from.
//
//   2. Unknown is shown as unknown. A value we could not establish renders as
//      "not established", never as 0, and the section is visibly marked.
// ---------------------------------------------------------------------------

import { formatEth, formatUnits, TRADER_CLASS_LABEL } from './launchState.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? ''));

/** Renders a value that may be unknown. Never falls back to zero. */
function known(value, render) {
  if (value === null || value === undefined) {
    return '<span class="unknown" title="Could not be established from chain">not established</span>';
  }
  return render(value);
}

function explorerAddress(address, base) {
  if (!base || !address) return '';
  return ` <a href="${esc(base)}/address/${esc(address)}" target="_blank" rel="noopener">↗</a>`;
}

function stepHeader(n, title, status) {
  const badge = status === true
    ? '<span class="pill pill-ok">verified</span>'
    : status === false
      ? '<span class="pill pill-bad">failed</span>'
      : status === null
        ? '<span class="pill pill-unknown">unknown</span>'
        : '';
  return `<div class="step-head"><span class="step-n">${n}</span>
    <h3>${esc(title)}</h3>${badge}</div>`;
}

export function renderLaunchDetail(state, { explorerBase = '' } = {}) {
  if (!state) return '<div class="empty">No launch selected.</div>';

  const v = state.verification;

  const banner = v.verified
    ? `<div class="notice ok"><strong>Verified on chain.</strong> ${v.passedCount}/${v.checkCount}
        checks passed and every token unit and every wei reconciles, at block
        ${esc(String(v.reconciledAtBlock ?? '—'))}.</div>`
    : `<div class="notice bad"><strong>NOT VERIFIED.</strong> ${v.failed.length} check(s) failed.
        The figures below are shown for diagnosis and must not be treated as settled.
        <ul>${v.failed.map((f) => `<li><code>${esc(f.id)}</code> ${esc(f.detail ?? '')}</li>`).join('')}</ul>
      </div>`;

  return `<div class="launch-detail">
    ${banner}

    <!-- 1. TOKEN -->
    <section class="step">
      ${stepHeader(1, 'Token', true)}
      <div class="kv">
        <div><span class="k">Name</span><span class="v">${esc(state.token.name ?? '—')}</span></div>
        <div><span class="k">Symbol</span><span class="v">$${esc(state.token.symbol ?? '—')}</span></div>
        <div><span class="k">Total supply</span><span class="v">
          ${known(state.token.totalSupplyFormatted, (x) => esc(x))}</span></div>
        <div><span class="k">Address</span><span class="v mono">${esc(short(state.token.address))}
          ${explorerAddress(state.token.address, explorerBase)}</span></div>
      </div>
    </section>

    <!-- 2. POOL -->
    <section class="step">
      ${stepHeader(2, 'Uniswap v4 pool', state.pool.exists)}
      <div class="kv">
        <div><span class="k">Pair</span><span class="v">
          ${known(state.pool.pairedWith, (x) => `$${esc(state.token.symbol ?? '')} / ${esc(x)}`)}</span></div>
        <div><span class="k">LP fee</span><span class="v">
          ${known(state.pool.feeBps, (x) => `${esc(x)} bps`)}</span></div>
        <div><span class="k">Hook</span><span class="v">
          ${known(state.pool.hookless, (x) => (x ? 'none (hookless)' : esc(short(state.pool.hooks))))}</span></div>
        <div><span class="k">Position ID</span><span class="v mono">${esc(state.pool.positionTokenId ?? '—')}</span></div>
      </div>
    </section>

    <!-- 3. LOCKED LIQUIDITY -->
    <section class="step">
      ${stepHeader(3, 'Locked liquidity', state.liquidity.locked)}
      <div class="kv">
        <div><span class="k">Locked in pool</span><span class="v">
          ${known(state.liquidity.lockedAmountFormatted, (x) => `${esc(x)} $${esc(state.token.symbol ?? '')}`)}</span></div>
        <div><span class="k">Share of supply</span><span class="v">
          ${known(state.liquidity.lockedPercentOfSupply, (x) => `${esc(x.toFixed(4))}%`)}</span></div>
        <div><span class="k">Burned remainder</span><span class="v mono">
          ${known(state.liquidity.burned, (x) => `${esc(x.toString())} units`)}</span></div>
        <div><span class="k">Position held by</span><span class="v mono">
          ${known(state.liquidity.positionOwner, (x) => esc(short(x)) + explorerAddress(x, explorerBase))}</span></div>
      </div>
      <p class="muted small">${esc(state.liquidity.explanation)}</p>
      ${state.liquidity.reconciles === false
    ? '<p class="bad small">Supply does not reconcile. A holder was not discovered.</p>' : ''}
    </section>

    <!-- 4. TRADING ACTIVITY -->
    <section class="step">
      ${stepHeader(4, 'Trading activity', undefined)}
      <p class="muted small"><strong>This is activity, not income.</strong>
        ${esc(state.trading.volumeCaveat)}</p>
      <div class="kv">
        <div><span class="k">Buys observed</span><span class="v">${esc(String(state.trading.buyCount))}</span></div>
        <div><span class="k">Third-party buyers</span><span class="v">${esc(String(state.trading.externalTraderCount))}</span></div>
        <div><span class="k">Our test buyers</span><span class="v">${esc(String(state.trading.controlledTraderCount))}</span></div>
        <div><span class="k">ETH volume</span><span class="v">
          ${known(state.trading.nativeVolumeWei, (x) => `${esc(formatEth(x))} ETH`)}</span></div>
      </div>
      ${state.trading.traders.length ? `<table class="mini">
        <thead><tr><th>Buyer</th><th>Type</th><th>Tokens received</th></tr></thead>
        <tbody>${state.trading.traders.map((t) => `<tr>
          <td class="mono small">${esc(short(t.address))}${explorerAddress(t.address, explorerBase)}</td>
          <td><span class="pill ${t.classification === 'external' ? 'pill-ext' : 'pill-ours'}">${esc(t.classificationLabel)}</span></td>
          <td class="mono small">${esc(t.tokensReceivedFormatted)}</td></tr>`).join('')}</tbody>
      </table>` : '<div class="empty small">No trades observed yet.</div>'}
      ${state.trading.hasExternalActivity
    ? `<p class="muted small"><strong>On third-party trading.</strong> ${esc(state.trading.externalCaveat)}</p>`
    : ''}
    </section>

    <!-- 5. FEES -->
    <section class="step">
      ${stepHeader(5, 'Fees captured', state.fees ? state.fees.reconciles : null)}
      ${state.fees ? `
      <div class="kv">
        <div><span class="k">LP fee collected</span><span class="v">
          ${known(state.fees.lpFeeNativeWei, (x) => `${esc(formatEth(x))} ETH`)}</span></div>
        <div><span class="k">Claimable in vault</span><span class="v">${esc(formatEth(state.fees.claimableInVaultWei))} ETH</span></div>
        <div><span class="k">Captured by us</span><span class="v strong">${esc(formatEth(state.fees.capturedWei))} ETH</span></div>
        <div><span class="k">Unaccounted</span><span class="v">${esc(formatEth(state.fees.unaccountedWei))} ETH</span></div>
      </div>
      <p class="muted small">${esc(state.fees.note)}</p>`
    : '<div class="empty small">Fee accounting could not be established.</div>'}
    </section>

    <!-- 6. REVENUE SPLIT -->
    <section class="step">
      ${stepHeader(6, 'Revenue split', state.split ? state.split.every((r) => r.balances) : null)}
      ${state.split ? `
      <p class="muted small"><strong>This is the only revenue.</strong> It is a share of the fee
        captured above — not of trading volume, and not of the ETH buyers spent.</p>
      <table class="mini">
        <thead><tr><th>Party</th><th>Share</th><th>Address</th><th>Earned</th><th>Withdrawn</th><th>Claimable</th></tr></thead>
        <tbody>${state.split.map((r) => `<tr>
          <td>${esc(r.label)}</td>
          <td>${known(r.sharePercent, (x) => `${esc(x)}%`)}</td>
          <td class="mono small">${esc(short(r.address))}${explorerAddress(r.address, explorerBase)}</td>
          <td class="mono small">${esc(r.creditedEth)}</td>
          <td class="mono small">${esc(r.withdrawnEth)}</td>
          <td class="mono small strong">${esc(r.claimableEth)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="3">Total</td>
          <td class="mono small">${esc(formatEth(state.totals.creditedWei))}</td>
          <td class="mono small">${esc(formatEth(state.totals.withdrawnWei))}</td>
          <td class="mono small">${esc(formatEth(state.totals.claimableWei))}</td></tr></tfoot>
      </table>
      ${state.split.some((r) => !r.balances)
    ? '<p class="bad small">A party\'s earned total does not equal withdrawn plus claimable.</p>' : ''}`
    : '<div class="empty small">Split could not be established.</div>'}
    </section>

    ${state.notes.length ? `<div class="notice">${state.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>` : ''}
  </div>`;
}

export { formatEth, formatUnits, TRADER_CLASS_LABEL };
