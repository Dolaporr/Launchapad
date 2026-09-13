/**
 * CI guard: fails if a deployable contract gains a privileged entry point that is not on the
 * documented allowlist. The README claims an exact set of privileged capabilities; this makes
 * that claim enforceable instead of aspirational.
 *
 * Run: node scripts/checkPrivileged.cjs   (after `npm run compile`)
 */
const fs = require('fs');
const path = require('path');

// The complete set of privileged/state-changing entry points we intend to ship, per contract.
const ALLOWED = {
  LaunchpadFactory: ['createLaunchpad'],
  Launchpad: ['launchToken'],
  LaunchToken: ['transfer', 'approve', 'transferFrom'],
  FeeRouter: ['route', 'withdraw', 'withdrawFor', 'sweepUnaccounted'],
  ReserveVault: ['sweepNonReserve'],
  // Milestone 2 — Uniswap integration.
  LaunchpadRewards: ['attributeLaunch', 'collectAndSplit', 'withdraw', 'withdrawFor'],
  LaunchpadFamilyLauncher: ['launch'],
};

// Artifacts live under a sub-directory for these.
const NESTED = { LaunchpadRewards: 'market', LaunchpadFamilyLauncher: 'market' };

// Names that must never appear on a deployable contract, in any form.
const FORBIDDEN = [
  /^upgradeTo/i, /^initialize$/i, /^pause$/i, /^unpause$/i,
  /^setOwner$/i, /^transferOwnership$/i, /^renounceOwnership$/i,
  /^mint$/i, /^burnFrom$/i, /^setFee/i, /^setLaunchPolicy$/i, /^setPreset$/i,
  /^selfdestruct$/i, /^setReserveToken$/i, /^migrate/i,
];

const ARTIFACTS = path.join(__dirname, '..', 'artifacts', 'contracts');
const failures = [];

for (const [contractName, allowed] of Object.entries(ALLOWED)) {
  const nested = NESTED[contractName];
  const artifactPath = nested
    ? path.join(ARTIFACTS, nested, `${contractName}.sol`, `${contractName}.json`)
    : path.join(ARTIFACTS, `${contractName}.sol`, `${contractName}.json`);
  if (!fs.existsSync(artifactPath)) {
    failures.push(`${contractName}: artifact not found at ${artifactPath} — did compile run?`);
    continue;
  }

  const { abi } = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const stateChanging = abi
    .filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability))
    .map((f) => f.name);

  for (const name of stateChanging) {
    if (!allowed.includes(name)) {
      failures.push(`${contractName}.${name}() is state-changing but not on the allowlist.`);
    }
    if (FORBIDDEN.some((pattern) => pattern.test(name))) {
      failures.push(`${contractName}.${name}() matches a forbidden privileged pattern.`);
    }
  }

  const missing = allowed.filter((name) => !stateChanging.includes(name));
  if (missing.length) {
    failures.push(`${contractName}: expected entry point(s) missing: ${missing.join(', ')}`);
  }

  console.log(`${contractName}: ${stateChanging.length ? stateChanging.join(', ') : '(no state-changing functions)'}`);
}

if (failures.length) {
  console.error('\nPrivileged-capability check FAILED:');
  failures.forEach((f) => console.error(`  - ${f}`));
  console.error('\nIf a new capability is intentional, add it to ALLOWED here AND document it in');
  console.error('contracts/README.md under "Every privileged capability in the system".');
  process.exit(1);
}

console.log('\nPrivileged-capability check passed: no undocumented admin surface.');
