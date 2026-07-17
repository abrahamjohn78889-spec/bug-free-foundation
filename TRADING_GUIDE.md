# Edge 5 Trading Guide

## Key Terms Explained

### 1. **Candle / Slot** (5 minutes)
A single trading period on Polymarket. Each candle represents 5 minutes of Bitcoin price movement.

**Example timeline:**
- **00:00** — Candle opens for `btc-updown-5m-1783529200`
- **04:40** — T-20s window opens (Priority 1)
- **04:50** — T-10s window opens (Priority 2)
- **04:58** — T-2s (STOPPING — no more orders allowed)
- **05:00** — Candle expires, winner is determined

### 2. **T-Minus (T-) Time**
Time remaining until the candle closes. Countdown timer.

- **T-20s** = 20 seconds left in the candle
- **T-10s** = 10 seconds left in the candle
- **T-2s** = 2 seconds left (engine locks and waits for settlement)
- **T-0s** = Candle expired, market resolves

### 3. **Priority 1 (P1) — T-20s to T-11s**
The first trading window. Hunt for cheap liquidity.

- **Price target:** $0.90 - $0.94 (adjust on dashboard)
- **Goal:** Grab shares at a discount before the final push
- **Risk:** Lower certainty, but better prices

**Example:**
- Bitcoin spot price: $97,500
- Strike (candle opening price): $98,000
- You want Bitcoin to go **UP** (closer to spot)
- P1 band: $0.90-$0.94 (bid $0.90-$0.94 for UP shares)

### 4. **Priority 2 (P2) — T-10s to T-3s**
The final trading window. Higher certainty, but tight timing.

- **Price target:** $0.95 - $0.99 (adjust on dashboard)
- **Goal:** Fill remaining position as direction becomes certain
- **Risk:** Tighter window, but stronger directional conviction

### 5. **Strike**
The opening price of the candle (the baseline).

When the candle opens, Bitcoin is at a price (e.g., $98,000). This is the **strike**.
- If spot > strike → **UP direction** wins at expiry
- If spot < strike → **DOWN direction** wins at expiry

### 6. **Spot Price**
The Bitcoin reference price from the Chainlink on-chain BTC/USD aggregator (Polygon), polled via public RPC.

- Shown on the dashboard for context; it is **display only**
- When a strategy edge is active, it is compared against the strike to determine direction and drives the drift guard
- Must be "fresh" (less than 10 seconds old) to be used

### 7. **Drift Guard**
Safety mechanism: the spot price must clear the strike by at least **$12 USD** in your target direction before firing an order.

**Example:**
- Strike: $98,000
- Spot: $98,005
- Drift padding: $12
- Status: ❌ **No trade** (spot only $5 above strike, need $12)
- If spot: $98,012 → ✅ **Trade allowed** (spot $12+ above strike)

**Why?** Prevents trading on tiny moves that could reverse in 2 seconds.

### 8. **Fair Value**
The "true" mid-price of a UP or DOWN token based on:
- Current spot vs. strike
- Open book depth
- Historical volatility

Fair value = the price the bot wants to bid *under* to grab the discount.

**Example:**
- Fair value for UP: $0.87
- P2 band: $0.95-$0.99
- Bot bids: $0.86 (one cent under fair value, but clamped to band min)

---

## How Continuous Trading Works

The bot trades **every 5 minutes automatically**, as long as it's **running** (PLAY button active).

### Trading Cycle (repeats every 5 min)

```
00:00 — CANDLE OPENS (btc-updown-5m-1783529200)
        Strike captured at opening spot price
        
04:40 — T-20s WINDOW OPENS (Priority 1)
        ├─ Check spot vs strike + drift guard
        ├─ Bid shares in P1 band ($0.90-$0.94)
        └─ Resting on book, waiting to fill
        
04:50 — T-10s WINDOW OPENS (Priority 2)
        ├─ If P1 didn't fill, reprice higher in P2 band
        ├─ Bid shares in P2 band ($0.95-$0.99)
        └─ Tighter urgency, higher prices
        
04:58 — T-2s HOLD STATE (STOPPING)
        └─ Drop all pending orders, lock the engine
        
05:00 — CANDLE EXPIRES
        ├─ Payoff determined (UP or DOWN winner)
        ├─ Position settles immediately
        ├─ PnL recorded to ledger
        └─ Return to WAITING state

05:01 — NEW CANDLE OPENS
        └─ Repeat cycle every 5 minutes indefinitely
```

### The Dashboard Shows Real-Time State

**When you click PLAY:**

1. **WAITING** (start of new candle)
   - Engine is armed, waiting for T-20s window
   - No orders resting yet

2. **PRIORITY_1** (T-20s to T-11s)
   - Engine posts bid in P1 band
   - Dashboard shows: `PRIORITY_1 | T-00:20 | 🟡 QUOTING $0.91 UP`

3. **PRIORITY_2** (T-10s to T-3s)
   - If unfilled, reprices higher in P2 band
   - Dashboard shows: `PRIORITY_2 | T-00:10 | 🟢 FILLED 10 shares UP @ $0.93`

4. **STOPPING** (T-2s to T-0s)
   - All orders dropped, engine silent
   - Waiting for settlement

5. **Back to WAITING** (new candle)
   - PnL recorded, cycle repeats

---

## Making Continuous Trades: Start → Stop → Repeat

### Setup (One Time)

1. **Dashboard → Set P1 Band**
   - Numeric fields (step arrows): min $0.90, max $0.94
   - This is your cheap liquidity hunting zone

2. **Dashboard → Set P2 Band**
   - Numeric fields (step arrows): min $0.95, max $0.99
   - This is your certainty zone (final sprint)

3. **Dashboard → Click PLAY**
   - Engine armed, waiting for next candle to open

### Automatic Continuous Loop

Once PLAY is clicked, the engine **loops every candle (every 5 min) automatically** until you click KILL:

```
Candle 1 (00:00-05:00)  → Trade A
Candle 2 (05:00-10:00)  → Trade B
Candle 3 (10:00-15:00)  → Trade C
Candle 4 (15:00-20:00)  → Trade D
... (infinite loop until KILL clicked)
```

**No manual restart needed.** The bot fires continuously.

### Stopping

1. Click **KILL** button
   - Engine halts immediately
   - All pending orders dropped
   - State saved to SQLite (survives crashes via auto-resume)

2. The next time you click PLAY, the engine resumes and loops again

---

## Paper vs. Live Trading

### Paper Mode (PAPER_V1) — Recommended to Start
- Real Chainlink on-chain BTC/USD reference feed (same as live; display only)
- No real money at risk
- Market discovery: **Not needed** (trades immediately)
- Starting balance: $100 (configurable)
- Perfect for learning the flow

**Dashboard shows realistic PnL** based on your bids vs. fair values.

### Live Mode (LIVE_V2) — Real Polymarket
- Real-money orders on actual markets
- Uses your funded proxy wallet
- Market discovery: **Required** (waits for market to be published)
- PnL is real Polygon collateral

**Important:** Markets only appear on Gamma API after ~1-2s into the candle opening. Engine will show `marketDiscovery: "waiting"` until the real market resolves, then trades fire.

---

## Example: Your First Trade

### Setup
1. Open dashboard → P1 Band: $0.90-$0.94, P2 Band: $0.95-$0.99
2. Click **PLAY** at any time (next 5-min boundary, bot auto-syncs)

### What Happens (Next 5 minutes)

```
Candle opens: btc-updown-5m-1783529200
Strike: BTC = $98,000

T-20s: Spot = $98,015
       → Drift guard clears (+$15 > +$12 threshold)
       → P1 bid: $0.91 UP (10 shares)
       → Order posted to book (waiting to fill)

T-15s: Spot = $98,012
       → No fill yet, bid still resting

T-10s: Spot = $98,020
       → P1 window closing, still no fill
       → Move to P2 band
       → Reprice bid to $0.97 UP (higher urgency)
       → Order replaced on book

T-05s: Spot = $98,025
       → ✅ FILLED: 10 shares UP @ $0.97 (avg)
       → Position locked in

T-00s: Candle expires
       → Spot finished at $98,030 (UP direction won)
       → ✅ WIN: 10 shares paid out $1.00
       → PnL: (10 × $1.00) - (10 × $0.97) = +$0.30
       → Ledger updated: $100 → $100.30

T+5s:  NEW CANDLE OPENS
       → Cycle repeats (fully automatic)
```

---

## Continuous Trading Tips

### Aggressive (More Trades, Higher Risk)
- **P1 Band:** $0.80-$0.88 (very cheap, low fill rate)
- **P2 Band:** $0.92-$0.98 (middle ground)
- **Result:** Fewer fills, but when you do, bigger payoff potential

### Conservative (Steady Wins, Low Risk)
- **P1 Band:** $0.92-$0.95 (high fill rate)
- **P2 Band:** $0.97-$0.99 (very tight)
- **Result:** Frequent small wins, consistent edge

### Balanced (Recommended)
- **P1 Band:** $0.90-$0.94 (default)
- **P2 Band:** $0.95-$0.99 (default)
- **Result:** Mix of cheap fills and high-certainty fills

---

## Monitoring Your Bot

### Dashboard Signals

- **Green PLAY** = Engine running, looping every 5 min
- **Red KILL** = Engine stopped
- **Clock Synced ✓** = Time authority online (required)
- **Spot Feed ✓** = Real-time price feed active (required)
- **Market Discovery: waiting** = LIVE_V2 searching for real market (normal)
- **Market Discovery: ready** = Real market found, ready to trade

### Telegram Alerts (Optional)
Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to get:
- Fill notifications: `✅ FILLED 10 UP @ $0.95`
- Win/loss: `🎯 WIN +$0.30 | balance: $100.30`
- Drift guard abort: `⚠️ ABORT drift guard, spot reversing`

### Trade Ledger
Click **📊 TRADES** tab to see all fills and settlements with timestamps, prices, and PnL.

---

## Troubleshooting Continuous Loops

### "Engine stops after one trade"
- **Check:** Is PLAY button still lit (green)?
- **Fix:** Make sure you didn't accidentally click KILL
- **Expected:** Engine loops every candle, no manual restart needed

### "No fills in P1, all filled in P2"
- **Normal:** P1 prices are aggressive (cheap), P2 is final attempt
- **Adjust:** If you want more P1 fills, raise P1 max to $0.96

### "Engine goes cold in LIVE_V2"
- **Normal:** Waiting for market to be published (1-2s after candle opens)
- **Check:** Status endpoint shows `marketDiscovery: "waiting"`
- **Fix:** Just wait, market will resolve as soon as it's published

### "PnL is negative"
- **Normal:** Sometimes spot reverses before you can fill
- **Check:** Look at winning side (UP vs DOWN) vs. your drift guard direction
- **Improve:** Increase `driftPaddingUsd` from $12 to $15 (more conservative)

---

## Next Steps

1. **Start with Paper Mode** — learn the flow risk-free
2. **Adjust bands** — experiment with P1 and P2 ranges
3. **Monitor one full hour** — watch 12 consecutive candles
4. **Switch to Live** — when confident, add your proxy wallet keys
5. **Let it loop** — engine trades continuously until you stop it

The bot trades **automatically every 5 minutes** once you hit PLAY. No manual order entry, no babysitting. Just set it and watch it fill.
