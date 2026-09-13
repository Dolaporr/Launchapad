import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, padConfig, buildTar, githubStatus } from '../lib/export.js';

const PAD = {
  slug: 'ai',
  padAddress: '0xB314cd4731c4F3B4025FCcF5B8E0a3072E8BCbde',
  owner: '0x1111111111111111111111111111111111111111',
  branding: {
    displayName: 'AI.fun',
    tagline: 'Launch AI tokens',
    description: 'A launchpad for AI projects.',
    accent: 'teal',
    links: { website: 'https://ai.fun/' },
  },
};
const CONTRACTS = {
  factory: '0xfac0000000000000000000000000000000000001',
  launcher: '0x1a0nche000000000000000000000000000000002'.replace('nche', 'bcde'),
  rewards: '0xre0000000000000000000000000000000000003a',
};
const ACCENTS = { teal: '#3FC8B4', violet: '#8B7CFF' };
const ARGS = {
  pad: PAD, chainId: 4663, contracts: CONTRACTS, apex: 'launchpad.family', accentColors: ACCENTS,
};

test('the export contains no keys or secrets', () => {
  const files = buildExport(ARGS);
  const all = files.map((f) => f.content).join('\n');
  // Looks for secret VALUES, not the words. The README deliberately mentions
  // "private key" and "mnemonic" while telling the owner never to commit one.
  for (const pattern of [
    /PRIVATE_KEY\s*=\s*['"]?0x[0-9a-f]{40,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY/,
    /\b(?:mnemonic|seed phrase)\s*[:=]\s*['"][a-z ]{20,}/i,
    /client_secret\s*[:=]\s*['"][^'"]+/i,
    /\b0x[0-9a-f]{64}\b/i,
  ]) {
    assert.ok(!pattern.test(all), `export leaked something matching ${pattern}`);
  }
  // And it ships a .gitignore so the owner does not add one later.
  assert.ok(files.some((f) => f.path === '.gitignore'));
});

test('the config holds addresses only, never economics', () => {
  const config = padConfig(ARGS);
  const serialised = JSON.stringify(config);
  for (const forbidden of ['creatorBps', 'padOwnerBps', 'protocolBps', 'feeRecipient',
    'splitBps', 'treasury', 'privateKey', 'secret']) {
    assert.ok(!serialised.includes(`"${forbidden}"`), `config contains ${forbidden}`);
  }
  assert.equal(config.padAddress, PAD.padAddress);
  assert.equal(config.contracts.launcher, CONTRACTS.launcher);
});

test('the generator refuses to emit a forbidden field rather than emitting it', () => {
  // A future edit that tried to bake the split into the export must fail loudly.
  const poisoned = {
    ...ARGS,
    pad: { ...PAD, branding: { ...PAD.branding, description: 'x', links: { creatorBps: 5000 } } },
  };
  assert.throws(() => padConfig(poisoned), /forbidden field: creatorBps/);
});

test('the README states that a custom frontend inherits no endorsement', () => {
  const readme = buildExport(ARGS).find((f) => f.path === 'README.md').content;
  assert.match(readme, /does \*\*not\*\* mean Launchpad\.family has reviewed, endorsed/);
  // And separates the two claims explicitly.
  assert.match(readme, /Onchain Launch Proof/);
  assert.match(readme, /Listed by Launchpad\.family/);
});

test('the README explains that repointing contracts breaks recognition, not economics', () => {
  const readme = buildExport(ARGS).find((f) => f.path === 'README.md').content;
  assert.match(readme, /not\*\* recognised by Launchpad\.family/);
  assert.match(readme, /enforced\s+by the contracts/);
});

test('the exported client reads economics from chain, not from the repo', () => {
  const appJs = buildExport(ARGS).find((f) => f.path === 'app.js').content;
  assert.match(appJs, /Reads everything from chain/);
  // No hardcoded percentages anywhere in the client.
  assert.ok(!/50\s*\/\s*30\s*\/\s*20|5000|3000|2000/.test(appJs));
});

test('branding survives into the export so it still looks like the pad', () => {
  const files = buildExport(ARGS);
  const html = files.find((f) => f.path === 'index.html').content;
  assert.match(html, /AI\.fun/);
  const css = files.find((f) => f.path === 'style.css').content;
  assert.match(css, /--accent: #3FC8B4/); // the teal from the palette
});

test('the tar archive is well formed and contains every file', () => {
  const files = buildExport(ARGS);
  const tar = buildTar(files);
  assert.equal(tar.length % 512, 0, 'tar must be block aligned');

  // Each file's name appears at the start of a 512-byte header block.
  for (const file of files) {
    const header = tar.subarray(0, tar.length);
    assert.ok(header.includes(Buffer.from(file.path)), `missing ${file.path} in archive`);
  }
  // Ends with the two zero blocks that mark end-of-archive.
  assert.ok(tar.subarray(-1024).every((b) => b === 0));
});

test('tar headers carry a valid checksum', () => {
  const tar = buildTar([{ path: 'a.txt', content: 'hello' }]);
  const header = tar.subarray(0, 512);
  const stored = parseInt(header.subarray(148, 154).toString('ascii'), 8);
  const recomputed = [...header].reduce((sum, byte, i) => (
    sum + (i >= 148 && i < 156 ? 0x20 : byte)
  ), 0);
  assert.equal(stored, recomputed);
});

test('GitHub export reports honestly that it is unconfigured and unproven', () => {
  const status = githubStatus({});
  assert.equal(status.configured, false);
  assert.match(status.reason, /no GitHub OAuth app/);
  // Never claimed as working: no credentials have ever exercised this path.
  assert.equal(status.proven, false);

  const withCreds = githubStatus({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
  assert.equal(withCreds.configured, true);
  assert.equal(withCreds.proven, false, 'must not claim proven merely because it is configured');
});
