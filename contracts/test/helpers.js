const { ethers } = require('hardhat');

const PRESET = { STANDARD: 0, NVDA: 1 };
const POLICY = { OWNER_ONLY: 0, OPEN: 1 };

/// Fixture: a factory whose reserve receiver is a plain EOA (NOT a ReserveVault — the vault
/// rejects native currency on purpose).
async function deployFactory() {
  const [deployer, padOwner, protocol, reserveReceiver, stranger] = await ethers.getSigners();
  const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
    .deploy(protocol.address, reserveReceiver.address);
  return { factory, deployer, padOwner, protocol, reserveReceiver, stranger };
}

async function createPad(factory, signer, name, uri, preset, policy = POLICY.OWNER_ONLY) {
  const tx = await factory.connect(signer).createLaunchpad(name, uri, preset, policy);
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === 'LaunchpadCreated');

  return {
    pad: await ethers.getContractAt('Launchpad', event.args.launchpad),
    router: await ethers.getContractAt('FeeRouter', event.args.feeRouter),
    event,
    receipt,
  };
}

module.exports = { PRESET, POLICY, deployFactory, createPad };
