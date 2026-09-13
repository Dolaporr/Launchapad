/**
 * Prepares a forked Robinhood Chain mainnet node for the browser lifecycle demo:
 * deploys our contracts, creates an OPEN pad, launches a REAL market token, executes a REAL BUY
 * swap against the resulting Uniswap pool, collects the fees, and splits them.
 *
 * Then prints the addresses for web/e2e/market-lifecycle.mjs.
 *
 *   FORK_RPC=… npx hardhat run scripts/setupMarketFork.cjs --network localhost
 */
const hre = require('hardhat');

const U = {
  liquidityLauncher: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0',
  instantLaunchStrategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',
  feeSplitter: '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf',
  beneficiaryVault: '0xd35E9CA72F64C7F93BE30fad67524323396B36D7',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
};

async function main() {
  const { ethers } = hre;
  const [deployer, padOwner, creator, protocol, trader] = await ethers.getSigners();

  for (const [name, address] of Object.entries(U)) {
    if ((await ethers.provider.getCode(address)) === '0x') {
      throw new Error(`${name} has no code — is this node forked from Robinhood Chain mainnet?`);
    }
  }

  const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
    .deploy(protocol.address, ethers.ZeroAddress);
  await factory.waitForDeployment();

  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
  const launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
    await factory.getAddress(), U.liquidityLauncher, U.instantLaunchStrategy,
    U.beneficiaryVault, U.positionManager, predicted,
  );
  await launcher.waitForDeployment();
  const rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
    .deploy(U.beneficiaryVault, await launcher.getAddress(), protocol.address);
  await rewards.waitForDeployment();

  await (await factory.connect(padOwner).createLaunchpad('Market Pad', 'ipfs://market', 0, 1)).wait();
  const pad = await factory.launchpads(0);

  // A token-only deployment too, so the demo can prove the two are distinguishable.
  await (await (await ethers.getContractAt('Launchpad', pad)).connect(creator)
    .launchToken('Bare Token', 'BARE')).wait();

  // The real market launch.
  await (await launcher.connect(creator).launch(pad, 'Canary Market', 'CNRY')).wait();
  const token = await launcher.allTokens(0);
  const positionTokenId = (await launcher.launchOf(token)).positionTokenId;

  // A REAL buy against the pool the launch created.
  const router = await (await ethers.getContractFactory('V4TestSwapRouter')).deploy(U.poolManager);
  await router.waitForDeployment();
  const key = { currency0: ethers.ZeroAddress, currency1: token, fee: 2500, tickSpacing: 25, hooks: ethers.ZeroAddress };
  const buy = ethers.parseEther('5');
  await (await router.connect(trader).buyExactIn(key, buy, trader.address, { value: buy })).wait();

  // Realise the fees and split them, so the UI has something true to show.
  const splitter = new ethers.Contract(U.feeSplitter, ['function collectFees(uint256[])'], deployer);
  await (await splitter.collectFees([positionTokenId])).wait();
  await (await rewards.collectAndSplit(positionTokenId)).wait();

  console.log(JSON.stringify({
    FACTORY: await factory.getAddress(),
    LAUNCHER: await launcher.getAddress(),
    REWARDS: await rewards.getAddress(),
    PAD: pad,
    PAD_OWNER: padOwner.address,
    CREATOR: creator.address,
    PROTOCOL: protocol.address,
    MARKET_TOKEN: token,
    POSITION_ID: positionTokenId.toString(),
    buyVolume: ethers.formatEther(buy),
    creatorPending: ethers.formatEther(await rewards.pending(creator.address)),
    padOwnerPending: ethers.formatEther(await rewards.pending(padOwner.address)),
    protocolPending: ethers.formatEther(await rewards.pending(protocol.address)),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
