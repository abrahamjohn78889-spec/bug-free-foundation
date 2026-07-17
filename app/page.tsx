import { redirect } from "next/navigation"
import { kvGet } from "@/lib/v2/engine/db"

// The redirect target depends on runtime engine state — never prerender it.
export const dynamic = "force-dynamic"

/**
 * Land on the page matching the engine's CURRENT pipeline so opening the
 * dashboard never auto-switches modes as a side effect of navigation.
 */
export default function RootPage() {
  const mode = kvGet("v2:pipeline-mode")
  redirect(mode === "LIVE_V2" ? "/v2" : "/v1")
}
