import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import {
  assertSep10Challenge,
  isInsecureBackendUrl,
  parseStellarToml,
  resolveSep10ServerConfig,
  verifySep10Challenge,
  type Sep10ServerConfig,
} from "./sep10.js";

const server = Keypair.random();
const meKeypair = Keypair.random();
const me = meKeypair.publicKey();
const homeDomain = "localhost:3001";
const webAuthDomain = "localhost:3001";
const config: Sep10ServerConfig = { serverKey: server.publicKey(), homeDomain, webAuthDomain };

/** A real SEP-10 challenge from the given server keypair, the way the backend builds one. */
function realChallenge(serverKeypair: Keypair, domain = homeDomain, authDomain = webAuthDomain): string {
  return WebAuth.buildChallengeTx(serverKeypair, me, domain, 300, Networks.TESTNET, authDomain);
}

/** A challenge with time bounds entirely in the past, signed by the server. */
function expiredChallenge(): string {
  const now = Math.floor(Date.now() / 1000);
  const nonce = Buffer.from(randomBytes(48)).toString("base64");
  const tx = new TransactionBuilder(new Account(server.publicKey(), "-1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimebounds(now - 7200, now - 3600)
    .addOperation(Operation.manageData({ name: `${homeDomain} auth`, value: nonce, source: me }))
    .addOperation(Operation.manageData({ name: "web_auth_domain", value: webAuthDomain, source: server.publicKey() }))
    .build();
  tx.sign(server);
  return tx.toXDR();
}

function build(sequence: string, ops: ReturnType<typeof Operation.manageData>[] | ReturnType<typeof Operation.payment>[]) {
  const builder = new TransactionBuilder(new Account(server.publicKey(), sequence), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const op of ops) builder.addOperation(op);
  return builder.build();
}

// The builder bumps the sequence by one, so "-1" yields a transaction at 0 like a real challenge.
const challengeOp = () => Operation.manageData({ name: "localhost auth", value: "nonce", source: me });

test("accepts a SEP-10 shaped challenge", () => {
  const tx = build("-1", [challengeOp(), Operation.manageData({ name: "web_auth_domain", value: "localhost", source: server.publicKey() })]);
  assert.equal(tx.sequence, "0");
  assert.doesNotThrow(() => assertSep10Challenge(tx, me));
});

test("refuses a transaction with a real sequence number", () => {
  const tx = build("100", [challengeOp()]);
  assert.throws(() => assertSep10Challenge(tx, me), /non-zero sequence/);
});

test("refuses a payment, even at sequence 0", () => {
  const pay = Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1", source: me });
  const tx = build("-1", [pay]);
  assert.throws(() => assertSep10Challenge(tx, me), /other than manageData/);
});

test("refuses a challenge that names a different account", () => {
  const tx = build("-1", [Operation.manageData({ name: "localhost auth", value: "nonce", source: Keypair.random().publicKey() })]);
  assert.throws(() => assertSep10Challenge(tx, me), /does not name this account/);
});

test("refuses a fee bump", () => {
  const inner = build("100", [challengeOp()]);
  inner.sign(server);
  const bump = TransactionBuilder.buildFeeBumpTransaction(server, "200", inner, Networks.TESTNET);
  assert.throws(() => assertSep10Challenge(bump, me), /fee bump/);
});

test("accepts a challenge from the real server key", () => {
  const tx = verifySep10Challenge(realChallenge(server), config, Networks.TESTNET, me);
  assert.equal(tx.source, server.publicKey());
  // And it is then signable by this account, as login does.
  assert.doesNotThrow(() => tx.sign(meKeypair));
});

test("refuses a challenge built with a different server keypair", () => {
  assert.throws(() => verifySep10Challenge(realChallenge(Keypair.random()), config, Networks.TESTNET, me), /not equal to the server|not signed by server/);
});

test("refuses a challenge whose time bounds have expired", () => {
  assert.throws(() => verifySep10Challenge(expiredChallenge(), config, Networks.TESTNET, me), /expired/);
});

test("refuses a challenge for the wrong home domain", () => {
  assert.throws(() => verifySep10Challenge(realChallenge(server, "evil.example"), config, Networks.TESTNET, me), /home domain/);
});

test("refuses a challenge for the wrong web-auth domain", () => {
  assert.throws(() => verifySep10Challenge(realChallenge(server, homeDomain, "evil.example"), config, Networks.TESTNET, me), /web_auth_domain/);
});

test("refuses a challenge on the wrong network", () => {
  const xdr = WebAuth.buildChallengeTx(server, me, homeDomain, 300, Networks.PUBLIC, webAuthDomain);
  assert.throws(() => verifySep10Challenge(xdr, config, Networks.TESTNET, me), /not signed by server/);
});

test("parses SIGNING_KEY and WEB_AUTH_ENDPOINT out of a stellar.toml", () => {
  const parsed = parseStellarToml(
    [
      `NETWORK_PASSPHRASE="Test SDF Network ; September 2015"`,
      `WEB_AUTH_ENDPOINT="http://localhost:3001/auth"`,
      `SIGNING_KEY="${server.publicKey()}"`,
    ].join("\n")
  );
  assert.equal(parsed.signingKey, server.publicKey());
  assert.equal(parsed.webAuthEndpoint, "http://localhost:3001/auth");
});

test("discovers the server key and domains from the backend's stellar.toml", async () => {
  const toml = [
    `NETWORK_PASSPHRASE="Test SDF Network ; September 2015"`,
    `WEB_AUTH_ENDPOINT="http://localhost:3001/auth"`,
    `SIGNING_KEY="${server.publicKey()}"`,
  ].join("\n");
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => new Response(toml)) as typeof fetch;
  try {
    const resolved = await resolveSep10ServerConfig({ backendUrl: "http://backend:3001" });
    assert.deepEqual(resolved, { serverKey: server.publicKey(), homeDomain: "localhost:3001", webAuthDomain: "localhost:3001" });
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("explicit SEP-10 settings win over the stellar.toml and need no fetch", async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch must not be called when everything is pinned");
  }) as typeof fetch;
  try {
    const resolved = await resolveSep10ServerConfig({
      backendUrl: "http://backend:3001",
      serverKey: server.publicKey(),
      homeDomain,
      webAuthDomain,
    });
    assert.deepEqual(resolved, config);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("refuses to resolve a server key the toml does not publish", async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => new Response(`WEB_AUTH_ENDPOINT="http://localhost:3001/auth"\n`)) as typeof fetch;
  try {
    await assert.rejects(() => resolveSep10ServerConfig({ backendUrl: "http://backend:3001" }), /server key is unknown/);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("warns only for plain http to a public host", () => {
  assert.equal(isInsecureBackendUrl("http://localhost:3001"), false);
  assert.equal(isInsecureBackendUrl("http://127.0.0.1:3001"), false);
  assert.equal(isInsecureBackendUrl("http://backend:3001"), false);
  assert.equal(isInsecureBackendUrl("https://api.verity.example"), false);
  assert.equal(isInsecureBackendUrl("http://api.verity.example"), true);
  assert.equal(isInsecureBackendUrl("http://192.168.1.10:3001"), true);
});
