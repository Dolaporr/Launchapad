/**
 * Launches a token through an existing launchpad, optionally from a DIFFERENT wallet than the
 * pad owner. That second-wallet path is the whole point of the Open launch policy: anybody can
 * launch through someone else's pad, and the supply belongs to them.
 *
 * Usage:
 *   PAD_ADDRESS=0x... TOKEN_NAME="Alpha" TOKEN_SYMBOL="ALPHA" TOKEN_SUPPLY=1000000 \
 *   [TOKEN_CREATOR_PRIVATE_KEY=0x...] \
 *     npx hardhat run scripts/launchToken.cjs --network robinhoodTestnet
 *
 * TOKEN_CREATOR_PRIVATE_KEY defaults to DEPLOYER_PRIVATE_KEY. Never printed, never committed.
 */
const hre = require('hardhat');
require('dotenv').config();

const EXPLORERS = {
  4663: 'https://robinhoodchain.blockscout.com',
  46630: 'https://explorer.testnet.chain.robinhood.com',
};

function explorerLink(chainId, kind, value) {
  const base = EXPLORERS[Number(chainId)];
  if (!base) return `(no known explorer for chain ${chainId}) ${value}`;
  return `${base}/${kind}/${value}`;
}

async function main() {
  const { ethers } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const padAddress = ethers.getAddress(process.env.PAD_ADDRESS || '');
  const tokenName = process.env.TOKEN_NAME;
  const tokenSymbol = process.env.TOKEN_SYMBOL;
  const wholeSupply = BigInt(process.env.TOKEN_SUPPLY || '1000000');
  if (!tokenName || !tokenSymbol) throw new Error('TOKEN_NAME and TOKEN_SYMBOL are required.');

  const creatorKey = process.env.TOKEN_CREATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!creatorKey) throw new Error('No signing key available.');
  const creator = new ethers.Wallet(creatorKey, ethers.provider);

  const pad = await ethers.getContractAt('Launchpad', padAddress, creator);

  const [padOwner, policy, canLaunch, balance] = await Promise.all([
    pad.owner(),
    pad.launchPolicy(),
    pad.canLaunch(creator.address),
    ethers.provider.getBalance(creator.address),
  ]);

  console.log(`Pad:            ${padAddress}`);
  console.log(`Pad owner:      ${padOwner}`);
  console.log(`Launch policy:  ${policy === 1n ? 'Open' : 'OwnerOnly'}`);
  console.log(`Token creator:  ${creator.address} (${creator.address.toLowerCase() === padOwner.toLowerCase() ? 'IS the pad owner' : 'is NOT the pad owner'})`);
  console.log(`Creator gas:    ${ethers.formatEther(balance)} ETH`);
  if (!canLaunch) throw new Error('This wallet cannot launch on this pad (owner-only policy).');

  const receipt = await (await pad.launchToken(tokenName, tokenSymbol, wholeSupply)).wait();

  const event = receipt.logs
    .map((log) => { try { return pad.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed && parsed.name === 'TokenLaunched');
  const tokenAddress = event.args.token;

  const token = await ethers.getContractAt('LaunchToken', tokenAddress);
  const [supply, creatorBalance, ownerBalance] = await Promise.all([
    token.totalSupply(),
    token.balanceOf(creator.address),
    token.balanceOf(padOwner),
  ]);

  console.log(JSON.stringify({
    chainId: Number(chainId),
    launchpad: padAddress,
    token: tokenAddress,
    name: tokenName,
    symbol: tokenSymbol,
    creator: event.args.creator,
    totalSupply: ethers.formatEther(supply),
    creatorHolds: ethers.formatEther(creatorBalance),
    padOwnerHolds: ethers.formatEther(ownerBalance),
    launchTx: receipt.hash,
    gasUsed: receipt.gasUsed.toString(),
    links: {
      token: explorerLink(chainId, 'address', tokenAddress),
      launchTx: explorerLink(chainId, 'tx', receipt.hash),
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
