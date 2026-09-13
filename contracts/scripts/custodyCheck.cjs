/**
 * Confirms the canary signing keys are still held and still derive the RECORDED addresses.
 *
 * These two wallets carry immutable on-chain attribution for $CANARY and may receive future fee
 * rewards from that pool forever. They must not be rotated or deleted.
 *
 *   npm run custody:check
 *
 * Prints booleans and PUBLIC addresses only. A private key is never printed, logged or written.
 * Read-only: sends no transaction and moves no funds.
 */
const { ethers } = require('ethers');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASELINE = path.join(__dirname, '..', 'baseline', 'canary-2026-09-13.json');

function main() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const expected = {
    padOwner: { address: baseline.roles.launchpadOwner, env: 'PAD_OWNER_PRIVATE_KEY' },
    tokenCreator: { address: baseline.roles.tokenCreator, env: 'TOKEN_CREATOR_PRIVATE_KEY' },
  };

  console.log('CANARY KEY CUSTODY CHECK — read only, no keys printed');
  console.log('='.repeat(72));

  let ok = true;
  for (const [role, { address, env }] of Object.entries(expected)) {
    const key = (process.env[env] || '').trim();
    if (!key) {
      console.log(`  MISSING  ${role.padEnd(13)} ${env} is not set — the recorded address ${address}`);
      console.log('           can no longer be signed for. Attribution is immutable, so any future');
      console.log('           rewards to it would be unreachable.');
      ok = false;
      continue;
    }
    let derived = null;
    try { derived = new ethers.Wallet(key).address; } catch { /* unparseable */ }
    const matches = Boolean(derived) && ethers.getAddress(derived) === ethers.getAddress(address);
    if (!matches) {
      // Deliberately does not print what it derived: that is still key-linked material.
      console.log(`  WRONG    ${role.padEnd(13)} ${env} does not derive the recorded address ${address}.`);
      console.log('           The key appears to have been rotated. Restore the original.');
      ok = false;
      continue;
    }
    console.log(`  OK       ${role.padEnd(13)} retained, derives ${address}`);
  }

  // The treasury never signs, so it needs no key — only a correct recorded address.
  console.log(`  N/A      ${'treasury'.padEnd(13)} ${baseline.roles.protocolTreasury} `
    + '(never signs; paid by permissionless withdrawFor)');

  console.log('='.repeat(72));
  console.log(ok
    ? 'CUSTODY OK — both canary keys retained and correct.'
    : 'CUSTODY FAILED — see above. Do not rotate or delete these keys.');
  if (!ok) process.exitCode = 1;
}

main();
