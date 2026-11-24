import "dotenv/config";
import "./net.js";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

const flag = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((v) => v === "true");

const contractId = z
  .string()
  .refine((v) => StrKey.isValidContract(v), "must be a Soroban contract ID starting with C");

const secretSeed = z
  .string()
  .refine(
    (v) => StrKey.isValidEd25519SecretSeed(v),
    "must be a Stellar secret key starting with S"
  );

const databaseUrl = z
  .string()
  .refine(
    (v) => /^postgres(ql)?:\/\//.test(v),
    "must be a PostgreSQL connection URL starting with postgres:// or postgresql://"
  );

const HOST_WITH_PORT_RE =
  /^(?=.{1,253}(:\d{1,5})?$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

function isValidHostWithPort(value: string): boolean {
  if (!HOST_WITH_PORT_RE.test(value)) return false;
  const colon = value.indexOf(":");
  if (colon === -1) return true;
  const port = Number(value.slice(colon + 1));
  return port >= 1 && port <= 65535;
}

const hostWithPort = z
  .string()
  .refine(
    isValidHostWithPort,
    "must be a host[:port] without scheme or path, e.g. api.verity.example"
  );

export const envSchema = z.object({
  SOROBAN_RPC_URL: z.string().url(),
  NETWORK_PASSPHRASE: z.string().min(1),
  ESCROW_GATE_CONTRACT_ID: contractId,
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: contractId,
  BOND_ASSET_CONTRACT_ID: contractId,
  DATABASE_URL: databaseUrl,
  KEEPER_SECRET_KEY: secretSeed,
  // Signs SEP-10 challenges. Defaults to the keeper key; give it its own so
  // the key that moves funds is not also the one answering every login.
  SEP10_SIGNING_SECRET: secretSeed.optional(),
  // Signs verdict attestations. Defaults to the keeper key; give it its own so
  // rotating the fund-moving key does not change every future attestation's attestor.
  ATTESTATION_SIGNING_SECRET: secretSeed.optional(),
  JWT_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -hex 32)"),
  // Host (and port) users reach the auth endpoint on, without a scheme.
  WEB_AUTH_DOMAIN: hostWithPort,
  HOME_DOMAIN: hostWithPort,
  // Scheme the public sees: "https" behind any real reverse proxy.
  PUBLIC_SCHEME: z.enum(["http", "https"]).default("http"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  // Shown by /health so tooling can tell which deployment it is talking to.
  DEPLOYMENT_NAME: z.string().default("testnet"),
  ARTIFACT_STORAGE_DIR: z.string().default("./.artifacts"),
  ARTIFACT_MAX_BYTES: z.coerce.number().int().positive().default(262_144),
  /** Cap on everything in ARTIFACT_STORAGE_DIR; an upload that would pass it is refused (507). */
  ARTIFACT_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(10 * 1024 ** 3),
  /** Uploads per account (or address) per minute, tighter than the global limit. */
  ARTIFACT_UPLOADS_PER_MINUTE: z.coerce.number().int().positive().default(30),

  // The indexer and keeper share one account sequence and one chain cursor,
  // so exactly one process may run them. Extra API-only instances set false.
  RUN_WORKERS: flag("true"),
  // Set true only behind a reverse proxy you control, so the client address
  // used for rate limiting comes from X-Forwarded-For.
  TRUST_PROXY: flag("false"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** Sign-in requests per client address per minute. Minting an identity costs
   * a GET and a POST /auth, so this stays far below the general budget. */
  AUTH_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(20),

  // A re-executor counts as online if its worker polled for work this recently.
  REEXECUTOR_LIVENESS_S: z.coerce.number().int().positive().default(60),
  // Extra re-executors assigned beyond quorum, so one slow or offline worker
  // does not cost a submission its consensus.
  REPLAY_OVERASSIGN: z.coerce.number().int().min(0).default(1),
  // An assignment unanswered for this long no longer counts toward quorum
  // and another re-executor is asked.
  REPLAY_REASSIGN_AFTER_S: z.coerce.number().int().positive().default(120),
  // Unsigned submission drafts older than this are deleted. Must outlast the
  // validity of the transaction built for them.
  DRAFT_TTL_S: z.coerce.number().int().positive().default(3600),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".");
    console.error(`  - ${path}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
