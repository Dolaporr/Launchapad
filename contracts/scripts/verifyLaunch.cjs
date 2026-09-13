/**
 * Deterministic launch verification — READ ONLY. Sends no transaction and signs nothing.
 *
 *   TOKEN=0x… LAUNCHER=0x… npx hardhat run scripts/verifyLaunch.cjs --network robinhood
 *
 * Or verify the frozen proven baseline, taking every address from the baseline record:
 *
 *   npm run verify:baseline
 *
 * Options:
 *   TOKEN, LAUNCHER          addresses to audit
 *   BASELINE=path.json       take addresses and controlled wallets from a launch record
 *   CONTROLLED=0x..,0x..     wallets to classify as ours; everything else is external
 *   OUT=path.json            write the reconstructed launch record here
 *   FROM_BLOCK=n             scan window start (default: the launch block, discovered on chain)
 *
 * Exit code is 1 if any check fails, so this is usable as a CI or monitoring gate.
 */
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
require('dotenv').config();
const { verifyLaunch } = require('./lib/launchVerifier.cjs');

function fmtWei(wei) {
  return `${hre.ethers.formatEther(wei)} ETH (${wei} wei)`;
}

async function main() {
  const { ethers } = hre;

  let token = (process.env.TOKEN || '').trim();
  let launcher = (process.env.LAUNCHER || '').trim();
  let controlled = (process.env.CONTROLLED || '').split(',').map((s) => s.trim()).filter(Boolean);

  const baselinePath = process.env.BASELINE
    ? path.resolve(process.env.BASELINE)
    : path.join(__dirname, '..', 'baseline', 'canary-2026-09-13.json');

  if ((!token || !launcher) && fs.existsSync(baselinePath)) {
    const b = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    token = token || b.token?.address;
    launcher = launcher || b.contracts?.LaunchpadFamilyLauncher;
    if (controlled.length === 0 && b.roles) {
      controlled = Object.values(b.roles).filter((v) => typeof v === 'string' && v.startsWith('0x'));
    }
    console.log(`using baseline ${path.relative(process.cwd(), baselinePath)}`);
  }

  if (!token || !launcher) {
    throw new Error('TOKEN and LAUNCHER are required (or supply a BASELINE record).');
  }

  console.log('='.repeat(78));
  console.log('LAUNCH VERIFICATION — read only');
  console.log(`token    ${token}`);
  console.log(`launcher ${launcher}`);
  console.log(`network  chain ${(await ethers.provider.getNetwork()).chainId}`);
  console.log('='.repeat(78));

  const record = await verifyLaunch({
    provider: ethers.provider,
    token,
    launcher,
    controlledWallets: controlled,
    fromBlock: process.env.FROM_BLOCK ? Number(process.env.FROM_BLOCK) : undefined,
  });

  console.log('\nCHECKS');
  console.log('-'.repeat(78));
  for (const c of record.verification.checks) {
    console.log(`  ${c.passed ? 'PASS ' : 'FAIL '} ${c.id}${c.detail ? `  — ${c.detail}` : ''}`);
  }

  if (record.supplyReconciliation) {
    const s = record.supplyReconciliation;
    console.log('\nSUPPLY RECONCILIATION');
    console.log('-'.repeat(78));
    console.log(`  total supply      ${s.totalSupply}`);
    console.log(`  locked in pool    ${s.lockedInPool}`);
    console.log(`  burned            ${s.burned}`);
    for (const h of s.holders) {
      console.log(`  holder            ${h.balance.padStart(30)}  ${h.address}  [${h.classification}]`);
    }
    console.log(`  EXACT             ${s.exact}`);
  }

  if (record.trading) {
    console.log('\nTRADING  (volume is NOT revenue — only fee capture is revenue)');
    console.log('-'.repeat(78));
    for (const t of record.trading.traders) {
      console.log(`  ${t.classification.padEnd(10)} ${t.address}  received ${t.tokensReceived}`);
    }
    if (record.trading.traders.length === 0) console.log('  no trades yet');
  }

  if (record.feeAccounting) {
    const f = record.feeAccounting;
    console.log('\nFEE ACCOUNTING  (this is the revenue)');
    console.log('-'.repeat(78));
    console.log(`  LP fee collected (native)   ${fmtWei(f.lpFeeNativeWei)}`);
    console.log(`  LP fee collected (token)    ${f.lpFeeTokenWei}`);
    console.log(`  claimable in vault now      ${fmtWei(f.attributedToVaultWei)}`);
    console.log(`  claimed into rewards        ${fmtWei(f.claimedTotalWei)}`);
    for (const role of ['creator', 'launchpadOwner', 'protocol']) {
      console.log(`  ${role.padEnd(15)} credited ${String(f.creditedWei[role]).padStart(16)}`
        + `  withdrawn ${String(f.withdrawnWei[role]).padStart(16)}`
        + `  pending ${String(f.pendingWei[role]).padStart(14)}`);
    }
    console.log(`  unaccounted                 ${f.unaccountedWei} wei`);
    console.log(`  EXACT                       ${f.exact}`);
  }

  if (record.findings?.length) {
    console.log('\nFINDINGS');
    console.log('-'.repeat(78));
    for (const f of record.findings) console.log(`  - ${f}`);
  }

  if (record.notes?.length) {
    console.log('\nNOTES');
    console.log('-'.repeat(78));
    for (const n of record.notes) console.log(`  - ${n}`);
  }

  const out = process.env.OUT ? path.resolve(process.env.OUT) : null;
  if (out) {
    fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\nrecord written to ${out}`);
  }

  const failed = record.verification.checks.filter((c) => !c.passed);
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${record.verification.status} — ${record.verification.checks.length - failed.length}`
    + `/${record.verification.checks.length} checks passed, reconciled at block ${record.reconciledAtBlock}`);
  console.log('='.repeat(78));
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\nVERIFICATION ERRORED: ${e.shortMessage || e.message}`);
  console.error('This is a failure, not an absence of problems. State could not be established.');
  process.exitCode = 1;
});
