# 60-Second Quick Start

## What Does The Bot Do?

Every 5 minutes:
1. **Captures** the Bitcoin price at candle open (= **strike**)
2. **Bids shares** on UP or DOWN based on current spot vs strike
3. **Waits** for the market to resolve
4. **Settles** instantly, records PnL, repeats

**Fully automatic. No manual trading.**

---

## The Timeline (Every 5 Minutes)

```
⏱️  00:00  Candle opens
    04:40  ⏳ P1 WINDOW opens (T-20s) — hunt cheap liquidity
    04:50  ⏳ P2 WINDOW opens (T-10s) — certainty zone
    04:58  🔴 STOPPING — no more orders allowed
    05:00  ✅ Candle expires, PnL settles, repeat
```

---

## 3 Key Controls

### 1. **P1 Band** (T-20s to T-11s)
Cheap prices, less certain. Set to **$0.90 - $0.94**

### 2. **P2 Band** (T-10s to T-3s)
Expensive prices, more certain. Set to **$0.95 - $0.99**

### 3. **PLAY / KILL**
- **PLAY** = Engine armed, loops every candle (automatic)
- **KILL** = Engine stopped (you can resume anytime)

---

## How to Make Continuous Trades

1. Set **P1 Band** on dashboard (numeric fields with step arrows)
2. Set **P2 Band** on dashboard (numeric fields with step arrows)
3. Click **PLAY**
4. **Bot trades automatically every 5 min until you click KILL**

That's it. No manual orders. No babysitting.

---

## Key Jargon Decoded

| Term | Meaning |
|------|---------|
| **Candle / Slot** | 5-minute trading period |
| **Strike** | Bitcoin price at candle open (baseline) |
| **Spot** | Bitcoin reference price (Chainlink on-chain BTC/USD, display only) |
| **T-20s** | 20 seconds left in candle |
| **P1** | First trading window (cheap zone) |
| **P2** | Second trading window (certainty zone) |
| **Drift Guard** | Safety: spot must clear strike by $12 before trading |
| **Fair Value** | True mid-price, bot bids 1¢ under it |
| **Fill** | Order executed, shares acquired |
| **Settle** | Payoff determined, position closed, PnL recorded |

---

## Paper Mode (Risk-Free Learning)

**Start here.** No real money.

- Spot feed: Real Chainlink on-chain BTC/USD reference (display only)
- Ledger: Fake balance ($100 default)
- Trades: Instant (no market discovery wait)
- Click PLAY → Watch 12 candles (~60 min) → Adjust bands → Repeat

---

## Live Mode (Real Money)

**Only after you understand Paper Mode.**

- Requires: Funded proxy wallet + API keys
- Trades: Real Polymarket orders
- PnL: Real Polygon collateral
- Market discovery: May wait 1-2s for real market to publish

Switch on dashboard (KILL first, then select V2 LIVE).

---

## Example: First Trade (Paper Mode)

```
You: Click PLAY at 14:32:00

14:32:00  Candle opens, strike captured
14:32:40  T-20s window, you bid $0.91 UP (10 shares)
14:32:50  T-10s window, bid still resting, no fill yet
14:33:00  Reprice to $0.96 UP (P2 band)
14:33:05  ✅ FILLED 10 shares UP @ $0.95 (avg)
14:37:00  Candle expires
          Spot was UP → ✅ WIN
          PnL: 10 × ($1.00 - $0.95) = +$0.50
          Balance: $100 → $100.50

14:37:05  NEW CANDLE OPENS → Repeat automatically
```

---

## Dashboard Health Checks

Before trading, verify:

- ✅ **Clock Synced** = Time authority online
- ✅ **Spot Feed** = Chainlink BTC/USD reference live
- ✅ **PLAY button lit** = Engine running

---

## Common Mistakes

1. **"I set P1 to $0.99"** ❌ (too high, defeats the purpose)
   - P1 is for *cheap* liquidity, keep it low ($0.90-$0.94)

2. **"I keep clicking PLAY manually"** ❌ (bot loops auto)
   - Set it once, bot trades every 5 min automatically

3. **"Drift guard aborted my trade"** ✓ (safety feature)
   - Spot was too close to strike, bot refused (good)
   - Increase drift padding or wait for bigger moves

4. **"No fills in Live Mode"** ✓ (normal 1-2s delay)
   - Real market takes time to publish
   - Show `marketDiscovery: "waiting"` then `"ready"`
   - Be patient, market will resolve

---

## Next Steps

1. **Read TRADING_GUIDE.md** (detailed explanation)
2. **Run Paper Mode for 1 hour** (12 candles)
3. **Adjust P1/P2 bands** (experiment)
4. **Switch to Live** (when ready, with real funds)
5. **Let it run** (fully automatic from then on)

---

## Support

- **Logs**: Check console for errors
- **Status API**: `curl http://localhost:3000/api/v1/bot/status` (paper) or `/api/v2/bot/status` (live)
- **Trades**: Click 📊 TRADES tab on dashboard
- **README**: Full deployment guide in root directory

**You're ready. Click PLAY and watch it trade.**
