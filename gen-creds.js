#!/usr/bin/env node
/**
 * Standalone CLOB Credentials Generator
 * 
 * Usage:
 *   node gen-creds.js <private_key> <funder_address>
 * 
 * Example:
 *   node gen-creds.js 0x1234... 0x5678...
 */

const { Wallet } = require("ethers");
const { ClobClient } = require("@polymarket/clob-client-v2");

async function main() {
  const privateKey = process.argv[2];
  const funderAddress = process.argv[3];

  if (!privateKey || !funderAddress) {
    console.log("Usage: node gen-creds.js <private_key> <funder_address>");
    console.log("Example: node gen-creds.js 0x1234567890abcdef... 0xabcdef1234567890...");
    process.exit(1);
  }

  try {
    const wallet = new Wallet(privateKey);
    
    class Adapter {
      constructor(w) { this._w = w; }
      _signTypedData(d, t, v) { return this._w.signTypedData(d, t, v); }
      getAddress() { return Promise.resolve(this._w.address); }
    }

    const client = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer: new Adapter(wallet),
      signatureType: 1,
      funderAddress,
      useServerTime: true,
    });

    const creds = await client.deriveApiKey(0);

    console.log("\nCLOB_API_KEY=" + creds.key);
    console.log("CLOB_SECRET=" + creds.secret);
    console.log("CLOB_PASS_PHRASE=" + creds.passphrase + "\n");
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
}

main();
