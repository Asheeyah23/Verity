import assert from "node:assert/strict";
import test from "node:test";
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

const { envSchema } = await import("./env.js");

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
