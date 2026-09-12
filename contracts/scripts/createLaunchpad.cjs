/**
 * Milestone-1 driver: create a real launchpad through a deployed factory, then launch a real
 * token under it, and print explorer links for both.
 *
 * Usage:
 *   FACTORY_ADDRESS=0x... PAD_NAME="My Pad" PAD_PRESET=standard \
 *     npx hardhat run scripts/createLaunchpad.cjs --network robinhoodTestnet
 *
 * Optional: TOKEN_NAME, TOKEN_SYMBOL, TOKEN_SUPPLY (whole tokens) to also launch a token.
 * Set PAD_PRESET=nvda for the NVDA Reserve preset (which accounts for, but does not buy, NVDA).
 */
const hre = require('hardhat');
require('dotenv').config();

const EXPLORERS = {
  4663: 'https://robinhoodchain.blockscout.com',
  46630: 'https://explorer.testnet.chain.robinhood.com',
};

const PRESETS = { standard: 0, nvda: 1 };

function explorerLink(chainId, kind, value) {
  const base = EXPLORERS[Number(chainId)];
  // No explorer known for this chain (e.g. the local hardhat network) — say so rather than
  // fabricating a URL.
  if (!base) return `(no known explorer for chain ${chainId}) ${value}`;
  return `${base}/${kind}/${value}`;
}

async function main() {
  const { ethers } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const factoryAddress = process.env.FACTORY_ADDRESS;
  if (!factoryAddress) throw new Error('FACTORY_ADDRESS is required.');

  const presetKey = (process.env.PAD_PRESET || 'standard').toLowerCase();
  if (!(presetKey in PRESETS)) {
    throw new Error(`PAD_PRESET must be one of: ${Object.keys(PRESETS).join(', ')}`);
  }
  const preset = PRESETS[presetKey];

  const padName = process.env.PAD_NAME || 'My Launchpad';
  const metadataURI = process.env.PAD_METADATA_URI || '';

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error('No signer available. Set DEPLOYER_PRIVATE_KEY in contracts/.env.');

  const factory = await ethers.getContractAt('LaunchpadFactory', ethers.getAddress(factoryAddress));

  if (preset === PRESETS.nvda && !(await factory.supportsNvdaReserve())) {
    throw new Error('This factory was deployed without a reserve receiver; it cannot create NVDA pads.');
  }

  console.log(`Creating launchpad "${padName}" (${presetKey}) as ${signer.address} ...`);
  const createTx = await factory.createLaunchpad(padName, metadataURI, preset);
  const createReceipt = await createTx.wait();

  const created = createReceipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === 'LaunchpadCreated');

  const padAddress = created.args.launchpad;
  const routerAddress = created.args.feeRouter;

  const result = {
    chainId: Number(chainId),
    launchpad: padAddress,
    feeRouter: routerAddress,
    owner: created.args.owner,
    preset: presetKey,
    createTx: createReceipt.hash,
    links: {
      launchpad: explorerLink(chainId, 'address', padAddress),
      feeRouter: explorerLink(chainId, 'address', routerAddress),
      createTx: explorerLink(chainId, 'tx', createReceipt.hash),
    },
  };

  if (process.env.TOKEN_NAME && process.env.TOKEN_SYMBOL) {
    const pad = await ethers.getContractAt('Launchpad', padAddress);
    const supply = BigInt(process.env.TOKEN_SUPPLY || '1000000000');
    console.log(`Launching token ${process.env.TOKEN_SYMBOL} (${supply} whole tokens) ...`);
    const tokenTx = await pad.launchToken(process.env.TOKEN_NAME, process.env.TOKEN_SYMBOL, supply);
    const tokenReceipt = await tokenTx.wait();
    const tokenAddress = await pad.tokens((await pad.tokenCount()) - 1n);

    result.token = {
      address: tokenAddress,
      name: process.env.TOKEN_NAME,
      symbol: process.env.TOKEN_SYMBOL,
      wholeSupply: supply.toString(),
      launchTx: tokenReceipt.hash,
      links: {
        token: explorerLink(chainId, 'address', tokenAddress),
        launchTx: explorerLink(chainId, 'tx', tokenReceipt.hash),
      },
    };
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
