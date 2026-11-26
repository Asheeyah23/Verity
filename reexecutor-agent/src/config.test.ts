import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Keypair, Networks, WebAuth } from "@stellar/stellar-sdk";
import { findConfigMismatches } from "./config.js";

const execFileAsync = promisify(execFile);

const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const CONTRACT_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const INDEX_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

test("returns no mismatches when contract ID and network passphrase match", () => {
  const mismatches = findConfigMismatches(
    { contractId: CONTRACT_A, networkPassphrase: Networks.TESTNET },
    { escrow_gate_contract_id: CONTRACT_A, network_passphrase: Networks.TESTNET }
  );
  assert.deepEqual(mismatches, []);
});

test("reports both contract IDs when escrow_gate_contract_id differs", () => {
  const mismatches = findConfigMismatches(
    { contractId: CONTRACT_A, networkPassphrase: Networks.TESTNET },
    { escrow_gate_contract_id: CONTRACT_B, network_passphrase: Networks.TESTNET }
  );
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /ESCROW_GATE_CONTRACT_ID/);
  assert.ok(mismatches[0].includes(CONTRACT_A));
  assert.ok(mismatches[0].includes(CONTRACT_B));
});

test("reports both passphrases when network_passphrase differs", () => {
  const mismatches = findConfigMismatches(
    { contractId: CONTRACT_A, networkPassphrase: Networks.TESTNET },
    { escrow_gate_contract_id: CONTRACT_A, network_passphrase: Networks.PUBLIC }
  );
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /NETWORK_PASSPHRASE/);
  assert.ok(mismatches[0].includes(Networks.TESTNET));
  assert.ok(mismatches[0].includes(Networks.PUBLIC));
});

test("reports both mismatches when contract ID and passphrase both differ", () => {
  const mismatches = findConfigMismatches(
    { contractId: CONTRACT_A, networkPassphrase: Networks.TESTNET },
    { escrow_gate_contract_id: CONTRACT_B, network_passphrase: Networks.PUBLIC }
  );
  assert.equal(mismatches.length, 2);
  assert.ok(mismatches[0].includes(CONTRACT_A) && mismatches[0].includes(CONTRACT_B));
  assert.ok(mismatches[1].includes(Networks.TESTNET) && mismatches[1].includes(Networks.PUBLIC));
});

test("treats missing or non-string backend fields as mismatches", () => {
  const mismatches = findConfigMismatches(
    { contractId: CONTRACT_A, networkPassphrase: Networks.TESTNET },
    {}
  );
  assert.equal(mismatches.length, 2);
  assert.ok(mismatches[0].includes(CONTRACT_A));
  assert.ok(mismatches[1].includes(Networks.TESTNET));
});

async function withStubBackend(
  config: { escrow_gate_contract_id: string; network_passphrase: string },
  fn: (url: string, requests: string[]) => Promise<void>
) {
  const serverKey = Keypair.random();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && url.pathname === "/v1/config") {
      res.end(JSON.stringify(config));
      return;
    }
    // The worker discovers and pins this server before it signs anything (SEP-10),
    // so the stub publishes its signing key and issues spec-conformant challenges.
    const host = req.headers.host ?? "127.0.0.1";
    if (req.method === "GET" && url.pathname === "/.well-known/stellar.toml") {
      res.setHeader("content-type", "text/plain");
      res.end(`SIGNING_KEY="${serverKey.publicKey()}"
WEB_AUTH_ENDPOINT="http://${host}/auth"
`);
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth") {
      const account = url.searchParams.get("account") ?? "";
      const transaction = WebAuth.buildChallengeTx(serverKey, account, host, 300, config.network_passphrase, host);
      res.end(JSON.stringify({ transaction, network_passphrase: config.network_passphrase }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/auth") {
      res.end(JSON.stringify({ token: "test-jwt" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/reexecutors/sync") {
      res.end(JSON.stringify({ reexecutor: { id: "rex-1", active: true, approved: true, stake_amount: "5000000000" } }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/reexecutors/rex-1/assignments") {
      res.end(JSON.stringify({ replay_assignments: [], spot_check_assignments: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function runWorkerOnce(envOverrides: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", INDEX_PATH, "--once"], {
      env: { ...process.env, ...envOverrides },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("worker exits 1 and prints both contract IDs when backend tracks a different contract", async () => {
  const workerKey = Keypair.random().secret();
  await withStubBackend(
    { escrow_gate_contract_id: CONTRACT_B, network_passphrase: Networks.TESTNET },
    async (backendUrl, requests) => {
      const result = await runWorkerOnce({
        BACKEND_URL: backendUrl,
        REEXECUTOR_SECRET_KEY: workerKey,
        ESCROW_GATE_CONTRACT_ID: CONTRACT_A,
        NETWORK_PASSPHRASE: Networks.TESTNET,
      });
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes(CONTRACT_A), `expected worker ID in stderr: ${result.stderr}`);
      assert.ok(result.stderr.includes(CONTRACT_B), `expected backend ID in stderr: ${result.stderr}`);
      // SEP-10 discovery is a read; nothing is signed before the config check refuses.
      assert.deepEqual(requests, ["GET /.well-known/stellar.toml", "GET /v1/config"]);
    }
  );
});

test("worker exits 1 and prints both passphrases when backend tracks a different network", async () => {
  const workerKey = Keypair.random().secret();
  await withStubBackend(
    { escrow_gate_contract_id: CONTRACT_A, network_passphrase: Networks.PUBLIC },
    async (backendUrl, requests) => {
      const result = await runWorkerOnce({
        BACKEND_URL: backendUrl,
        REEXECUTOR_SECRET_KEY: workerKey,
        ESCROW_GATE_CONTRACT_ID: CONTRACT_A,
        NETWORK_PASSPHRASE: Networks.TESTNET,
      });
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes(Networks.TESTNET), `expected worker passphrase in stderr: ${result.stderr}`);
      assert.ok(result.stderr.includes(Networks.PUBLIC), `expected backend passphrase in stderr: ${result.stderr}`);
      // SEP-10 discovery is a read; nothing is signed before the config check refuses.
      assert.deepEqual(requests, ["GET /.well-known/stellar.toml", "GET /v1/config"]);
    }
  );
});

test("worker starts and polls normally when backend config matches", async () => {
  const workerKey = Keypair.random().secret();
  await withStubBackend(
    { escrow_gate_contract_id: CONTRACT_A, network_passphrase: Networks.TESTNET },
    async (backendUrl, requests) => {
      const result = await runWorkerOnce({
        BACKEND_URL: backendUrl,
        REEXECUTOR_SECRET_KEY: workerKey,
        ESCROW_GATE_CONTRACT_ID: CONTRACT_A,
        NETWORK_PASSPHRASE: Networks.TESTNET,
      });
      assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
      assert.deepEqual(requests, [
        "GET /.well-known/stellar.toml",
        "GET /v1/config",
        "GET /auth",
        "POST /auth",
        "POST /v1/reexecutors/sync",
        "GET /v1/reexecutors/rex-1/assignments",
      ]);
    }
  );
});
