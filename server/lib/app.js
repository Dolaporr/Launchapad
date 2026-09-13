// ---------------------------------------------------------------------------
// The Launchpad.family application.
//
// Two surfaces from one codebase, chosen by the Host header:
//
//   launchpad.family        the infrastructure: build a launchpad, browse them
//   ai.launchpad.family     ONE pad, with its own brand foregrounded
//
// Host routing is the SAME code path in development and production. Locally the
// Host header is supplied by the test or by `--host`; deployed, it arrives from
// a real wildcard DNS record. `/p/<slug>` exists only as a dev convenience and is
// never linked from production UI.
//
// The server's authority is strictly limited. It decides what Launchpad.family
// distributes — slugs, listing, discovery. It decides nothing economic. Every
// claim it records was verified against chain first.
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Registry, LISTING_ACTIVE, LISTING_DELISTED } from './registry.js';
import { BrandingStore, ACCENT_COLORS, validateBranding } from './branding.js';
import { ChainReader } from './chain.js';
import { slugFromHost, validateSlug, metadataUriFor, slugFromMetadataUri } from './slug.js';
import { padMetrics, rankPads } from './metrics.js';
import { buildExport, buildTar, githubStatus } from './export.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** How long a signing challenge stays valid. Short, because it authorises a write. */
const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 512 * 1024; // a logo data URL is the largest legitimate body

export class App {
  constructor({
    registry, branding, chain, webRoot,
    apex = 'launchpad.family',
    chainId = 4663,
    origin = 'https://launchpad.family',
    adminToken = null,
    contracts = {},
    indexer = null,
  }) {
    this.registry = registry ?? new Registry(':memory:');
    this.branding = branding ?? new BrandingStore(':memory:');
    this.chain = chain ?? null;
    this.webRoot = webRoot;
    this.apex = apex;
    this.chainId = chainId;
    this.origin = origin;
    this.adminToken = adminToken;
    // Addresses the client needs to transact. They are ADDRESSES only: the client
    // reads every economic value from these contracts, never from this config.
    this.contracts = {
      factory: contracts.factory ?? null,
      launcher: contracts.launcher ?? null,
      rewards: contracts.rewards ?? null,
    };
    /** Single-use signing challenges: nonce -> {address, action, expiresAt}. */
    this.indexer = indexer;
    this.nonces = new Map();
  }

  // --- helpers --------------------------------------------------------------

  issueNonce(address, action) {
    this.sweepNonces();
    const nonce = randomBytes(16).toString('hex');
    this.nonces.set(nonce, {
      address: String(address).toLowerCase(),
      action,
      expiresAt: Date.now() + NONCE_TTL_MS,
    });
    return nonce;
  }

  sweepNonces(now = Date.now()) {
    for (const [nonce, entry] of this.nonces) {
      if (entry.expiresAt <= now) this.nonces.delete(nonce);
    }
  }

  /** The exact text a wallet signs. Includes the action so one signature cannot authorise another. */
  challengeText({ action, slug, address, nonce }) {
    return [
      'Launchpad.family',
      `action: ${action}`,
      `launchpad: ${slug}`,
      `wallet: ${String(address).toLowerCase()}`,
      `nonce: ${nonce}`,
    ].join('\n');
  }

  /**
   * Consumes a signing challenge and confirms the signer.
   * Nonces are single-use: a replayed signature finds nothing to consume.
   */
  async consumeSignature({ nonce, signature, action, slug, expectedAddress }) {
    this.sweepNonces();
    const entry = this.nonces.get(nonce);
    if (!entry) return { ok: false, code: 'bad_nonce', message: 'That request expired. Try again.' };
    this.nonces.delete(nonce);

    if (entry.action !== action) {
      return { ok: false, code: 'wrong_action', message: 'Signature was for a different action.' };
    }
    if (expectedAddress && entry.address !== String(expectedAddress).toLowerCase()) {
      return { ok: false, code: 'wrong_wallet', message: 'Signature is from a different wallet.' };
    }
    if (!this.chain) {
      return { ok: false, code: 'no_chain', message: 'Server cannot verify signatures right now.' };
    }

    const message = this.challengeText({ action, slug, address: entry.address, nonce });
    const valid = await this.chain.verifySignedBy(message, signature, entry.address);
    if (!valid) return { ok: false, code: 'bad_signature', message: 'Signature did not match.' };
    return { ok: true, address: entry.address };
  }

  /**
   * Reads a pad from chain and decides whether it may hold `slug`.
   *
   * Three things must all hold, and each is read from chain rather than trusted:
   * the pad exists and the factory vouches for it; the caller is its owner; and
   * the pad's IMMUTABLE metadataURI commits to exactly this slug.
   */
  async verifyPadClaim({ padAddress, slug, owner, factoryAddress }) {
    if (!this.chain) return { ok: false, code: 'no_chain', message: 'Cannot reach the chain.' };

    const pad = await this.chain.readPad(padAddress);
    if (!pad) return { ok: false, code: 'not_a_pad', message: 'No launchpad at that address.' };

    if (factoryAddress) {
      const known = await this.chain.factoryKnowsPad(factoryAddress, padAddress);
      if (!known) {
        return {
          ok: false,
          code: 'unknown_pad',
          message: 'That launchpad was not created by the Launchpad.family factory.',
        };
      }
    }

    if (pad.owner.toLowerCase() !== String(owner).toLowerCase()) {
      return { ok: false, code: 'not_owner', message: 'That wallet does not own this launchpad.' };
    }

    const committed = slugFromMetadataUri(pad.metadataURI);
    if (committed !== slug) {
      return {
        ok: false,
        code: 'slug_mismatch',
        message: committed
          ? `That launchpad committed to "${committed}" on chain, not "${slug}".`
          : 'That launchpad did not commit to a Launchpad.family name on chain.',
      };
    }

    return { ok: true, pad };
  }

  /**
   * Metrics for a pad, computed from INDEXED CHAIN DATA only.
   * Returns null when there is no indexer, so the UI shows "unavailable" rather
   * than an authoritative-looking set of zeroes.
   */
  async metricsFor(padAddress, { padOwner, force = false } = {}) {
    if (!this.indexer) return null;
    try {
      const launches = await this.indexer.indexPad(padAddress, { force });
      return padMetrics(launches, {
        padOwner,
        protocolTreasury: this.contracts.protocolTreasury ?? null,
        protocolAddresses: [
          this.contracts.factory, this.contracts.launcher, this.contracts.rewards,
        ].filter(Boolean),
        uniswapAddresses: this.contracts.uniswap ?? [],
      });
    } catch (error) {
      // Surfaced rather than silently swallowed: a metrics failure that renders
      // as "no launches" is indistinguishable from a pad that really has none.
      if (process.env.DEBUG_METRICS) console.error('metricsFor failed:', error.message);
      return null;
    }
  }

  /**
   * Pads eligible for public discovery.
   *
   * Every CONFIRMED pad is viewed first, not just the already-discoverable ones.
   * A pad only becomes discoverable once its first verified launch is recorded,
   * and that recording happens while building the view — so filtering first would
   * mean a pad could never cross the threshold.
   */
  async discoverablePads(now = Date.now(), { force = false } = {}) {
    const rows = this.registry.allConfirmed(this.chainId);
    const views = (await Promise.all(
      rows.map((row) => this.padView(row.slug, now, { force })),
    )).filter(Boolean);
    return views.filter((view) => view.listing.discoverable);
  }

  /** Public view of a pad: registry + branding + the onchain facts, clearly separated. */
  async padView(slug, now = Date.now(), { force = false } = {}) {
    const row = this.registry.resolve(slug, now);
    if (!row) return null;

    let onchain = null;
    if (this.chain) {
      try { onchain = await this.chain.readPad(row.pad_address); } catch { onchain = null; }
    }

    const branding = this.branding.get(row.slug, { fallbackName: onchain?.name ?? '' });
    const metrics = await this.metricsFor(row.pad_address, {
      padOwner: row.owner_address, force,
    });

    // A pad becomes discoverable on its first VERIFIED launch, which only the
    // indexer can establish. The registry records it so abandonment can lift.
    if (metrics?.totalLaunches > 0 && !row.first_launch_at) {
      const at = this.indexer?.firstLaunchAt(row.pad_address);
      if (at) this.registry.recordFirstLaunch(row.slug, at);
    }

    return {
      metrics,
      slug: row.slug,
      padAddress: row.pad_address,
      owner: row.owner_address,
      chainId: row.chain_id,
      // What Launchpad.family chooses to distribute. Revocable, and NOT a safety claim.
      listing: {
        status: row.listing_status,
        discoverable: row.discoverable,
        abandoned: row.abandoned,
        reason: row.delisted_reason ?? null,
      },
      // What the chain says. Objective, and independent of anything above.
      onchain: onchain && {
        name: onchain.name,
        owner: onchain.owner,
        metadataURI: onchain.metadataURI,
        launchPolicy: onchain.launchPolicy,
        launchPolicyLabel: onchain.launchPolicy === 1 ? 'OPEN' : 'OWNER_ONLY',
      },
      branding,
      createdAt: row.confirmed_at,
      firstLaunchAt: row.first_launch_at,
    };
  }

  // --- HTTP -----------------------------------------------------------------

  handler() {
    return async (req, res) => {
      try {
        await this.route(req, res);
      } catch (error) {
        this.json(res, 500, { error: 'server_error', message: error.message });
      }
    };
  }

  async route(req, res) {
    const host = req.headers.host || '';
    const url = new URL(req.url, `http://${host || 'localhost'}`);
    const padSlug = slugFromHost(host, this.apex);

    if (url.pathname.startsWith('/api/')) {
      return this.api(req, res, url, padSlug);
    }

    // A pad subdomain serves the pad shell for every non-asset path, so client
    // routing works on deep links.
    if (padSlug) return this.servePadShell(res, padSlug, url);

    // Dev-only mirror of a hosted pad. Never linked in production UI.
    const devPad = url.pathname.match(/^\/p\/([^/]+)\/?$/);
    if (devPad) {
      const validated = validateSlug(devPad[1]);
      if (!validated.ok) return this.notFound(res);
      return this.servePadShell(res, validated.slug, url);
    }

    return this.serveApex(res, url);
  }

  async api(req, res, url, padSlug) {
    const route = url.pathname.replace(/^\/api/, '');
    const method = req.method.toUpperCase();

    // --- read ---------------------------------------------------------------
    if (method === 'GET' && route === '/health') {
      return this.json(res, 200, { ok: true, apex: this.apex, chainId: this.chainId });
    }

    if (method === 'GET' && route === '/config') {
      return this.json(res, 200, {
        apex: this.apex,
        chainId: this.chainId,
        origin: this.origin,
        accentColors: ACCENT_COLORS,
        padSlug: padSlug ?? null,
        contracts: this.contracts,
      });
    }

    if (method === 'GET' && route === '/slug/check') {
      const availability = this.registry.availability(url.searchParams.get('slug') || '');
      return this.json(res, 200, {
        ...availability,
        // Shown in the builder so the user sees the address they are claiming.
        hostname: availability.slug ? `${availability.slug}.${this.apex}` : null,
        metadataURI: availability.slug ? metadataUriFor(availability.slug, this.origin) : null,
      });
    }

    if (method === 'GET' && route === '/leaderboard') {
      const force = url.searchParams.get('refresh') === '1';
      return this.json(res, 200, { pads: rankPads(await this.discoverablePads(Date.now(), { force })) });
    }

    const metricsMatch = route.match(/^\/pads\/([^/]+)\/metrics$/);
    if (method === 'GET' && metricsMatch) {
      const view = await this.padView(metricsMatch[1]);
      if (!view) return this.json(res, 404, { error: 'not_found' });
      return this.json(res, 200, { slug: view.slug, metrics: view.metrics });
    }

    if (method === 'GET' && route === '/pads') {
      const force = url.searchParams.get('refresh') === '1';
      return this.json(res, 200, { pads: await this.discoverablePads(Date.now(), { force }) });
    }

    const padMatch = route.match(/^\/pads\/([^/]+)$/);
    if (method === 'GET' && padMatch) {
      const view = await this.padView(padMatch[1], Date.now(), {
        force: url.searchParams.get('refresh') === '1',
      });
      if (!view) return this.json(res, 404, { error: 'not_found' });
      return this.json(res, 200, view);
    }

    if (method === 'GET' && route === '/owner/pads') {
      const owner = url.searchParams.get('owner') || '';
      const rows = this.registry.confirmedPadsOfOwner(this.chainId, owner);
      const pads = await Promise.all(rows.map((row) => this.padView(row.slug)));
      return this.json(res, 200, { pads: pads.filter(Boolean) });
    }

    // --- write --------------------------------------------------------------
    if (method === 'POST' && route === '/challenge') {
      const body = await this.body(req);
      if (!body) return this.json(res, 400, { error: 'bad_body' });
      const { address, action, slug } = body;
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
        return this.json(res, 400, { error: 'bad_address', message: 'Connect a wallet first.' });
      }
      const nonce = this.issueNonce(address, action);
      return this.json(res, 200, {
        nonce,
        message: this.challengeText({ action, slug: slug ?? '-', address, nonce }),
        expiresInMs: NONCE_TTL_MS,
      });
    }

    if (method === 'POST' && route === '/slug/reserve') {
      const body = await this.body(req);
      if (!body) return this.json(res, 400, { error: 'bad_body' });
      const result = this.registry.reserve({
        slug: body.slug, owner: body.owner, chainId: this.chainId,
      });
      if (!result.ok) return this.json(res, 409, result);
      return this.json(res, 200, {
        ...result,
        hostname: `${result.slug}.${this.apex}`,
        metadataURI: metadataUriFor(result.slug, this.origin),
      });
    }

    if (method === 'POST' && route === '/slug/release') {
      const body = await this.body(req);
      if (!body) return this.json(res, 400, { error: 'bad_body' });
      return this.json(res, 200, this.registry.release({ slug: body.slug, owner: body.owner }));
    }

    // The only call that makes a name permanently taken, and it verifies chain first.
    if (method === 'POST' && route === '/pads/confirm') {
      const body = await this.body(req);
      if (!body) return this.json(res, 400, { error: 'bad_body' });

      const claim = await this.verifyPadClaim({
        padAddress: body.padAddress,
        slug: body.slug,
        owner: body.owner,
        factoryAddress: body.factoryAddress,
      });
      if (!claim.ok) return this.json(res, 400, claim);

      const confirmed = this.registry.confirm({
        slug: body.slug,
        owner: body.owner,
        chainId: this.chainId,
        padAddress: body.padAddress,
      });
      if (!confirmed.ok) return this.json(res, 409, confirmed);

      if (body.branding) {
        this.branding.put(confirmed.slug, {
          ...body.branding,
          displayName: body.branding.displayName || claim.pad.name,
        });
      }
      const view = await this.padView(confirmed.slug);
      return this.json(res, 200, { ok: true, pad: view, hostname: `${confirmed.slug}.${this.apex}` });
    }

    const brandingMatch = route.match(/^\/pads\/([^/]+)\/branding$/);
    if (method === 'PUT' && brandingMatch) {
      const body = await this.body(req);
      if (!body) return this.json(res, 400, { error: 'bad_body' });
      const row = this.registry.resolve(brandingMatch[1]);
      if (!row) return this.json(res, 404, { error: 'not_found' });

      const auth = await this.consumeSignature({
        nonce: body.nonce,
        signature: body.signature,
        action: 'update-branding',
        slug: row.slug,
        expectedAddress: row.owner_address,
      });
      if (!auth.ok) return this.json(res, 401, auth);

      // Ownership is re-read from chain, never taken from the registry row: the
      // pad could have been created by a different wallet than we recorded.
      if (this.chain) {
        const onchainOwner = await this.chain.padOwner(row.pad_address);
        if (onchainOwner.toLowerCase() !== auth.address) {
          return this.json(res, 403, { error: 'not_owner', message: 'That wallet does not own this launchpad.' });
        }
      }

      const saved = this.branding.put(row.slug, body.branding ?? {});
      if (!saved.ok) return this.json(res, 400, saved);
      return this.json(res, 200, { ok: true, branding: this.branding.get(row.slug) });
    }

    // --- export -------------------------------------------------------------
    if (method === 'GET' && route === '/export/status') {
      return this.json(res, 200, { github: githubStatus() });
    }

    const exportMatch = route.match(/^\/export\/([^/]+)\/(preview|download)$/);
    if (method === 'GET' && exportMatch) {
      const view = await this.padView(exportMatch[1]);
      if (!view) return this.json(res, 404, { error: 'not_found' });
      let files;
      try {
        files = buildExport({
          pad: view,
          chainId: this.chainId,
          contracts: this.contracts,
          apex: this.apex,
          accentColors: ACCENT_COLORS,
        });
      } catch (error) {
        return this.json(res, 500, { error: 'export_refused', message: error.message });
      }
      if (exportMatch[2] === 'preview') {
        return this.json(res, 200, {
          slug: view.slug,
          files: files.map((f) => ({ path: f.path, bytes: f.content.length })),
          github: githubStatus(),
        });
      }
      const tar = buildTar(files);
      res.writeHead(200, {
        'content-type': 'application/x-tar',
        'content-length': tar.length,
        'content-disposition': `attachment; filename="${view.slug}-launchpad.tar"`,
      });
      return res.end(tar);
    }

    // --- admin --------------------------------------------------------------
    if (method === 'POST' && route === '/admin/listing') {
      if (!this.adminToken || req.headers['x-admin-token'] !== this.adminToken) {
        return this.json(res, 401, { error: 'unauthorised' });
      }
      const body = await this.body(req);
      if (!body) return this.json(res, 400, { error: 'bad_body' });
      const status = body.status === LISTING_DELISTED ? LISTING_DELISTED : LISTING_ACTIVE;
      const result = this.registry.setListingStatus(body.slug, status, body.reason ?? null);
      return this.json(res, result.ok ? 200 : 404, result);
    }

    return this.json(res, 404, { error: 'unknown_route', route });
  }

  // --- responses ------------------------------------------------------------

  json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  notFound(res) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  async body(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(); resolve(null); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }

  /**
   * Serves a static file from the web root, refusing anything outside it.
   *
   * Containment is checked on the RESOLVED path, not on the request string.
   * Inspecting the string for `..` looks like a guard but is not one: `normalize`
   * collapses `/../../etc/passwd` to `etc/passwd`, so the marker is gone before
   * the check ever runs. Only comparing the final absolute path to the root is
   * actually sound.
   */
  async serveFile(res, pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return this.notFound(res); }
    if (decoded.includes('\u0000')) return this.notFound(res);

    const root = resolve(this.webRoot);
    const file = resolve(join(root, decoded));
    if (file !== root && !file.startsWith(root + sep)) return this.notFound(res);
    try {
      const info = await stat(file);
      if (!info.isFile()) return this.notFound(res);
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
      return true;
    } catch {
      return this.notFound(res);
    }
  }

  async serveApex(res, url) {
    if (url.pathname !== '/' && extname(url.pathname)) {
      return this.serveFile(res, url.pathname);
    }
    return this.serveFile(res, '/index.html');
  }

  async servePadShell(res, slug, url) {
    if (extname(url.pathname)) return this.serveFile(res, url.pathname);
    return this.serveFile(res, '/pad.html');
  }

  listen(port, hostname = '127.0.0.1') {
    this.server = createServer(this.handler());
    return new Promise((resolve) => {
      this.server.listen(port, hostname, () => resolve(this.server.address()));
    });
  }

  async close() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}

export { Registry, BrandingStore, ChainReader, validateBranding };
