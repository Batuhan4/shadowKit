// GET /api/config — public ShadowKit testnet config for the browser (contract ids, RPC, network).
// First Pages Function; proves the functions/ deploy path. No secrets. (Cloudflare Pages Functions use
// file-based routing: web/functions/api/config.ts -> /api/config.)
import config from "../../src/lib/contracts.json";

export const onRequestGet = async (): Promise<Response> =>
  new Response(JSON.stringify(config), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30",
      "access-control-allow-origin": "*",
    },
  });
