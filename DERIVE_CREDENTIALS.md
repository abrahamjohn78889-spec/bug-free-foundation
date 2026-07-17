# Deriving Polymarket CLOB API Credentials

This guide shows you how to generate your API credentials directly using the official Polymarket SDK integrated into this project.

## Prerequisites

Before deriving credentials, ensure your `.env` file has:

```env
WALLET_PRIVATE_KEY=0x...          # Your signing wallet private key
FUNDER_ADDRESS=0x...              # Your funder/proxy address
```

> **Where to get these:**
> - `WALLET_PRIVATE_KEY`: Your Polygon wallet's private key (EOA or proxy signer)
> - `FUNDER_ADDRESS`: The address that holds your USDC collateral on Polygon

## Step 1: Run the Credential Derivation Script

Open VS Code terminal in the project root and run:

```bash
node scripts/derive-clob-credentials.mjs
```

## Step 2: Expected Output

When you run the command, you'll see output like this:

```
🔐 Deriving CLOB API credentials from your wallet...

✅ Credentials successfully derived!

Copy and paste these into your .env file:

CLOB_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CLOB_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CLOB_PASS_PHRASE=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

📍 Location in .env:
   - Find the [LIVE_V2] section
   - Replace the blank values for:
     CLOB_API_KEY=
     CLOB_SECRET=
     CLOB_PASS_PHRASE=

🎯 These credentials are tied to your wallet and will not change.
   You only need to derive them once per wallet.
```

**Do NOT copy the script output that shows `CLOB_API_KEY=undefined` — that means your wallet private key was invalid. Go back to Step 1 and verify your `WALLET_PRIVATE_KEY` in `.env` is correct.**

## Step 3: Update Your `.env` File

Copy the three credential lines from the script output and paste them into your `.env` file:

### Exact locations to paste:

Find this section in `.env`:

```env
# ============ LIVE_V2 (Real Trading) ============
# REQUIRED before switching ENVIRONMENT=LIVE_V2

# Signing wallet (EOA or proxy)
WALLET_PRIVATE_KEY=0x...
FUNDER_ADDRESS=0x...

# CLOB API credentials (derive with: node scripts/derive-clob-credentials.mjs)
CLOB_API_KEY=                    ← PASTE HERE
CLOB_SECRET=                     ← PASTE HERE
CLOB_PASS_PHRASE=                ← PASTE HERE
SIGNATURE_TYPE=1
```

Replace the blank values with the credentials from the script output.

**After pasting, your `.env` should look like:**

```env
CLOB_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CLOB_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CLOB_PASS_PHRASE=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Step 4: Switch to Live Mode (Optional)

Once credentials are filled in, you can enable live trading by changing:

```env
ENVIRONMENT=LIVE_V2
```

> ⚠️ **Warning:** This enables REAL trading with REAL capital. Only do this after:
> - ✅ You've tested extensively in `ENVIRONMENT=PAPER_V1`
> - ✅ You've verified all configuration is correct
> - ✅ You understand the risks

## Troubleshooting

### `❌ WALLET_PRIVATE_KEY not found in .env`

**Cause:** You haven't filled in your private key yet.

**Fix:**
1. Open `.env`
2. Find `WALLET_PRIVATE_KEY=`
3. Add your wallet's private key: `WALLET_PRIVATE_KEY=0x...`

### `❌ Failed to derive credentials: invalid BigNumberish string`

**Cause:** Your `WALLET_PRIVATE_KEY` format is incorrect.

**Fix:**
- Ensure it's a valid 32-byte hex string: `0x` followed by 64 hex characters
- Example: `0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef`
- Never include quotes or extra spaces

### `❌ Failed to derive credentials: network connectivity issue`

**Cause:** Script can't reach Polymarket's servers.

**Fix:**
- Check your internet connection
- Verify `CHAINLINK_RPC_URL` in `.env` is set to a working Polygon RPC

### `CLOB_API_KEY=undefined`

**Cause:** The script ran but your wallet private key is invalid.

**Fix:**
- Run the script again
- Verify your `WALLET_PRIVATE_KEY` is exactly correct (copy from your wallet manager)
- If it still fails, your wallet may not be registered on Polymarket

## Important Notes

- **Credentials are tied to your wallet** — You only need to derive them once. They won't change unless you create a new wallet.
- **Never commit `.env`** — The file is `.gitignore`'d to keep your credentials safe.
- **The script doesn't use your private key for trading** — It only signs a credential derivation request with the official Polymarket SDK.
- **No manual API setup needed** — The script generates credentials directly from your wallet using the Polymarket SDK.

---

**Ready?** Run the script now:

```bash
node scripts/derive-clob-credentials.mjs
```
