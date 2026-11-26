import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  explorerNetwork,
  explorerUrl,
  isTestnetPassphrase,
  MAINNET_PASSPHRASE,
  TESTNET_PASSPHRASE,
} from "./config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("explorerUrl and network passphrase helpers", () => {
  it("routes testnet passphrases and config objects to stellar.expert/explorer/testnet", () => {
    assert.equal(
      explorerUrl("tx", "abc123", TESTNET_PASSPHRASE),
      "https://stellar.expert/explorer/testnet/tx/abc123"
    );
    assert.equal(
      explorerUrl("account", "GABC", { network_passphrase: TESTNET_PASSPHRASE }),
      "https://stellar.expert/explorer/testnet/account/GABC"
    );
    assert.equal(
      explorerUrl("contract", "CDEF", TESTNET_PASSPHRASE),
      "https://stellar.expert/explorer/testnet/contract/CDEF"
    );
    assert.equal(explorerNetwork(TESTNET_PASSPHRASE), "testnet");
    assert.equal(isTestnetPassphrase(TESTNET_PASSPHRASE), true);
    assert.equal(isTestnetPassphrase({ network_passphrase: TESTNET_PASSPHRASE }), true);
  });

  it("routes mainnet passphrases and config objects to stellar.expert/explorer/public", () => {
    assert.equal(
      explorerUrl("tx", "abc123", MAINNET_PASSPHRASE),
      "https://stellar.expert/explorer/public/tx/abc123"
    );
    assert.equal(
      explorerUrl("account", "GABC", { network_passphrase: MAINNET_PASSPHRASE }),
      "https://stellar.expert/explorer/public/account/GABC"
    );
    assert.equal(
      explorerUrl("contract", "CDEF", MAINNET_PASSPHRASE),
      "https://stellar.expert/explorer/public/contract/CDEF"
    );
    assert.equal(explorerNetwork(MAINNET_PASSPHRASE), "public");
    assert.equal(isTestnetPassphrase(MAINNET_PASSPHRASE), false);
    assert.equal(isTestnetPassphrase({ network_passphrase: MAINNET_PASSPHRASE }), false);
  });

  it("falls back to the default network passphrase when omitted", () => {
    assert.equal(
      explorerUrl("contract", "C123"),
      "https://stellar.expert/explorer/testnet/contract/C123"
    );
    assert.equal(isTestnetPassphrase(), true);
  });
});

describe("docs/MAINNET.md checklist", () => {
  it("covers all required sections, statuses, and referenced files", () => {
    const mainnetDocPath = path.join(REPO_ROOT, "docs", "MAINNET.md");
    assert.equal(existsSync(mainnetDocPath), true, "docs/MAINNET.md must exist");
    const doc = readFileSync(mainnetDocPath, "utf8");
    for (const heading of [
      "## 1. Contracts",
      "## 2. Keys",
      "## 3. Assets",
      "## 4. Operations",
      "## 5. Product",
      "## 6. Legal and treasury",
    ]) {
      assert.match(doc, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    for (const status of ["`missing`", "`partial`", "`done`"]) {
      assert.ok(doc.includes(status), `expected status ${status} in docs/MAINNET.md`);
    }
  });
});

describe("deployment scripts network handling", () => {
  it("reads network, network_passphrase and rpc_url from deployment records and refuses mainnet in dev.sh and smoke.sh", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "verity-deploy-test-"));
    try {
      const deploymentsDir = path.join(tmp, "deployments");
      const scriptsDir = path.join(tmp, "scripts");
      const binDir = path.join(tmp, "bin");
      execFileSync("bash", [
        "-c",
        `mkdir -p "$1" "$2" "$3" && cp "$4"/scripts/*.sh "$2"/ && cp "$4"/deployments/testnet.json "$1"/testnet.json`,
        "--",
        deploymentsDir,
        scriptsDir,
        binDir,
        REPO_ROOT,
      ]);

      // Stub stellar and curl in binDir so smoke.sh passes require_commands
      for (const tool of ["stellar", "curl"]) {
        const p = path.join(binDir, tool);
        writeFileSync(p, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
      }

      // 1. Existing testnet.json works unchanged and defaults rpc_url to testnet
      const testnetOut = execFileSync(
        "bash",
        [
          "-c",
          'ROOT_DIR="$1"; source "$1/scripts/_deployment.sh"; printf "%s|%s|%s" "$NETWORK" "$NETWORK_PASSPHRASE" "$SOROBAN_RPC_URL"',
          "--",
          tmp,
        ],
        { encoding: "utf8" }
      );
      assert.equal(
        testnetOut,
        `testnet|${TESTNET_PASSPHRASE}|https://soroban-testnet.stellar.org`
      );

      // 2. Mainnet deployment record populates network, network_passphrase, and rpc_url
      writeFileSync(
        path.join(deploymentsDir, "mainnet-check.json"),
        JSON.stringify({
          deployment: "mainnet-check",
          public: false,
          network: "mainnet",
          network_passphrase: MAINNET_PASSPHRASE,
          rpc_url: "https://mainnet-rpc.example.org",
          escrow_gate_contract_id: "CDUEU4F56OMU7HZ5KURWNXT3YVOVPNTJYE4MBXTYTJAXBG4L2TCLQ4EK",
          zk_verifier_registry_contract_id: "CDDVZ7IRRU3RXK3KZGX7FFDNA3EQZMJ7Q2V4KVEV5SQAIALEI4HPLPO5",
          native_xlm_sac_address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          deployer_public_key: "GAEG6KATD3ZMATNI66OWWPR4HJ6VCGMOJHNX3XKCLZKFVGUZXGY3P2PA",
          keeper_public_key: "GA3KVWVISNVS2ZHZ2KOU4TXWNJZXXRUZQD57QZVQRTZUJATSXDZ4KOZV",
          bootstrap_reexecutors: [],
        })
      );

      const mainnetOut = execFileSync(
        "bash",
        [
          "-c",
          'ROOT_DIR="$1"; VERITY_DEPLOYMENT=mainnet-check; source "$1/scripts/_deployment.sh"; printf "%s|%s|%s" "$NETWORK" "$NETWORK_PASSPHRASE" "$SOROBAN_RPC_URL"',
          "--",
          tmp,
        ],
        { encoding: "utf8" }
      );
      assert.equal(
        mainnetOut,
        `mainnet|${MAINNET_PASSPHRASE}|https://mainnet-rpc.example.org`
      );

      // 3. dev.sh and smoke.sh both refuse a mainnet record
      assert.throws(
        () =>
          execFileSync("bash", [path.join(scriptsDir, "dev.sh")], {
            env: { ...process.env, VERITY_DEPLOYMENT: "mainnet-check" },
            stdio: "pipe",
          }),
        /is on mainnet/
      );
      assert.throws(
        () =>
          execFileSync("bash", [path.join(scriptsDir, "smoke.sh")], {
            env: {
              ...process.env,
              PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
              VERITY_DEPLOYMENT: "mainnet-check",
            },
            stdio: "pipe",
          }),
        /is on mainnet/
      );

      // 4. deploy_testnet.sh requires --mainnet-i-have-read-docs-MAINNET for VERITY_NETWORK=mainnet
      assert.throws(
        () =>
          execFileSync("bash", [path.join(scriptsDir, "deploy_testnet.sh")], {
            env: {
              ...process.env,
              VERITY_DEPLOYMENT: "new-main",
              VERITY_NETWORK: "mainnet",
            },
            stdio: "pipe",
          }),
        /--mainnet-i-have-read-docs-MAINNET/
      );

      // 5. With the flag, deploy_testnet.sh on mainnet never calls --fund and fails on unfunded identities
      assert.throws(
        () =>
          execFileSync(
            "bash",
            [path.join(scriptsDir, "deploy_testnet.sh"), "--mainnet-i-have-read-docs-MAINNET"],
            {
              env: {
                ...process.env,
                PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
                VERITY_DEPLOYMENT: "new-main",
                VERITY_NETWORK: "mainnet",
              },
              stdio: "pipe",
            }
          ),
        /Friendbot \(--fund\) is never used on mainnet/
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
