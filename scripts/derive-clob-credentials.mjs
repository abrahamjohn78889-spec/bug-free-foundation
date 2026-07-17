/**
 * scripts/derive-clob-credentials.mjs
 *
 * Derives Polymarket CLOB API credentials (key, secret, passphrase) from your
 * wallet private key using the official @polymarket/clob-client-v2 SDK —
 * the same SDK already used by lib/v2/engine/execution/live.ts.
 *
 * Prerequisites:
 *   WALLET_PRIVATE_KEY  — set in .env (0x-prefixed private key)
 *   FUNDER_ADDRESS      — set in .env (0x-prefixed proxy/funder address)
 *
 * Run from the project root:
 *   node scripts/derive-clob-credentials.mjs
 */

import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"
import { Wallet } from "ethers"
import { ClobClient } from "@polymarket/clob-client-v2"

// ---------------------------------------------------------------------------
// 1. Parse .env from project root (parent of scripts/)
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "..")

function loadEnv() {
  let raw
  const envPath  = path.join(ROOT, ".env")
  const tmplPath = path.join(ROOT, ".env.template")
  try {
    raw = readFileSync(envPath, "utf-8")
  } catch {
    // Fall back to .env.template so the script still runs if the user has
    // not yet renamed the file — they will get a clear error below for
    // missing credentials rather than a confusing "file not found" crash.
    try {
      raw = readFileSync(tmplPath, "utf-8")
      console.log("NOTE: .env not found — reading .env.template instead.")
      console.log("      Rename .env.template to .env and fill in your credentials.\n")
    } catch {
      console.error("ERROR: neither .env nor .env.template found in the project root.")
      console.error("       Rename .env.template to .env and fill in WALLET_PRIVATE_KEY and FUNDER_ADDRESS.")
      process.exit(1)
    }
  }
  const out = {}
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq === -1) continue
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
  }
  return out
}

const env = loadEnv()

const PRIVATE_KEY    = env.WALLET_PRIVATE_KEY
const FUNDER_ADDRESS = env.FUNDER_ADDRESS

if (!PRIVATE_KEY) {
  console.error("ERROR: WALLET_PRIVATE_KEY is empty or missing in .env")
  process.exit(1)
}
if (!FUNDER_ADDRESS) {
  console.error("ERROR: FUNDER_ADDRESS is empty or missing in .env")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 2. Ethers v6 -> SDK v5-style signer adapter  (mirrors live.ts)
// ---------------------------------------------------------------------------
class EthersV6Adapter {
  constructor(wallet) { this._w = wallet }
  _signTypedData(domain, types, value) { return this._w.signTypedData(domain, types, value) }
  getAddress() { return Promise.resolve(this._w.address) }
}

// ---------------------------------------------------------------------------
// 3. Derive and print
// ---------------------------------------------------------------------------
async function main() {
  console.log("Deriving CLOB API credentials from your wallet ...")
  console.log("")

  const wallet = new Wallet(PRIVATE_KEY)
  const client = new ClobClient({
    host:          "https://clob.polymarket.com",
    chain:         137,            // Polygon mainnet
    signer:        new EthersV6Adapter(wallet),
    signatureType: 1,              // proxy / L2 signature
    funderAddress: FUNDER_ADDRESS,
    useServerTime: true,
  })

  let creds
  try {
    // Nonce 0 is the stable default — produces the same credentials every time
    // for a given wallet, so you can re-run this script to recover them.
    creds = await client.deriveApiKey(0)
  } catch (err) {
    console.error("ERROR: " + (err?.message ?? String(err)))
    console.error("")
    console.error("Common causes:")
    console.error("  - WALLET_PRIVATE_KEY is incorrect")
    console.error("  - FUNDER_ADDRESS does not match the private key")
    console.error("  - No internet connection to clob.polymarket.com")
    process.exit(1)
  }

  if (!creds?.key) {
    console.error("ERROR: SDK returned empty credentials.")
    console.error("       Confirm FUNDER_ADDRESS owns a Polymarket proxy wallet.")
    process.exit(1)
  }

  console.log("------------------------------------------------------")
  console.log("SUCCESS  Copy the three lines below into your .env file")
  console.log("------------------------------------------------------")
  console.log("")
  console.log("CLOB_API_KEY=" + creds.key)
  console.log("CLOB_SECRET=" + creds.secret)
  console.log("CLOB_PASS_PHRASE=" + creds.passphrase)
  console.log("")
  console.log("------------------------------------------------------")
  console.log("In .env find:")
  console.log("  CLOB_API_KEY=")
  console.log("  CLOB_SECRET=")
  console.log("  CLOB_PASS_PHRASE=")
  console.log("and replace each blank value with the output above.")
  console.log("------------------------------------------------------")
}

main()
