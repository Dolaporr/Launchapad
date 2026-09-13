// ---------------------------------------------------------------------------
// Top Launchpads.
//
// Ranked on metrics that are HARD TO GAME, and shown separately rather than
// compressed into one opaque score. Volume is context only: a single wallet can
// manufacture volume against its own pool for the cost of the fee, so ranking by
// it would rank whoever is most willing to wash trade.
//
// Survival metrics measure ACTIVITY, not safety. They say a token still had
// independent traders a week later. They say nothing about whether it is honest,
// competent or worth buying, and the copy never implies otherwise.
// ---------------------------------------------------------------------------

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Renders a survival rate.
 *
 * `null` means not enough history has passed to judge, which is a different
 * statement from 0% and must never render as one. A pad whose launches are three
 * days old has not failed — it cannot be measured yet.
 */
export function survivalCell(rate) {
  if (rate === null || rate === undefined) {
    return '<span class="value unknown">Not enough history yet</span>';
  }
  return `<span class="value">${Math.round(rate * 100)}%</span>`;
}

function padHref(pad, config) {
  return `${location.protocol}//${pad.slug}.${config.apex}`;
}

function padAvatar(pad) {
  const accent = pad.branding?.accentColor || 'var(--accent)';
  const initials = esc((pad.branding?.displayName || pad.slug).slice(0, 2).toUpperCase());
  return pad.branding?.logo
    ? `<span class="pad-mark" style="background:${esc(accent)}"><img src="${esc(pad.branding.logo)}" alt="" /></span>`
    : `<span class="pad-mark" style="background:${esc(accent)}">${initials}</span>`;
}

export function renderPadCard(pad, config, { owner = false } = {}) {
  const m = pad.metrics ?? {};
  const policy = pad.onchain?.launchPolicyLabel;
  return `<div class="card">
    <div class="spread">
      <a class="pad-identity" href="${esc(padHref(pad, config))}" style="text-decoration:none;color:inherit">
        ${padAvatar(pad)}
        <div>
          <h3 style="margin:0">${esc(pad.branding?.displayName || pad.slug)}</h3>
          <span class="muted small mono">${esc(pad.slug)}.${esc(config.apex)}</span>
        </div>
      </a>
      ${policy ? `<span class="pill ${policy === 'OPEN' ? 'pill-open' : 'pill-owner'}">${esc(policy)}</span>` : ''}
    </div>
    ${pad.branding?.tagline ? `<p class="muted small" style="margin:12px 0 0">${esc(pad.branding.tagline)}</p>` : ''}
    <div class="grid three" style="margin-top:14px">
      <div class="metric"><span class="label">Launches</span>
        <span class="value">${esc(String(m.totalLaunches ?? 0))}</span></div>
      <div class="metric"><span class="label">Creators</span>
        <span class="value">${esc(String(m.uniqueCreators ?? 0))}</span></div>
      <div class="metric"><span class="label">7-day activity</span>
        ${survivalCell(m.survival7d)}</div>
    </div>
    ${owner ? `<div class="row" style="margin-top:14px">
      <a class="btn small primary" href="${esc(padHref(pad, config))}/owner">Owner tools</a>
      <a class="btn small ghost" href="${esc(padHref(pad, config))}">View</a>
    </div>` : ''}
    ${pad.listing?.status === 'DELISTED' ? `<div class="notice bad" style="margin-top:12px">
      <strong>Not listed by Launchpad.family.</strong>
      <span class="small">Its onchain history is unaffected and still verifiable.</span>
    </div>` : ''}
  </div>`;
}

export function renderLeaderboard(pads, config) {
  if (!pads.length) {
    return `<div class="zero">
      <h3>No launchpads have launched a token yet</h3>
      <p>A launchpad joins this list once its first token launches. Empty launchpads are never
         ranked, so the list cannot be padded out by creating them.</p>
      <a class="btn primary" href="#create">Build the first one</a>
    </div>`;
  }

  // Ranked by unique creators, then repeat creators, then launches. Deliberately
  // NOT by volume — see the note rendered below the table.
  const ranked = [...pads].sort((a, b) => {
    const am = a.metrics ?? {};
    const bm = b.metrics ?? {};
    return (bm.uniqueCreators ?? 0) - (am.uniqueCreators ?? 0)
      || (bm.repeatCreators ?? 0) - (am.repeatCreators ?? 0)
      || (bm.totalLaunches ?? 0) - (am.totalLaunches ?? 0);
  });

  return `<div class="spread" style="margin-bottom:14px">
      <div><div class="eyebrow">Top launchpads</div>
        <h2 style="margin:6px 0 0">Ranked by creators, not volume</h2></div>
    </div>
    <div class="card" style="padding:6px 10px">
      <table class="fam">
        <thead><tr>
          <th></th><th>Launchpad</th>
          <th>Unique creators</th><th>Repeat creators</th><th>Launches</th>
          <th>7-day activity</th><th>30-day activity</th>
        </tr></thead>
        <tbody>${ranked.map((pad, i) => {
    const m = pad.metrics ?? {};
    return `<tr>
            <td class="rank">${i + 1}</td>
            <td><a href="${esc(padHref(pad, config))}" style="text-decoration:none;color:inherit">
              <div class="row" style="gap:9px">
                ${padAvatar(pad)}
                <div>
                  <strong>${esc(pad.branding?.displayName || pad.slug)}</strong>
                  <div class="muted mono" style="font-size:11.5px">${esc(pad.slug)}.${esc(config.apex)}</div>
                </div>
              </div></a></td>
            <td>${esc(String(m.uniqueCreators ?? 0))}</td>
            <td>${esc(String(m.repeatCreators ?? 0))}</td>
            <td>${esc(String(m.totalLaunches ?? 0))}</td>
            <td>${survivalCell(m.survival7d)}</td>
            <td>${survivalCell(m.survival30d)}</td>
          </tr>`;
  }).join('')}</tbody>
      </table>
    </div>
    <p class="muted small" style="margin-top:12px">
      Ranked by unique creators, then repeat creators, then launches. Volume is not a ranking
      signal: it is trivially manufactured by trading against your own pool.
      <strong>Activity metrics are not safety metrics</strong> — they show a token still had
      independent traders later, and say nothing about whether it is legitimate or worth buying.
    </p>`;
}
