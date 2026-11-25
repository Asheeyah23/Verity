import { HttpError } from "../../http-error.js";

/** The fields of a submission request that are kept on its row, in the order
 * a mismatch is reported. `idempotency_key` itself is what found the row. */
export const SUBMISSION_REQUEST_FIELDS = [
  "escrow_ref",
  "escrow_value",
  "task_type",
  "input_hash",
  "input_ref",
  "function_hash",
  "function_ref",
  "claimed_output_hash",
  "claimed_output_ref",
  "bond_amount",
] as const;

export type SubmissionRequestField = (typeof SUBMISSION_REQUEST_FIELDS)[number];

/** A request body leaves an optional field out (`undefined`); a row stores
 * that as `null`. Both mean "not given". */
export type SubmissionRequestValues = { [K in SubmissionRequestField]?: string | null };

const AMOUNT_FIELDS: ReadonlySet<SubmissionRequestField> = new Set(["escrow_value", "bond_amount"]);

/** A stroop amount as an integer, however Postgres printed its `numeric`
 * ("500", "500.0"); null when it is not a whole number. */
function wholeAmount(value: string): bigint | null {
  const match = /^(\d+)(?:\.0+)?$/.exec(value.trim());
  return match ? BigInt(match[1]!) : null;
}

function sameValue(field: SubmissionRequestField, stored: string | null, sent: string | null): boolean {
  if (stored === null || sent === null) return stored === sent;
  if (AMOUNT_FIELDS.has(field)) {
    const a = wholeAmount(stored);
    const b = wholeAmount(sent);
    if (a !== null && b !== null) return a === b;
  }
  return stored === sent;
}

/**
 * The fields in which a request differs from the submission its
 * idempotency_key resolved to, in `SUBMISSION_REQUEST_FIELDS` order.
 *
 * `escrow_value` is the one field a row may not have: rows written before the
 * column existed hold null. Null there means "not recorded", which cannot be
 * compared, so it is never reported as a difference.
 */
export function differingSubmissionFields(
  row: SubmissionRequestValues,
  body: SubmissionRequestValues,
): SubmissionRequestField[] {
  return SUBMISSION_REQUEST_FIELDS.filter((field) => {
    const stored = row[field] ?? null;
    const sent = body[field] ?? null;
    if (field === "escrow_value" && stored === null) return false;
    return !sameValue(field, stored, sent);
  });
}

/** Whether a retry asks for the submission that its key already made. */
export function sameSubmissionRequest(row: SubmissionRequestValues, body: SubmissionRequestValues): boolean {
  return differingSubmissionFields(row, body).length === 0;
}

/**
 * For a key that resolved to a submission already on-chain (or landed): an
 * identical retry may be answered with that submission, a changed one may
 * not. Answering it with 200 would tell the caller that the submission they
 * just edited exists, when what exists is the earlier one.
 */
export function refuseDifferentSubmission(row: SubmissionRequestValues, body: SubmissionRequestValues): void {
  const fields = differingSubmissionFields(row, body);
  if (fields.length === 0) return;
  throw new HttpError(
    409,
    `idempotency_key was already used for a different submission (${fields.join(", ")} ${
      fields.length === 1 ? "differs" : "differ"
    }). That submission is on-chain and was not changed; send the new one with a new idempotency_key.`,
  );
}
