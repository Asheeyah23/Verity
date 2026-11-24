import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";

// sep10.ts imports the validated environment and the keeper at module load
// time. Set all required fields before its first dynamic import; never reuse
// a developer's .env secrets or contact the Soroban RPC in these tests.
const keeper = Keypair.random();
const server = Keypair.random();
const client = Keypair.random();
const other = Keypair.random();
const passphrase = "Test SDF Network ; September 2015";
const homeDomain = "localhost";
const webAuthDomain = "localhost:3001";
const jwtSecret = "a".repeat(32);
// The issuer is the advertised SEP-10 endpoint, built from PUBLIC_SCHEME and
// WEB_AUTH_DOMAIN (PUBLIC_SCHEME defaults to http).
const issuer = `http://${webAuthDomain}/auth`;

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: passphrase,
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: keeper.secret(),
  SEP10_SIGNING_SECRET: server.secret(),
  JWT_SECRET: jwtSecret,
  WEB_AUTH_DOMAIN: webAuthDomain,
  HOME_DOMAIN: homeDomain,
});

const { buildChallenge, verifyChallenge, issueJwt, verifyJwt, sep10SigningKey } =
  await import("./sep10.js");

function signChallenge(xdr: string, signer: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  tx.sign(signer);
  return tx.toXDR();
}

function customChallenge(
  signingKey: Keypair,
  home: string = homeDomain,
  webAuth: string = webAuthDomain,
): string {
  return WebAuth.buildChallengeTx(
    signingKey,
    client.publicKey(),
    home,
    300,
    passphrase,
    webAuth,
  );
}

test("SEP-10 signs using its dedicated signing key", () => {
  assert.equal(sep10SigningKey, server.publicKey());
  assert.notEqual(sep10SigningKey, keeper.publicKey());
});

test("SEP-10 accepts a valid challenge signed by its claimed client", () => {
  const signed = signChallenge(buildChallenge(client.publicKey(), homeDomain), client);
  assert.deepEqual(verifyChallenge(signed), { account: client.publicKey() });
});

test("SEP-10 rejects a challenge that has only the server signature", () => {
  assert.throws(
    () => verifyChallenge(buildChallenge(client.publicKey(), homeDomain)),
    /None of the given signers match/,
  );
});

test("SEP-10 rejects a challenge signed by an unrelated account", () => {
  const signed = signChallenge(buildChallenge(client.publicKey(), homeDomain), other);
  assert.throws(() => verifyChallenge(signed), /None of the given signers match/);
});

test("SEP-10 rejects a challenge with the wrong home domain", () => {
  const signed = signChallenge(customChallenge(server, "evil.example"), client);
  assert.throws(() => verifyChallenge(signed));
});

test("SEP-10 rejects a challenge with the wrong web authentication domain", () => {
  const signed = signChallenge(customChallenge(server, homeDomain, "other.example"), client);
  assert.throws(() => verifyChallenge(signed));
});

test("SEP-10 rejects a challenge built by an unknown server signer", () => {
  const signed = signChallenge(customChallenge(other), client);
  assert.throws(() => verifyChallenge(signed));
});

test("SEP-10 rejects malformed challenge XDR", () => {
  assert.throws(() => verifyChallenge("not xdr"));
});

test("JWT round-trips the account subject with a one-hour lifetime", () => {
  const token = issueJwt(client.publicKey());
  assert.deepEqual(verifyJwt(token), { sub: client.publicKey() });
  const payload = jwt.decode(token) as {
    sub: string;
    iat: number;
    exp: number;
    iss: string;
  };
  assert.equal(payload.sub, client.publicKey());
  assert.equal(payload.iss, issuer);
  assert.equal(payload.exp - payload.iat, 3600);
});

test("JWT tokens are signed with HS256", () => {
  const decoded = jwt.decode(issueJwt(client.publicKey()), { complete: true });
  assert.equal(decoded?.header.alg, "HS256");
});

test("JWT verification rejects an already-expired signed token", () => {
  const expired = jwt.sign({ sub: client.publicKey() }, jwtSecret, {
    algorithm: "HS256",
    issuer,
    expiresIn: -10,
  });
  assert.throws(() => verifyJwt(expired), /jwt expired/);
});

test("JWT verification rejects a payload modified without re-signing", () => {
  const token = issueJwt(client.publicKey());
  const [header, body, signature] = token.split(".");
  assert.ok(header && body && signature);
  const forgedPayload = { ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), sub: other.publicKey() };
  const tampered = [
    header,
    Buffer.from(JSON.stringify(forgedPayload)).toString("base64url"),
    signature,
  ].join(".");
  assert.throws(() => verifyJwt(tampered), /invalid signature/);
});

test("JWT verification rejects a token signed with a different secret", () => {
  const foreign = jwt.sign(
    { sub: client.publicKey() },
    "b".repeat(32),
    { algorithm: "HS256", issuer, expiresIn: "1h" },
  );
  assert.throws(() => verifyJwt(foreign), /invalid signature/);
});

test("JWT verification rejects a token issued by another deployment", () => {
  const foreign = jwt.sign(
    { sub: client.publicKey() },
    jwtSecret,
    { algorithm: "HS256", issuer: "https://other.example/auth", expiresIn: "1h" },
  );
  assert.throws(() => verifyJwt(foreign), /jwt issuer invalid/);
});

test("JWT verification rejects an algorithm other than HS256", () => {
  const hs512 = jwt.sign(
    { sub: client.publicKey() },
    jwtSecret,
    { algorithm: "HS512", issuer, expiresIn: "1h" },
  );
  assert.throws(() => verifyJwt(hs512), /invalid algorithm/);
});

test("JWT verification rejects a subject that is not a G-address", () => {
  for (const sub of ["not-an-account", server.secret()]) {
    const token = jwt.sign({ sub }, jwtSecret, {
      algorithm: "HS256",
      issuer,
      expiresIn: "1h",
    });
    assert.throws(() => verifyJwt(token), /JWT subject is not a Stellar account/);
  }
});
