import type { TaskType } from "./types";

export type ExampleId = "deterministic-correct" | "retrieval-correct" | "deterministic-wrong";

export interface SubmissionExample {
  id: ExampleId;
  label: string;
  taskType: Extract<TaskType, "deterministic" | "retrieval">;
  expectedOutcome: "verified" | "slashed";
  input: string;
  functionBody: string;
  output: string;
  note: string;
}

/** Ready-to-submit examples for the new-submission form. Every example produces
 * a real testnet transaction that locks a real testnet bond once signed. */
export const EXAMPLES = {
  deterministicCorrect: {
    id: "deterministic-correct",
    label: "Deterministic",
    taskType: "deterministic",
    expectedOutcome: "verified",
    input: '{"n": 21}',
    functionBody: "return { doubled: input.n * 2 };",
    output: '{"doubled": 42}',
    note: "Real testnet submission. Re-executors will replay this function against the input and should find it correct; your bond is returned once verified.",
  },
  retrievalCorrect: {
    id: "retrieval-correct",
    label: "Retrieval",
    taskType: "retrieval",
    expectedOutcome: "verified",
    input: '{"url": "https://horizon-testnet.stellar.org/", "pointer": "/network_passphrase"}',
    functionBody: "",
    output: "Test SDF Network ; September 2015",
    note: "Real testnet submission. A sampled re-executor will re-fetch the Stellar Horizon testnet root, read /network_passphrase, and should find it correct.",
  },
  deterministicWrong: {
    id: "deterministic-wrong",
    label: "Wrong example (to see a slash)",
    taskType: "deterministic",
    expectedOutcome: "slashed",
    input: '{"n": 21}',
    functionBody: "return { doubled: input.n * 2 };",
    output: '{"doubled": 43}',
    note: "Real testnet submission with a deliberately wrong claimed output (43 instead of 42). Re-executors will replay this and vote mismatch, so your locked testnet bond will be forfeited.",
  },
} as const satisfies Record<string, SubmissionExample>;

export const EXAMPLE_LIST: readonly SubmissionExample[] = [
  EXAMPLES.deterministicCorrect,
  EXAMPLES.retrievalCorrect,
  EXAMPLES.deterministicWrong,
];

/** Generates a unique-looking escrow reference for a filled example, e.g. `demo-a3f90c`. */
export function generateExampleEscrowRef(): string {
  const bytes = new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `demo-${suffix}`;
}
