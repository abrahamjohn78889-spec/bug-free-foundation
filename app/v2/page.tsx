import type { Metadata } from "next"
import { TerminalDashboard } from "@/components/v2/terminal-dashboard"

export const metadata: Metadata = { title: "V2 LIVE — BTC 5M Terminal" }

/** Stable, bookmarkable URL for the LIVE_V2 pipeline (real money). */
export default function V2LivePage() {
  return <TerminalDashboard pipeline="LIVE_V2" />
}
