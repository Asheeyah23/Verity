import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { BACKEND_ACTION_TIMEOUT_MS, BACKEND_URL } from "./config";

export const SESSION_COOKIE = "verity_jwt";

/** Parse a request body as JSON, answering a malformed or empty body with a
 * 400 instead of letting the SyntaxError from Request.json() surface as an
 * unhandled 500. Returns a result so callers stay one-liners; the 400 is
 * built here, in one place. */
export async function readJsonBody(
  req: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "invalid JSON body" }, { status: 400 }) };
  }
}

/** The signed-in account, read from the session cookie without verifying
 * it — good enough to address a request or for display, never to authorise one (the backend
 * verifies the token itself on every call). */
export async function unverifiedSessionAccount(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (payload.exp && Date.now() >= payload.exp * 1000) return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Kept for backwards compatibility with display-only callers; see unverifiedSessionAccount. */
export const sessionAccount = unverifiedSessionAccount;

/**
 * Returns the verified Stellar account from the backend session endpoint.
 * Returns null if the session cookie is missing, forged, or expired.
 */
export async function verifiedSessionAccount(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip");

  try {
    const res = await fetch(`${BACKEND_URL}/v1/session`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS),
    });
    if (res.status === 401) {
      store.delete(SESSION_COOKIE);
      return null;
    }
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { account?: string };
    return typeof data.account === "string" ? data.account : null;
  } catch {
    return null;
  }
}

/**
 * Server-only proxy to the real backend for actions that need the caller's
 * JWT. The JWT lives only in an httpOnly cookie set by /api/auth - client
 * JS never sees it, only this server-side handler reads it and attaches it
 * as the Authorization header the backend's requireAuth middleware expects.
 */
export async function proxyToBackend(
  path: string,
  init: { method: string; body?: unknown }
): Promise<NextResponse> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip");

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout (AbortSignal.timeout) -> outcome unknown, do not say "try again"
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return NextResponse.json(
        {
          error:
            "The request took too long. The transaction may still have reached the network. Check your account before trying again.",
          outcome_unknown: true,
        },
        { status: 504 }
      );
    }
    // Refused connection, DNS failure, etc. -> safe to retry
    return NextResponse.json(
      { error: "The Verity backend is not reachable right now. Try again in a moment." },
      { status: 502 }
    );
  }

  const data = await res.json().catch(() => ({}));
  const response = NextResponse.json(data, { status: res.status });
  // The backend no longer accepts this token (expired, or signed with a
  // secret that has since changed): drop it so the browser stops presenting it.
  if (res.status === 401) response.cookies.delete(SESSION_COOKIE);
  return response;
}
