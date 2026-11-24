import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_TX_VALIDITY_MS } from "../modules/submissions/supersede.js";
import { decideDraftPurge, RELAYED_DRAFT_RETENTION_MS } from "./draft-purge.js";

const now = Date.parse("2026-10-25T12:00:00Z");
const ago = (ms: number) => new Date(now - ms);
const DRAFT_TTL_MS = 3600 * 1000;

test("unsigned drafts are kept before DRAFT_TTL_MS and deleted at or after it", () => {
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS - 1),
      relayStartedAt: null,
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "keep"
  );
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS),
      relayStartedAt: null,
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "delete"
  );
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS * 2),
      relayStartedAt: null,
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "delete"
  );
});

test("a relayed draft whose transaction succeeded is always adopted, never deleted", () => {
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS * 2),
      relayStartedAt: ago(DRAFT_TTL_MS * 2),
      chainStatus: "SUCCESS",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "adopt"
  );
  // Even past the retention window, a confirmed SUCCESS is still adopted.
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(RELAYED_DRAFT_RETENTION_MS * 2),
      relayStartedAt: ago(RELAYED_DRAFT_RETENTION_MS * 2),
      chainStatus: "SUCCESS",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "adopt"
  );
  // Even before DRAFT_TTL_MS, a confirmed SUCCESS can be adopted.
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(1_000),
      relayStartedAt: ago(1_000),
      chainStatus: "SUCCESS",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "adopt"
  );
});

test("a relayed draft whose transaction failed is deleted once expired, kept before TTL", () => {
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS - 1),
      relayStartedAt: ago(10_000),
      chainStatus: "FAILED",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "keep"
  );
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS),
      relayStartedAt: ago(10_000),
      chainStatus: "FAILED",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "delete"
  );
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS * 2),
      relayStartedAt: ago(DRAFT_TTL_MS * 2),
      chainStatus: "FAILED",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "delete"
  );
});

test("a NOT_FOUND relayed draft is kept while inside its transaction validity window", () => {
  // Draft updated_at is past DRAFT_TTL_MS, but relay_started_at is still fresh.
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS + 10_000),
      relayStartedAt: ago(BUILT_TX_VALIDITY_MS - 1),
      chainStatus: "NOT_FOUND",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "keep"
  );
});

test("a NOT_FOUND relayed draft is kept across RPC retention even after tx validity and 24h", () => {
  const oneDayMs = 24 * 60 * 60 * 1000;
  // Past tx validity (5.5m) and DRAFT_TTL_MS (1h).
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(2 * 3600 * 1000),
      relayStartedAt: ago(2 * 3600 * 1000),
      chainStatus: "NOT_FOUND",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "keep"
  );
  // Past 24h RPC tx retention, still within 7d event retention.
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(2 * oneDayMs),
      relayStartedAt: ago(2 * oneDayMs),
      chainStatus: "NOT_FOUND",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "keep"
  );
  // One millisecond before the retention boundary.
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(RELAYED_DRAFT_RETENTION_MS),
      relayStartedAt: ago(RELAYED_DRAFT_RETENTION_MS - 1),
      chainStatus: "NOT_FOUND",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "keep"
  );
});

test("a NOT_FOUND relayed draft is given up once both tx validity and retention have elapsed", () => {
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(RELAYED_DRAFT_RETENTION_MS),
      relayStartedAt: ago(RELAYED_DRAFT_RETENTION_MS),
      chainStatus: "NOT_FOUND",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "give_up"
  );
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(RELAYED_DRAFT_RETENTION_MS + 60_000),
      relayStartedAt: ago(RELAYED_DRAFT_RETENTION_MS + 60_000),
      chainStatus: "NOT_FOUND",
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "give_up"
  );
});

test("NOT_FOUND requires BOTH transaction validity and retention windows to pass", () => {
  // Even if retentionMs is configured shorter than txValidityMs, an in-flight tx is still kept.
  const shortRetentionMs = 60_000;
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS),
      relayStartedAt: ago(BUILT_TX_VALIDITY_MS - 1),
      chainStatus: "NOT_FOUND",
      draftTtlMs: DRAFT_TTL_MS,
      retentionMs: shortRetentionMs,
      now,
    }),
    "keep"
  );
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS),
      relayStartedAt: ago(BUILT_TX_VALIDITY_MS),
      chainStatus: "NOT_FOUND",
      draftTtlMs: DRAFT_TTL_MS,
      retentionMs: shortRetentionMs,
      now,
    }),
    "give_up"
  );
});

test("a relayed draft without chainStatus is treated conservatively like NOT_FOUND", () => {
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(DRAFT_TTL_MS * 2),
      relayStartedAt: ago(DRAFT_TTL_MS * 2),
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "keep"
  );
  assert.equal(
    decideDraftPurge({
      updatedAt: ago(RELAYED_DRAFT_RETENTION_MS),
      relayStartedAt: ago(RELAYED_DRAFT_RETENTION_MS),
      draftTtlMs: DRAFT_TTL_MS,
      now,
    }),
    "give_up"
  );
});
