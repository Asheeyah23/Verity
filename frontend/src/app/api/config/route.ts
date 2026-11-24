import { NextRequest, NextResponse } from "next/server";
import { BACKEND_READ_TIMEOUT_MS, BACKEND_URL } from "../../../lib/config";

export async function GET(req: NextRequest) {
  const forwarded = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip");
  try {
    const res = await fetch(`${BACKEND_URL}/v1/config`, {
      headers: forwarded ? { "x-forwarded-for": forwarded } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(BACKEND_READ_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "The Verity backend is not reachable right now. Try again in a moment." },
      { status: 502 }
    );
  }
}
