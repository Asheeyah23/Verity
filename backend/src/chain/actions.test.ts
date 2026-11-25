import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { Errors } from "escrow-gate";
import type { SubmissionRecord } from "escrow-gate";

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

const {
  consensusOutcome,
  minChallengerBond,
  contractErrorName,
  finalizeOnChain,
  resolveChallengeOnChain,
  releaseAttestationLockOnChain,
} = await import("./actions.js");
const { escrowGateAsKeeper } = await import("./clients.js");

const record = (fields: Partial<SubmissionRecord>) => fields as SubmissionRecord;

describe("consensusOutcome", () => {
  const huge = 10n ** 18n;
  const cases: Array<{
    name: string;
    votes: [number, number];
    weights: [bigint, bigint];
    bps?: number;
    want: "verified" | "slashed" | null;
  }> = [
    { name: "below quorum, all matched", votes: [2, 0], weights: [1200n, 0n], want: null },
    { name: "below quorum, all mismatched", votes: [0, 2], weights: [0n, 1200n], want: null },
    { name: "quorum met but no bonded weight", votes: [2, 1], weights: [0n, 0n], want: null },
    { name: "matched exactly at 66%", votes: [2, 1], weights: [66n, 34n], want: "verified" },
    { name: "matched one point under 66%", votes: [2, 1], weights: [65n, 35n], want: null },
    { name: "mismatched exactly at 66%", votes: [1, 2], weights: [34n, 66n], want: "slashed" },
    { name: "mismatched one point under 66%", votes: [1, 2], weights: [35n, 65n], want: null },
    { name: "unanimous matched", votes: [3, 0], weights: [1800n, 0n], want: "verified" },
    { name: "unanimous mismatched", votes: [0, 3], weights: [0n, 1800n], want: "slashed" },
    {
      name: "one dissenter at 10000 bps",
      votes: [2, 1],
      weights: [100n, 1n],
      bps: 10000,
      want: null,
    },
    {
      name: "unanimous at 10000 bps",
      votes: [3, 0],
      weights: [100n, 0n],
      bps: 10000,
      want: "verified",
    },
    {
      name: "weights above 2^53 exactly at 66%",
      votes: [2, 1],
      weights: [66n * huge, 34n * huge],
      want: "verified",
    },
    {
      name: "weights above 2^53 one unit under 66%",
      votes: [2, 1],
      weights: [66n * huge - 1n, 34n * huge + 1n],
      want: null,
    },
  ];

  for (const { name, votes, weights, bps = 6600, want } of cases) {
    it(name, () => {
      const sub = record({
        match_votes: votes[0],
        mismatch_votes: votes[1],
        bonded_weight_matched: weights[0],
        bonded_weight_mismatched: weights[1],
        cfg_quorum_min_reexecutors: 3,
        cfg_quorum_supermajority_bps: bps,
      });
      assert.equal(consensusOutcome(sub), want);
    });
  }
});

describe("minChallengerBond", () => {
  const cases: Array<[escrow: bigint, bps: number, want: bigint]> = [
    [1_000_000n, 500, 50_000n],
    [999n, 500, 49n],
    [9999n, 1, 0n],
    [0n, 500, 0n],
    [10n ** 20n + 19n, 500, 5n * 10n ** 18n],
  ];

  for (const [escrow, bps, want] of cases) {
    it(`${escrow} at ${bps} bps is ${want}`, () => {
      const sub = record({ escrow_value: escrow, cfg_challenger_bond_min_bps: bps });
      assert.equal(minChallengerBond(sub), want);
    });
  }
});

describe("contractErrorName", () => {
  it("names the contract error in a host error message", () => {
    assert.equal(
      contractErrorName(new Error("HostError: Error(Contract, #1)")),
      "AlreadyInitialized",
    );
    assert.equal(contractErrorName(new Error("HostError: Error(Contract, #11)")), "BondTooLow");
  });

  it("falls back to the number for a code the bindings do not know", () => {
    assert.equal(
      contractErrorName(new Error("HostError: Error(Contract, #9999)")),
      "ContractError#9999",
    );
  });

  it("returns null when the message has no contract error", () => {
    assert.equal(contractErrorName(new Error("HostError: Error(Budget, ExceededLimit)")), null);
  });

  it("reads a plain string", () => {
    assert.equal(contractErrorName("Error(Contract, #11)"), "BondTooLow");
  });

  it("returns null for an object without a message", () => {
    assert.equal(contractErrorName({}), null);
  });

  it("matches every entry in the generated Errors table", () => {
    for (const [code, { message }] of Object.entries(Errors)) {
      assert.equal(contractErrorName(new Error(`HostError: Error(Contract, #${code})`)), message);
    }
  });
});

describe("keeper transactions timeout option", () => {
  it("passes timeoutInSeconds to finalize", async () => {
    const orig = escrowGateAsKeeper.finalize;
    let passedOptions: any = null;
    escrowGateAsKeeper.finalize = (async (_args: any, options: any) => {
      passedOptions = options;
      return {
        isReadCall: true,
        result: { unwrap: () => ({ tag: "Verified", values: void 0 }) },
      };
    }) as any;
    try {
      await finalizeOnChain("42");
      assert.deepEqual(passedOptions, { timeoutInSeconds: 30 });
    } finally {
      escrowGateAsKeeper.finalize = orig;
    }
  });

  it("passes timeoutInSeconds to resolve_challenge", async () => {
    const orig = escrowGateAsKeeper.resolve_challenge;
    let passedOptions: any = null;
    escrowGateAsKeeper.resolve_challenge = (async (_args: any, options: any) => {
      passedOptions = options;
      return {
        signAndSend: async () => ({
          result: { unwrap: () => ({ tag: "Verified", values: void 0 }) },
          sendTransactionResponse: { hash: "abc123hash" },
        }),
      };
    }) as any;
    try {
      const res = await resolveChallengeOnChain("42");
      assert.deepEqual(passedOptions, { timeoutInSeconds: 30 });
      assert.equal(res.txHash, "abc123hash");
    } finally {
      escrowGateAsKeeper.resolve_challenge = orig;
    }
  });

  it("passes timeoutInSeconds to release_attestation_lock", async () => {
    const orig = escrowGateAsKeeper.release_attestation_lock;
    let passedOptions: any = null;
    escrowGateAsKeeper.release_attestation_lock = (async (_args: any, options: any) => {
      passedOptions = options;
      return {
        signAndSend: async () => ({
          result: { unwrap: () => void 0 },
          sendTransactionResponse: { hash: "def456hash" },
        }),
      };
    }) as any;
    try {
      const hash = await releaseAttestationLockOnChain("42", "GACCOUNT123");
      assert.deepEqual(passedOptions, { timeoutInSeconds: 30 });
      assert.equal(hash, "def456hash");
    } finally {
      escrowGateAsKeeper.release_attestation_lock = orig;
    }
  });

  it("logs transaction hash when TransactionStillPending is thrown", async () => {
    const orig = escrowGateAsKeeper.finalize;
    escrowGateAsKeeper.finalize = (async () => ({
      isReadCall: false,
      signed: { hash: () => Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex") },
      signAndSend: async () => {
        const err = new Error(
          'Waited 30 seconds for transaction to complete, but it did not. Returning anyway. Check the transaction status manually. Sent transaction: { "hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }'
        );
        err.name = "TransactionStillPendingError";
        throw err;
      },
    })) as any;

    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => logged.push(args.join(" "));

    try {
      await assert.rejects(finalizeOnChain("42"), (err: any) => err.name === "TransactionStillPendingError");
      assert.equal(logged.some((l) => l.includes("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")), true);
    } finally {
      escrowGateAsKeeper.finalize = orig;
      console.error = origError;
    }
  });
});
