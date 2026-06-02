import { createShadowKitApiServer } from "./server.js";

const port = Number(process.env.SHADOWKIT_API_PORT ?? 4200);
const app = createShadowKitApiServer({
  payTo: process.env.RESOURCE_SERVER_ADDRESS!, // the account that receives USDC (foundation §3.6a)
  network: (process.env.X402_NETWORK as "stellar:testnet" | "stellar:pubnet") ?? "stellar:testnet",
  priceUsdc: process.env.X402_PRICE_USDC ?? "$0.001",
  facilitatorUrl: process.env.X402_FACILITATOR_URL!,
  govVaultId: process.env.GOV_VAULT_ID!,
  rpcUrl: process.env.RPC_URL!,
  direction: (process.env.X402_DIRECTION as "both" | "agent-pays-only") ?? "both",
});
app.listen(port, () => console.log(`shadowkit-api x402 listening on :${port}`));
