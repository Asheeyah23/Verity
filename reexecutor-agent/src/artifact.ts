import { createHash } from "node:crypto";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Extracts and validates the 64-char lowercase hex content hash from an artifact ref.
 * Throws if the ref format is wrong.
 */
export function extractArtifactHash(ref: string): string {
  const contentHash = ref.split(/[\\/]/).pop()!;
  if (!HEX64.test(contentHash)) {
    throw new Error(`artifact ref "${ref}" does not end with a 64-char lowercase hex hash`);
  }
  return contentHash;
}

/**
 * Validates that the ref ends with a 64-char lowercase hex content hash,
 * decodes the base64 bytes, and verifies the sha256 matches the hash in the ref.
 * Throws if the ref format is wrong or the bytes don't match the expected hash.
 *
 * This is a transport/backend integrity check. It does NOT replace the
 * on-chain input_hash check done in index.ts which validates the agent's
 * declared input against the contract.
 */
export function verifiedArtifact(ref: string, contentBase64: string): Buffer {
  const contentHash = extractArtifactHash(ref);
  const bytes = Buffer.from(contentBase64, "base64");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== contentHash) {
    throw new Error(
      `backend served artifact ${contentHash} whose sha256 is ${actual}`
    );
  }
  return bytes;
}

