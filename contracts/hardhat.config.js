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
      chainId: 31337,
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
