import type { Metadata } from "next"
import { TerminalDashboard } from "@/components/v2/terminal-dashboard"

export const metadata: Metadata = { title: "V1 PAPER — BTC 5M Terminal" }

/** Stable, bookmarkable URL for the PAPER_V1 pipeline (simulated execution). */
export default function V1PaperPage() {
  return <TerminalDashboard pipeline="PAPER_V1" />
}
