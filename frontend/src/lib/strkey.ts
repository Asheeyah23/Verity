const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** SEP-0023 version byte for an Ed25519 public key (`G...`): `6 << 3`. */
const ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3;
const ED25519_STRKEY_LENGTH = 56;
const ED25519_DECODED_BYTES = 35;

/** CRC-16-XMODEM checksum used by Stellar StrKey (SEP-0023). */
function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]! << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

/**
 * Decodes a Stellar Ed25519 public key (`G...`) into its 32 raw public-key
 * bytes, checking the SEP-0023 version byte and CRC-16-XMODEM checksum.
 */
export function decodeEd25519PublicKey(address: string): Uint8Array<ArrayBuffer> {
  if (typeof address !== "string" || address.length !== ED25519_STRKEY_LENGTH) {
    throw new Error("Stellar Ed25519 public key must be 56 characters");
  }

  const decoded = new Uint8Array(ED25519_DECODED_BYTES);
  let buffer = 0;
  let bitsLeft = 0;
  let byteIndex = 0;

  for (let i = 0; i < address.length; i++) {
    const value = BASE32_ALPHABET.indexOf(address[i]!);
    if (value === -1) {
      throw new Error(`Invalid base32 character in Stellar public key at index ${i}`);
    }
    buffer = (buffer << 5) | value;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      decoded[byteIndex++] = (buffer >> bitsLeft) & 0xff;
    }
  }

  if (decoded[0] !== ED25519_PUBLIC_KEY_VERSION_BYTE) {
    throw new Error("Address is not a Stellar Ed25519 public key (G-address)");
  }

  const payloadWithVersion = decoded.subarray(0, 33);
  const expectedCrc = crc16Xmodem(payloadWithVersion);
  const actualCrc = decoded[33]! | (decoded[34]! << 8);
  if (actualCrc !== expectedCrc) {
    throw new Error("Invalid Stellar public key checksum");
  }

  return decoded.slice(1, 33);
}

/** Decodes a canonical base64 string into raw bytes. */
export function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new Error("Invalid base64 string");
  }
  const binary = atob(encoded);
  if (btoa(binary) !== encoded) {
    throw new Error("Non-canonical base64 padding bits");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type SignatureCheckResult =
  | { status: "valid" }
  | { status: "invalid"; reason: string }
  | { status: "unsupported" };

function isEd25519UnsupportedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  if (name === "NotSupportedError") return true;
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /unrecognized algorithm|not supported|unsupported algorithm/i.test(message)
  );
}

/**
 * Verifies an attestation's base64 ed25519 signature over `canonical` against
 * its Stellar `signer` G-address using WebCrypto `Ed25519`.
 */
export async function verifyEd25519Signature(params: {
  canonical: string;
  signature: string;
  signatureAlgorithm: string;
  signer: string | null;
  subtle?: SubtleCrypto | null;
}): Promise<SignatureCheckResult> {
  const { canonical, signature, signatureAlgorithm, signer } = params;

  if (signatureAlgorithm !== "ed25519") {
    return {
      status: "invalid",
      reason: `Unsupported signature algorithm "${signatureAlgorithm}"`,
    };
  }

  if (!signer) {
    return {
      status: "invalid",
      reason: "Attestation has no signer key",
    };
  }

  let publicKeyBytes: Uint8Array<ArrayBuffer>;
  try {
    publicKeyBytes = decodeEd25519PublicKey(signer);
  } catch {
    return {
      status: "invalid",
      reason: "Signer is not a valid Stellar Ed25519 public key",
    };
  }

  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = decodeBase64(signature);
  } catch {
    return {
      status: "invalid",
      reason: "Signature is not valid base64",
    };
  }

  if (signatureBytes.byteLength !== 64) {
    return {
      status: "invalid",
      reason: `Signature must be 64 bytes (got ${signatureBytes.byteLength})`,
    };
  }

  const subtle =
    "subtle" in params ? params.subtle : globalThis.crypto?.subtle ?? null;
  if (!subtle || typeof subtle.importKey !== "function" || typeof subtle.verify !== "function") {
    return { status: "unsupported" };
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
  } catch (err) {
    if (isEd25519UnsupportedError(err)) {
      return { status: "unsupported" };
    }
    return {
      status: "invalid",
      reason: "Signer key could not be imported as an Ed25519 public key",
    };
  }

  try {
    const messageBytes = new TextEncoder().encode(canonical);
    const valid = await subtle.verify(
      { name: "Ed25519" },
      cryptoKey,
      signatureBytes,
      messageBytes
    );
    if (!valid) {
      return {
        status: "invalid",
        reason: "Signature does not match canonical JSON for this signer",
      };
    }
    return { status: "valid" };
  } catch (err) {
    if (isEd25519UnsupportedError(err)) {
      return { status: "unsupported" };
    }
    return {
      status: "invalid",
      reason: "Signature verification failed",
    };
  }
}

/** Download filename `verity-attestation-<chain id>.json` for an attestation response. */
export function attestationFilename(
  payload: Record<string, unknown>,
  chainSubmissionId?: string | null
): string {
  const subject = payload?.subject as
    | { chain_submission_id?: string | number | null; submission_id?: string | null }
    | undefined;
  const id =
    chainSubmissionId ??
    (subject?.chain_submission_id != null ? String(subject.chain_submission_id) : null) ??
    subject?.submission_id ??
    "unknown";
  return `verity-attestation-${id}.json`;
}
