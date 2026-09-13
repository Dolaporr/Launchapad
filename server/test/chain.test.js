import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  ChainReader, selector, encodeAddress, encodeUint,
  decodeAddress, decodeUint, decodeString,
} from '../lib/chain.js';

const require = createRequire(import.meta.url);
const CONTRACTS_DIR = new URL('../../contracts/', import.meta.url).pathname;

// --- pure codec -------------------------------------------------------------

test('selectors are computed, not hardcoded, and match the compiled contracts', () => {
  assert.equal(selector('owner()'), '0x8da5cb5b');
  assert.equal(selector('metadataURI()'), '0x03ee438c');
  assert.equal(selector('launchPolicy()'), '0xf26b16db');
  assert.equal(selector('isLaunchpad(address)'), '0xe4606ec1');
});

test('encodes and decodes words', () => {
  const addr = '0xB314cd4731c4F3B4025FCcF5B8E0a3072E8BCbde';
  assert.equal(encodeAddress(addr).length, 64);
  assert.equal(decodeAddress(encodeAddress(addr)).toLowerCase(), addr.toLowerCase());
  assert.equal(decodeUint(encodeUint(2635400n)), 2635400n);
  assert.equal(decodeUint('0x'), 0n);
});

test('decodes a dynamic string return', () => {
  // offset(32) + length(5) + "hello" padded
  const hex = '0x'
    + '0000000000000000000000000000000000000000000000000000000000000020'
    + '0000000000000000000000000000000000000000000000000000000000000005'
    + Buffer.from('hello').toString('hex').padEnd(64, '0');
  assert.equal(decodeString(hex), 'hello');
  assert.equal(decodeString('0x'), '');
});

// --- integration against a real EVM ----------------------------------------

/**
 * Kills a spawned node and everything it spawned.
 *
 * `npx hardhat node` runs the real node behind a wrapper, so killing the child
 * we hold leaves the node alive and still bound to the port. Spawning detached
 * puts the whole tree in its own process group, and killing the negated pid
 * takes the group. Without this the suite leaves an orphan holding port 8546,
 * and the next run cannot start.
 */
function killTree(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/** Spawns a plain hardhat node and resolves once it is accepting requests. */
async function startNode(port) {
  const child = spawn('npx', ['hardhat', 'node', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: CONTRACTS_DIR,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, FORK_RPC: '' },
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return { child, url };
    } catch { /* not up yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  killTree(child);
  throw new Error('hardhat node did not start');
}

test('signature recovery and pad reads against a real EVM', { timeout: 180000 }, async (t) => {
  let ethers;
  try { ({ ethers } = require('../../contracts/node_modules/ethers')); } catch {
    t.skip('ethers unavailable');
    return;
  }

  let node;
  try { node = await startNode(8546); } catch (e) {
    t.skip(`could not start a local node: ${e.message}`);
    return;
  }
  t.after(() => killTree(node.child));

  const reader = new ChainReader({ rpcUrl: node.url });

  await t.test('recovers the signer of a personal_sign signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const message = 'Launchpad.family\naction: claim\nslug: ai\nnonce: abc123';
    const signature = await wallet.signMessage(message);

    const recovered = await reader.recoverPersonalSign(message, signature);
    assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase());
    assert.equal(await reader.verifySignedBy(message, signature, wallet.address), true);
  });

  await t.test('rejects a signature over a DIFFERENT message', async () => {
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signMessage('nonce: aaa');
    // The whole point of the nonce: a signature cannot be replayed for another action.
    assert.equal(await reader.verifySignedBy('nonce: bbb', signature, wallet.address), false);
  });

  await t.test('rejects a signature from a different wallet', async () => {
    const alice = ethers.Wallet.createRandom();
    const bob = ethers.Wallet.createRandom();
    const message = 'nonce: shared';
    const signature = await alice.signMessage(message);
    assert.equal(await reader.verifySignedBy(message, signature, bob.address), false);
  });

  await t.test('rejects malformed and malleable signatures', async () => {
    const wallet = ethers.Wallet.createRandom();
    const message = 'nonce: mall';
    const signature = await wallet.signMessage(message);

    assert.equal(await reader.recoverPersonalSign(message, '0x'), null);
    assert.equal(await reader.recoverPersonalSign(message, `${signature}ff`), null);
    assert.equal(await reader.recoverPersonalSign(message, signature.slice(0, -2)), null);

    // Flip s to n-s and v accordingly: a second valid signature for the same
    // message. Accepting it would let one authorisation be presented twice.
    const sig = ethers.Signature.from(signature);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const malleable = ethers.concat([
      sig.r,
      ethers.toBeHex(N - BigInt(sig.s), 32),
      new Uint8Array([sig.v === 27 ? 28 : 27]),
    ]);
    assert.equal(await reader.recoverPersonalSign(message, ethers.hexlify(malleable)), null);
  });

  await t.test('reads a deployed launchpad and rejects a non-contract', async () => {
    const provider = new ethers.JsonRpcProvider(node.url);
    const deployer = await provider.getSigner(0);
    const padOwner = await provider.getSigner(1);

    const artifact = (name) => require(`${CONTRACTS_DIR}artifacts/contracts/${name}`);
    const factoryArtifact = artifact('LaunchpadFactory.sol/LaunchpadFactory.json');
    const padArtifact = artifact('Launchpad.sol/Launchpad.json');

    const Factory = new ethers.ContractFactory(
      factoryArtifact.abi, factoryArtifact.bytecode, deployer,
    );
    const factory = await Factory.deploy(await deployer.getAddress(), ethers.ZeroAddress);
    await factory.waitForDeployment();

    const metadataUri = 'https://launchpad.family/p/ai-fun';
    await (await factory.connect(padOwner)
      .createLaunchpad('AI.fun', metadataUri, 0, 1)).wait();
    const padAddress = await factory.launchpads(0);

    const pad = await reader.readPad(padAddress);
    assert.equal(pad.owner.toLowerCase(), (await padOwner.getAddress()).toLowerCase());
    assert.equal(pad.name, 'AI.fun');
    assert.equal(pad.metadataURI, metadataUri);
    assert.equal(pad.launchPolicy, 1); // OPEN
    assert.equal(await reader.factoryKnowsPad(await factory.getAddress(), padAddress), true);

    // An EOA is not a pad, and must not read as an empty one.
    assert.equal(await reader.readPad(await deployer.getAddress()), null);
    assert.equal(await reader.readPad('0xdeadbeef'), null);
    // A real contract that is not from this factory is not vouched for.
    assert.equal(
      await reader.factoryKnowsPad(await factory.getAddress(), await factory.getAddress()),
      false,
    );

    // Unused here, but proves the artifact shape is what we think it is.
    assert.ok(padArtifact.abi.length > 0);
  });
});
