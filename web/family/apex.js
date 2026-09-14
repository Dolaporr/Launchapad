// ---------------------------------------------------------------------------
// Launchpad.family — the apex surface.
//
//   /            home + Top Launchpads
//   #create      the Launchpad Builder
//   #pads        directory
//   #dashboard   my launchpads and my creator earnings
//
// The product being sold here is "build your own launchpad". Launching a token
// is a capability of a launchpad, not the headline of this page.
// ---------------------------------------------------------------------------

import { api, ApiError } from './api.js';
import * as wallet from './wallet.js';
import { WALLET } from './wallet.js';
import { readSplit, economicsPanel } from './economics.js';
import { renderLeaderboard, renderPadCard } from './leaderboard.js';
import { connectButton, install as installConnectUI, openSheet } from './connectUI.js';
import * as chain from '../chain.js';

const app = () => document.getElementById('app');
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = {
  config: null,
  split: null,
  pads: [],
  myPads: [],
  error: null,
  busy: false,
  /** Builder working state, kept in memory only until the pad exists on chain. */
  draft: {
    step: 'identity',
    name: '',
    slug: '',
    slugStatus: null,
    tagline: '',
    description: '',
    accent: 'violet',
    logo: null,
    links: {},
    policy: 1, // OPEN
    reservation: null,
    tx: null,
    created: null,
  },
};

// --- routing ---------------------------------------------------------------

function route() {
  const hash = location.hash.slice(1);
  const [name, value] = hash.split('=');
  return { name: name || 'home', value: value || '' };
}

async function render() {
  const { name } = route();
  if (state.error) return renderError();
  if (!state.config) { app().innerHTML = '<div class="fam-boot">Loading…</div>'; return; }

  if (name === 'create') return renderBuilder();
  if (name === 'pads') return renderDirectory();
  if (name === 'dashboard') return renderDashboard();
  return renderHome();
}

function renderError() {
  app().innerHTML = `<div class="notice bad">
    <strong>Something went wrong.</strong>
    <p class="small" style="margin:6px 0 0">${esc(state.error)}</p>
    <button class="btn small" style="margin-top:10px" id="retryBtn">Try again</button>
  </div>`;
  document.getElementById('retryBtn')?.addEventListener('click', () => {
    state.error = null; boot();
  });
}

// --- wallet chrome ---------------------------------------------------------

function walletChrome() {
  const slot = document.getElementById('walletSlot');
  if (!slot) return;
  // Every state renders a button that opens the connect sheet — including
  // NO_PROVIDER, which used to render dead text and strand mobile visitors.
  slot.innerHTML = connectButton();
}

// --- home ------------------------------------------------------------------

function renderHome() {
  app().innerHTML = `
    <section style="padding:30px 0 34px">
      <div class="eyebrow">Launchpad.family</div>
      <h1 style="max-width:640px">Build your own launchpad.</h1>
      <p class="muted" style="max-width:600px;font-size:16px">
        Configure a branded launchpad, create it on chain, and get a hosted version at
        <span class="mono">yourname.${esc(state.config.apex)}</span> straight away.
        Creators launch through it; you earn a fixed share of every token's fee stream.
      </p>
      <div class="row" style="margin-top:20px">
        <a class="btn primary" href="#create">Build a launchpad</a>
        <a class="btn ghost" href="#pads">Browse launchpads</a>
      </div>
    </section>

    <section id="leaderboardSlot">
      <div class="fam-boot">Loading launchpads…</div>
    </section>`;
  loadLeaderboard();
}

async function loadLeaderboard() {
  const slot = document.getElementById('leaderboardSlot');
  if (!slot) return;
  try {
    const { pads } = await api.pads();
    state.pads = pads;
    slot.innerHTML = renderLeaderboard(pads, state.config);
  } catch (error) {
    // A failed read must never render as "no launchpads exist".
    slot.innerHTML = `<div class="notice bad"><strong>Could not load launchpads.</strong>
      <p class="small" style="margin:6px 0 0">${esc(error.message)}</p></div>`;
  }
}

// --- directory -------------------------------------------------------------

async function renderDirectory() {
  app().innerHTML = `<h1>Launchpads</h1>
    <p class="muted">Every launchpad with at least one launch.</p>
    <div id="dirSlot"><div class="fam-boot">Loading…</div></div>`;
  const slot = document.getElementById('dirSlot');
  try {
    const { pads } = await api.pads();
    state.pads = pads;
    slot.innerHTML = pads.length
      ? `<div class="grid two">${pads.map((p) => renderPadCard(p, state.config)).join('')}</div>`
      : `<div class="zero">
          <h3>No launchpads yet</h3>
          <p>A launchpad appears here once its first token has launched. Empty launchpads are
             never listed or ranked.</p>
          <a class="btn primary" href="#create">Build the first one</a>
        </div>`;
  } catch (error) {
    slot.innerHTML = `<div class="notice bad"><strong>Could not load launchpads.</strong>
      <p class="small" style="margin:6px 0 0">${esc(error.message)}</p></div>`;
  }
}

// --- dashboard -------------------------------------------------------------

async function renderDashboard() {
  const w = wallet.wallet;
  if (w.status !== WALLET.READY) {
    app().innerHTML = `<h1>My launchpads</h1>${walletGate()}`;
    bindWalletGate();
    return;
  }

  app().innerHTML = `<h1>My launchpads</h1>
    <div id="dashSlot"><div class="fam-boot">Reading from chain…</div></div>`;
  const slot = document.getElementById('dashSlot');
  try {
    const { pads } = await api.padsOfOwner(w.address);
    state.myPads = pads;
    slot.innerHTML = pads.length
      ? `<div class="grid two">${pads.map((p) => renderPadCard(p, state.config, { owner: true })).join('')}</div>`
      : `<div class="zero">
          <h3>You have not built a launchpad yet</h3>
          <p>Create one and it is live at its own address within a minute of the transaction
             confirming.</p>
          <a class="btn primary" href="#create">Build a launchpad</a>
        </div>`;
  } catch (error) {
    slot.innerHTML = `<div class="notice bad">${esc(error.message)}</div>`;
  }
}

function walletGate() {
  const w = wallet.wallet;
  if (w.status === WALLET.NO_PROVIDER) {
    // Still a CTA: the sheet is where "no wallet" becomes actionable, whether that
    // means a hand-off link on mobile or install instructions on desktop.
    return `<div class="zero">
      <h3>A wallet is needed here</h3>
      <p>Launchpads are created on chain, so this page needs a wallet to know which
         launchpads are yours. Nothing is signed until you ask for it.</p>
      <button class="btn primary" data-wallet-open>Connect wallet</button>
    </div>`;
  }
  if (w.status === WALLET.WRONG_CHAIN) {
    return `<div class="zero">
      <h3>Wrong network</h3>
      <p>Your wallet is on chain ${esc(String(w.chainId))}. Launchpad.family runs on chain
         ${esc(String(state.config.chainId))}.</p>
      <button class="btn primary" id="gateSwitch">Switch network</button>
    </div>`;
  }
  return `<div class="zero">
    <h3>Connect your wallet</h3>
    <p>So we can show the launchpads and earnings that belong to you.</p>
    <button class="btn primary" id="gateConnect">Connect wallet</button>
  </div>`;
}

function bindWalletGate() {
  document.getElementById('gateConnect')?.addEventListener('click', () => wallet.connect());
  document.getElementById('gateSwitch')?.addEventListener('click', () => wallet.switchChain());
}

// --- builder ---------------------------------------------------------------

const STEPS = [
  ['identity', 'Identity'],
  ['rules', 'Rules'],
  ['model', 'Launch model'],
  ['preview', 'Preview'],
  ['create', 'Create'],
];

function stepChips(current) {
  const index = STEPS.findIndex(([key]) => key === current);
  return `<div class="steps">${STEPS.map(([key, label], i) => {
    const st = i < index ? 'done' : i === index ? 'active' : 'todo';
    return `<span class="step-chip" data-state="${st}">${i + 1}. ${esc(label)}</span>`;
  }).join('')}</div>`;
}

function renderBuilder() {
  const d = state.draft;
  if (d.created) return renderCreated();

  const body = {
    identity: builderIdentity,
    rules: builderRules,
    model: builderModel,
    preview: builderPreview,
    create: builderCreate,
  }[d.step] ?? builderIdentity;

  app().innerHTML = `<h1>Build your launchpad</h1>
    ${stepChips(d.step)}
    <div id="builderBody">${body()}</div>`;
  bindBuilder();
}

function builderIdentity() {
  const d = state.draft;
  const apex = state.config.apex;
  const status = d.slugStatus;
  return `<div class="grid two">
    <div class="card">
      <div class="field">
        <label for="padName">Launchpad name</label>
        <input id="padName" type="text" maxlength="40" value="${esc(d.name)}"
               placeholder="AI.fun" autocomplete="off" />
        <span class="hint">This is the brand people see. It is stored on chain and cannot be
          changed later.</span>
      </div>

      <div class="field">
        <label for="padSlug">Web address</label>
        <div class="slug-preview">
          <span class="you" id="slugEcho">${esc(d.slug || 'yourname')}</span><span class="rest">.${esc(apex)}</span>
        </div>
        <input id="padSlug" type="text" maxlength="32" value="${esc(d.slug)}"
               placeholder="ai" autocomplete="off" style="margin-top:8px" />
        <span class="hint" id="slugHint">
          ${status
    ? status.available
      ? `<span style="color:var(--ok)">Available.</span>`
      : `<span style="color:var(--bad)">${esc(status.message || 'Not available.')}</span>`
    : 'Lowercase letters, numbers and hyphens. This becomes your address and is permanent.'}
        </span>
      </div>

      <div class="field">
        <label for="padTagline">Tagline <span class="muted">(optional)</span></label>
        <input id="padTagline" type="text" maxlength="120" value="${esc(d.tagline)}"
               placeholder="Launch AI tokens" />
      </div>

      <div class="field">
        <label for="padDescription">Description <span class="muted">(optional)</span></label>
        <textarea id="padDescription" maxlength="2000"
                  placeholder="What is this launchpad for?">${esc(d.description)}</textarea>
      </div>
    </div>

    <div class="card">
      <div class="field">
        <label>Logo <span class="muted">(optional)</span></label>
        <div class="row">
          <label class="logo-drop" for="padLogo">
            ${d.logo ? `<img src="${esc(d.logo)}" alt="" />` : 'Add<br/>logo'}
          </label>
          <input id="padLogo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
          <div class="small muted" style="flex:1;min-width:140px">
            PNG, JPEG, WEBP or GIF, under 256 KB.<br/>
            SVG is not accepted because it can carry scripts.
          </div>
        </div>
      </div>

      <div class="field">
        <label>Accent colour</label>
        <div class="swatches" id="swatches">
          ${Object.entries(state.config.accentColors).map(([key, value]) => `
            <button type="button" class="swatch" data-accent="${esc(key)}"
                    style="background:${esc(value)}"
                    aria-pressed="${d.accent === key}" title="${esc(key)}"></button>`).join('')}
        </div>
        <span class="hint">A fixed palette, so every launchpad stays readable.</span>
      </div>

      <div class="field">
        <label for="linkWebsite">Website <span class="muted">(optional)</span></label>
        <input id="linkWebsite" type="text" value="${esc(d.links.website || '')}" placeholder="ai.fun" />
      </div>
      <div class="field">
        <label for="linkX">X <span class="muted">(optional)</span></label>
        <input id="linkX" type="text" value="${esc(d.links.x || '')}" placeholder="x.com/aifun" />
      </div>
    </div>
  </div>

  <div class="row" style="margin-top:18px">
    <button class="btn primary" id="toRules" ${d.slugStatus?.available && d.name ? '' : 'disabled'}>
      Continue
    </button>
    ${!d.name ? '<span class="muted small">Add a name to continue.</span>' : ''}
  </div>`;
}

function builderRules() {
  const d = state.draft;
  return `<div class="card">
    <h2>Who can launch here?</h2>
    <p class="muted small">This is written into the launchpad contract and is
      <strong>permanent</strong>. It cannot be opened or closed later.</p>

    <div class="grid two" style="margin-top:16px">
      <button type="button" class="card" id="policyOpen"
        style="text-align:left;cursor:pointer;border-color:${d.policy === 1 ? 'var(--accent)' : 'var(--line)'}">
        <span class="pill pill-open">OPEN</span>
        <h3 style="margin-top:10px">Anyone can launch</h3>
        <p class="muted small" style="margin:0">
          Any wallet can launch a token through your launchpad, and you earn your share of every
          one. This is how you recruit creators. The cost is that you cannot vet who launches.
        </p>
      </button>

      <button type="button" class="card" id="policyOwner"
        style="text-align:left;cursor:pointer;border-color:${d.policy === 0 ? 'var(--accent)' : 'var(--line)'}">
        <span class="pill pill-owner">OWNER ONLY</span>
        <h3 style="margin-top:10px">Only you can launch</h3>
        <p class="muted small" style="margin:0">
          A private storefront. Nobody else can launch through it, so there are no other creators
          to recruit.
        </p>
      </button>
    </div>
  </div>

  <div class="row" style="margin-top:18px">
    <button class="btn ghost" id="backToIdentity">Back</button>
    <button class="btn primary" id="toModel">Continue</button>
  </div>`;
}

function builderModel() {
  return `${economicsPanel(state.split)}
  <div class="row" style="margin-top:18px">
    <button class="btn ghost" id="backToRules">Back</button>
    <button class="btn primary" id="toPreview" ${state.split?.ok ? '' : 'disabled'}>
      Continue
    </button>
    ${state.split?.ok ? '' : '<span class="muted small">Cannot continue until the model is readable.</span>'}
  </div>`;
}

function builderPreview() {
  const d = state.draft;
  const accent = state.config.accentColors[d.accent];
  return `<p class="muted">This is your launchpad. Nothing has been created yet.</p>
  <div class="preview-frame" style="--accent:${esc(accent)}">
    <div class="preview-bar">
      <span class="preview-dot"></span><span class="preview-dot"></span><span class="preview-dot"></span>
      <span class="preview-url">${esc(d.slug)}.${esc(state.config.apex)}</span>
    </div>
    <div class="preview-body">
      <div class="pad-identity" style="margin-bottom:18px">
        <span class="pad-mark" style="background:${esc(accent)}">
          ${d.logo ? `<img src="${esc(d.logo)}" alt="" />` : esc((d.name || '?').slice(0, 2).toUpperCase())}
        </span>
        <div>
          <h2 class="pad-title">${esc(d.name)}</h2>
          ${d.tagline ? `<p class="pad-tagline">${esc(d.tagline)}</p>` : ''}
        </div>
      </div>
      ${d.description ? `<p class="small">${esc(d.description)}</p>` : ''}
      <div class="zero" style="margin-top:16px">
        <h3>No launches yet</h3>
        <p>This is what visitors see until your first creator launches a token.</p>
        <span class="btn primary" style="pointer-events:none">Launch a token</span>
      </div>
    </div>
  </div>

  <div class="row" style="margin-top:18px">
    <button class="btn ghost" id="backToModel">Back</button>
    <button class="btn primary" id="toCreate">Looks right — continue</button>
  </div>`;
}

function builderCreate() {
  const d = state.draft;
  const w = wallet.wallet;

  if (w.status !== WALLET.READY) {
    return `<div class="card">${walletGate()}</div>`;
  }
  if (d.tx?.status === 'pending') {
    return `<div class="card">
      <h2>Creating ${esc(d.name)}…</h2>
      <p class="muted small">Waiting for the transaction to confirm. Do not close this tab.</p>
      <p class="mono small">${esc(d.tx.hash || '')}</p>
    </div>`;
  }

  return `<div class="card">
    <h2>Create ${esc(d.name)}</h2>
    <div class="grid two" style="margin-top:12px">
      <div>
        <div class="metric"><span class="label">Address</span>
          <span class="value" style="font-size:15px">${esc(d.slug)}.${esc(state.config.apex)}</span></div>
      </div>
      <div>
        <div class="metric"><span class="label">Who can launch</span>
          <span class="value" style="font-size:15px">${d.policy === 1 ? 'Anyone' : 'Only you'}</span></div>
      </div>
    </div>

    <div class="notice" style="margin-top:16px">
      One transaction creates your launchpad on chain. The name, web address and launch rule are
      written into the contract and are <strong>permanent</strong>. Your logo, tagline, description
      and colour can be changed later.
    </div>

    ${d.tx?.status === 'error' ? `<div class="notice bad" style="margin-top:12px">
      <strong>That did not go through.</strong>
      <p class="small" style="margin:6px 0 0">${esc(d.tx.message)}</p></div>` : ''}

    <div class="row" style="margin-top:16px">
      <button class="btn ghost" id="backToPreview">Back</button>
      <button class="btn primary" id="signCreate">Create launchpad</button>
    </div>
  </div>`;
}

function renderCreated() {
  const { created } = state.draft;
  const url = `${location.protocol}//${created.hostname}`;
  app().innerHTML = `
    <div class="notice ok" style="margin-bottom:20px">
      <strong>${esc(created.pad.branding.displayName)} is live.</strong>
    </div>
    <div class="card">
      <div class="eyebrow">Your launchpad</div>
      <h1 style="margin-top:8px">${esc(created.hostname)}</h1>
      <div class="copy-row" style="margin-top:12px">
        <input type="text" readonly value="${esc(url)}" id="padUrl" />
        <button class="btn small" id="copyUrl">Copy</button>
        <a class="btn small primary" href="${esc(url)}">Open</a>
      </div>
      <p class="muted small" style="margin-top:14px">
        Share this with creators. Anyone who launches through it earns their own share, and you
        earn yours automatically — the split is enforced by the contracts, not by this page.
      </p>
      <p class="muted small">
        Your launchpad will not appear in the public directory or leaderboard until its first
        token launches.
      </p>
    </div>`;
  document.getElementById('copyUrl')?.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(url);
    document.getElementById('copyUrl').textContent = 'Copied';
  });
}

// --- builder behaviour -----------------------------------------------------

let slugTimer = null;

function bindBuilder() {
  const d = state.draft;

  const nameInput = document.getElementById('padName');
  nameInput?.addEventListener('input', (e) => {
    d.name = e.target.value;
    // Suggest a slug from the name until the user edits the slug directly.
    if (!d.slugTouched) {
      d.slug = e.target.value.toLowerCase().trim()
        .replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 32);
      const slugInput = document.getElementById('padSlug');
      if (slugInput) slugInput.value = d.slug;
      document.getElementById('slugEcho').textContent = d.slug || 'yourname';
      scheduleSlugCheck();
    }
    document.getElementById('toRules').disabled = !(d.slugStatus?.available && d.name);
  });

  const slugInput = document.getElementById('padSlug');
  slugInput?.addEventListener('input', (e) => {
    d.slugTouched = true;
    d.slug = e.target.value;
    document.getElementById('slugEcho').textContent = d.slug || 'yourname';
    scheduleSlugCheck();
  });

  document.getElementById('padTagline')?.addEventListener('input', (e) => { d.tagline = e.target.value; });
  document.getElementById('padDescription')?.addEventListener('input', (e) => { d.description = e.target.value; });
  document.getElementById('linkWebsite')?.addEventListener('input', (e) => { d.links.website = e.target.value; });
  document.getElementById('linkX')?.addEventListener('input', (e) => { d.links.x = e.target.value; });

  document.getElementById('padLogo')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) {
      alert('That image is over 256 KB. Please use a smaller one.');
      return;
    }
    d.logo = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
    renderBuilder();
  });

  document.getElementById('swatches')?.addEventListener('click', (e) => {
    const button = e.target.closest('[data-accent]');
    if (!button) return;
    d.accent = button.dataset.accent;
    document.documentElement.style.setProperty('--accent', state.config.accentColors[d.accent]);
    renderBuilder();
  });

  const go = (step) => { d.step = step; renderBuilder(); };
  document.getElementById('toRules')?.addEventListener('click', () => go('rules'));
  document.getElementById('backToIdentity')?.addEventListener('click', () => go('identity'));
  document.getElementById('toModel')?.addEventListener('click', () => go('model'));
  document.getElementById('backToRules')?.addEventListener('click', () => go('rules'));
  document.getElementById('toPreview')?.addEventListener('click', () => go('preview'));
  document.getElementById('backToModel')?.addEventListener('click', () => go('model'));
  document.getElementById('toCreate')?.addEventListener('click', () => go('create'));
  document.getElementById('backToPreview')?.addEventListener('click', () => go('preview'));

  document.getElementById('policyOpen')?.addEventListener('click', () => { d.policy = 1; renderBuilder(); });
  document.getElementById('policyOwner')?.addEventListener('click', () => { d.policy = 0; renderBuilder(); });

  document.getElementById('gateConnect')?.addEventListener('click', () => wallet.connect());
  document.getElementById('gateSwitch')?.addEventListener('click', () => wallet.switchChain());
  document.getElementById('signCreate')?.addEventListener('click', createLaunchpad);
}

function scheduleSlugCheck() {
  clearTimeout(slugTimer);
  slugTimer = setTimeout(async () => {
    const d = state.draft;
    if (!d.slug) { d.slugStatus = null; updateSlugHint(); return; }
    try {
      d.slugStatus = await api.checkSlug(d.slug);
    } catch (error) {
      d.slugStatus = { available: false, message: error.message };
    }
    updateSlugHint();
  }, 280);
}

function updateSlugHint() {
  const hint = document.getElementById('slugHint');
  const d = state.draft;
  if (!hint) return;
  if (!d.slugStatus) {
    hint.innerHTML = 'Lowercase letters, numbers and hyphens. This becomes your address and is permanent.';
  } else if (d.slugStatus.available) {
    hint.innerHTML = '<span style="color:var(--ok)">Available.</span>';
  } else {
    hint.innerHTML = `<span style="color:var(--bad)">${esc(d.slugStatus.message || 'Not available.')}</span>`;
  }
  const next = document.getElementById('toRules');
  if (next) next.disabled = !(d.slugStatus?.available && d.name);
}

/**
 * The one transaction. Order matters:
 *   1. hold the name briefly so two people cannot race for it while signing;
 *   2. create the pad on chain, baking the slug into the immutable metadataURI;
 *   3. ask the server to confirm — it re-reads chain before recording anything.
 * If step 3 fails the pad still exists on chain and the owner still owns it.
 */
async function createLaunchpad() {
  const d = state.draft;
  const w = wallet.wallet;
  const { contracts, origin } = state.config;

  if (!contracts.factory) {
    d.tx = { status: 'error', message: 'No launchpad factory is configured for this deployment.' };
    return renderBuilder();
  }

  d.tx = { status: 'pending' };
  renderBuilder();

  try {
    const reservation = await api.reserveSlug(d.slug, w.address);
    d.reservation = reservation;

    const metadataURI = reservation.metadataURI ?? `${origin}/p/${d.slug}`;
    const hash = await chain.createLaunchpadTx({
      from: w.address,
      factory: contracts.factory,
      name: d.name,
      metadataURI,
      preset: 0, // STANDARD — the only preset in V1
      policy: d.policy,
    });
    d.tx = { status: 'pending', hash };
    renderBuilder();

    const receipt = await chain.waitForReceipt(hash);
    if (!receipt || receipt.status === '0x0') throw new Error('The transaction reverted.');

    const padAddress = chain.addressFromLog(
      receipt, chain.ABI.TOPICS['LaunchpadCreated(address,address,address,uint8,uint8,string,string)'],
    );
    if (!padAddress) throw new Error('Could not find the new launchpad in the transaction logs.');

    const confirmed = await api.confirmPad({
      slug: d.slug,
      owner: w.address,
      padAddress,
      factoryAddress: contracts.factory,
      branding: {
        displayName: d.name,
        tagline: d.tagline,
        description: d.description,
        accent: d.accent,
        logo: d.logo,
        links: d.links,
      },
    });

    d.created = confirmed;
    d.tx = { status: 'done', hash };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : chain.describeError(error);
    d.tx = { status: 'error', message };
    // Free the name so a failed attempt does not hold it for the full window.
    try { await api.releaseSlug(d.slug, w.address); } catch { /* best effort */ }
  }
  renderBuilder();
}

// --- boot ------------------------------------------------------------------

async function boot() {
  try {
    state.config = await api.config();
  } catch (error) {
    state.error = error.message;
    return render();
  }

  document.documentElement.style.setProperty(
    '--accent', state.config.accentColors[state.draft.accent],
  );

  // init also aims the switch/add-network flow at the server's chain.
  await wallet.init(state.config.chainId);
  installConnectUI();
  wallet.onWalletChange(() => { walletChrome(); if (route().name === 'dashboard') render(); });
  walletChrome();

  // The launch model is read from the contracts, once, up front.
  state.split = await readSplit(state.config.contracts.rewards);

  await render();
}

window.addEventListener('hashchange', render);
boot();

// Exposed for the browser proof, which asserts on the same state the UI rendered from.
window.__family = { state, api, wallet, render, boot };
