import { createPremiumDataServer } from "./server.js";

const port = Number(process.env.PREMIUM_DATA_PORT ?? 4100);
const app = createPremiumDataServer({
  // payTo = the resource-server account that receives USDC (foundation §3.6a):
  payTo: process.env.RESOURCE_SERVER_ADDRESS!,
  network: (process.env.X402_NETWORK as "stellar:testnet" | "stellar:pubnet") ?? "stellar:testnet",
  priceUsdc: process.env.X402_PRICE_USDC ?? "$0.001",
  facilitatorUrl: process.env.X402_FACILITATOR_URL!,
});
app.listen(port, () => console.log(`premium-data x402 listening on :${port}`));
