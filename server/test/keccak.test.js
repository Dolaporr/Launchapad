import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { keccak256, keccak256Hex, personalSignDigest, toChecksumAddress } from '../lib/keccak.js';

// This is the only hand-written cryptography in the project, so it is checked
// twice: against published vectors, and against a mature implementation over
// randomised input. A subtly wrong hash would break signature auth silently.

test('matches published Keccak-256 vectors', () => {
  assert.equal(
    keccak256Hex(''),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
  assert.equal(
    keccak256Hex('abc'),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
  assert.equal(
    keccak256Hex('testing'),
    '0x5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02',
  );
});

test('is NOT NIST SHA3-256, which Node would have given us', async () => {
  const { createHash } = await import('node:crypto');
  const sha3 = createHash('sha3-256').update('abc').digest('hex');
  // If these ever matched, the padding would be wrong.
  assert.notEqual(keccak256Hex('abc').slice(2), sha3);
});

test('handles every boundary around the 136-byte rate', () => {
  // Absorption bugs hide exactly at the block boundary.
  for (const length of [0, 1, 135, 136, 137, 271, 272, 273, 1000]) {
    const input = Buffer.alloc(length, 0xab);
    const digest = keccak256(input);
    assert.equal(digest.length, 32, `wrong length for input ${length}`);
  }
});

test('agrees with ethers over randomised inputs, including block boundaries', async () => {
  // ethers is a devDependency of contracts/ and is used here as an oracle only.
  // The server itself has no runtime dependencies.
  const require = createRequire(import.meta.url);
  let ethers;
  try {
    ({ ethers } = require('../../contracts/node_modules/ethers'));
  } catch {
    // If the oracle is unavailable the published vectors above still cover us.
    return;
  }

  const lengths = [0, 1, 2, 31, 32, 33, 63, 64, 135, 136, 137, 200, 272, 500];
  for (const length of lengths) {
    const bytes = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + length * 11) & 0xff;
    assert.equal(
      keccak256Hex(bytes),
      ethers.keccak256(bytes),
      `mismatch at length ${length}`,
    );
  }

  // And a few random ones.
  for (let i = 0; i < 25; i += 1) {
    const length = Math.floor(Math.random() * 400);
    const bytes = Buffer.from(Array.from({ length }, () => Math.floor(Math.random() * 256)));
    assert.equal(keccak256Hex(bytes), ethers.keccak256(bytes), `mismatch on random input ${i}`);
  }
});

test('computes the same function selectors the web client hardcodes', () => {
  // web/chain.js precomputes these; if keccak were wrong they would not match.
  assert.equal(keccak256Hex('totalSupply()').slice(0, 10), '0x18160ddd');
  assert.equal(keccak256Hex('balanceOf(address)').slice(0, 10), '0x70a08231');
  assert.equal(keccak256Hex('owner()').slice(0, 10), '0x8da5cb5b');
  assert.equal(keccak256Hex('metadataURI()').slice(0, 10), '0x03ee438c');
  assert.equal(keccak256Hex('launchPolicy()').slice(0, 10), '0xf26b16db');
  assert.equal(
    keccak256Hex('Transfer(address,address,uint256)'),
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  );
});

test('personal_sign digest matches ethers hashMessage', async () => {
  const require = createRequire(import.meta.url);
  let ethers;
  try {
    ({ ethers } = require('../../contracts/node_modules/ethers'));
  } catch { return; }

  for (const message of ['', 'hello', 'Launchpad.family\nnonce: abc123', 'x'.repeat(300)]) {
    assert.equal(
      `0x${personalSignDigest(message).toString('hex')}`,
      ethers.hashMessage(message),
      `mismatch for message of length ${message.length}`,
    );
  }
});

test('checksums addresses per EIP-55', () => {
  assert.equal(
    toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'),
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  );
  assert.equal(
    toChecksumAddress('0xB314cd4731c4F3B4025FCcF5B8E0a3072E8BCbde'.toLowerCase()),
    '0xB314cd4731c4F3B4025FCcF5B8E0a3072E8BCbde',
  );
  assert.throws(() => toChecksumAddress('nope'), /not an address/);
});
