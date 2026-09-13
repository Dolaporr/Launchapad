// ---------------------------------------------------------------------------
// The launch model, shown to a pad owner BEFORE they create anything.
//
// Every number here is read from the deployed contracts. Nothing is hardcoded
// from documentation, because the whole point of the architecture is that the
// contracts are the single source of economic truth — including for our own UI.
//
// If the contracts cannot be read, this reports that plainly. It never falls
// back to "the numbers we expect", because a confident wrong number shown before
// someone commits is worse than an honest gap.
// ---------------------------------------------------------------------------

import * as chain from '../chain.js';

/**
 * Uniswap's own parameters for the pool a launch creates. These belong to
 * Uniswap's deployment, not to us, and are stated as measured facts.
 */
export const MARKET_FACTS = {
  lpFeeBps: 25,
  // Share of the ETH side of the LP fee that Uniswap routes to the creator-fee
  // stream. Measured on chain, not assumed.
  creatorStreamShareOfEthFeePct: 40,
  totalSupply: '1,000,000,000',
};

/** 25 bps x 40% = 10 bps of ETH BUY volume reaching the stream we split. */
export const EFFECTIVE_STREAM_BPS = 10;

export async function readSplit(rewardsAddress) {
  if (!rewardsAddress) {
    return { ok: false, reason: 'No rewards contract is configured for this deployment.' };
  }
  try {
    const [creator, padOwner, protocol] = await Promise.all([
      chain.callUint(rewardsAddress, 'CREATOR_BPS()'),
      chain.callUint(rewardsAddress, 'PAD_OWNER_BPS()'),
      chain.callUint(rewardsAddress, 'PROTOCOL_BPS()'),
    ]);
    const total = creator + padOwner + protocol;
    if (total !== 10000n) {
      return { ok: false, reason: `Split does not sum to 100% on chain (${total} bps).` };
    }
    return {
      ok: true,
      creatorBps: Number(creator),
      padOwnerBps: Number(padOwner),
      protocolBps: Number(protocol),
      source: rewardsAddress,
    };
  } catch (error) {
    return { ok: false, reason: chain.describeError(error) };
  }
}

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * The pre-creation economics panel.
 *
 * Deliberately leads with what the CREATOR gives up, because that is the
 * counterintuitive part and the thing most likely to be misunderstood after the
 * fact: the whole supply becomes permanently locked liquidity.
 */
export function economicsPanel(split, { padOwnerShareLabel = 'You (launchpad owner)' } = {}) {
  if (!split?.ok) {
    return `<div class="notice bad">
      <strong>The launch model could not be read from the contracts.</strong>
      <p class="small" style="margin:6px 0 0">${esc(split?.reason || 'Unknown error.')}
      Nothing is shown here rather than showing numbers we cannot verify.</p>
    </div>`;
  }

  const pct = (bps) => `${bps / 100}%`;
  return `<div class="card">
    <div class="eyebrow">The launch model</div>
    <h2 style="margin-top:6px">Fixed for every token launched here</h2>
    <p class="muted small" style="margin-top:0">
      These values are set in the deployed contracts and cannot be changed by you,
      by a creator, or by Launchpad.family — including from an exported frontend.
    </p>

    <div class="notice warn" style="margin:14px 0">
      <strong>A creator receives no tokens.</strong>
      The entire ${esc(MARKET_FACTS.totalSupply)} supply goes into a Uniswap v4 pool as
      <strong>permanently locked liquidity</strong>. Nobody can withdraw it — not the creator,
      not you, not us. In exchange the creator earns a share of trading fees.
    </div>

    <h3>Where trading fees go</h3>
    <p class="muted small">
      The pool charges <strong>${MARKET_FACTS.lpFeeBps} bps</strong> on a trade. Uniswap routes
      <strong>${MARKET_FACTS.creatorStreamShareOfEthFeePct}%</strong> of the ETH side of that fee
      into the creator-fee stream. That stream — about
      <strong>${EFFECTIVE_STREAM_BPS} bps of ETH buy volume</strong> — is what gets split below.
      Sells pay their fee in the token, and none of that reaches this stream.
    </p>

    <div style="margin-top:12px">
      <div class="econ-line">
        <span class="who">Token creator</span>
        <span class="share">${pct(split.creatorBps)}</span>
      </div>
      <div class="econ-line">
        <span class="who">${esc(padOwnerShareLabel)}</span>
        <span class="share">${pct(split.padOwnerBps)}</span>
      </div>
      <div class="econ-line">
        <span class="who">Launchpad.family protocol</span>
        <span class="share">${pct(split.protocolBps)}</span>
      </div>
    </div>

    <p class="muted small" style="margin-top:14px">
      Percentages are of the creator-fee stream only — not of trading volume, and not of the
      ETH buyers spend. Read live from
      <span class="mono">${esc(split.source)}</span>.
    </p>
  </div>`;
}

/** A compact restatement for the pad page, where the reader is a creator, not the owner. */
export function creatorEconomicsSummary(split) {
  if (!split?.ok) {
    return '<p class="muted small">Fee split unavailable — the contracts could not be read.</p>';
  }
  return `<p class="muted small">
    You receive <strong>${split.creatorBps / 100}%</strong> of this token's creator-fee stream
    (about ${EFFECTIVE_STREAM_BPS} bps of ETH buy volume).
    ${split.padOwnerBps / 100}% goes to the launchpad owner and
    ${split.protocolBps / 100}% to the protocol. You receive no tokens: the entire supply becomes
    permanently locked liquidity.
  </p>`;
}
