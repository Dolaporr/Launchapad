// ---------------------------------------------------------------------------
// Chain indexer.
//
// Turns chain state into the launch and trade records the metrics need. Two
// things it deliberately does NOT do:
//
//   - It never trusts the registry about what launched. A launch counts only if
//     `verifyMarketLaunch` is true on chain AND the launch names this pad.
//   - It never infers a trader from Uniswap's `Swap` event. In v4 the `sender`
//     on that event is the ROUTER, not the person trading, so counting it would
//     count routers. Traders are derived from the token's own `Transfer` logs:
//     for any transfer where one side is the PoolManager, the other side is the
//     trader — the recipient on a buy, the sender on a sell.
//
// The known limitation, stated rather than hidden: if someone trades through an
// intermediary contract that then forwards the tokens, the intermediary is
// counted as the trader.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { keccak256Hex } from './keccak.js';
import { encodeAddress, decodeAddress, decodeUint } from './chain.js';

const TRANSFER_TOPIC = keccak256Hex('Transfer(address,address,uint256)');
const LAUNCH_TOPIC = keccak256Hex('TokenLaunchedToUniswap(address,address,address,address,uint256)');

/** How long an indexed pad stays fresh before a re-read. */
export const CACHE_TTL_MS = 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS launches (
  token         TEXT PRIMARY KEY,
  pad_address   TEXT NOT NULL,
  token_creator TEXT NOT NULL,
  position_id   TEXT,
  launched_at   INTEGER NOT NULL,
  launch_block  INTEGER NOT NULL,
  indexed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS launches_pad ON launches (pad_address);

CREATE TABLE IF NOT EXISTS trades (
  token   TEXT NOT NULL,
  trader  TEXT NOT NULL,
  at      INTEGER NOT NULL,
  block   INTEGER NOT NULL,
  log_idx INTEGER NOT NULL,
  PRIMARY KEY (token, block, log_idx)
);
CREATE INDEX IF NOT EXISTS trades_token ON trades (token);

CREATE TABLE IF NOT EXISTS pad_index_state (
  pad_address     TEXT PRIMARY KEY,
  last_indexed_at INTEGER NOT NULL,
  last_block      INTEGER NOT NULL
);
`;

export class Indexer {
  /**
   * @param {object} o
   * @param {import('./chain.js').ChainReader} o.chain
   * @param {string} o.launcher   LaunchpadFamilyLauncher address
   * @param {string} o.poolManager Uniswap v4 PoolManager
   */
  constructor({ chain, launcher, poolManager, dbOrPath = ':memory:', maxLookbackBlocks = 500000 }) {
    this.chain = chain;
    this.launcher = launcher;
    this.poolManager = poolManager;
    this.maxLookbackBlocks = maxLookbackBlocks;
    this.db = typeof dbOrPath === 'string' ? new DatabaseSync(dbOrPath) : dbOrPath;
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  async blockTime(blockNumber) {
    const block = await this.chain.rpc('eth_getBlockByNumber',
      [`0x${blockNumber.toString(16)}`, false]);
    return block ? Number(BigInt(block.timestamp)) * 1000 : null;
  }

  /** Tokens this launcher records for a pad, filtered to those the chain vouches for. */
  async verifiedLaunchesOf(padAddress) {
    if (!this.launcher) return [];
    const raw = await this.chain.callSig(
      this.launcher, 'tokensOfLaunchpad(address)', [encodeAddress(padAddress)],
    );
    const hex = String(raw || '').replace(/^0x/, '');
    if (hex.length < 128) return [];
    const count = Number(BigInt(`0x${hex.slice(64, 128)}`));
    const tokens = [];
    for (let i = 0; i < count; i += 1) {
      tokens.push(decodeAddress(hex.slice(128 + i * 64, 192 + i * 64)));
    }

    const verified = [];
    for (const token of tokens) {
      const isMarket = await this.chain.callSig(
        this.launcher, 'verifyMarketLaunch(address)', [encodeAddress(token)],
      );
      if (decodeUint(isMarket) !== 1n) continue;

      const record = await this.chain.callSig(
        this.launcher, 'launchOf(address)', [encodeAddress(token)],
      );
      const r = String(record).replace(/^0x/, '');
      const launchPad = decodeAddress(r.slice(192, 256));
      if (launchPad.toLowerCase() !== padAddress.toLowerCase()) continue;

      verified.push({
        token,
        tokenCreator: decodeAddress(r.slice(64, 128)),
        positionId: BigInt(`0x${r.slice(256, 320)}`).toString(),
      });
    }
    return verified;
  }

  /** The block a token launched in, from the launcher's own event. */
  async launchBlockOf(token, head) {
    const filter = {
      address: this.launcher,
      topics: [LAUNCH_TOPIC, `0x${encodeAddress(token)}`],
    };
    let span = 10000;
    let to = head;
    let scanned = 0;
    while (scanned < this.maxLookbackBlocks && to > 0) {
      const from = Math.max(0, to - span + 1);
      let logs;
      try {
        logs = await this.chain.rpc('eth_getLogs', [{
          ...filter,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
        }]);
      } catch {
        if (span <= 2000) throw new Error(`could not read launch logs for ${token}`);
        span = Math.floor(span / 4);
        continue;
      }
      if (logs.length) return Number(BigInt(logs[0].blockNumber));
      scanned += (to - from + 1);
      to = from - 1;
      span = Math.min(span * 2, 200000);
    }
    return null;
  }

  /**
   * Trades against a token's pool, from its Transfer log.
   * A transfer with the PoolManager on one side is a trade; the other side is the trader.
   */
  async tradesOf(token, fromBlock, head) {
    const trades = [];
    const span = 50000;
    for (let start = fromBlock; start <= head; start += span) {
      const end = Math.min(start + span - 1, head);
      const logs = await this.chain.rpc('eth_getLogs', [{
        address: token,
        topics: [TRANSFER_TOPIC],
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
      }]);

      const times = new Map();
      for (const log of logs) {
        const from = decodeAddress(log.topics[1]).toLowerCase();
        const to = decodeAddress(log.topics[2]).toLowerCase();
        const pool = this.poolManager.toLowerCase();
        if (from !== pool && to !== pool) continue;

        const counterparty = from === pool ? to : from;
        // The pool paying the strategy is the launch's own rounding remainder, not a trade.
        if (counterparty === pool) continue;

        const block = Number(BigInt(log.blockNumber));
        if (!times.has(block)) times.set(block, await this.blockTime(block));
        trades.push({
          trader: counterparty,
          at: times.get(block),
          block,
          logIndex: Number(BigInt(log.logIndex ?? '0x0')),
        });
      }
    }
    return trades.filter((t) => t.at !== null);
  }

  /** Reads a pad's launches and their trades, writing them to the cache. */
  async indexPad(padAddress, { force = false, now = Date.now() } = {}) {
    const state = this.db
      .prepare('SELECT * FROM pad_index_state WHERE pad_address = ?')
      .get(padAddress.toLowerCase());
    if (!force && state && now - state.last_indexed_at < CACHE_TTL_MS) {
      return this.readPadLaunches(padAddress);
    }

    const head = await this.chain.getBlockNumber();
    const verified = await this.verifiedLaunchesOf(padAddress);

    for (const entry of verified) {
      const existing = this.db.prepare('SELECT * FROM launches WHERE token = ?').get(entry.token.toLowerCase());
      let launchBlock = existing?.launch_block ?? null;
      let launchedAt = existing?.launched_at ?? null;

      if (launchBlock === null) {
        launchBlock = await this.launchBlockOf(entry.token, head);
        if (launchBlock === null) {
          // Skipped rather than guessed. Logged, because silently dropping a real
          // launch makes a pad look empty when it is not.
          if (process.env.DEBUG_METRICS) {
            console.error(`indexer: could not find launch block for ${entry.token}`);
          }
          continue;
        }
        launchedAt = await this.blockTime(launchBlock);
        if (launchedAt === null) continue;
        this.db.prepare(`INSERT OR REPLACE INTO launches
          (token, pad_address, token_creator, position_id, launched_at, launch_block, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          entry.token.toLowerCase(), padAddress.toLowerCase(), entry.tokenCreator.toLowerCase(),
          entry.positionId, launchedAt, launchBlock, now,
        );
      }

      const trades = await this.tradesOf(entry.token, launchBlock, head);
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO trades (token, trader, at, block, log_idx) VALUES (?, ?, ?, ?, ?)',
      );
      for (const trade of trades) {
        insert.run(entry.token.toLowerCase(), trade.trader, trade.at, trade.block, trade.logIndex);
      }
    }

    this.db.prepare(`INSERT INTO pad_index_state (pad_address, last_indexed_at, last_block)
      VALUES (?, ?, ?) ON CONFLICT(pad_address) DO UPDATE SET
      last_indexed_at = excluded.last_indexed_at, last_block = excluded.last_block`)
      .run(padAddress.toLowerCase(), now, head);

    return this.readPadLaunches(padAddress);
  }

  /** Cached launches for a pad, in the shape metrics expects. */
  readPadLaunches(padAddress) {
    const launches = this.db
      .prepare('SELECT * FROM launches WHERE pad_address = ? ORDER BY launched_at ASC')
      .all(padAddress.toLowerCase());
    const tradeRows = this.db.prepare('SELECT * FROM trades WHERE token = ?');
    return launches.map((row) => ({
      token: row.token,
      tokenCreator: row.token_creator,
      positionId: row.position_id,
      launchedAt: row.launched_at,
      trades: tradeRows.all(row.token).map((t) => ({ trader: t.trader, at: t.at })),
    }));
  }

  /** When a pad's first verified launch happened, or null. Drives abandonment. */
  firstLaunchAt(padAddress) {
    const row = this.db
      .prepare('SELECT MIN(launched_at) AS first FROM launches WHERE pad_address = ?')
      .get(padAddress.toLowerCase());
    return row?.first ?? null;
  }
}
