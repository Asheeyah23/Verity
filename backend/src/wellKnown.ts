import type { FastifyInstance } from "fastify";
import { env, webAuthEndpoint } from "./config/env.js";
import { sep10SigningKey } from "./auth/sep10.js";

/**
 * SEP-1 file advertising the SEP-10 endpoint and its signing key. Served by
 * the backend because WEB_AUTH_DOMAIN points at it; a deployment whose home
 * domain is a different host should serve the same content from there.
 * SEP-1 requires Access-Control-Allow-Origin: * so browser-based wallets can read it.
 */
export async function wellKnownPlugin(app: FastifyInstance) {
  app.get("/.well-known/stellar.toml", async (_req, reply) => {
    reply.type("text/plain");
    reply.header("Access-Control-Allow-Origin", "*");
    return [
      `NETWORK_PASSPHRASE="${env.NETWORK_PASSPHRASE}"`,
      `WEB_AUTH_ENDPOINT="${webAuthEndpoint}"`,
      `SIGNING_KEY="${sep10SigningKey}"`,
    ].join("\n");
  });
}
