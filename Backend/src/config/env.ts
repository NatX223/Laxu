import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  // Placeholders — wired up when the corresponding function is built:
  rpcUrl: process.env.RPC_URL ?? "",
  arcusApiBaseUrl: process.env.ARCUS_API_BASE_URL ?? "",
  arcusApiKey: process.env.ARCUS_API_KEY ?? "",
  deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY ?? "",
  arcusOperatorPrivateKey: process.env.ARCUS_OPERATOR_PRIVATE_KEY ?? "",
};
