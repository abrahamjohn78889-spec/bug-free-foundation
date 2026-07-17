import { env } from "./config"
import { logEvent } from "./events"
import { allStrategyMeta, isStrategyId } from "./strategy-registry/registry"
import type { StrategyId, TradeSide } from "./types"

// ------------------------------------------------------------
// Integrated Telegram Control Bot (secure long-polling).
// Commands: /start_bot /stop_bot /set_balance <amt> /status
//           /strategies /set_strategy <edgeN>
// Broadcasts a formatted PnL card after every settled trade.
// Only the chat configured in TELEGRAM_CHAT_ID is obeyed.
// ------------------------------------------------------------

// Minimal engine surface Telegram needs (avoids circular import)
export interface TelegramEngineHandle {
  running: boolean
  mode: string
  activeStrategy: StrategyId | null
  start(): string
  stop(): string
  setPaperBalance(amount: number): string
  setStrategy(id: StrategyId | null): string
  bankroll: { balance: number; dustReserve: number }
}

export interface SettlementCard {
  marketId: string
  side: TradeSide
  filledPrice: number
  result: "WIN" | "LOSS"
  pnl: number
  bankroll: number
  dust: number
}

export class TelegramBot {
  connected = false
  private engine: TelegramEngineHandle
  private offset = 0
  private stopped = false

  constructor(engine: TelegramEngineHandle) {
    this.engine = engine
    if (env.TELEGRAM_BOT_TOKEN) {
      this.connected = true
      void this.pollLoop()
      logEvent("info", "Telegram control bot online (long polling)")
    } else {
      logEvent("info", "Telegram disabled — set TELEGRAM_BOT_TOKEN to enable remote control")
    }
  }

  private api(method: string) {
    return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`
  }

  private async send(chatId: string, text: string) {
    try {
      await fetch(this.api("sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      })
    } catch {
      // network hiccup; broadcast is best-effort
    }
  }

  broadcastSettlement(card: SettlementCard) {
    if (!this.connected || !env.TELEGRAM_CHAT_ID) return
    const icon = card.result === "WIN" ? "🟢" : "🔴"
    const text = [
      `${icon} <b>TRADE SETTLED — ${card.result}</b>`,
      ``,
      `Market: <code>${card.marketId}</code>`,
      `Side: <b>${card.side}</b>`,
      `Filled Price: $${card.filledPrice.toFixed(2)}`,
      `Net PnL: <b>${card.pnl >= 0 ? "+" : ""}$${card.pnl.toFixed(2)}</b>`,
      `Compounded Bankroll: $${card.bankroll.toFixed(2)}`,
      `Dust Reserve Saved: $${card.dust.toFixed(4)}`,
    ].join("\n")
    void this.send(env.TELEGRAM_CHAT_ID, text)
  }

  private authorized(chatId: string): boolean {
    return !env.TELEGRAM_CHAT_ID || String(chatId) === String(env.TELEGRAM_CHAT_ID)
  }

  private handleCommand(chatId: string, text: string) {
    const [cmd, arg] = text.trim().split(/\s+/)
    let reply: string
    switch (cmd) {
      case "/start_bot":
        reply = this.engine.start()
        break
      case "/stop_bot":
        reply = this.engine.stop()
        break
      case "/set_balance": {
        const amt = Number(arg)
        reply = Number.isFinite(amt) ? this.engine.setPaperBalance(amt) : "Usage: /set_balance 250"
        break
      }
      case "/status":
        reply = [
          `Engine: ${this.engine.running ? "RUNNING" : "STOPPED"} (${this.engine.mode})`,
          `Active Edge: ${this.engine.activeStrategy ? this.engine.activeStrategy.toUpperCase() : "NONE (Standing Limit Order only)"}`,
          `Balance: $${this.engine.bankroll.balance.toFixed(2)}`,
          `Dust Reserve: $${this.engine.bankroll.dustReserve.toFixed(4)}`,
        ].join("\n")
        break
      case "/strategies":
        reply = [
          "<b>Strategy Registry</b>",
          ...allStrategyMeta().map(
            (m) => `${m.id === this.engine.activeStrategy ? "▶" : "•"} <b>${m.id}</b> — ${m.name}`,
          ),
          "",
          "Switch with /set_strategy edge5 (engine must be stopped)",
        ].join("\n")
        break
      case "/set_strategy":
        reply = isStrategyId(arg) ? this.engine.setStrategy(arg) : "Usage: /set_strategy edge5 (edge1–edge6)"
        break
      default:
        reply = "Commands: /start_bot /stop_bot /set_balance <amount> /status /strategies /set_strategy <edgeN>"
    }
    void this.send(chatId, reply)
  }

  private async pollLoop() {
    while (!this.stopped) {
      try {
        const res = await fetch(`${this.api("getUpdates")}?timeout=25&offset=${this.offset}`, { cache: "no-store" })
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 5000))
          continue
        }
        const data = (await res.json()) as {
          ok: boolean
          result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>
        }
        for (const update of data.result ?? []) {
          this.offset = update.update_id + 1
          const msg = update.message
          if (!msg?.text) continue
          const chatId = String(msg.chat.id)
          if (!this.authorized(chatId)) continue
          this.handleCommand(chatId, msg.text)
        }
      } catch {
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }
}

// ---------- singleton ----------

// V2 owns the Telegram control bot exclusively (V1 disables it). The singleton
// lives under a V2-specific global key so it can never collide with any other
// stack sharing this process.
const globalRef = globalThis as unknown as { __botTelegramV2?: TelegramBot }

export function getTelegram(engine: TelegramEngineHandle): TelegramBot | null {
  if (!globalRef.__botTelegramV2) {
    globalRef.__botTelegramV2 = new TelegramBot(engine)
  }
  return globalRef.__botTelegramV2
}
