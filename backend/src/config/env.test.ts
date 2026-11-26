import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const HOST_ERROR = "must be a host[:port] without scheme or path, e.g. api.verity.example";

// env.ts validates process.env on module load; seed valid values before
// importing envSchema so loading the module never exits or reads a local .env.
const validEnv = {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
};

Object.assign(process.env, validEnv);

const { envSchema, preprocessedSchema, MIN_DRAFT_TTL_S } = await import("./env.js");

const DOMAIN_FIELDS = ["WEB_AUTH_DOMAIN", "HOME_DOMAIN"] as const;

const VALID_HOSTS = [
  "localhost:3001",
  "api.verity.example",
  "localhost",
  "a",
  "sub-1.verity-app.example.com:443",
  "127.0.0.1:8080",
  "api.verity.example:1",
  "api.verity.example:65535",
  "API.Verity.Example",
  `${"a".repeat(62)}.`.repeat(4) + "a",
  `${`${"a".repeat(62)}.`.repeat(4)}a:3001`,
];

const INVALID_HOSTS = [
  "https://x",
  "http://localhost:3001",
  "https://api.verity.example",
  "x/",
  "api.verity.example/",
  "x/auth",
  "api.verity.example/auth",
  "x y",
  " localhost",
  "localhost ",
  "localhost\n",
  "",
  "api.verity.example:0",
  "api.verity.example:65536",
  "api.verity.example:99999",
  "api.verity.example:100000",
  "api.verity.example:",
  "api.verity.example:abc",
  "-bad.example",
  "bad-.example",
  ".example.com",
  "example.com.",
  "a..b",
  "user@api.verity.example",
  "api.verity.example?foo=bar",
  "api.verity.example#frag",
  `${"a".repeat(62)}.`.repeat(4) + "aa",
  `${`${"a".repeat(62)}.`.repeat(4)}aa:3001`,
];

test("envSchema accepts bare host and host:port values for WEB_AUTH_DOMAIN and HOME_DOMAIN", () => {
  for (const field of DOMAIN_FIELDS) {
    for (const value of VALID_HOSTS) {
      const result = envSchema.safeParse({ ...validEnv, [field]: value });
      assert.equal(
        result.success,
        true,
        `expected ${field}=${JSON.stringify(value)} to be accepted`
      );
      if (result.success) {
        assert.equal(result.data[field], value);
      }
    }
  }
});

test("envSchema rejects schemes, paths, whitespace, invalid ports, and malformed hosts", () => {
  for (const field of DOMAIN_FIELDS) {
    for (const value of INVALID_HOSTS) {
      const result = envSchema.safeParse({ ...validEnv, [field]: value });
      assert.equal(
        result.success,
        false,
        `expected ${field}=${JSON.stringify(value)} to be rejected`
      );
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join(".") === field);
        assert.ok(issue, `expected an error issue on ${field} for ${JSON.stringify(value)}`);
        assert.equal(issue.message, HOST_ERROR);
      }
    }
  }
});

const keeper = Keypair.random();
const attestor = Keypair.random();
const sep10 = Keypair.random();
const contractId = StrKey.encodeContract(Buffer.alloc(32));

const baseConfig = {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: contractId,
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: contractId,
  BOND_ASSET_CONTRACT_ID: contractId,
  DATABASE_URL: "postgres://verity:verity@localhost:5432/verity",
  KEEPER_SECRET_KEY: keeper.secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost:3001",
};


test("empty-string optional env values parse to their defaults", () => {
  const parsed = preprocessedSchema.parse({
    ...baseConfig,
    ATTESTATION_SIGNING_SECRET: "",
    SEP10_SIGNING_SECRET: "",
    PUBLIC_SCHEME: "",
    PORT: "",
    DEPLOYMENT_NAME: "",
    ARTIFACT_STORAGE_DIR: "",
    ARTIFACT_MAX_BYTES: "",
    ARTIFACT_MAX_TOTAL_BYTES: "",
    ARTIFACT_UPLOADS_PER_MINUTE: "",
    RUN_WORKERS: "",
    TRUST_PROXY: "",
    RATE_LIMIT_PER_MINUTE: "",
    REEXECUTOR_LIVENESS_S: "",
    REPLAY_OVERASSIGN: "",
    REPLAY_REASSIGN_AFTER_S: "",
    DRAFT_TTL_S: "",
  });

  assert.equal(parsed.ATTESTATION_SIGNING_SECRET, undefined);
  assert.equal(parsed.SEP10_SIGNING_SECRET, undefined);
  assert.equal(parsed.PUBLIC_SCHEME, "http");
  assert.equal(parsed.PORT, 3001);
  assert.equal(parsed.DEPLOYMENT_NAME, "testnet");
  assert.equal(parsed.ARTIFACT_STORAGE_DIR, "./.artifacts");
  assert.equal(parsed.ARTIFACT_MAX_BYTES, 262144);
  assert.equal(parsed.ARTIFACT_MAX_TOTAL_BYTES, 10737418240);
  assert.equal(parsed.ARTIFACT_UPLOADS_PER_MINUTE, 30);
  assert.equal(parsed.RUN_WORKERS, true);
  assert.equal(parsed.TRUST_PROXY, false);
  assert.equal(parsed.RATE_LIMIT_PER_MINUTE, 300);
  assert.equal(parsed.REEXECUTOR_LIVENESS_S, 60);
  assert.equal(parsed.REPLAY_OVERASSIGN, 1);
  assert.equal(parsed.REPLAY_REASSIGN_AFTER_S, 120);
  assert.equal(parsed.DRAFT_TTL_S, 3600);
});

test("custom optional values are preserved", () => {
  const parsed = preprocessedSchema.parse({
    ...baseConfig,
    ATTESTATION_SIGNING_SECRET: attestor.secret(),
    SEP10_SIGNING_SECRET: sep10.secret(),
    PORT: "4000",
    RUN_WORKERS: "false",
    RATE_LIMIT_PER_MINUTE: "500",
  });

  assert.equal(parsed.ATTESTATION_SIGNING_SECRET, attestor.secret());
  assert.equal(parsed.SEP10_SIGNING_SECRET, sep10.secret());
  assert.equal(parsed.PORT, 4000);
  assert.equal(parsed.RUN_WORKERS, false);
  assert.equal(parsed.RATE_LIMIT_PER_MINUTE, 500);
});

test("empty string for required key fails validation", () => {
  assert.throws(() => {
    preprocessedSchema.parse({
      ...baseConfig,
      KEEPER_SECRET_KEY: "",
    });
  });
});

// #282: the draft purge must never delete a draft whose transaction is still
// being signed or relayed. 330 s of built-transaction validity + 60 s relay.
test("MIN_DRAFT_TTL_S covers a built transaction's validity plus the relay", async () => {
  const { BUILT_TX_VALIDITY_MS } = await import("../modules/submissions/supersede.js");
  assert.equal(MIN_DRAFT_TTL_S, 390);
  assert.ok(MIN_DRAFT_TTL_S * 1000 >= BUILT_TX_VALIDITY_MS + 45_000);
});

test("DRAFT_TTL_S defaults to 3600, which is accepted", () => {
  const parsed = envSchema.parse(validEnv);
  assert.equal(parsed.DRAFT_TTL_S, 3600);
  assert.equal(envSchema.parse({ ...validEnv, DRAFT_TTL_S: "3600" }).DRAFT_TTL_S, 3600);
});

test("DRAFT_TTL_S at the floor is accepted", () => {
  const parsed = envSchema.parse({ ...validEnv, DRAFT_TTL_S: String(MIN_DRAFT_TTL_S) });
  assert.equal(parsed.DRAFT_TTL_S, MIN_DRAFT_TTL_S);
});

for (const value of ["60", "1", String(MIN_DRAFT_TTL_S - 1), "0", "-5"]) {
  test(`DRAFT_TTL_S=${value} is rejected with a message naming the floor`, () => {
    const result = envSchema.safeParse({ ...validEnv, DRAFT_TTL_S: value });
    assert.equal(result.success, false);
    const issue = result.error!.issues.find((i) => i.path.join(".") === "DRAFT_TTL_S");
    assert.ok(issue, "expected an issue on DRAFT_TTL_S");
    assert.equal(
      issue.message,
      `must be at least ${MIN_DRAFT_TTL_S} seconds so a draft outlives the transaction built for it and its relay`
    );
  });
}

test("startup with DRAFT_TTL_S=60 exits 1 and names the problem", () => {
  const envModule = fileURLToPath(new URL("./env.ts", import.meta.url));
  const run = (draftTtl: string) =>
    spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), envModule], {
      // A cwd with no .env, so dotenv cannot add a developer's local settings.
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...validEnv, DRAFT_TTL_S: draftTtl },
      encoding: "utf8",
      timeout: 60_000,
    });

  const bad = run("60");
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /Invalid environment configuration/);
  assert.match(bad.stderr, new RegExp(`DRAFT_TTL_S: must be at least ${MIN_DRAFT_TTL_S} seconds`));

  const good = run("3600");
  assert.equal(good.status, 0, good.stderr);
});
