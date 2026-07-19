/**
 * ============================================================================
 * DASHBOARD SESSION AUTH — stateless HMAC-signed sessions
 * ============================================================================
 * Design constraints:
 *  • Must work in BOTH the Next.js proxy/middleware (Web Crypto only) and
 *    Node route handlers, so everything uses crypto.subtle (async HMAC).
 *  • No session store needed: tokens are self-contained `expiry.signature`
 *    values signed with a key derived from DASHBOARD_PASSWORD. Changing the
 *    password instantly invalidates every outstanding session.
 *  • The password itself NEVER goes into the cookie — only the HMAC.
 * ============================================================================
 */


/**
 * PR-003 H6 — server-side session invalidation via a monotonic session epoch.
 *
 * Before H6 the only ways to invalidate outstanding sessions were:
 *   • change DASHBOARD_PASSWORD (also forces the operator to change how
 *     they log in — heavy hammer, and irreversible without an env edit), or
 *   • wait for the 7-day TTL.
 *
 * Neither is acceptable for a stolen-cookie scenario where the operator
 * wants to sign out every browser tab NOW without rotating the password.
 * The session epoch is a small integer folded into the HMAC key derivation
 * — bumping it re-derives the key, invalidating every previously issued
 * token instantly on the next verify() call.
 *
 * Storage:
 *   • Seeded from SESSION_EPOCH env at process start.
 *   • Mutable at runtime via bumpSessionEpoch(); persisted best-effort to
 *     .session-epoch so a restart preserves the revocation. Missing/bad
 *     file → falls back to env (or 0), which is safe: the operator can
 *     always bump again.
 */
import * as fs from "node:fs"
import * as path from "node:path"

const EPOCH_FILE = path.join(process.cwd(), "data", ".session-epoch")
function readEpochFile(): number | null {
  try {
    const raw = fs.readFileSync(EPOCH_FILE, "utf8").trim()
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
  } catch { return null }
}
function writeEpochFile(n: number): void {
  try {
    fs.mkdirSync(path.dirname(EPOCH_FILE), { recursive: true })
    fs.writeFileSync(EPOCH_FILE, String(n))
  } catch (e) {
    // Best-effort — a read-only FS still keeps the in-memory bump active
    // for the current process, so a signed-out attacker's cookie fails.
    console.error(`[auth] session-epoch persist failed: ${(e as Error).message}`)
  }
}
let _sessionEpoch: number = (() => {
  const fromFile = readEpochFile()
  if (fromFile !== null) return fromFile
  const fromEnv = Number(process.env.SESSION_EPOCH ?? "0")
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? Math.floor(fromEnv) : 0
})()
export function currentSessionEpoch(): number { return _sessionEpoch }
export function bumpSessionEpoch(): number {
  _sessionEpoch += 1
  writeEpochFile(_sessionEpoch)
  return _sessionEpoch
}
/** TESTING ONLY. */
export function resetSessionEpochForTests(n = 0): void { _sessionEpoch = n }

const SESSION_COOKIE = "edge5_session"
const SESSION_TTL_MS = 7 * 24 * 3_600_000 // 7 days

export { SESSION_COOKIE }

function getPassword(): string | null {
  const p = process.env.DASHBOARD_PASSWORD
  return p && p.length > 0 ? p : null
}

/**
 * Operator username from .env. Defaults to "admin" so existing password-only
 * deployments keep working unchanged (DASHBOARD_USERNAME is optional).
 */
function getUsername(): string {
  const u = process.env.DASHBOARD_USERNAME
  return u && u.length > 0 ? u : "admin"
}

/** Auth is enforced only when DASHBOARD_PASSWORD is set (opt-in, like BOT_CONTROL_TOKEN). */
export function dashboardAuthEnabled(): boolean {
  return getPassword() !== null
}

async function hmacKey(): Promise<CryptoKey> {
  const password = getPassword() ?? ""
  // Domain-separated key derivation: the raw credentials are never the key.
  // BOTH username and password feed the key, so changing EITHER in .env
  // invalidates every outstanding session after restart.
  // H6: session epoch folds into the derived key so bumpSessionEpoch() invalidates every outstanding token.
  const material = new TextEncoder().encode(`edge5-dashboard-session-v3|${_sessionEpoch}|${getUsername()}|${password}`)
  const digest = await crypto.subtle.digest("SHA-256", material)
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Mint a session token: `<expiryMs>.<hmac-hex>`. */
export async function createSessionToken(): Promise<string> {
  const expiry = String(Date.now() + SESSION_TTL_MS)
  const key = await hmacKey()
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expiry))
  return `${expiry}.${toHex(sig)}`
}

/** Verify a session token. Constant-time via crypto.subtle.verify. */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false
  const dot = token.indexOf(".")
  if (dot <= 0) return false
  const expiry = token.slice(0, dot)
  const sigHex = token.slice(dot + 1)
  const expiryMs = Number(expiry)
  if (!Number.isFinite(expiryMs) || Date.now() > expiryMs) return false
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false
  const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map((h) => Number.parseInt(h, 16)))
  const key = await hmacKey()
  // crypto.subtle.verify is constant-time on the MAC comparison.
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(expiry))
}

/**
 * Constant-time comparison of two strings via SHA-256 digests with a
 * fixed-length XOR loop so the comparison cannot leak length/prefix.
 */
async function constantTimeEquals(candidate: string, actual: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(candidate)),
    crypto.subtle.digest("SHA-256", enc.encode(actual)),
  ])
  const ua = new Uint8Array(a)
  const ub = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= ua[i] ^ ub[i]
  return diff === 0
}

/**
 * Constant-time credential check. BOTH comparisons always run (no
 * short-circuit), so a wrong username costs the same time as a wrong
 * password — the response can never reveal which field was wrong.
 */
export async function checkCredentials(username: string, password: string): Promise<boolean> {
  const actualPassword = getPassword()
  if (actualPassword === null) return false
  const [userOk, passOk] = await Promise.all([
    constantTimeEquals(username, getUsername()),
    constantTimeEquals(password, actualPassword),
  ])
  return userOk && passOk
}

/** Cookie attributes. `Secure` is added when the request arrived over HTTPS
 *  (directly or via a reverse proxy that sets x-forwarded-proto). */
export function sessionCookieHeader(token: string, isHttps: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax", // primary CSRF defense: cross-site POSTs never carry the cookie
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (isHttps) parts.push("Secure")
  return parts.join("; ")
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function requestIsHttps(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto")
  if (proto) return proto.split(",")[0].trim() === "https"
  return new URL(req.url).protocol === "https:"
}
