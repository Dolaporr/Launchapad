// ---------------------------------------------------------------------------
// Pad slugs.
//
// A slug becomes a hostname: `ai` -> ai.launchpad.family. That makes it a
// security boundary, not a cosmetic field, so the rules here are deliberately
// strict and this module is pure and exhaustively tested.
//
// Three properties matter:
//
//   1. NORMALISATION IS TOTAL. Two inputs that a human would read as the same
//      name must collapse to the same slug, or two pads could claim visually
//      identical hostnames.
//   2. NO CONFUSABLES. Anything that could impersonate another pad or one of
//      our own hostnames is refused, not silently rewritten.
//   3. REJECTION IS EXPLICIT. An invalid name returns a reason a human can act
//      on. Never a silent truncation into something they did not choose.
// ---------------------------------------------------------------------------

/** Hostname labels cap at 63 chars; we cap lower so slugs stay readable and typable. */
// Two characters, because the product's own flagship example is `ai` -> ai.launchpad.family.
export const MIN_SLUG_LENGTH = 2;
export const MAX_SLUG_LENGTH = 32;

/**
 * Names Launchpad.family needs for itself, or that would be dangerous in a
 * hostname position. Squatting `admin.launchpad.family` or `www.launchpad.family`
 * must be impossible.
 */
export const RESERVED_SLUGS = new Set([
  // Infrastructure hostnames.
  'www', 'app', 'api', 'admin', 'root', 'support', 'help', 'docs', 'doc', 'status',
  'mail', 'email', 'smtp', 'imap', 'pop', 'ftp', 'ns', 'ns1', 'ns2', 'dns', 'mx',
  'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'download', 'downloads',
  'blog', 'news', 'about', 'legal', 'terms', 'privacy', 'security', 'abuse',
  'staging', 'stage', 'dev', 'test', 'testing', 'demo', 'sandbox', 'preview', 'beta', 'alpha',
  'local', 'localhost', 'internal', 'private', 'public', 'host', 'server',
  // Product surfaces that must never be shadowed by a pad.
  'launchpad', 'launchpads', 'family', 'create', 'builder', 'build', 'dashboard',
  'verify', 'verified', 'proof', 'explore', 'discover', 'leaderboard', 'top',
  'pad', 'pads', 'token', 'tokens', 'launch', 'launches', 'creator', 'creators',
  'owner', 'owners', 'earnings', 'rewards', 'fees', 'settings', 'account', 'profile',
  'login', 'logout', 'signin', 'signup', 'auth', 'oauth', 'callback', 'connect',
  'export', 'embed', 'widget', 'invite', 'share',
  // Terms that would imply an endorsement we do not give.
  'official', 'verify-token', 'safe', 'audited', 'trusted', 'certified',
  // Brand terms worth withholding from open registration.
  'robinhood', 'uniswap', 'ethereum', 'anthropic', 'claude',
]);

/** Slugs that are valid but withheld for later product use rather than refused as unsafe. */
export const RESERVED_REASON = 'reserved';

const VALID_SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Collapses a human-typed name toward a candidate slug.
 *
 * This only lowercases, trims, and maps separators to hyphens. It deliberately
 * does NOT strip unexpected characters: a name containing them is REJECTED by
 * `validateSlug` rather than silently mutated into a different name than the
 * user typed. Silent rewriting is how people end up owning a hostname they did
 * not intend to claim.
 */
export function normaliseSlug(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    // Spaces, underscores and dots read as separators to a human typing a name.
    .replace(/[\s_.]+/g, '-')
    // Collapse hyphen runs so "a--b" and "a-b" cannot both be registered.
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @returns {{ok: true, slug: string} | {ok: false, code: string, message: string}}
 */
export function validateSlug(input) {
  const slug = normaliseSlug(input);

  if (!slug) {
    return { ok: false, code: 'empty', message: 'Pick a name for your launchpad.' };
  }
  if (slug.length < MIN_SLUG_LENGTH) {
    return {
      ok: false,
      code: 'too_short',
      message: `Needs at least ${MIN_SLUG_LENGTH} characters.`,
    };
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    return {
      ok: false,
      code: 'too_long',
      message: `Keep it to ${MAX_SLUG_LENGTH} characters or fewer.`,
    };
  }
  if (!VALID_SLUG.test(slug)) {
    return {
      ok: false,
      code: 'invalid_characters',
      message: 'Use lowercase letters, numbers and hyphens only. It becomes part of your web address.',
    };
  }
  // `xn--` is the punycode prefix: allowing it would let a slug render as a completely different
  // script in the address bar. Checked against BOTH the raw input and the normalised form, because
  // collapsing hyphen runs turns `xn--abc` into `xn-abc` and would otherwise hide the marker.
  const rawLower = String(input).trim().toLowerCase();
  if (slug.startsWith('xn-') || rawLower.startsWith('xn--')) {
    return {
      ok: false,
      code: 'punycode',
      message: 'That name is not available.',
    };
  }
  // An all-numeric label can be read as an IP segment by some resolvers and
  // tooling, so it is refused rather than risked.
  if (/^\d+$/.test(slug)) {
    return {
      ok: false,
      code: 'all_numeric',
      message: 'Include at least one letter.',
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return {
      ok: false,
      code: RESERVED_REASON,
      message: 'That name is reserved. Try another.',
    };
  }

  return { ok: true, slug };
}

/** True when the input is already exactly its own normalised, valid form. */
export function isCanonicalSlug(input) {
  const result = validateSlug(input);
  return result.ok && result.slug === input;
}

/** The immutable onchain pointer for a slug. Baked into `Launchpad.metadataURI` at creation. */
export function metadataUriFor(slug, origin = 'https://launchpad.family') {
  return `${origin.replace(/\/+$/, '')}/p/${slug}`;
}

/**
 * Recovers the slug a pad committed to onchain.
 *
 * The pad's `metadataURI` is immutable, so this is the authoritative statement of
 * which slug that pad claimed at creation. Returns null when the URI is not one
 * of ours — which is itself meaningful: that pad never claimed a slug here.
 */
export function slugFromMetadataUri(uri) {
  if (typeof uri !== 'string') return null;
  const match = uri.trim().match(/^https?:\/\/[^/]+\/p\/([^/?#]+)\/?$/i);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  const result = validateSlug(candidate);
  // Must be already-canonical: a pad pointing at `/p/AI--Fun` did not claim `ai-fun`.
  return result.ok && result.slug === candidate ? result.slug : null;
}

/** The hostname a pad is served on in production. */
export function hostnameFor(slug, apex = 'launchpad.family') {
  return `${slug}.${apex}`;
}

/**
 * Extracts a pad slug from an incoming Host header.
 *
 * Returns null for the apex, for `www`, and for anything that is not a single
 * label under the apex — so `a.b.launchpad.family` is not treated as pad `a`.
 */
export function slugFromHost(host, apex = 'launchpad.family') {
  if (typeof host !== 'string' || !host) return null;
  // Strip port, lowercase, drop a trailing dot from a fully-qualified name.
  const name = host.split(':')[0].trim().toLowerCase().replace(/\.$/, '');
  if (name === apex || name === `www.${apex}`) return null;
  if (!name.endsWith(`.${apex}`)) return null;

  const label = name.slice(0, -(apex.length + 1));
  if (!label || label.includes('.')) return null;
  if (label === 'www') return null;

  const result = validateSlug(label);
  return result.ok && result.slug === label ? result.slug : null;
}
