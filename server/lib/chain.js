// ---------------------------------------------------------------------------
// Server-side chain reads.
//
// The server reads chain for exactly one reason: to VERIFY claims before writing
// anything to the registry. It never writes to chain, holds no key, and never
// decides economics. If chain and the registry ever disagree, chain wins and the
// registry row is wrong.
//
// Zero runtime dependencies. Selectors are computed with our own keccak, so
// there is no hardcoded-constant drift to guard.
// ---------------------------------------------------------------------------

import { keccak256, keccak256Hex, personalSignDigest, toChecksumAddress } from './keccak.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** The EVM's own ecrecover, at precompile address 0x01. */
const ECRECOVER_PRECOMPILE = '0x0000000000000000000000000000000000000001';

const strip = (hex) => String(hex || '').replace(/^0x/, '');
const pad32 = (hex) => strip(hex).padStart(64, '0');

export function selector(signature) {
  return keccak256Hex(signature).slice(0, 10);
}

export function encodeAddress(address) {
  return pad32(String(address).toLowerCase());
}

export function encodeUint(value) {
  return pad32(BigInt(value).toString(16));
}

export function decodeAddress(word) {
  return `0x${strip(word).slice(-40)}`;
}

export function decodeUint(word) {
  const hex = strip(word);
  return hex ? BigInt(`0x${hex}`) : 0n;
}

/** Decodes a single dynamic `string` return value. */
export function decodeString(returnData) {
  const hex = strip(returnData);
  if (hex.length < 128) return '';
  const length = Number(BigInt(`0x${hex.slice(64, 128)}`));
  if (!length) return '';
  const body = hex.slice(128, 128 + length * 2);
  return Buffer.from(body, 'hex').toString('utf8');
}

export class ChainReader {
  constructor({ rpcUrl, chainId, timeoutMs = 20000 }) {
    if (!rpcUrl) throw new Error('rpcUrl is required');
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
    this.timeoutMs = timeoutMs;
    this._id = 0;
  }

  async rpc(method, params = []) {
    this._id += 1;
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this._id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message}`);
    return body.result;
  }

  async call(to, data) {
    return this.rpc('eth_call', [{ to, data }, 'latest']);
  }

  async callSig(to, signature, args = []) {
    return this.call(to, selector(signature) + args.join(''));
  }

  async getCode(address) {
    return this.rpc('eth_getCode', [address, 'latest']);
  }

  async isContract(address) {
    const code = await this.getCode(address);
    return typeof code === 'string' && code !== '0x' && code !== '0x0';
  }

  async getBlockNumber() {
    return Number(BigInt(await this.rpc('eth_blockNumber')));
  }

  /** Verifies the node is actually on the chain we think it is. */
  async verifyChainId() {
    const reported = Number(BigInt(await this.rpc('eth_chainId')));
    if (this.chainId !== undefined && reported !== this.chainId) {
      throw new Error(`RPC is on chain ${reported}, expected ${this.chainId}`);
    }
    return reported;
  }

  // --- Launchpad reads ------------------------------------------------------

  async padOwner(pad) {
    return toChecksumAddress(decodeAddress(await this.callSig(pad, 'owner()')));
  }

  async padName(pad) {
    return decodeString(await this.callSig(pad, 'name()'));
  }

  async padMetadataUri(pad) {
    return decodeString(await this.callSig(pad, 'metadataURI()'));
  }

  async padLaunchPolicy(pad) {
    return Number(decodeUint(await this.callSig(pad, 'launchPolicy()')));
  }

  async factoryKnowsPad(factory, pad) {
    const result = await this.callSig(factory, 'isLaunchpad(address)', [encodeAddress(pad)]);
    return decodeUint(result) === 1n;
  }

  /**
   * Everything needed to decide whether a pad may claim a slug.
   * Returns null when there is no contract at the address at all.
   */
  async readPad(pad) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(pad)) return null;
    if (!await this.isContract(pad)) return null;
    const [owner, name, metadataURI, launchPolicy] = await Promise.all([
      this.padOwner(pad), this.padName(pad), this.padMetadataUri(pad), this.padLaunchPolicy(pad),
    ]);
    return { address: toChecksumAddress(pad), owner, name, metadataURI, launchPolicy };
  }

  // --- Signature verification ----------------------------------------------

  /**
   * Recovers the signer of an EIP-191 personal_sign signature.
   *
   * Uses the EVM's own `ecrecover` precompile through `eth_call` rather than
   * implementing secp256k1 point recovery by hand. That keeps the server free of
   * dependencies while delegating the actual cryptography to the chain we are
   * already talking to — and it is the same function the contracts would use.
   *
   * @returns {Promise<string|null>} checksummed address, or null if unrecoverable
   */
  async recoverPersonalSign(message, signature) {
    const sig = strip(signature);
    if (sig.length !== 130) return null;

    const r = sig.slice(0, 64);
    const s = sig.slice(64, 128);
    let v = parseInt(sig.slice(128, 130), 16);
    // Wallets emit 0/1 or 27/28; normalise to the 27/28 the precompile expects.
    if (v === 0 || v === 1) v += 27;
    if (v !== 27 && v !== 28) return null;

    // Reject the upper half of the curve order: signature malleability means the
    // same message has a second valid signature, which would let one signature be
    // replayed as a "different" one.
    const sValue = BigInt(`0x${s}`);
    const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
    if (sValue === 0n || sValue > HALF_N) return null;

    const digest = personalSignDigest(message).toString('hex');
    const input = digest + pad32(v.toString(16)) + r + s;
    const result = await this.call(ECRECOVER_PRECOMPILE, `0x${input}`);

    const recovered = decodeAddress(result);
    if (!recovered || recovered === ZERO_ADDRESS) return null;
    return toChecksumAddress(recovered);
  }

  /** True when `signature` over `message` was produced by `expected`. */
  async verifySignedBy(message, signature, expected) {
    try {
      const recovered = await this.recoverPersonalSign(message, signature);
      if (!recovered) return false;
      return recovered.toLowerCase() === String(expected).toLowerCase();
    } catch {
      return false;
    }
  }
}

export { keccak256, keccak256Hex, toChecksumAddress, ZERO_ADDRESS };
