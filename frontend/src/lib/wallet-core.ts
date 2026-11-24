export type WalletErrorCode = "not-installed" | "wrong-network" | "network-unknown" | "rejected" | "timeout";

export class WalletError extends Error {
  readonly code: WalletErrorCode;

  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "WalletError";
  }
}

export interface FreighterErrorLike {
  message?: string;
}

export interface FreighterApi {
  isConnected: () => Promise<{ isConnected: boolean; error?: FreighterErrorLike }>;
  requestAccess: () => Promise<{ address: string; error?: FreighterErrorLike }>;
  getNetwork: () => Promise<{ network: string; networkPassphrase: string; error?: FreighterErrorLike }>;
  signTransaction: (
    xdr: string,
    opts: { networkPassphrase: string; address: string }
  ) => Promise<{ signedTxXdr: string; error?: FreighterErrorLike }>;
}

export interface WalletTimeouts {
  accessMs: number;
  getNetworkMs: number;
  signMs: number;
}

export const DEFAULT_WALLET_TIMEOUTS: WalletTimeouts = {
  accessMs: 120_000,
  getNetworkMs: 10_000,
  signMs: 300_000,
};

export interface WatchedWalletChange {
  address?: string;
  network?: string;
  networkPassphrase?: string;
}

export type WatchedWalletEffect =
  | { kind: "account-switched" }
  | { kind: "wrong-network"; message: string }
  | { kind: "network-ok" }
  | { kind: "ignore" };

export function wrongNetworkMessage(network?: string): string {
  const label = network?.trim() || "another network";
  return `Freighter is on ${label}. Switch it to Testnet to keep going.`;
}

/** Decides what a WatchWalletChanges tick means for the active session.
 * WatchWalletChanges fires immediately on start, and Freighter reports an
 * empty networkPassphrase while locked, so empty passphrases are ignored
 * rather than flashing a false wrong-network banner. */
export function evaluateWalletChange(
  change: WatchedWalletChange,
  activeAccount: string,
  expectedPassphrase: string
): WatchedWalletEffect {
  if (change.address && change.address !== activeAccount) {
    return { kind: "account-switched" };
  }
  if (!change.networkPassphrase) {
    return { kind: "ignore" };
  }
  if (change.networkPassphrase !== expectedPassphrase) {
    return { kind: "wrong-network", message: wrongNetworkMessage(change.network) };
  }
  return { kind: "network-ok" };
}

/** Freighter answers through the extension; if nothing ever answers, the
 * promise never settles. Nobody should watch a button say "Connecting..."
 * forever, so every wait on the wallet has an end. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WalletError("timeout", message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function createWalletClient(api: FreighterApi, timeouts: WalletTimeouts = DEFAULT_WALLET_TIMEOUTS) {
  /** Confirms Freighter is unlocked and set to the expected Stellar network. */
  async function assertWalletNetwork(expectedPassphrase: string): Promise<void> {
    const network = await withTimeout(
      api.getNetwork(),
      timeouts.getNetworkMs,
      "Freighter did not respond when checking the network. Open the extension, unlock it, and try again."
    );
    if (network.error) {
      const details = network.error.message ? ` (${network.error.message})` : "";
      throw new WalletError(
        "network-unknown",
        `Could not read the network from Freighter${details}. Make sure Freighter is unlocked and set to Testnet, then try again.`
      );
    }
    if (!network.networkPassphrase) {
      throw new WalletError(
        "network-unknown",
        "Could not read the network from Freighter. Make sure Freighter is unlocked and set to Testnet, then try again."
      );
    }
    if (network.networkPassphrase !== expectedPassphrase) {
      throw new WalletError("wrong-network", wrongNetworkMessage(network.network));
    }
  }

  /** Asks Freighter for the active account, on the network this deployment uses. */
  async function connectWallet(expectedPassphrase: string): Promise<string> {
    // Without the extension this resolves to isConnected: false (after a short
    // internal timeout) rather than to an error.
    const connected = await api.isConnected();
    if (connected.error || !connected.isConnected) {
      throw new WalletError("not-installed", "Freighter is not installed in this browser.");
    }
    const result = await withTimeout(
      api.requestAccess(),
      timeouts.accessMs,
      "Freighter did not respond. Open the extension, unlock it, and try again."
    );
    if (result.error || !result.address) {
      throw new WalletError("rejected", result.error?.message ?? "Freighter access was declined.");
    }
    await assertWalletNetwork(expectedPassphrase);
    return result.address;
  }

  async function signXdr(
    xdr: string,
    opts: { networkPassphrase: string; address: string }
  ): Promise<string> {
    await assertWalletNetwork(opts.networkPassphrase);
    const result = await withTimeout(
      api.signTransaction(xdr, opts),
      timeouts.signMs,
      "Freighter did not respond to the signing request. Open the extension and try again."
    );
    if (result.error || !result.signedTxXdr) {
      throw new WalletError("rejected", result.error?.message ?? "The signing request was declined.");
    }
    return result.signedTxXdr;
  }

  return { assertWalletNetwork, connectWallet, signXdr };
}
