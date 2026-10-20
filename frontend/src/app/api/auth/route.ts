import { NextRequest, NextResponse } from "next/server";
import { BACKEND_URL } from "../../../lib/config";
import { readJsonBody, SESSION_COOKIE } from "../../../lib/backend-proxy";

/**
 * Step 2 of SEP-10: the client has already signed the challenge with
 * Freighter. We forward the signed XDR to the real backend for verification
 * against the claimed account's actual on-chain signing key, then store the
 * returned JWT in an httpOnly cookie - never in localStorage, never handed
 * back to client JS - so an XSS bug can't exfiltrate the session token.
 */
export async function POST(req: NextRequest) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "The Verity backend is not reachable right now. Try again in a moment." }, { status: 502 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    return NextResponse.json({ error: data.error ?? "authentication failed" }, { status: res.status });
  }

  const payload = JSON.parse(Buffer.from(data.token.split(".")[1], "base64url").toString("utf8"));

  // The cookie must die with the token, whatever lifetime the backend issues:
  // a cookie that outlives the JWT keeps sending a dead token (confusing
  // "not authenticated" errors), one that dies first signs the user out for
  // no reason. `exp` is seconds since the epoch, Date.now() is milliseconds;
  // Math.floor plus the not-positive rule below also absorbs a few seconds of
  // clock skew between the backend and this host. A token without a numeric
  // `exp` gets a session cookie rather than an invented lifetime.
  const remaining =
    typeof payload.exp === "number" ? Math.floor(payload.exp - Date.now() / 1000) : undefined;
  if (remaining !== undefined && remaining <= 0) {
    return NextResponse.json(
      { error: "The backend issued a token that has already expired." },
      { status: 502 },
    );
  }

  const response = NextResponse.json({ account: payload.sub });
  response.cookies.set(SESSION_COOKIE, data.token, {
    httpOnly: true,
    // Tied to production on purpose: the session token must never travel over
    // plain HTTP. Browsers silently drop a `Secure` cookie set by a
    // non-localhost HTTP response, so a production deployment without HTTPS
    // answers 200 here yet never signs anyone in — /api/session keeps
    // returning { account: null }. That is the documented requirement, not a
    // bug: see docs/DEPLOY.md, "4. Put HTTPS in front".
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...(remaining !== undefined ? { maxAge: remaining } : {}),
  });
  return response;
}
