// 127.0.0.1, not "localhost" - this host resolves localhost to ::1 first,
// and the backend only binds IPv4, so "localhost" fails fast with ECONNREFUSED.
export const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:3001";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? TESTNET_PASSPHRASE;

export type ExplorerKind = "tx" | "account" | "contract";
export type PassphraseSource =
  | string
  | { network_passphrase?: string | null }
  | null
  | undefined;

function resolvePassphrase(source: PassphraseSource = NETWORK_PASSPHRASE): string {
  if (typeof source === "string") return source.trim();
  if (source && typeof source.network_passphrase === "string") {
    return source.network_passphrase.trim();
  }
  return NETWORK_PASSPHRASE.trim();
}

/** True only when the deployment's network passphrase is Stellar testnet. */
export function isTestnetPassphrase(source: PassphraseSource = NETWORK_PASSPHRASE): boolean {
  return resolvePassphrase(source) === TESTNET_PASSPHRASE;
}

/** Maps a Stellar network passphrase (or `/v1/config` object) to stellar.expert's network slug. */
export function explorerNetwork(
  source: PassphraseSource = NETWORK_PASSPHRASE
): "testnet" | "public" {
  const passphrase = resolvePassphrase(source);
  if (
    passphrase === MAINNET_PASSPHRASE ||
    passphrase === "mainnet" ||
    passphrase === "public"
  ) {
    return "public";
  }
  return "testnet";
}

/** Builds a stellar.expert URL for a transaction, account, or contract on the configured network. */
export function explorerUrl(
  kind: ExplorerKind,
  id: string,
  source: PassphraseSource = NETWORK_PASSPHRASE
): string {
  return `https://stellar.expert/explorer/${explorerNetwork(source)}/${kind}/${id}`;
}

/** How long a server-side call to the backend may take before the page gives
 * up and shows its error state. Transaction relays wait for confirmation
 * on-chain (up to ~45s in the backend), so actions get longer than reads. */
export const BACKEND_READ_TIMEOUT_MS = 20_000;
export const BACKEND_ACTION_TIMEOUT_MS = 90_000;
export const FREIGHTER_INSTALL_URL = "https://www.freighter.app/";
/** Testnet faucet. Server-side only: /api/friendbot calls it for the
 * signed-in account. */
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
