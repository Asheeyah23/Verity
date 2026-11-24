import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../http-error.js";
import { buildChallenge, issueJwt, verifyChallenge, verifyJwt } from "./sep10.js";

declare module "fastify" {
  interface FastifyRequest {
    stellarAccount?: string;
  }
}

/** Sign-in is where identities are minted, so it gets a much lower budget
 * than the rest of the API. It applies per client address (and, for a request
 * that already carries a valid token, per account too). */
const authRateLimit = {
  config: { rateLimit: { max: env.AUTH_REQUESTS_PER_MINUTE, timeWindow: "1 minute" } },
};

export async function authPlugin(app: FastifyInstance) {
  app.get("/auth", authRateLimit, async (req) => {
    const query = z
      .object({
        account: z
          .string()
          .min(1)
          .refine(StrKey.isValidEd25519PublicKey, "account must be a valid Stellar public key"),
        home_domain: z.string().optional(),
      })
      .parse(req.query);
    if (query.home_domain !== undefined && query.home_domain !== env.HOME_DOMAIN) {
      throw new HttpError(400, `home_domain must be ${env.HOME_DOMAIN}`);
    }
    const transaction = buildChallenge(query.account, env.HOME_DOMAIN);
    return { transaction, network_passphrase: env.NETWORK_PASSPHRASE };
  });

  app.post("/auth", authRateLimit, async (req, reply) => {
    const body = z.object({ transaction: z.string().min(1) }).parse(req.body);
    try {
      const { account } = verifyChallenge(body.transaction);
      const token = issueJwt(account);
      return { token };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "invalid challenge" };
    }
  });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "missing bearer token" });
    return;
  }
  try {
    const { sub } = verifyJwt(header.slice("Bearer ".length));
    req.stellarAccount = sub;
  } catch {
    reply.code(401).send({ error: "invalid or expired token" });
  }
}
