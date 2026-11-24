import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import {
  attestationFilename,
  decodeBase64,
  decodeEd25519PublicKey,
  verifyEd25519Signature,
} from "./strkey.ts";

/** Golden vectors produced by `@stellar/stellar-sdk` StrKey.encodeEd25519PublicKey. */
const GOLDEN_KEYS = [
  [
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0000000000000000000000000000000000000000000000000000000000000000",
  ],
  [
    "GD7777777777777777777777777777777777777777777777777773DB",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  ],
  [
    "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH",
    "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29",
  ],
  [
    "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
    "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c",
  ],
  [
    "GAMX62ZD4FWIKMWGVPEDR6WNL2TYTPQMO2ZJEAZUAON7VCZ5G2GWDF7W",
    "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61",
  ],
];

/** Minimal SEP-0023 encoder used in tests to turn arbitrary 32-byte keys into G-addresses. */
function encodeEd25519PublicKey(raw32, versionByte = 6 << 3) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const payload = new Uint8Array(35);
  payload[0] = versionByte;
  payload.set(raw32, 1);
  let crc = 0x0000;
  for (let i = 0; i < 33; i++) {
    crc ^= payload[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  payload[33] = crc & 0xff;
  payload[34] = (crc >> 8) & 0xff;

  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < payload.length; i++) {
    value = (value << 8) | payload[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >> bits) & 0x1f];
    }
  }
  return out;
}

function makeSignedAttestation() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  // Ed25519 SubjectPublicKeyInfo has a fixed 12-byte ASN.1 header followed by the 32-byte raw key.
  const rawPub = new Uint8Array(spki.subarray(spki.length - 32));
  const signer = encodeEd25519PublicKey(rawPub);

  const payload = {
    schema: "verity.attestation.v2",
    network_passphrase: "Test SDF Network ; September 2015",
    escrow_gate_contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    attestor: { type: "verity-verification-layer", stellar_account: signer },
    subject: {
      agent_stellar_account: "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH",
      escrow_ref: "escrow-1",
      submission_id: "11111111-1111-4111-8111-111111111111",
      chain_submission_id: "7",
    },
    claim: {
      task_type: "deterministic",
      verdict: "verified",
      resolution_method: "reexecution_consensus",
      attestations: [
        {
          reexecutor: "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
          matched: true,
          tx_hash: "c".repeat(64),
        },
      ],
    },
    submit_tx_hash: "a".repeat(64),
    finalize_tx_hash: "b".repeat(64),
    issued_at: "2026-10-24T12:00:00.000Z",
  };
  const canonical = canonicalJson(payload);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");

  return {
    attestation: {
      payload,
      canonical,
      signature,
      signature_algorithm: "ed25519",
      signer,
      delivered_to: null,
      issued_at: "2026-10-24T12:00:05.000Z",
    },
    publicKey,
  };
}

describe("decodeEd25519PublicKey", () => {
  for (const [address, expectedHex] of GOLDEN_KEYS) {
    it(`decodes ${address}`, () => {
      const raw = decodeEd25519PublicKey(address);
      assert.equal(raw.byteLength, 32);
      assert.equal(Buffer.from(raw).toString("hex"), expectedHex);
    });
  }

  it("rejects keys of the wrong length", () => {
    assert.throws(() => decodeEd25519PublicKey(""), /56 characters/);
    assert.throws(
      () => decodeEd25519PublicKey("GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKY"),
      /56 characters/
    );
    assert.throws(
      () => decodeEd25519PublicKey("GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYHH"),
      /56 characters/
    );
  });

  it("rejects lowercase and non-base32 characters", () => {
    const valid = GOLDEN_KEYS[2][0];
    assert.throws(() => decodeEd25519PublicKey(valid.toLowerCase()), /Invalid base32/);
    assert.throws(() => decodeEd25519PublicKey(`${valid.slice(0, 55)}0`), /Invalid base32/);
    assert.throws(() => decodeEd25519PublicKey(`${valid.slice(0, 55)}1`), /Invalid base32/);
    assert.throws(() => decodeEd25519PublicKey(`${valid.slice(0, 55)}8`), /Invalid base32/);
    assert.throws(() => decodeEd25519PublicKey(`${valid.slice(0, 55)}=`), /Invalid base32/);
  });

  it("rejects a checksummed key with a non-G version byte (e.g. C-address or GE... version 49)", () => {
    assert.throws(
      () => decodeEd25519PublicKey("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"),
      /not a Stellar Ed25519 public key/
    );
    const badVersionG = encodeEd25519PublicKey(new Uint8Array(32), (6 << 3) | 1);
    assert.equal(badVersionG[0], "G");
    assert.throws(
      () => decodeEd25519PublicKey(badVersionG),
      /not a Stellar Ed25519 public key/
    );
  });

  it("rejects a corrupted checksum", () => {
    const valid = GOLDEN_KEYS[2][0];
    const lastChar = valid[55] === "A" ? "B" : "A";
    const corrupted = `${valid.slice(0, 55)}${lastChar}`;
    assert.throws(() => decodeEd25519PublicKey(corrupted), /checksum/);
  });
});

describe("decodeBase64", () => {
  it("decodes standard base64", () => {
    const bytes = new Uint8Array(64).fill(0xab);
    const b64 = Buffer.from(bytes).toString("base64");
    assert.deepEqual(decodeBase64(b64), bytes);
  });

  it("rejects malformed or non-canonical base64", () => {
    assert.throws(() => decodeBase64(""), /Invalid base64/);
    assert.throws(() => decodeBase64("abc"), /Invalid base64/);
    assert.throws(() => decodeBase64("ab!d"), /Invalid base64/);
    // "AB==" has a non-zero padding bit (canonical for 0x00 is "AA==").
    assert.throws(() => decodeBase64("AB=="), /Non-canonical base64/);
  });
});

describe("verifyEd25519Signature and canonical check", () => {
  it("passes both checks for a valid settled attestation", async () => {
    const { attestation: att } = makeSignedAttestation();
    assert.equal(canonicalJson(att.payload), att.canonical);
    const sigResult = await verifyEd25519Signature({
      canonical: att.canonical,
      signature: att.signature,
      signatureAlgorithm: att.signature_algorithm,
      signer: att.signer,
    });
    assert.deepEqual(sigResult, { status: "valid" });
  });

  it("changing one character of canonical makes both checks fail", async () => {
    const { attestation: att } = makeSignedAttestation();
    const idx = att.canonical.indexOf("verified");
    const tampered =
      att.canonical.slice(0, idx) + "Verified" + att.canonical.slice(idx + "verified".length);

    assert.notEqual(canonicalJson(att.payload), tampered);
    const sigResult = await verifyEd25519Signature({
      canonical: tampered,
      signature: att.signature,
      signatureAlgorithm: att.signature_algorithm,
      signer: att.signer,
    });
    assert.equal(sigResult.status, "invalid");
  });

  it("fails the signature check when signed by a different key", async () => {
    const { attestation: att } = makeSignedAttestation();
    const otherSigner = GOLDEN_KEYS[2][0];
    const sigResult = await verifyEd25519Signature({
      canonical: att.canonical,
      signature: att.signature,
      signatureAlgorithm: att.signature_algorithm,
      signer: otherSigner,
    });
    assert.equal(sigResult.status, "invalid");
  });

  it("rejects missing signer, unknown algorithm, or malformed signature", async () => {
    const { attestation: att } = makeSignedAttestation();
    const noSigner = await verifyEd25519Signature({
      canonical: att.canonical,
      signature: att.signature,
      signatureAlgorithm: att.signature_algorithm,
      signer: null,
    });
    assert.equal(noSigner.status, "invalid");

    const badAlg = await verifyEd25519Signature({
      canonical: att.canonical,
      signature: att.signature,
      signatureAlgorithm: "rsa",
      signer: att.signer,
    });
    assert.equal(badAlg.status, "invalid");

    const shortSig = await verifyEd25519Signature({
      canonical: att.canonical,
      signature: Buffer.alloc(32).toString("base64"),
      signatureAlgorithm: att.signature_algorithm,
      signer: att.signer,
    });
    assert.equal(shortSig.status, "invalid");
  });

  it("reports unsupported when WebCrypto does not support Ed25519", async () => {
    const { attestation: att } = makeSignedAttestation();
    const unsupportedSubtle = {
      importKey() {
        throw new DOMException("Unrecognized algorithm name", "NotSupportedError");
      },
      verify() {
        throw new Error("should not be reached");
      },
    };
    const res = await verifyEd25519Signature({
      canonical: att.canonical,
      signature: att.signature,
      signatureAlgorithm: att.signature_algorithm,
      signer: att.signer,
      subtle: unsupportedSubtle,
    });
    assert.deepEqual(res, { status: "unsupported" });

    const noSubtle = await verifyEd25519Signature({
      canonical: att.canonical,
      signature: att.signature,
      signatureAlgorithm: att.signature_algorithm,
      signer: att.signer,
      subtle: null,
    });
    assert.deepEqual(noSubtle, { status: "unsupported" });
  });

  it("downloaded JSON round-trips through the README Node verification checks", () => {
    const { attestation: original, publicKey } = makeSignedAttestation();
    const downloadedText = `${JSON.stringify(original, null, 2)}\n`;
    const att = JSON.parse(downloadedText);

    assert.equal(att.signature_algorithm, "ed25519");
    assert.equal(typeof att.canonical, "string");
    assert.equal(canonicalJson(att.payload), att.canonical);
    assert.equal(att.payload?.attestor?.stellar_account, att.signer);
    const signature = Buffer.from(att.signature, "base64");
    const message = Buffer.from(att.canonical, "utf8");
    assert.equal(signature.length, 64);
    assert.equal(verify(null, message, publicKey, signature), true);
    assert.equal(verify(null, Buffer.concat([message, Buffer.from(" ")]), publicKey, signature), false);
    assert.equal(att.payload?.schema, "verity.attestation.v2");
    assert.equal(att.payload?.subject?.submission_id, "11111111-1111-4111-8111-111111111111");
  });
});

describe("attestationFilename", () => {
  it("uses the chain submission id", () => {
    const { attestation: att } = makeSignedAttestation();
    assert.equal(attestationFilename(att.payload), "verity-attestation-7.json");
    assert.equal(attestationFilename(att.payload, "42"), "verity-attestation-42.json");
  });
});
