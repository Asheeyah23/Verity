/** A malformed retrieval spec is expensive: every re-executor fails to replay
 * it, votes "mismatch", and the agent's own bond is slashed (see
 * reexecutor-agent/src/sandbox/retrieval.ts). Catch what the worker would
 * reject here, before anything is uploaded or signed. */
export function validateRetrievalSpec(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      'The request spec must be a JSON object, e.g. {"url": "https://...", "pointer": "/field"}.'
    );
  }
  const spec = value as Record<string, unknown>;
  const url = spec.url;
  if (typeof url !== "string") {
    throw new Error('The request spec needs a "url" starting with http:// or https://.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL. Use a full address like https://example.com/data.json.`);
  }
  // new URL() accepts javascript: and ftp: too; the worker only replays http(s).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error('The "url" must start with http:// or https://.');
  }
  if (Object.hasOwn(spec, "pointer") && spec.pointer !== undefined) {
    const pointer = spec.pointer;
    if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/"))) {
      throw new Error(
        'The "pointer" must be a JSON Pointer string: "" for the whole document, or starting with "/", e.g. "/network_passphrase".'
      );
    }
  }
}
