// ============================================================================
// AUTH BOOT VALIDATION TESTS (INC-004 PR-001, C3)
// ============================================================================
// Exercises `assertAuthBootConfig` directly with an injected env snapshot so
// the tests never mutate process.env and never boot a real engine. The pure
// function is the single source of truth for the boot verdict; `start()` just
// enforces its result. See lib/v2/engine/auth-boot.ts.
// ============================================================================

import { describe, expect, it } from "vitest"
import { assertAuthBootConfig, enforceAuthBoot } from "@/lib/v2/engine/auth-boot"

const FULL: Record<string, string> = {
  DASHBOARD_PASSWORD: "dashboard-secret",
  BOT_CONTROL_TOKEN: "bot-secret",
  NODE_ENV: "production",
}

describe("assertAuthBootConfig — LIVE_V2 fail-CLOSED", () => {
  it("passes when both secrets are set", () => {
    const r = assertAuthBootConfig("LIVE_V2", FULL)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.missing).toEqual([])
  })

  it("refuses startup when DASHBOARD_PASSWORD is missing", () => {
    const r = assertAuthBootConfig("LIVE_V2", { ...FULL, DASHBOARD_PASSWORD: undefined as unknown as string })
    expect(r.ok).toBe(false)
    expect(r.missing).toContain("DASHBOARD_PASSWORD")
    expect(r.errors.some((e) => e.includes("DASHBOARD_PASSWORD"))).toBe(true)
    expect(r.errors.some((e) => /Refusing LIVE_V2 startup/i.test(e))).toBe(true)
  })

  it("refuses startup when BOT_CONTROL_TOKEN is missing", () => {
    const r = assertAuthBootConfig("LIVE_V2", { ...FULL, BOT_CONTROL_TOKEN: undefined as unknown as string })
    expect(r.ok).toBe(false)
    expect(r.missing).toContain("BOT_CONTROL_TOKEN")
    expect(r.errors.some((e) => e.includes("BOT_CONTROL_TOKEN"))).toBe(true)
  })

  it("refuses startup when BOTH secrets are missing (reports both)", () => {
    const r = assertAuthBootConfig("LIVE_V2", { NODE_ENV: "production" })
    expect(r.ok).toBe(false)
    expect(r.missing.sort()).toEqual(["BOT_CONTROL_TOKEN", "DASHBOARD_PASSWORD"])
    expect(r.errors.length).toBe(2)
  })

  it("treats empty-string secrets as missing (unset defence)", () => {
    const r = assertAuthBootConfig("LIVE_V2", { ...FULL, DASHBOARD_PASSWORD: "" })
    expect(r.ok).toBe(false)
    expect(r.missing).toContain("DASHBOARD_PASSWORD")
  })
})

describe("assertAuthBootConfig — PAPER_V1 allows but WARNs", () => {
  it("passes cleanly when secrets are set (no warnings)", () => {
    const r = assertAuthBootConfig("PAPER_V1", FULL)
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([])
  })

  it("passes when secrets are missing, emits a WARN per missing secret + summary reminder", () => {
    const r = assertAuthBootConfig("PAPER_V1", { NODE_ENV: "production" })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.missing.sort()).toEqual(["BOT_CONTROL_TOKEN", "DASHBOARD_PASSWORD"])
    // one warn per missing + summary reminder
    expect(r.warnings.length).toBe(3)
    expect(r.warnings.some((w) => w.includes("DASHBOARD_PASSWORD"))).toBe(true)
    expect(r.warnings.some((w) => w.includes("BOT_CONTROL_TOKEN"))).toBe(true)
    expect(r.warnings.some((w) => /Authentication is disabled/i.test(w))).toBe(true)
    expect(r.warnings.every((w) => w.startsWith("[PAPER_V1]"))).toBe(true)
  })
})

describe("assertAuthBootConfig — ALLOW_UNAUTH escape hatch", () => {
  it("is honoured in development and bypasses missing-secret errors", () => {
    const r = assertAuthBootConfig("LIVE_V2", {
      NODE_ENV: "development",
      ALLOW_UNAUTH: "1",
    })
    expect(r.ok).toBe(true)
    expect(r.allowUnauthApplied).toBe(true)
    expect(r.warnings.some((w) => /ALLOW_UNAUTH=1/.test(w))).toBe(true)
    // still surfaces which secrets are missing so operators can fix them
    expect(r.warnings.some((w) => /DASHBOARD_PASSWORD|BOT_CONTROL_TOKEN/.test(w))).toBe(true)
  })

  it("REFUSES startup when ALLOW_UNAUTH=1 is set in production (even with secrets present)", () => {
    const r = assertAuthBootConfig("LIVE_V2", { ...FULL, ALLOW_UNAUTH: "1" })
    expect(r.ok).toBe(false)
    expect(r.allowUnauthApplied).toBe(false)
    expect(r.errors.some((e) => /ALLOW_UNAUTH=1 is only honoured when NODE_ENV=development/i.test(e))).toBe(true)
  })

  it("REFUSES startup when ALLOW_UNAUTH=1 is set with NODE_ENV unset", () => {
    const r = assertAuthBootConfig("PAPER_V1", { ALLOW_UNAUTH: "1" })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /ALLOW_UNAUTH=1 is only honoured/i.test(e))).toBe(true)
  })

  it("accepts truthy variants (true / yes / on / 1) only in development", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      const r = assertAuthBootConfig("LIVE_V2", { NODE_ENV: "development", ALLOW_UNAUTH: v })
      expect(r.ok, `dev ok for ALLOW_UNAUTH=${v}`).toBe(true)
      expect(r.allowUnauthApplied).toBe(true)
    }
    for (const v of ["0", "false", "no", "", "off"]) {
      const r = assertAuthBootConfig("LIVE_V2", { NODE_ENV: "development", ALLOW_UNAUTH: v, ...FULL })
      expect(r.ok, `dev ok for ALLOW_UNAUTH=${v} with full secrets`).toBe(true)
      expect(r.allowUnauthApplied).toBe(false)
    }
  })
})

describe("enforceAuthBoot", () => {
  it("returns null and emits warns on success", () => {
    const emitted: Array<[string, string]> = []
    const out = enforceAuthBoot("PAPER_V1", (l, m) => emitted.push([l, m]), { NODE_ENV: "production" })
    expect(out).toBeNull()
    expect(emitted.every(([l]) => l === "warn")).toBe(true)
    expect(emitted.length).toBeGreaterThan(0)
  })

  it("returns a combined error string and emits an error on failure", () => {
    const emitted: Array<[string, string]> = []
    const out = enforceAuthBoot("LIVE_V2", (l, m) => emitted.push([l, m]), { NODE_ENV: "production" })
    expect(out).not.toBeNull()
    expect(out!).toMatch(/\[AUTH-BOOT\]/)
    expect(out!).toMatch(/DASHBOARD_PASSWORD/)
    expect(out!).toMatch(/BOT_CONTROL_TOKEN/)
    expect(emitted.some(([l]) => l === "error")).toBe(true)
  })

  it("returns a fatal error when ALLOW_UNAUTH is misused outside development", () => {
    const emitted: Array<[string, string]> = []
    const out = enforceAuthBoot(
      "LIVE_V2",
      (l, m) => emitted.push([l, m]),
      { ...FULL, ALLOW_UNAUTH: "1", NODE_ENV: "production" },
    )
    expect(out).not.toBeNull()
    expect(out!).toMatch(/ALLOW_UNAUTH=1 is only honoured when NODE_ENV=development/i)
  })
})