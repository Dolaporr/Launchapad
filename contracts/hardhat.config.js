require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

// Never inline a key. An empty accounts array simply disables signing for that network.
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || '';
const accounts = deployerKey ? [deployerKey] : [];

// Robinhood Chain network details, verified 2026-09-12 against https://docs.robinhood.com/chain/connecting
// Public RPCs are rate-limited and documented as "not recommended for production use".
const RH_MAINNET_CHAIN_ID = 4663;
const RH_TESTNET_CHAIN_ID = 46630;

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      // Overridable so the browser end-to-end test can run a local node that reports the
      // Robinhood testnet chain id, exercising the app's real network-detection path.
      // This changes nothing about a deployment: it only affects `npx hardhat node`/tests.
      chainId: Number(process.env.HARDHAT_CHAIN_ID || 31337),
      // Mainnet-fork mode, opt-in via FORK_RPC. Off by default so the normal suite stays
      // hermetic and CI never depends on a third-party RPC.
      //   FORK_RPC=https://rpc.mainnet.chain.robinhood.com npm run test:fork
      forking: process.env.FORK_RPC
        ? {
          url: process.env.FORK_RPC,
          ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
        }
        : undefined,
      // Robinhood Chain is not a chain Hardhat ships history for, so executing against forked
      // historical state needs an explicit hardfork activation. Without this, any eth_call at the
      // fork block fails with "No known hardfork for execution on historical block".
      chains: {
        4663: { hardforkHistory: { cancun: 0 } },
        46630: { hardforkHistory: { cancun: 0 } },
      },
    },
    localhost: {
      url: 'http://127.0.0.1:8545',
      chainId: Number(process.env.HARDHAT_CHAIN_ID || 31337),
    },
    robinhoodTestnet: {
      url: process.env.RH_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com',
      chainId: RH_TESTNET_CHAIN_ID,
      accounts,
    },
    // Mainnet is defined so verification and reads work. Deployment to it is gated in
    // scripts/deploy.cjs behind ALLOW_MAINNET=1 and must never happen without explicit approval.
    robinhood: {
      url: process.env.RH_MAINNET_RPC || 'https://rpc.mainnet.chain.robinhood.com',
      chainId: RH_MAINNET_CHAIN_ID,
      accounts,
    },
  },
  etherscan: {
    // Blockscout instances generally accept any non-empty API key string.
    apiKey: {
      robinhood: process.env.EXPLORER_API_KEY || 'blockscout',
      robinhoodTestnet: process.env.EXPLORER_API_KEY || 'blockscout',
    },
    customChains: [
      {
        network: 'robinhood',
        chainId: RH_MAINNET_CHAIN_ID,
        urls: {
          apiURL: 'https://robinhoodchain.blockscout.com/api',
          browserURL: 'https://robinhoodchain.blockscout.com',
        },
      },
      {
        // The testnet explorer is documented at explorer.testnet.chain.robinhood.com. Its
        // verification API path has NOT been confirmed; override with EXPLORER_TESTNET_API_URL
        // if verification fails rather than assuming this is right.
        network: 'robinhoodTestnet',
        chainId: RH_TESTNET_CHAIN_ID,
        urls: {
          apiURL: process.env.EXPLORER_TESTNET_API_URL
            || 'https://explorer.testnet.chain.robinhood.com/api',
          browserURL: 'https://explorer.testnet.chain.robinhood.com',
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
