import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { BACKEND_ACTION_TIMEOUT_MS, BACKEND_URL, FRIENDBOT_URL } from "../../../lib/config";
import { SESSION_COOKIE } from "../../../lib/backend-proxy";

// Rate limit: at most one Friendbot funding per account per minute in memory
const fundingCooldowns = new Map<string, number>();
const COOLDOWN_MS = 60_000;

/**
 * Asks Stellar's testnet faucet (Friendbot) to fund the signed-in account.
 * Before calling Friendbot, this route verifies the session token against
 * the backend's /v1/session endpoint to ensure the account is authenticated
 * with a valid cryptographic signature, preventing arbitrary faucet draining.
 */
export async function POST() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip");

  let sessionRes: Response;
  try {
    sessionRes = await fetch(`${BACKEND_URL}/v1/session`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json(
      { error: "The Verity backend is not reachable right now. Try again in a moment." },
      { status: 502 }
    );
  }

  if (sessionRes.status === 401) {
    const res = NextResponse.json({ error: "not authenticated" }, { status: 401 });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  if (!sessionRes.ok) {
    return NextResponse.json(
      { error: "The Verity backend rejected the session check. Try again in a moment." },
      { status: 502 }
    );
  }

  const sessionData = (await sessionRes.json().catch(() => ({}))) as { account?: string };
  const account = sessionData.account;
  if (!account || typeof account !== "string") {
    const res = NextResponse.json({ error: "not authenticated" }, { status: 401 });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  const now = Date.now();
  const lastFunded = fundingCooldowns.get(account);
  if (lastFunded && now - lastFunded < COOLDOWN_MS) {
    return NextResponse.json(
      { error: "Funding rate limit exceeded. Please wait a minute before requesting funds again." },
      { status: 429 }
    );
  }

  let res: Response;
  try {
    res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(account)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return NextResponse.json({ error: "The testnet faucet did not respond. Try again shortly." }, { status: 502 });
  }

  fundingCooldowns.set(account, now);

  if (res.ok) {
    return NextResponse.json({ funded: true, message: "Friendbot sent 10,000 test XLM to your account." });
  }
  // Friendbot funds an account once; asking again is answered with an error
  // that means "already has funds", which is fine for our purposes.
  const detail = await res.text().catch(() => "");
  if (/already funded|op_already_exists|createAccountAlreadyExist/i.test(detail)) {
    return NextResponse.json({ funded: false, message: "This account already has test XLM from Friendbot." });
  }
  return NextResponse.json({ error: "The testnet faucet declined the request. Try again shortly." }, { status: 502 });
}
