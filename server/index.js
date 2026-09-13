#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Launchpad.family server.
//
//   node server/index.js --port 4173 --apex launchpad.family
//
// Production expects wildcard DNS (`*.launchpad.family`) and a wildcard TLS
// certificate in front of this process, so the Host header arrives intact. The
// routing code is identical locally and in production — only the source of the
// Host header differs.
//
// Environment:
//   PORT, HOST              listen address
//   APEX                    apex domain (default launchpad.family)
//   ORIGIN                  public origin baked into immutable metadataURIs
//   CHAIN_ID, RPC_URL       chain to read
//   FACTORY, LAUNCHER, REWARDS, PROTOCOL_TREASURY, POOL_MANAGER
//   DB_PATH                 SQLite file (default: in-memory, nothing persists)
//   ADMIN_TOKEN             enables the delisting endpoint
//   GITHUB_CLIENT_ID/SECRET enables real GitHub export (otherwise download only)
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { App } from './lib/app.js';
import { Registry } from './lib/registry.js';
import { BrandingStore } from './lib/branding.js';
import { ChainReader } from './lib/chain.js';
import { Indexer } from './lib/indexer.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const PORT = Number(arg('port', process.env.PORT || 4173));
const HOST = arg('host', process.env.HOST || '127.0.0.1');
const APEX = arg('apex', process.env.APEX || 'launchpad.family');
const ORIGIN = arg('origin', process.env.ORIGIN || `https://${APEX}`);
const CHAIN_ID = Number(arg('chain-id', process.env.CHAIN_ID || 4663));
const RPC_URL = arg('rpc', process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com');
const DB_PATH = arg('db', process.env.DB_PATH || ':memory:');

const CONTRACTS = {
  factory: arg('factory', process.env.FACTORY || null),
  launcher: arg('launcher', process.env.LAUNCHER || null),
  rewards: arg('rewards', process.env.REWARDS || null),
  protocolTreasury: process.env.PROTOCOL_TREASURY || null,
  // Uniswap's own addresses are never market participants and are excluded from
  // trader counts.
  uniswap: [
    process.env.POOL_MANAGER || '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    '0x58daec3116aae6D93017bAAea7749052E8a04fA7', // PositionManager
    '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf', // FeeSplitter
    '0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99', // UniversalRouter
    '0x23f8209572b4a1C2AD88A42749E830791Fb027f1', // InstantLaunchStrategy
    '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0', // LiquidityLauncher
  ],
};

const webRoot = new URL('../web/', import.meta.url).pathname;

// One database file for every store, so a deployment is a single artefact.
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

const chain = new ChainReader({ rpcUrl: RPC_URL, chainId: CHAIN_ID });

const app = new App({
  registry: new Registry(DB_PATH),
  branding: new BrandingStore(db),
  chain,
  webRoot,
  apex: APEX,
  chainId: CHAIN_ID,
  origin: ORIGIN,
  adminToken: process.env.ADMIN_TOKEN || null,
  contracts: CONTRACTS,
  indexer: CONTRACTS.launcher
    ? new Indexer({
      chain,
      launcher: CONTRACTS.launcher,
      poolManager: CONTRACTS.uniswap[0],
      dbOrPath: db,
    })
    : null,
});

const address = await app.listen(PORT, HOST);

console.log(`Launchpad.family on http://${HOST}:${address.port}`);
console.log(`  apex      ${APEX}`);
console.log(`  pads      <slug>.${APEX}   (dev mirror: /p/<slug>)`);
console.log(`  chain     ${CHAIN_ID} via ${RPC_URL}`);
console.log(`  factory   ${CONTRACTS.factory ?? '(not configured — the builder cannot create pads)'}`);
console.log(`  launcher  ${CONTRACTS.launcher ?? '(not configured — no launches or metrics)'}`);
console.log(`  database  ${DB_PATH === ':memory:' ? 'in memory (nothing persists)' : DB_PATH}`);

// Verify the RPC really is the chain we claim, rather than discovering it later
// through confusing read failures.
try {
  const reported = await chain.verifyChainId();
  console.log(`  rpc ok    reports chain ${reported}`);
} catch (error) {
  console.warn(`  rpc WARN  ${error.message}`);
}
