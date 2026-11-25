import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// The app reads the validated environment at import time; assign before the
// first import so a developer's backend/.env is never used. A small limit, so
// both sides of it can be reached with a few bytes.
const MAX_BYTES = 10;
Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  ATTESTATION_SIGNING_SECRET: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
  ARTIFACT_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "verity-artifact-routes-")),
  ARTIFACT_MAX_BYTES: String(MAX_BYTES),
});

const { artifactBodyLimit } = await import("./routes.js");
const { buildApp } = await import("../../app.js");
const { issueJwt } = await import("../../auth/sep10.js");

const app = await buildApp();
app.log.level = "silent";
after(() => app.close());

const token = issueJwt(Keypair.random().publicKey());
const upload = (payload: unknown) =>
  app.inject({
    method: "POST",
    url: "/v1/artifacts",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
const base64Of = (bytes: number, fill = 7) => Buffer.alloc(bytes, fill).toString("base64");

test("artifactBodyLimit is the base64 length of the limit plus 4096 bytes", () => {
  for (const bytes of [1, 2, 3, 4, 10, 262_144, 786_432, 1_048_576, 5_000_001]) {
    assert.equal(artifactBodyLimit(bytes), Buffer.alloc(bytes).toString("base64").length + 4096, `${bytes}`);
  }
  assert.equal(artifactBodyLimit(3), 4 + 4096);
  assert.equal(artifactBodyLimit(4), 8 + 4096);
  assert.equal(artifactBodyLimit(262_144), 353_624);
  // What a 1 MiB artifact needs is more than the app-wide 1 MiB body limit.
  assert.equal(artifactBodyLimit(1_048_576), 1_402_200);
  assert.ok(artifactBodyLimit(1_048_576) > 1_048_576);
});

test("an artifact exactly ARTIFACT_MAX_BYTES long is stored", async () => {
  const res = await upload({ content_base64: base64Of(MAX_BYTES) });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().size_bytes, MAX_BYTES);
});

test("one byte over gets the 413 that names the limit", async () => {
  const res = await upload({ content_base64: base64Of(MAX_BYTES + 1) });
  assert.equal(res.statusCode, 413, res.body);
  assert.deepEqual(res.json(), { error: `artifact is larger than the ${MAX_BYTES}-byte limit` });
});

test("the upload route's body limit follows ARTIFACT_MAX_BYTES, not the app-wide 1 MiB", async () => {
  const limit = artifactBodyLimit(MAX_BYTES); // 4112 bytes here
  const frame = JSON.stringify({ content_base64: "" }).length;

  // An artifact far over the limit, in a body that still fits: the handler answers.
  const fits = await upload({ content_base64: base64Of(3000) });
  assert.ok(fits.payload.length > 0 && JSON.stringify({ content_base64: base64Of(3000) }).length <= limit);
  assert.equal(fits.statusCode, 413, fits.body);
  assert.match(fits.json().error, /^artifact is larger than the 10-byte limit$/);

  // A body one byte past the route's limit is refused while it is read.
  const over = "A".repeat(limit - frame + 4);
  const body = JSON.stringify({ content_base64: over });
  assert.ok(body.length > limit && body.length < 1_048_576);
  const refused = await upload(body);
  assert.equal(refused.statusCode, 413, refused.body);
  assert.doesNotMatch(refused.json().error, /artifact is larger/);
});

test("other routes keep the 1 MiB body limit", async () => {
  const post = (bytes: number) =>
    app.inject({
      method: "POST",
      url: "/auth",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ transaction: "A".repeat(bytes) }),
    });

  // Far past the upload route's 4112 bytes, and read in full: the handler
  // answers that this is not a challenge.
  const read = await post(500_000);
  assert.equal(read.statusCode, 400, read.body);

  // Past 1 MiB it is refused before the handler.
  const refused = await post(1_048_576);
  assert.equal(refused.statusCode, 413, refused.body);
});

test("content_type is echoed up to 255 characters and refused beyond", async () => {
  const ok = await upload({ content_base64: base64Of(4), content_type: "t".repeat(255) });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().content_type, "t".repeat(255));

  const long = await upload({ content_base64: base64Of(4), content_type: "t".repeat(256) });
  assert.equal(long.statusCode, 400, long.body);
  assert.match(long.json().error, /^content_type: /);

  const none = await upload({ content_base64: base64Of(4) });
  assert.equal(none.statusCode, 201, none.body);
  assert.equal(none.json().content_type, null);
});

test("an upload without a token is refused before the body matters", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/artifacts",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ content_base64: base64Of(4) }),
  });
  assert.equal(res.statusCode, 401, res.body);
});
