// ---------------------------------------------------------------------------
// Client for the Launchpad.family server.
//
// The server is authoritative for DISTRIBUTION only: slugs, listing, discovery.
// It is never asked about economics — fee recipients, attribution, provenance
// and the split are read from chain by web/chain.js and nowhere else. If this
// module ever starts returning a fee number, something has gone wrong.
// ---------------------------------------------------------------------------

/** An API call that failed in a way the UI should show, rather than swallow. */
export class ApiError extends Error {
  constructor(message, { status, code, payload } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    // A network failure is not "no results". It must not render as an empty state.
    throw new ApiError('Could not reach Launchpad.family. Check your connection.', {
      code: 'network',
    });
  }

  let payload = null;
  try { payload = await response.json(); } catch { /* non-JSON body */ }

  if (!response.ok) {
    throw new ApiError(
      payload?.message || payload?.error || `Request failed (${response.status})`,
      { status: response.status, code: payload?.code || payload?.error, payload },
    );
  }
  return payload;
}

export const api = {
  config: () => call('/config'),
  health: () => call('/health'),

  // --- slugs ---------------------------------------------------------------
  checkSlug: (slug) => call(`/slug/check?slug=${encodeURIComponent(slug)}`),
  reserveSlug: (slug, owner) => call('/slug/reserve', { method: 'POST', body: { slug, owner } }),
  releaseSlug: (slug, owner) => call('/slug/release', { method: 'POST', body: { slug, owner } }),

  // --- pads ----------------------------------------------------------------
  // `refresh` forces a re-index. Used right after a launch so the creator sees
  // their own token immediately instead of waiting out the index cache.
  pads: ({ refresh = false } = {}) => call(`/pads${refresh ? '?refresh=1' : ''}`),
  pad: (slug, { refresh = false } = {}) => call(
    `/pads/${encodeURIComponent(slug)}${refresh ? '?refresh=1' : ''}`,
  ),
  padsOfOwner: (owner) => call(`/owner/pads?owner=${encodeURIComponent(owner)}`),

  /**
   * Binds a slug to a pad that now exists on chain. The server re-verifies
   * ownership and the pad's immutable metadataURI before recording anything.
   */
  confirmPad: ({ slug, owner, padAddress, factoryAddress, branding }) => call('/pads/confirm', {
    method: 'POST',
    body: { slug, owner, padAddress, factoryAddress, branding },
  }),

  // --- owner-authenticated writes -----------------------------------------
  challenge: ({ address, action, slug }) => call('/challenge', {
    method: 'POST', body: { address, action, slug },
  }),

  updateBranding: ({ slug, nonce, signature, branding }) => call(
    `/pads/${encodeURIComponent(slug)}/branding`,
    { method: 'PUT', body: { nonce, signature, branding } },
  ),

  // --- metrics -------------------------------------------------------------
  leaderboard: ({ refresh = false } = {}) => call(`/leaderboard${refresh ? '?refresh=1' : ''}`),
  padMetrics: (slug) => call(`/pads/${encodeURIComponent(slug)}/metrics`),

  // --- export --------------------------------------------------------------
  exportStatus: () => call('/export/status'),
  exportPreview: (slug) => call(`/export/${encodeURIComponent(slug)}/preview`),
};
