import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createWalletClient,
  evaluateWalletChange,
  WalletError,
  wrongNetworkMessage,
} from "./wallet-core.ts";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const FUTURENET_PASSPHRASE = "Test SDF Future Network ; October 2022";
const ACCOUNT_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ACCOUNT_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQW5";

function makeApi(overrides = {}) {
  return {
    isConnected: async () => ({ isConnected: true }),
    requestAccess: async () => ({ address: ACCOUNT_A }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: TESTNET_PASSPHRASE }),
    signTransaction: async (xdr) => ({ signedTxXdr: `signed:${xdr}` }),
    ...overrides,
  };
}

describe("wrongNetworkMessage", () => {
  it("names the active network", () => {
    assert.equal(
      wrongNetworkMessage("PUBLIC"),
      "Freighter is on PUBLIC. Switch it to Testnet to keep going."
    );
  });

  it("trims whitespace and falls back when empty or missing", () => {
    assert.equal(
      wrongNetworkMessage("  FUTURENET  "),
      "Freighter is on FUTURENET. Switch it to Testnet to keep going."
    );
    assert.equal(
      wrongNetworkMessage(""),
      "Freighter is on another network. Switch it to Testnet to keep going."
    );
    assert.equal(
      wrongNetworkMessage(undefined),
      "Freighter is on another network. Switch it to Testnet to keep going."
    );
  });
});

describe("evaluateWalletChange", () => {
  it("reports account-switched when Freighter changes accounts", () => {
    const effect = evaluateWalletChange(
      { address: ACCOUNT_B, network: "PUBLIC", networkPassphrase: MAINNET_PASSPHRASE },
      ACCOUNT_A,
      TESTNET_PASSPHRASE
    );
    assert.deepEqual(effect, { kind: "account-switched" });
  });

  it("ignores empty networkPassphrase when Freighter is locked", () => {
    const effect = evaluateWalletChange(
      { address: ACCOUNT_A, network: "", networkPassphrase: "" },
      ACCOUNT_A,
      TESTNET_PASSPHRASE
    );
    assert.deepEqual(effect, { kind: "ignore" });
  });

  it("ignores missing networkPassphrase on initial locked tick", () => {
    const effect = evaluateWalletChange(
      { address: "", network: "", networkPassphrase: "" },
      ACCOUNT_A,
      TESTNET_PASSPHRASE
    );
    assert.deepEqual(effect, { kind: "ignore" });
  });

  it("reports wrong-network when Freighter switches off Testnet", () => {
    const effect = evaluateWalletChange(
      { address: ACCOUNT_A, network: "PUBLIC", networkPassphrase: MAINNET_PASSPHRASE },
      ACCOUNT_A,
      TESTNET_PASSPHRASE
    );
    assert.deepEqual(effect, {
      kind: "wrong-network",
      message: "Freighter is on PUBLIC. Switch it to Testnet to keep going.",
    });
  });

  it("reports network-ok when Freighter matches the expected passphrase", () => {
    const effect = evaluateWalletChange(
      { address: ACCOUNT_A, network: "TESTNET", networkPassphrase: TESTNET_PASSPHRASE },
      ACCOUNT_A,
      TESTNET_PASSPHRASE
    );
    assert.deepEqual(effect, { kind: "network-ok" });
  });

  it("recovers from wrong-network back to network-ok when switched back to Testnet", () => {
    const bad = evaluateWalletChange(
      { address: ACCOUNT_A, network: "FUTURENET", networkPassphrase: FUTURENET_PASSPHRASE },
      ACCOUNT_A,
      TESTNET_PASSPHRASE
    );
    assert.equal(bad.kind, "wrong-network");

    const ok = evaluateWalletChange(
      { address: ACCOUNT_A, network: "TESTNET", networkPassphrase: TESTNET_PASSPHRASE },
      ACCOUNT_A,
      TESTNET_PASSPHRASE
    );
    assert.deepEqual(ok, { kind: "network-ok" });
  });
});

describe("createWalletClient", () => {
  it("assertWalletNetwork succeeds when networkPassphrase matches", async () => {
    const client = createWalletClient(makeApi());
    await assert.doesNotReject(() => client.assertWalletNetwork(TESTNET_PASSPHRASE));
  });

  it("assertWalletNetwork throws WalletError(wrong-network) on mismatch", async () => {
    const client = createWalletClient(
      makeApi({
        getNetwork: async () => ({ network: "PUBLIC", networkPassphrase: MAINNET_PASSPHRASE }),
      })
    );
    await assert.rejects(
      () => client.assertWalletNetwork(TESTNET_PASSPHRASE),
      (err) => {
        assert.ok(err instanceof WalletError);
        assert.equal(err.code, "wrong-network");
        assert.equal(err.message, "Freighter is on PUBLIC. Switch it to Testnet to keep going.");
        return true;
      }
    );
  });

  it("assertWalletNetwork throws WalletError(network-unknown) on Freighter error or locked wallet", async () => {
    const errored = createWalletClient(
      makeApi({
        getNetwork: async () => ({ network: "", networkPassphrase: "", error: { message: "locked" } }),
      })
    );
    await assert.rejects(
      () => errored.assertWalletNetwork(TESTNET_PASSPHRASE),
      (err) => err instanceof WalletError && err.code === "network-unknown" && err.message.includes("(locked)")
    );

    const locked = createWalletClient(
      makeApi({
        getNetwork: async () => ({ network: "", networkPassphrase: "" }),
      })
    );
    await assert.rejects(
      () => locked.assertWalletNetwork(TESTNET_PASSPHRASE),
      (err) => err instanceof WalletError && err.code === "network-unknown"
    );
  });

  it("assertWalletNetwork times out when getNetwork never resolves", async () => {
    const client = createWalletClient(
      makeApi({ getNetwork: () => new Promise(() => {}) }),
      { accessMs: 50, getNetworkMs: 25, signMs: 50 }
    );
    await assert.rejects(
      () => client.assertWalletNetwork(TESTNET_PASSPHRASE),
      (err) => err instanceof WalletError && err.code === "timeout"
    );
  });

  it("signXdr checks network first and never calls signTransaction on wrong network", async () => {
    let signCalled = 0;
    const client = createWalletClient(
      makeApi({
        getNetwork: async () => ({ network: "PUBLIC", networkPassphrase: MAINNET_PASSPHRASE }),
        signTransaction: async () => {
          signCalled += 1;
          return { signedTxXdr: "should-not-happen" };
        },
      })
    );

    await assert.rejects(
      () => client.signXdr("UNSIGNED_XDR", { networkPassphrase: TESTNET_PASSPHRASE, address: ACCOUNT_A }),
      (err) =>
        err instanceof WalletError &&
        err.code === "wrong-network" &&
        err.message === "Freighter is on PUBLIC. Switch it to Testnet to keep going."
    );
    assert.equal(signCalled, 0);
  });

  it("signXdr checks network with timeout before calling signTransaction", async () => {
    let signCalled = 0;
    const client = createWalletClient(
      makeApi({
        getNetwork: () => new Promise(() => {}),
        signTransaction: async () => {
          signCalled += 1;
          return { signedTxXdr: "should-not-happen" };
        },
      }),
      { accessMs: 50, getNetworkMs: 25, signMs: 50 }
    );

    await assert.rejects(
      () => client.signXdr("UNSIGNED_XDR", { networkPassphrase: TESTNET_PASSPHRASE, address: ACCOUNT_A }),
      (err) => err instanceof WalletError && err.code === "timeout"
    );
    assert.equal(signCalled, 0);
  });

  it("signXdr signs and returns signedTxXdr when network matches", async () => {
    let seenOpts = null;
    const client = createWalletClient(
      makeApi({
        signTransaction: async (xdr, opts) => {
          seenOpts = { xdr, opts };
          return { signedTxXdr: "SIGNED_XDR" };
        },
      })
    );

    const signed = await client.signXdr("UNSIGNED_XDR", {
      networkPassphrase: TESTNET_PASSPHRASE,
      address: ACCOUNT_A,
    });
    assert.equal(signed, "SIGNED_XDR");
    assert.deepEqual(seenOpts, {
      xdr: "UNSIGNED_XDR",
      opts: { networkPassphrase: TESTNET_PASSPHRASE, address: ACCOUNT_A },
    });
  });

  it("pre-build network check stops before any backend request on wrong network", async () => {
    let backendCalls = 0;
    const client = createWalletClient(
      makeApi({
        getNetwork: async () => ({ network: "PUBLIC", networkPassphrase: MAINNET_PASSPHRASE }),
      })
    );

    await assert.rejects(async () => {
      await client.assertWalletNetwork(TESTNET_PASSPHRASE);
      backendCalls += 1;
    }, (err) => err instanceof WalletError && err.code === "wrong-network");
    assert.equal(backendCalls, 0);
  });

  it("connectWallet verifies extension, access, and network", async () => {
    const okClient = createWalletClient(makeApi());
    assert.equal(await okClient.connectWallet(TESTNET_PASSPHRASE), ACCOUNT_A);

    const wrongNetClient = createWalletClient(
      makeApi({
        getNetwork: async () => ({ network: "PUBLIC", networkPassphrase: MAINNET_PASSPHRASE }),
      })
    );
    await assert.rejects(
      () => wrongNetClient.connectWallet(TESTNET_PASSPHRASE),
      (err) => err instanceof WalletError && err.code === "wrong-network"
    );

    const missingExtClient = createWalletClient(
      makeApi({ isConnected: async () => ({ isConnected: false }) })
    );
    await assert.rejects(
      () => missingExtClient.connectWallet(TESTNET_PASSPHRASE),
      (err) => err instanceof WalletError && err.code === "not-installed"
    );
  });
});
