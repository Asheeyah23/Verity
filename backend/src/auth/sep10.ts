import { Keypair, StrKey, WebAuth } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";
import { env, webAuthEndpoint } from "../config/env.js";
import { keeperKeypair } from "../chain/keeper.js";

/** Verity's own SEP-10 signing key. Signing a WebAuth challenge grants no
 * on-chain authority, so falling back to the keeper key is safe — but a
 * deployment should set SEP10_SIGNING_SECRET so the key that pays for keeper
 * transactions is not the one exercised by every login. */
const serverKeypair: Keypair = env.SEP10_SIGNING_SECRET
  ? Keypair.fromSecret(env.SEP10_SIGNING_SECRET)
  : keeperKeypair;
export const sep10SigningKey = serverKeypair.publicKey();

export function buildChallenge(clientAccountId: string, homeDomain: string) {
  return WebAuth.buildChallengeTx(
    serverKeypair,
    clientAccountId,
    homeDomain,
    300,
    env.NETWORK_PASSPHRASE,
    env.WEB_AUTH_DOMAIN
  );
}

/**
 * Verifies the returned challenge really was signed by the claimed account's
 * key — a real Ed25519 signature check against the transaction hash, not a
 * trust-the-client-claim. v1 simplification: checks that the client account
 * itself signed (single-signer assumption), not full weighted-multisig
 * threshold — that needs a Horizon signer-weight lookup, left as a documented
 * follow-up rather than faked.
 */
export function verifyChallenge(signedChallengeXdr: string): { account: string } {
  const { tx, clientAccountID } = WebAuth.readChallengeTx(
    signedChallengeXdr,
    serverKeypair.publicKey(),
    env.NETWORK_PASSPHRASE,
    [env.HOME_DOMAIN],
    env.WEB_AUTH_DOMAIN
  );
  const signers = WebAuth.verifyChallengeTxSigners(
    tx.toXDR(),
    serverKeypair.publicKey(),
    env.NETWORK_PASSPHRASE,
    [clientAccountID],
    [env.HOME_DOMAIN],
    env.WEB_AUTH_DOMAIN
  );
  if (!signers.includes(clientAccountID)) {
    throw new Error("Challenge transaction was not signed by the claimed account");
  }
  return { account: clientAccountID };
}

/**
 * Issues an HS256 session token that names this deployment as its issuer, so
 * another deployment's token (same JWT_SECRET, different WEB_AUTH_ENDPOINT) is
 * not accepted here. Signing in again is required after this shipped.
 */
export function issueJwt(account: string): string {
  return jwt.sign({ sub: account }, env.JWT_SECRET, {
    algorithm: "HS256",
    issuer: webAuthEndpoint,
    expiresIn: "1h",
  });
}

/**
 * Pins the algorithm and the issuer rather than trusting whatever the token
 * header and claims say, and requires the subject to be a real Stellar
 * account: the rate limiter and requireAuth both key off it.
 */
export function verifyJwt(token: string): { sub: string } {
  const payload = jwt.verify(token, env.JWT_SECRET, {
    algorithms: ["HS256"],
    issuer: webAuthEndpoint,
  });
  if (typeof payload !== "object") {
    throw new Error("JWT payload is not an object");
  }
  const { sub } = payload;
  if (typeof sub !== "string" || !StrKey.isValidEd25519PublicKey(sub)) {
    throw new Error("JWT subject is not a Stellar account");
  }
  return { sub };
}
