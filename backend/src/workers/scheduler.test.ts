import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const contractId = StrKey.encodeContract(Buffer.alloc(32));

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: contractId,
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: contractId,
  BOND_ASSET_CONTRACT_ID: contractId,
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { isReadyToSettle } = await import("./scheduler.js");

describe("isReadyToSettle", () => {
  it("rejects non-terminal statuses", () => {
    for (const status of ["pending", "disputed", "draft", "created"]) {
      assert.equal(
        isReadyToSettle({
          status,
          resolution_method: "reexecution_consensus",
          has_attestation: true,
        }),
        false,
        `status ${status} should not be ready to settle`
      );
    }
  });

  it("rejects when resolution_method is null or missing", () => {
    for (const status of ["verified", "slashed", "expired_unverified"]) {
      assert.equal(
        isReadyToSettle({
          status,
          resolution_method: null,
          has_attestation: true,
        }),
        false,
        `status ${status} with null resolution_method should not be ready to settle`
      );
    }
  });

  it("rejects when attestation has not been exported yet", () => {
    for (const status of ["verified", "slashed", "expired_unverified"]) {
      assert.equal(
        isReadyToSettle({
          status,
          resolution_method: "reexecution_consensus",
          has_attestation: false,
        }),
        false,
        `status ${status} without attestation should not be ready to settle`
      );
    }
  });

  it("accepts terminal status with known resolution_method and exported attestation", () => {
    for (const status of ["verified", "slashed", "expired_unverified"]) {
      for (const method of ["reexecution_consensus", "window_elapsed", "zk_proof"]) {
        assert.equal(
          isReadyToSettle({
            status,
            resolution_method: method,
            has_attestation: true,
          }),
          true,
          `status ${status} with method ${method} and attestation should be ready to settle`
        );
      }
    }
  });
});
