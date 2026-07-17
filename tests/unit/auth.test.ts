// ============================================================================
// AUTH TESTS — dashboard session tokens + control API shared-secret guard
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  checkCredentials,
  clearSessionCookieHeader,
  createSessionToken,
  dashboardAuthEnabled,
  sessionCookieHeader,
  verifySessionToken,
} from "@/lib/v2/engine/dashboard-auth"
import { checkControlAuth } from "@/lib/v2/engine/api-auth"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env.DASHBOARD_PASSWORD = ORIGINAL_ENV.DASHBOARD_PASSWORD
  if (ORIGINAL_ENV.DASHBOARD_USERNAME === undefined) delete process.env.DASHBOARD_USERNAME
  else process.env.DASHBOARD_USERNAME = ORIGINAL_ENV.DASHBOARD_USERNAME
  process.env.BOT_CONTROL_TOKEN = ORIGINAL_ENV.BOT_CONTROL_TOKEN
})

describe("dashboard session auth", () => {
  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = "test-password-123"
    delete process.env.DASHBOARD_USERNAME
  })

  it("is disabled when DASHBOARD_PASSWORD is unset", () => {
    delete process.env.DASHBOARD_PASSWORD
    expect(dashboardAuthEnabled()).toBe(false)
  })

  it("mints a token that verifies", async () => {
    const token = await createSessionToken()
    expect(await verifySessionToken(token)).toBe(true)
  })

  it("rejects garbage, empty, and malformed tokens", async () => {
    expect(await verifySessionToken(undefined)).toBe(false)
    expect(await verifySessionToken(null)).toBe(false)
    expect(await verifySessionToken("")).toBe(false)
    expect(await verifySessionToken("no-dot-here")).toBe(false)
    expect(await verifySessionToken(".sigonly")).toBe(false)
    expect(await verifySessionToken("12345.not-hex")).toBe(false)
  })

  it("rejects a token with a tampered expiry (signature no longer matches)", async () => {
    const token = await createSessionToken()
    const [, sig] = token.split(".")
    const farFuture = String(Date.now() + 999 * 24 * 3_600_000)
    expect(await verifySessionToken(`${farFuture}.${sig}`)).toBe(false)
  })

  it("rejects an expired token even with a valid-format signature", async () => {
    const token = await createSessionToken()
    const [, sig] = token.split(".")
    const past = String(Date.now() - 1000)
    expect(await verifySessionToken(`${past}.${sig}`)).toBe(false)
  })

  it("changing the password invalidates all existing sessions", async () => {
    const token = await createSessionToken()
    expect(await verifySessionToken(token)).toBe(true)
    process.env.DASHBOARD_PASSWORD = "rotated-password"
    expect(await verifySessionToken(token)).toBe(false)
  })

  it("checkCredentials accepts the correct pair and rejects others (default username: admin)", async () => {
    expect(await checkCredentials("admin", "test-password-123")).toBe(true)
    expect(await checkCredentials("admin", "wrong")).toBe(false)
    expect(await checkCredentials("wrong-user", "test-password-123")).toBe(false)
    expect(await checkCredentials("", "test-password-123")).toBe(false)
    expect(await checkCredentials("admin", "")).toBe(false)
    expect(await checkCredentials("admin", "test-password-1234")).toBe(false)
  })

  it("DASHBOARD_USERNAME overrides the default username", async () => {
    process.env.DASHBOARD_USERNAME = "operator"
    expect(await checkCredentials("operator", "test-password-123")).toBe(true)
    expect(await checkCredentials("admin", "test-password-123")).toBe(false)
  })

  it("checkCredentials rejects everything when auth is disabled", async () => {
    delete process.env.DASHBOARD_PASSWORD
    expect(await checkCredentials("admin", "anything")).toBe(false)
  })

  it("changing the USERNAME invalidates all existing sessions", async () => {
    const token = await createSessionToken()
    expect(await verifySessionToken(token)).toBe(true)
    process.env.DASHBOARD_USERNAME = "new-operator"
    expect(await verifySessionToken(token)).toBe(false)
  })

  it("session cookie is HttpOnly + SameSite=Lax, Secure only on HTTPS", () => {
    const httpCookie = sessionCookieHeader("tok", false)
    expect(httpCookie).toContain("HttpOnly")
    expect(httpCookie).toContain("SameSite=Lax")
    expect(httpCookie).not.toContain("Secure")
    const httpsCookie = sessionCookieHeader("tok", true)
    expect(httpsCookie).toContain("Secure")
    expect(clearSessionCookieHeader()).toContain("Max-Age=0")
  })
})

describe("control API shared-secret guard", () => {
  function reqWith(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/api/v2/bot/control", { method: "POST", headers })
  }

  it("is a no-op when BOT_CONTROL_TOKEN is unset", () => {
    delete process.env.BOT_CONTROL_TOKEN
    expect(checkControlAuth(reqWith()).ok).toBe(true)
  })

  it("rejects missing/wrong/short/long tokens and accepts the exact token", () => {
    process.env.BOT_CONTROL_TOKEN = "secret-token"
    expect(checkControlAuth(reqWith()).ok).toBe(false)
    expect(checkControlAuth(reqWith({ authorization: "Bearer wrong-tokenn" })).ok).toBe(false)
    expect(checkControlAuth(reqWith({ authorization: "Bearer secret" })).ok).toBe(false)
    expect(checkControlAuth(reqWith({ authorization: "Bearer secret-token-extra" })).ok).toBe(false)
    expect(checkControlAuth(reqWith({ authorization: "Bearer secret-token" })).ok).toBe(true)
    expect(checkControlAuth(reqWith({ "x-bot-token": "secret-token" })).ok).toBe(true)
  })
})
