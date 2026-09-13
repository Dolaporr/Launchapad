// ---------------------------------------------------------------------------
// keccak256.
//
// Node ships `sha3-256`, which is NOT this. NIST SHA-3 appends the domain bits
// `01` before padding; Ethereum's Keccak-256 is the original submission and
// appends nothing. They produce completely different digests for the same input,
// so the built-in cannot be substituted here.
//
// This is the one piece of cryptography written by hand in this project, purely
// to keep the server free of runtime dependencies. It is verified in tests
// against published vectors AND against ethers' implementation over random
// inputs, because a hash that is subtly wrong would silently break signature
// authentication rather than failing loudly.
// ---------------------------------------------------------------------------

const RATE_BYTES = 136; // 1600 - 2*256 bits, as bytes: the Keccak-256 rate.
const ROUNDS = 24;

// Round constants for Keccak-f[1600], split into lo/hi 32-bit halves because JS
// bitwise operators are 32-bit. Using BigInt throughout would be simpler but an
// order of magnitude slower, and this runs on every request.
const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
  0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);
const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  // Round 21 is 0x8000000000008080 and round 22 is 0x0000000080000001 — their high
  // words differ, and transposing them only corrupts the final rounds, which shows
  // up as a digest that still partially resembles the correct one.
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);

// Rotation offsets and the pi permutation, flattened for the lane layout below.
const ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
  27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];
const PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
  15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

/**
 * Keccak-f[1600] on a 50-word state (25 lanes x {lo, hi}).
 * Lane i occupies s[2i] = low 32 bits, s[2i+1] = high 32 bits.
 */
function keccakF(s) {
  const bcLo = new Uint32Array(5);
  const bcHi = new Uint32Array(5);

  for (let round = 0; round < ROUNDS; round += 1) {
    // Theta
    for (let i = 0; i < 5; i += 1) {
      bcLo[i] = s[i * 2] ^ s[(i + 5) * 2] ^ s[(i + 10) * 2] ^ s[(i + 15) * 2] ^ s[(i + 20) * 2];
      bcHi[i] = s[i * 2 + 1] ^ s[(i + 5) * 2 + 1] ^ s[(i + 10) * 2 + 1]
        ^ s[(i + 15) * 2 + 1] ^ s[(i + 20) * 2 + 1];
    }
    for (let i = 0; i < 5; i += 1) {
      const j = (i + 4) % 5;
      const k = (i + 1) % 5;
      // rotl64(bc[k], 1)
      const rotLo = ((bcLo[k] << 1) | (bcHi[k] >>> 31)) >>> 0;
      const rotHi = ((bcHi[k] << 1) | (bcLo[k] >>> 31)) >>> 0;
      const tLo = (bcLo[j] ^ rotLo) >>> 0;
      const tHi = (bcHi[j] ^ rotHi) >>> 0;
      for (let y = 0; y < 25; y += 5) {
        s[(y + i) * 2] = (s[(y + i) * 2] ^ tLo) >>> 0;
        s[(y + i) * 2 + 1] = (s[(y + i) * 2 + 1] ^ tHi) >>> 0;
      }
    }

    // Rho and Pi
    let tLo = s[2];
    let tHi = s[3];
    for (let i = 0; i < 24; i += 1) {
      const j = PILN[i];
      const cLo = s[j * 2];
      const cHi = s[j * 2 + 1];
      const n = ROTC[i];
      let rLo; let rHi;
      if (n < 32) {
        rLo = ((tLo << n) | (tHi >>> (32 - n))) >>> 0;
        rHi = ((tHi << n) | (tLo >>> (32 - n))) >>> 0;
      } else if (n === 32) {
        rLo = tHi; rHi = tLo;
      } else {
        const m = n - 32;
        rLo = ((tHi << m) | (tLo >>> (32 - m))) >>> 0;
        rHi = ((tLo << m) | (tHi >>> (32 - m))) >>> 0;
      }
      s[j * 2] = rLo;
      s[j * 2 + 1] = rHi;
      tLo = cLo; tHi = cHi;
    }

    // Chi
    for (let y = 0; y < 25; y += 5) {
      for (let i = 0; i < 5; i += 1) {
        bcLo[i] = s[(y + i) * 2];
        bcHi[i] = s[(y + i) * 2 + 1];
      }
      for (let i = 0; i < 5; i += 1) {
        const a = (i + 1) % 5;
        const b = (i + 2) % 5;
        s[(y + i) * 2] = (bcLo[i] ^ (~bcLo[a] & bcLo[b])) >>> 0;
        s[(y + i) * 2 + 1] = (bcHi[i] ^ (~bcHi[a] & bcHi[b])) >>> 0;
      }
    }

    // Iota
    s[0] = (s[0] ^ RC_LO[round]) >>> 0;
    s[1] = (s[1] ^ RC_HI[round]) >>> 0;
  }
}

/**
 * @param {Uint8Array|Buffer} input
 * @returns {Buffer} 32-byte digest
 */
export function keccak256(input) {
  const data = input instanceof Uint8Array ? input : Buffer.from(input);
  const state = new Uint32Array(50);

  // Absorb.
  const blocks = Math.floor(data.length / RATE_BYTES);
  let offset = 0;
  for (let b = 0; b < blocks; b += 1) {
    for (let i = 0; i < RATE_BYTES; i += 1) {
      const byte = data[offset + i];
      const lane = (i / 8) | 0;
      const shift = (i % 8) * 8;
      if (shift < 32) {
        state[lane * 2] = (state[lane * 2] ^ (byte << shift)) >>> 0;
      } else {
        state[lane * 2 + 1] = (state[lane * 2 + 1] ^ (byte << (shift - 32))) >>> 0;
      }
    }
    keccakF(state);
    offset += RATE_BYTES;
  }

  // Pad. Keccak's original padding is 0x01 ... 0x80 — NOT SHA-3's 0x06.
  const tail = new Uint8Array(RATE_BYTES);
  const remaining = data.length - offset;
  tail.set(data.subarray(offset), 0);
  tail[remaining] = 0x01;
  tail[RATE_BYTES - 1] = (tail[RATE_BYTES - 1] | 0x80) & 0xff;

  for (let i = 0; i < RATE_BYTES; i += 1) {
    const byte = tail[i];
    const lane = (i / 8) | 0;
    const shift = (i % 8) * 8;
    if (shift < 32) {
      state[lane * 2] = (state[lane * 2] ^ (byte << shift)) >>> 0;
    } else {
      state[lane * 2 + 1] = (state[lane * 2 + 1] ^ (byte << (shift - 32))) >>> 0;
    }
  }
  keccakF(state);

  // Squeeze 32 bytes.
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) {
    const lane = (i / 8) | 0;
    const shift = (i % 8) * 8;
    const word = shift < 32 ? state[lane * 2] : state[lane * 2 + 1];
    out[i] = (word >>> (shift % 32)) & 0xff;
  }
  return out;
}

/** keccak256 of a UTF-8 string, as a 0x-prefixed hex string. */
export function keccak256Hex(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return `0x${keccak256(bytes).toString('hex')}`;
}

/**
 * The EIP-191 "personal_sign" digest: keccak256("\x19Ethereum Signed Message:\n" + len + message).
 * This is what a wallet actually signs when a dapp calls personal_sign.
 */
export function personalSignDigest(message) {
  const body = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  return keccak256(Buffer.concat([prefix, body]));
}

/** EIP-55 checksummed address from 20 raw bytes or a hex string. */
export function toChecksumAddress(address) {
  const hex = String(address).replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`not an address: ${address}`);
  const hash = keccak256(Buffer.from(hex, 'utf8')).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i += 1) {
    out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}
