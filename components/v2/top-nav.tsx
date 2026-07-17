"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut } from "lucide-react"
import { logout } from "@/components/v2/use-bot"
import type { PipelineMode } from "@/lib/v2/engine/types"

const LINKS: { href: string; label: string; pipeline: PipelineMode; activeClass: string }[] = [
  { href: "/v1", label: "V1 PAPER", pipeline: "PAPER_V1", activeClass: "border-neon bg-neon/10 text-neon" },
  { href: "/v2", label: "V2 LIVE", pipeline: "LIVE_V2", activeClass: "border-crimson bg-crimson/10 text-crimson" },
]

/**
 * Permanent one-click navigation between the two pipelines. The URLs are
 * stable and bookmarkable (/v1, /v2); the route determines which pipeline the
 * terminal requests. `engineMode` (the pipeline the engine is ACTUALLY in)
 * is shown as a dot on the link it corresponds to, so a glance tells you
 * both where you are and what the engine is doing.
 */
export function TopNav({ engineMode }: { engineMode?: PipelineMode }) {
  const pathname = usePathname()

  return (
    <nav aria-label="Pipeline navigation" className="flex items-center gap-2">
      {LINKS.map((l) => {
        const active = pathname === l.href || pathname.startsWith(`${l.href}/`)
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[11px] tracking-widest transition-colors ${
              active ? l.activeClass : "border-border bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            {engineMode === l.pipeline ? (
              <span
                className={`size-1.5 rounded-full ${l.pipeline === "PAPER_V1" ? "bg-neon" : "bg-crimson"}`}
                title="Engine is currently in this pipeline"
                aria-hidden="true"
              />
            ) : null}
            {l.label}
          </Link>
        )
      })}
      <button
        type="button"
        onClick={() => void logout()}
        className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-crimson"
        aria-label="Log out of the dashboard"
      >
        <LogOut className="size-3" aria-hidden="true" />
        <span className="hidden sm:inline">LOGOUT</span>
      </button>
    </nav>
  )
}
