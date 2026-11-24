import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../http-error.js";
import {
  SUBMISSION_REQUEST_FIELDS,
  differingSubmissionFields,
  refuseDifferentSubmission,
  sameSubmissionRequest,
  type SubmissionRequestField,
  type SubmissionRequestValues,
} from "./idempotency.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

/** A deterministic submission as the route stores it: every optional field given. */
const row = (): Required<SubmissionRequestValues> => ({
  escrow_ref: "bounty-42",
  escrow_value: "10000000000",
  task_type: "deterministic",
  input_hash: HASH_A,
  input_ref: HASH_A,
  function_hash: HASH_B,
  function_ref: HASH_B,
  claimed_output_hash: HASH_C,
  claimed_output_ref: HASH_C,
  bond_amount: "500000000",
});

/** The request that made `row()`. */
const body = (): SubmissionRequestValues => ({ ...row() });

/** A different, valid value for each field. */
const CHANGED: Record<SubmissionRequestField, string> = {
  escrow_ref: "bounty-43",
  escrow_value: "10000000001",
  task_type: "retrieval",
  input_hash: HASH_C,
  input_ref: HASH_C,
  function_hash: HASH_A,
  function_ref: HASH_A,
  claimed_output_hash: HASH_B,
  claimed_output_ref: HASH_B,
  bond_amount: "500000001",
};

test("an identical retry is the same request", () => {
  assert.deepEqual(differingSubmissionFields(row(), body()), []);
  assert.equal(sameSubmissionRequest(row(), body()), true);
});

test("every stored field is compared, and a change in one names that one", () => {
  assert.equal(SUBMISSION_REQUEST_FIELDS.length, 10);
  for (const field of SUBMISSION_REQUEST_FIELDS) {
    const changed = { ...body(), [field]: CHANGED[field] };
    assert.deepEqual(differingSubmissionFields(row(), changed), [field], field);
    assert.equal(sameSubmissionRequest(row(), changed), false, field);
  }
});

test("several changes are all named, in one fixed order", () => {
  const changed = { ...body(), bond_amount: CHANGED.bond_amount, escrow_ref: CHANGED.escrow_ref, input_ref: CHANGED.input_ref };
  assert.deepEqual(differingSubmissionFields(row(), changed), ["escrow_ref", "input_ref", "bond_amount"]);
});

const OPTIONAL: SubmissionRequestField[] = ["input_ref", "function_hash", "function_ref", "claimed_output_ref"];

test("an optional field left out of the body is the null the row stores", () => {
  for (const field of OPTIONAL) {
    const stored = { ...row(), [field]: null };
    const withoutIt: SubmissionRequestValues = { ...body() };
    delete withoutIt[field];
    assert.deepEqual(differingSubmissionFields(stored, withoutIt), [], `${field} left out`);
    assert.deepEqual(differingSubmissionFields(stored, { ...body(), [field]: undefined }), [], `${field} undefined`);
    assert.deepEqual(differingSubmissionFields(stored, { ...body(), [field]: null }), [], `${field} null`);
  }
});

test("an optional field added on the retry is a difference", () => {
  for (const field of OPTIONAL) {
    const stored = { ...row(), [field]: null };
    assert.deepEqual(differingSubmissionFields(stored, body()), [field], field);
  }
});

test("an optional field dropped on the retry is a difference", () => {
  for (const field of OPTIONAL) {
    const withoutIt: SubmissionRequestValues = { ...body() };
    delete withoutIt[field];
    assert.deepEqual(differingSubmissionFields(row(), withoutIt), [field], field);
  }
});

test("an empty string is a value, not a field left out", () => {
  const stored = { ...row(), input_ref: null };
  assert.deepEqual(differingSubmissionFields(stored, { ...body(), input_ref: "" }), ["input_ref"]);
});

test("amounts are compared as numbers, however the database printed them", () => {
  for (const stored of ["500000000", "500000000.0", "500000000.0000000"]) {
    assert.deepEqual(differingSubmissionFields({ ...row(), bond_amount: stored }, body()), [], stored);
  }
  for (const stored of ["500000001", "50000000", "500000000.5"]) {
    assert.deepEqual(differingSubmissionFields({ ...row(), bond_amount: stored }, body()), ["bond_amount"], stored);
  }
});

test("amounts past 2^53 are compared exactly", () => {
  const max = (2n ** 127n - 1n).toString();
  const below = (2n ** 127n - 2n).toString();
  assert.equal(Number(max), Number(below), "as floats the two are the same number");
  const stored = { ...row(), escrow_value: max, bond_amount: max };
  assert.deepEqual(differingSubmissionFields(stored, { ...body(), escrow_value: max, bond_amount: max }), []);
  assert.deepEqual(differingSubmissionFields(stored, { ...body(), escrow_value: below, bond_amount: max }), ["escrow_value"]);
  assert.deepEqual(differingSubmissionFields(stored, { ...body(), escrow_value: max, bond_amount: below }), ["bond_amount"]);
});

test("a row from before escrow_value was stored cannot differ in it", () => {
  const legacy = { ...row(), escrow_value: null };
  assert.deepEqual(differingSubmissionFields(legacy, body()), []);
  assert.deepEqual(differingSubmissionFields(legacy, { ...body(), escrow_value: CHANGED.escrow_value }), []);
  // The rest of such a row is still compared.
  assert.deepEqual(differingSubmissionFields(legacy, { ...body(), bond_amount: CHANGED.bond_amount }), ["bond_amount"]);
});

test("hashes and references are compared exactly", () => {
  assert.deepEqual(differingSubmissionFields(row(), { ...body(), input_hash: HASH_A.toUpperCase() }), ["input_hash"]);
  assert.deepEqual(differingSubmissionFields(row(), { ...body(), escrow_ref: "bounty-42 " }), ["escrow_ref"]);
});

test("fields that are not part of the request are ignored", () => {
  const stored = { ...row(), id: "0b5e", status: "verified", chain_tx_hash: HASH_A, chain_submission_id: "7" };
  const sent = { ...body(), idempotency_key: "key-1" };
  assert.deepEqual(differingSubmissionFields(stored, sent), []);
});

test("refuseDifferentSubmission lets an identical retry through", () => {
  assert.doesNotThrow(() => refuseDifferentSubmission(row(), body()));
});

test("refuseDifferentSubmission answers a changed retry with 409 and names the field", () => {
  assert.throws(
    () => refuseDifferentSubmission(row(), { ...body(), bond_amount: CHANGED.bond_amount }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 409);
      assert.equal(
        err.message,
        "idempotency_key was already used for a different submission (bond_amount differs). " +
          "That submission is on-chain and was not changed; send the new one with a new idempotency_key.",
      );
      return true;
    },
  );
});

test("refuseDifferentSubmission names every differing field", () => {
  assert.throws(
    () => refuseDifferentSubmission(row(), { ...body(), escrow_ref: CHANGED.escrow_ref, bond_amount: CHANGED.bond_amount }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /^idempotency_key was already used for a different submission \(escrow_ref, bond_amount differ\)\. /);
      return true;
    },
  );
});
