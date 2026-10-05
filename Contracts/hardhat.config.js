require("@nomicfoundation/hardhat-toolbox");
require("hardhat-contract-sizer");
require("dotenv").config();

const monadKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.MONAD_ADMIN_PRIVATE_KEY;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  networks: {
    monadTestnet: {
      url: process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: monadKey ? [monadKey] : [],
    },
    robinhoodTestnet: {
      url: process.env.RPC_URL || "",
      chainId: 46630,
      accounts: process.env.ADMIN_PRIVATE_KEY ? [process.env.ADMIN_PRIVATE_KEY] : [],
    },
  },
  // Monad verification (https://docs.monad.xyz/guides/verify-smart-contract/hardhat): Sourcify via
  // MonadVision needs no key; Monadscan goes through the Etherscan v2 API (optional key).
  sourcify: {
    enabled: true,
    apiUrl: "https://sourcify-api-monad.blockvision.org",
    browserUrl: "https://monadvision.com",
  },
  etherscan: {
    enabled: Boolean(process.env.ETHERSCAN_API_KEY),
    apiKey: {
      monadTestnet: process.env.ETHERSCAN_API_KEY || "",
      'robinhood-chain-testnet': 'empty'
    },
    customChains: [
      {
        network: "monadTestnet",
        chainId: 10143,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=10143",
          browserURL: "https://testnet.monadscan.com"
        }
      },
      {
        network: "robinhood-chain-testnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com:443/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com:443"
        }
      }
    ]
  }
};
