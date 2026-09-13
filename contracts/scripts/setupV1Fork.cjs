/**
 * Deploys the V1 stack on a forked node so the browser journey has real contracts.
 *
 * Deploys our factory, launcher and rewards against Uniswap's REAL mainnet
 * deployment, funds the pad-owner and creator wallets, and prints the addresses
 * the server needs. It creates NO launchpad and NO token: the whole point of the
 * browser proof is that a person does that through the product.
 *
 *   FORK_RPC=… npx hardhat run scripts/setupV1Fork.cjs --network localhost
 */
const hre = require('hardhat');
const { U } = require('./lib/uniswapCanary.cjs');

async function main() {
  const { ethers, network } = hre;
  await network.provider.send('evm_mine');

  const [deployer, padOwner, creator, treasury, trader] = await ethers.getSigners();

  const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
    .deploy(treasury.address, ethers.ZeroAddress);
  await factory.waitForDeployment();

  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
  const launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
    await factory.getAddress(), U.liquidityLauncher, U.instantLaunchStrategy,
    U.beneficiaryVault, U.positionManager, predicted,
  );
  await launcher.waitForDeployment();

  const rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
    .deploy(U.beneficiaryVault, await launcher.getAddress(), treasury.address);
  await rewards.waitForDeployment();

  if ((await rewards.getAddress()) !== predicted) {
    throw new Error('rewards did not land at the predicted address');
  }

  // The browser wallets need gas.
  for (const wallet of [padOwner, creator, trader]) {
    await (await deployer.sendTransaction({
      to: wallet.address, value: ethers.parseEther('2'),
    })).wait();
  }

  console.log(JSON.stringify({
    FACTORY: await factory.getAddress(),
    LAUNCHER: await launcher.getAddress(),
    REWARDS: await rewards.getAddress(),
    PROTOCOL_TREASURY: treasury.address,
    OWNER: padOwner.address,
    CREATOR: creator.address,
    TRADER: trader.address,
    CHAIN_ID: Number((await ethers.provider.getNetwork()).chainId),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
});
