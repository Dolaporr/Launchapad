// ---------------------------------------------------------------------------
// The pad registry.
//
// This is Launchpad.family's OFFCHAIN bookkeeping: which slug maps to which pad,
// who may be discovered, and what we are willing to distribute. It is never a
// source of economic truth. Fee recipients, attribution, provenance and the
// split live only in the contracts, and nothing here can alter them.
//
// What this file is authoritative for:
//   - slug uniqueness and the short-lived reservation held during signing
//   - one hosted pad per wallet (a V1 anti-squatting measure, offchain by design)
//   - listing status (ACTIVE / DELISTED) for discovery only
//   - abandonment, which hides a pad from discovery WITHOUT touching the chain
//
// Two rules run through all of it:
//   1. A name is only finally taken once the pad exists ON CHAIN. A form
//      submission reserves nothing permanently.
//   2. A namespace is NEVER recycled. Freeing an abandoned name would let
//      somebody else inherit its reputation and links — an impersonation vector.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { validateSlug } from './slug.js';

/** How long a slug is held while the user signs the creation transaction. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** A pad with no valid launch after this long drops out of discovery. */
export const ABANDONED_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const LISTING_ACTIVE = 'ACTIVE';
export const LISTING_DELISTED = 'DELISTED';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pads (
  slug            TEXT PRIMARY KEY,
  chain_id        INTEGER NOT NULL,
  pad_address     TEXT,
  owner_address   TEXT NOT NULL,
  listing_status  TEXT NOT NULL DEFAULT 'ACTIVE',
  delisted_reason TEXT,
  reserved_until  INTEGER,
  created_at      INTEGER NOT NULL,
  confirmed_at    INTEGER,
  first_launch_at INTEGER
);
-- A confirmed pad address may appear exactly once. Partial index so unconfirmed
-- reservations (pad_address NULL) do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS pads_address_unique
  ON pads (chain_id, pad_address) WHERE pad_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS pads_owner ON pads (chain_id, owner_address);
`;

const lower = (a) => String(a || '').trim().toLowerCase();

export class Registry {
  /** @param {string} [path] file path, or ':memory:' for tests. */
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  /** Drops reservations that were never confirmed on chain. Idempotent. */
  sweepExpired(now = Date.now()) {
    const result = this.db
      .prepare('DELETE FROM pads WHERE confirmed_at IS NULL AND reserved_until IS NOT NULL AND reserved_until <= ?')
      .run(now);
    return Number(result.changes || 0);
  }

  /**
   * Row for a slug, or null. Expired reservations are swept first so reads are honest.
   *
   * Normalisation happens HERE so every lookup path agrees with what `reserve` stored.
   * Looking up by the raw user input instead silently missed the row a caller had just
   * created, because "AI Fun" is stored as "ai-fun".
   */
  get(slug, now = Date.now()) {
    const validated = validateSlug(slug);
    if (!validated.ok) return null;
    this.sweepExpired(now);
    return this.db.prepare('SELECT * FROM pads WHERE slug = ?').get(validated.slug) ?? null;
  }

  getByAddress(chainId, padAddress) {
    if (!padAddress) return null;
    return this.db
      .prepare('SELECT * FROM pads WHERE chain_id = ? AND pad_address = ?')
      .get(chainId, lower(padAddress)) ?? null;
  }

  /** Confirmed pads owned by a wallet. Unconfirmed reservations do not count as owning anything. */
  confirmedPadsOfOwner(chainId, owner) {
    return this.db
      .prepare('SELECT * FROM pads WHERE chain_id = ? AND owner_address = ? AND confirmed_at IS NOT NULL')
      .all(chainId, lower(owner));
  }

  /**
   * Is this slug claimable right now?
   * Separates "invalid name" from "already taken" from "being signed for" so the
   * UI can say something true and specific.
   */
  availability(slug, now = Date.now()) {
    const validated = validateSlug(slug);
    if (!validated.ok) return { available: false, ...validated };

    const row = this.get(validated.slug, now);
    if (!row) return { available: true, slug: validated.slug };

    if (row.confirmed_at) {
      return {
        available: false, slug: validated.slug, code: 'taken',
        message: 'That name is already a launchpad.',
      };
    }
    return {
      available: false, slug: validated.slug, code: 'reserved_by_other',
      message: 'Someone is creating a launchpad with that name right now. Try again shortly.',
      reservedUntil: row.reserved_until,
    };
  }

  /**
   * Holds a slug while the owner signs. Deliberately short-lived: an abandoned
   * signing flow must never permanently burn a name.
   *
   * Re-reserving the same slug by the same wallet extends the hold rather than
   * failing, so a user who reloads the builder is not locked out of their own name.
   */
  reserve({ slug, owner, chainId }, now = Date.now()) {
    const validated = validateSlug(slug);
    if (!validated.ok) return { ok: false, ...validated };

    const ownerAddress = lower(owner);
    if (!/^0x[0-9a-f]{40}$/.test(ownerAddress)) {
      return { ok: false, code: 'bad_owner', message: 'Connect a wallet first.' };
    }

    this.sweepExpired(now);

    // One hosted pad per wallet in V1. Offchain only: the contracts impose no
    // such limit, and this restriction is never written into them.
    const existing = this.confirmedPadsOfOwner(chainId, ownerAddress);
    if (existing.length > 0) {
      return {
        ok: false, code: 'owner_limit',
        message: 'This wallet already has a hosted launchpad. V1 allows one per wallet.',
        existingSlug: existing[0].slug,
      };
    }

    const row = this.db.prepare('SELECT * FROM pads WHERE slug = ?').get(validated.slug);
    const until = now + RESERVATION_TTL_MS;

    if (row) {
      if (row.confirmed_at) {
        return { ok: false, code: 'taken', message: 'That name is already a launchpad.' };
      }
      if (row.owner_address !== ownerAddress) {
        return {
          ok: false, code: 'reserved_by_other',
          message: 'Someone is creating a launchpad with that name right now.',
        };
      }
      this.db.prepare('UPDATE pads SET reserved_until = ? WHERE slug = ?').run(until, validated.slug);
      return { ok: true, slug: validated.slug, reservedUntil: until, renewed: true };
    }

    this.db.prepare(`INSERT INTO pads (slug, chain_id, owner_address, reserved_until, created_at)
                     VALUES (?, ?, ?, ?, ?)`)
      .run(validated.slug, chainId, ownerAddress, until, now);
    return { ok: true, slug: validated.slug, reservedUntil: until, renewed: false };
  }

  /** Releases a reservation the same wallet holds. Never releases a confirmed pad. */
  release({ slug, owner }, now = Date.now()) {
    const row = this.get(slug, now);
    if (!row) return { ok: true, released: false };
    if (row.confirmed_at) {
      return { ok: false, code: 'already_confirmed', message: 'That launchpad exists on chain.' };
    }
    if (row.owner_address !== lower(owner)) {
      return { ok: false, code: 'not_yours', message: 'That reservation belongs to another wallet.' };
    }
    this.db.prepare('DELETE FROM pads WHERE slug = ?').run(row.slug);
    return { ok: true, released: true };
  }

  /**
   * Binds a slug to a pad that now EXISTS ON CHAIN. This is the only call that
   * makes a name permanently taken.
   *
   * The caller must have already verified against chain that: the pad exists,
   * `pad.owner()` is this owner, and `pad.metadataURI()` commits to this slug.
   * This method does not read chain itself — it records a verified fact.
   */
  confirm({ slug, owner, chainId, padAddress }, now = Date.now()) {
    const address = lower(padAddress);
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return { ok: false, code: 'bad_address', message: 'Invalid pad address.' };
    }
    const ownerAddress = lower(owner);
    const row = this.get(slug, now);
    if (!row) {
      return { ok: false, code: 'no_reservation', message: 'That reservation has expired.' };
    }
    if (row.confirmed_at) {
      // Idempotent when it is the same pad; a conflict otherwise.
      if (row.pad_address === address) {
        return { ok: true, slug: row.slug, already: true };
      }
      return { ok: false, code: 'taken', message: 'That name is already a launchpad.' };
    }
    if (row.owner_address !== ownerAddress) {
      return { ok: false, code: 'not_yours', message: 'That reservation belongs to another wallet.' };
    }

    const existingForAddress = this.getByAddress(chainId, address);
    if (existingForAddress) {
      return {
        ok: false, code: 'pad_already_listed',
        message: `That pad is already hosted at ${existingForAddress.slug}.`,
      };
    }

    this.db.prepare(`UPDATE pads SET pad_address = ?, confirmed_at = ?, reserved_until = NULL
                     WHERE slug = ?`).run(address, now, row.slug);
    return { ok: true, slug: row.slug, padAddress: address };
  }

  /** Records the pad's first valid launch. Write-once; it is what ends abandonment. */
  recordFirstLaunch(slug, at = Date.now()) {
    const row = this.get(slug, at);
    if (!row || !row.confirmed_at) return { ok: false, code: 'unknown_pad' };
    if (row.first_launch_at) return { ok: true, already: true, at: row.first_launch_at };
    this.db.prepare('UPDATE pads SET first_launch_at = ? WHERE slug = ?').run(at, row.slug);
    return { ok: true, at };
  }

  /**
   * Discovery status. Note what this does NOT do: nothing here changes the chain,
   * redirects fees, or seizes anything. It only decides what we distribute.
   */
  setListingStatus(slug, status, reason = null) {
    if (status !== LISTING_ACTIVE && status !== LISTING_DELISTED) {
      return { ok: false, code: 'bad_status' };
    }
    const row = this.get(slug);
    if (!row) return { ok: false, code: 'unknown_pad' };
    this.db.prepare('UPDATE pads SET listing_status = ?, delisted_reason = ? WHERE slug = ?')
      .run(status, status === LISTING_DELISTED ? reason : null, row.slug);
    return { ok: true, slug: row.slug, status };
  }

  /** A pad is abandoned when it has been confirmed for 14 days with no valid launch. */
  isAbandoned(row, now = Date.now()) {
    if (!row || !row.confirmed_at) return false;
    if (row.first_launch_at) return false;
    return now - row.confirmed_at >= ABANDONED_AFTER_MS;
  }

  /**
   * Everything a pad needs to be resolved and rendered, plus WHY it is or is not
   * discoverable. The hosted page uses this even when the pad is undiscoverable,
   * because a direct URL must keep working.
   */
  resolve(slug, now = Date.now()) {
    const row = this.get(slug, now);
    if (!row || !row.confirmed_at) return null;
    const abandoned = this.isAbandoned(row, now);
    return {
      ...row,
      abandoned,
      discoverable: row.listing_status === LISTING_ACTIVE && !abandoned && Boolean(row.first_launch_at),
    };
  }

  /**
   * Pads eligible for public discovery and the leaderboard.
   *
   * Requires a first launch: empty pads are never ranked. Excludes delisted and
   * abandoned pads. Their hosted URLs and owner dashboards keep working regardless.
   */
  discoverable(chainId, now = Date.now()) {
    this.sweepExpired(now);
    return this.db.prepare(`
      SELECT * FROM pads
      WHERE chain_id = ? AND confirmed_at IS NOT NULL
        AND listing_status = ? AND first_launch_at IS NOT NULL
      ORDER BY confirmed_at ASC
    `).all(chainId, LISTING_ACTIVE).filter((row) => !this.isAbandoned(row, now));
  }

  /** Every confirmed pad, discoverable or not. For owner dashboards and admin views. */
  allConfirmed(chainId) {
    return this.db
      .prepare('SELECT * FROM pads WHERE chain_id = ? AND confirmed_at IS NOT NULL ORDER BY confirmed_at ASC')
      .all(chainId);
  }
}
