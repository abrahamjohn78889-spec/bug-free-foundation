import { NextResponse } from "next/server"
import { clearSessionCookieHeader } from "@/lib/v2/engine/dashboard-auth"

export const runtime = "nodejs"

export async function POST() {
  const res = NextResponse.json({ ok: true, message: "Logged out" })
  res.headers.set("Set-Cookie", clearSessionCookieHeader())
  return res
}
