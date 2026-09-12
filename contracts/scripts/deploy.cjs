/**
 * Deploys ReserveVault + LaunchpadFactory.
 *
 * Deliberate safety properties of this script:
 *   - It refuses to run against mainnet unless ALLOW_MAINNET=1 is set explicitly.
 *   - It refuses to invent a canonical NVDA address. NVDA_ADDRESS must be supplied and is
 *     re-verified against Robinhood's live asset registry unless SKIP_NVDA_VERIFY=1.
 *   - It refuses to wire the ReserveVault as the fee router's reserve receiver. The vault holds
 *     the reserve ERC-20 and rejects native currency; pointing fees at it would revert every route.
 *   - It never prints or persists a private key.
 */
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
require('dotenv').config();

const REGISTRY_URL = 'https://api.robinhood.com/rhj/assets';
const MAINNET_CHAIN_ID = 4663n;

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is missing. Set it in contracts/.env (see .env.example).`);
  }
  return value.trim();
}

/**
 * Verifies NVDA_ADDRESS against Robinhood's live asset registry at deploy time.
 * This is the "never hard-code an address based on an assumption" guard.
 */
async function verifyNvdaAddress(address, chainId) {
  const response = await fetch(REGISTRY_URL);
  if (!response.ok) {
    throw new Error(
      `Could not reach the Robinhood asset registry (HTTP ${response.status}). `
      + 'Verify NVDA_ADDRESS by hand, then re-run with SKIP_NVDA_VERIFY=1.',
    );
  }
  const payload = await response.json();
  const assets = Array.isArray(payload)
    ? payload
    : payload.assets || payload.results || Object.values(payload).find(Array.isArray) || [];

  const nvda = assets.find((asset) => asset.tokenSymbol === 'NVDA');
  if (!nvda) {
    throw new Error('No NVDA entry found in the Robinhood asset registry. Refusing to deploy.');
  }

  const deployments = nvda.deployments || [];
  const match = deployments.find(
    (d) => String(d.contractAddress).toLowerCase() === address.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `NVDA_ADDRESS ${address} does not match the canonical registry entry. `
      + `Registry lists: ${deployments.map((d) => `${d.contractAddress} (chain ${d.chainId})`).join(', ') || 'none'}`,
    );
  }
  if (BigInt(match.chainId) !== chainId) {
    throw new Error(
      `NVDA_ADDRESS ${address} is registered on chain ${match.chainId}, but you are deploying to `
      + `chain ${chainId}. Canonical Robinhood Stock Tokens are only deployed on chain 4663 `
      + '(mainnet). For a testnet run, deploy a clearly-labelled mock and set '
      + 'SKIP_NVDA_VERIFY=1 — and never describe that mock as real NVDA.',
    );
  }

  return {
    symbol: nvda.tokenSymbol,
    name: nvda.tokenName,
    decimals: nvda.tokenDecimals,
    status: nvda.status,
    currentMultiplier: nvda.currentMultiplier,
    registryChainId: match.chainId,
  };
}

const RESERVE_RECEIVER_ERROR =
  'RESERVE_RECEIVER must not be a ReserveVault. The vault holds the reserve ERC-20 and rejects '
  + 'native currency by design, so every NVDA-preset fee route would revert. Point '
  + 'RESERVE_RECEIVER at the constrained NVDA buyer module — or, until that exists, at a '
  + 'clearly-labelled holding address whose balance is NOT presented as NVDA.';

/**
 * Refuses a reserve receiver that looks like a ReserveVault, by probing for the vault's
 * `reserveToken()` view. Catches a vault deployed by an earlier run, not just this one.
 */
async function assertNotAReserveVault(address) {
  const { ethers } = hre;
  const code = await ethers.provider.getCode(address);
  if (code === '0x') return; // An EOA cannot be a vault.

  const selector = ethers.id('reserveToken()').slice(0, 10);
  try {
    const result = await ethers.provider.call({ to: address, data: selector });
    if (result && result !== '0x' && BigInt(result) !== 0n) {
      throw new Error(RESERVE_RECEIVER_ERROR);
    }
  } catch (error) {
    if (error.message === RESERVE_RECEIVER_ERROR) throw error;
    // Any other revert just means this contract is not a ReserveVault.
  }
}

async function main() {
  const { ethers, network } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  if (chainId === MAINNET_CHAIN_ID && process.env.ALLOW_MAINNET !== '1') {
    throw new Error(
      'Refusing to deploy to Robinhood Chain mainnet (4663). Deploy to testnet first. '
      + 'If mainnet is genuinely approved, re-run with ALLOW_MAINNET=1.',
    );
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error('No signer available. Set DEPLOYER_PRIVATE_KEY in contracts/.env.');
  }

  // SKIP_VAULT=1 deploys the launchpad factory alone, with no reserve leg at all.
  // This is the correct shape for Robinhood Chain testnet: canonical NVDA does not exist
  // there, so a ReserveVault would have nothing real to hold and an NVDA-preset launchpad
  // could not do what its name claims. With no reserve receiver the factory itself refuses
  // to create NVDA pads (`supportsNvdaReserve()` returns false) — the honesty boundary is
  // enforced on chain rather than only in the UI.
  const skipVault = process.env.SKIP_VAULT === '1';

  const protocolTreasury = ethers.getAddress(required('PROTOCOL_TREASURY'));
  const nvdaAddress = skipVault ? null : ethers.getAddress(required('NVDA_ADDRESS'));
  const reserveReceiver = skipVault
    ? ethers.ZeroAddress
    : ethers.getAddress(required('RESERVE_RECEIVER'));
  const vaultOwner = ethers.getAddress(process.env.VAULT_OWNER || deployer.address);

  let registryEntry = null;
  if (skipVault) {
    console.log('\nSKIP_VAULT=1 — deploying the launchpad factory only.');
    console.log('No ReserveVault, no reserve receiver, and NVDA-preset launchpads are');
    console.log('impossible on this deployment by construction.\n');
  } else if (process.env.SKIP_NVDA_VERIFY === '1') {
    console.warn(
      '\n!! SKIP_NVDA_VERIFY=1 — the reserve asset was NOT verified against the Robinhood registry.',
    );
    console.warn('!! Whatever is at NVDA_ADDRESS must not be described as canonical NVDA.\n');
  } else {
    registryEntry = await verifyNvdaAddress(nvdaAddress, chainId);
    console.log(`Verified reserve asset against ${REGISTRY_URL}:`, registryEntry);
  }

  let vaultAddress = null;
  if (!skipVault) {
    // Pre-flight: a ReserveVault must never be the native-fee sink. It rejects native currency
    // by design, so pointing fees at one made every NVDA-preset route revert.
    await assertNotAReserveVault(reserveReceiver);

    const vault = await (await ethers.getContractFactory('ReserveVault'))
      .deploy(vaultOwner, nvdaAddress);
    await vault.waitForDeployment();
    vaultAddress = await vault.getAddress();

    if (reserveReceiver.toLowerCase() === vaultAddress.toLowerCase()) {
      throw new Error(RESERVE_RECEIVER_ERROR);
    }
  }

  const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
    .deploy(protocolTreasury, reserveReceiver);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  const output = {
    network: network.name,
    chainId: Number(chainId),
    deployer: deployer.address,
    contracts: {
      reserveVault: vaultAddress,
      launchpadFactory: factoryAddress,
    },
    config: {
      reserveToken: nvdaAddress,
      reserveTokenVerified: registryEntry !== null,
      reserveTokenRegistryEntry: registryEntry,
      protocolTreasury,
      reserveReceiver,
      vaultOwner: skipVault ? null : vaultOwner,
      supportsNvdaReserve: await factory.supportsNvdaReserve(),
    },
    notes: skipVault ? [
      'Factory only: no ReserveVault and no reserve receiver were deployed.',
      'supportsNvdaReserve() is false, so this factory CANNOT create NVDA-preset launchpads.',
      'This deployment does not buy, hold, or represent NVDA in any form.',
    ] : [
      'This deployment does NOT buy NVDA. FeeRouter only accounts for the reserve leg.',
      'RESERVE_RECEIVER is not the vault and is not yet a constrained buyer module.',
      'The vault proves custody of whatever reserveToken was set to, nothing more.',
    ],
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, `${network.name}-${Date.now()}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
  );

  console.log(JSON.stringify(output, null, 2));
  console.log('\nNext: create a launchpad with');
  console.log(`  npx hardhat run scripts/createLaunchpad.cjs --network ${network.name}`);
  console.log(`  (set FACTORY_ADDRESS=${factoryAddress})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
