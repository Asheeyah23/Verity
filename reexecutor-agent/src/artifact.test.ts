import test from "node:test";
import assert from "node:assert/strict";
import { verifiedArtifact, extractArtifactHash } from "./artifact.js";
import { createHash } from "node:crypto";

function makeRef(contentHash: string): string {
  return `https://example.com/artifacts/${contentHash}`;
}

function hashOf(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

const correctContent = '{"key": "value"}';
const correctHash = hashOf(correctContent);
const correctBase64 = Buffer.from(correctContent).toString("base64");

test("verifiedArtifact returns bytes when content matches the ref hash", () => {
  const ref = makeRef(correctHash);
  const bytes = verifiedArtifact(ref, correctBase64);
  assert.equal(bytes.toString("utf8"), correctContent);
});

test("verifiedArtifact throws when a single byte is flipped", () => {
  const tampered = Buffer.from(correctContent);
  tampered[0] = tampered[0] ^ 1;
  const badBase64 = tampered.toString("base64");
  const ref = makeRef(correctHash);
  assert.throws(
    () => verifiedArtifact(ref, badBase64),
    new RegExp(`backend served artifact ${correctHash} whose sha256 is`)
  );
});

test("verifiedArtifact throws before any request when ref segment is not 64 lowercase hex", () => {
  const refs = [
    "https://example.com/artifacts/GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    "https://example.com/artifacts/not-a-hash",
    "https://example.com/artifacts/",
    "https://example.com/artifacts/123",
    "https://example.com/artifacts/abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHI",
  ];
  for (const ref of refs) {
    assert.throws(
      () => verifiedArtifact(ref, correctBase64),
      new RegExp(`artifact ref "${ref}" does not end with a 64-char lowercase hex hash`)
    );
  }
});

test("extractArtifactHash extracts and validates the content hash from a ref", () => {
  const ref = makeRef(correctHash);
  assert.equal(extractArtifactHash(ref), correctHash);
});

test("extractArtifactHash throws before any request when ref segment is not 64 lowercase hex", () => {
  const refs = [
    "https://example.com/artifacts/GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    "https://example.com/artifacts/not-a-hash",
    "https://example.com/artifacts/",
    "https://example.com/artifacts/123",
    "https://example.com/artifacts/abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHI",
  ];
  for (const ref of refs) {
    assert.throws(
      () => extractArtifactHash(ref),
      new RegExp(`artifact ref "${ref}" does not end with a 64-char lowercase hex hash`)
    );
  }
});

