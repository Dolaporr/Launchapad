/**
 * Deploys the Milestone 2 market contracts: LaunchpadFamilyLauncher + LaunchpadRewards.
 *
 * DEPLOY ORDER IS FORCED. LaunchpadRewards refuses an EOA registrar, so the launcher must exist
 * first. The launcher therefore takes the address rewards WILL have, predicted from the deployer
 * nonce, and the script verifies the prediction held before reporting success.
 *
 *   FACTORY_ADDRESS=0x... PROTOCOL_TREASURY=0x... \
 *     npx hardhat run scripts/deployMarket.cjs --network robinhood
 *
 * Mainnet is gated behind ALLOW_MAINNET=1, same as scripts/deploy.cjs.
 */
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
require('dotenv').config();

const MAINNET = 4663n;
const UNISWAP = {
  liquidityLauncher: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0',
  instantLaunchStrategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',
  beneficiaryVault: '0xd35E9CA72F64C7F93BE30fad67524323396B36D7',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
};

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is required.`);
  return v.trim();
}

async function main() {
  const { ethers, network } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  if (chainId === MAINNET && process.env.ALLOW_MAINNET !== '1') {
    throw new Error('Refusing to deploy to Robinhood Chain mainnet. Re-run with ALLOW_MAINNET=1 only when approved.');
  }
  if (chainId !== MAINNET) {
    console.warn(`\n!! Chain ${chainId} is not Robinhood Chain mainnet (4663).`);
    console.warn('!! Uniswap\'s Liquidity Launchpad is deployed on 4663 ONLY. These contracts will');
    console.warn('!! deploy but cannot launch anything here.\n');
  }

  const [deployer] = await ethers.getSigners();
  const factory = ethers.getAddress(required('FACTORY_ADDRESS'));
  const protocolTreasury = ethers.getAddress(required('PROTOCOL_TREASURY'));

  for (const [name, address] of Object.entries(UNISWAP)) {
    const code = await ethers.provider.getCode(address);
    if (code === '0x') throw new Error(`${name} has no code at ${address} on chain ${chainId}.`);
  }

  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predictedRewards = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });

  const launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
    factory, UNISWAP.liquidityLauncher, UNISWAP.instantLaunchStrategy,
    UNISWAP.beneficiaryVault, UNISWAP.positionManager, predictedRewards,
  );
  await launcher.waitForDeployment();

  const rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
    .deploy(UNISWAP.beneficiaryVault, await launcher.getAddress(), protocolTreasury);
  await rewards.waitForDeployment();

  const rewardsAddress = await rewards.getAddress();
  if (rewardsAddress.toLowerCase() !== predictedRewards.toLowerCase()) {
    throw new Error(`Rewards landed at ${rewardsAddress}, launcher expects ${predictedRewards}. Mis-wired — do not use.`);
  }
  if (!(await launcher.isCorrectlyWired())) {
    throw new Error('Launcher reports incorrect wiring. Do not use this pair.');
  }

  const output = {
    network: network.name,
    chainId: Number(chainId),
    deployer: deployer.address,
    contracts: {
      launchpadFamilyLauncher: await launcher.getAddress(),
      launchpadRewards: rewardsAddress,
    },
    config: {
      launchpadFactory: factory,
      protocolTreasury,
      uniswap: UNISWAP,
      split: { creatorBps: 5000, padOwnerBps: 3000, protocolBps: 2000 },
    },
    notes: [
      'The 50/30/20 split applies to the Uniswap CREATOR-FEE STREAM only.',
      'That stream is 40% of the ETH side of a 25 bps LP fee: 5/3/2 bps of BUY volume.',
      'The token side of the LP fee goes 100% to Uniswap; sells earn this protocol nothing.',
      'Nothing here buys NVDA and no v4 hook is used.',
    ],
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `market-${network.name}-${Date.now()}.json`), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
