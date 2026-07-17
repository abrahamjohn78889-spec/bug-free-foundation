"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut, TestTube2, Zap } from "lucide-react"
import { logout } from "@/components/v2/use-bot"
import { SettingsDrawer } from "@/components/v2/settings-drawer"
import type { PipelineMode } from "@/lib/v2/engine/types"

const LINKS = [
  {
    href: "/v1",
    label: "PAPER",
    sub: "V1",
    pipeline: "PAPER_V1" as PipelineMode,
    icon: TestTube2,
    // Emerald for PAPER (safe)
    activeCls: "border-neon/60 bg-neon/10 text-neon shadow-[0_0_0_1px_var(--neon)_inset]",
    dotCls: "text-neon",
  },
  {
    href: "/v2",
    label: "LIVE",
    sub: "V2",
    pipeline: "LIVE_V2" as PipelineMode,
    icon: Zap,
    // Crimson for LIVE (real money)
    activeCls: "border-crimson/60 bg-crimson/10 text-crimson shadow-[0_0_0_1px_var(--crimson)_inset]",
    dotCls: "text-crimson",
  },
]

/**
 * Premium pill nav — pipeline badge + live engine indicator + Settings + Logout.
 */
export function TopNav({ engineMode }: { engineMode?: PipelineMode }) {
  const pathname = usePathname()

  return (
    <nav aria-label="Pipeline navigation" className="flex items-center gap-1.5">
      <div className="inline-flex items-center rounded-lg border border-border bg-secondary/40 p-0.5">
        {LINKS.map((l) => {
          const active = pathname === l.href || pathname.startsWith(`${l.href}/`)
          const engineHere = engineMode === l.pipeline
          const Icon = l.icon
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`group relative flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px] tracking-widest transition-all ${
                active
                  ? l.activeCls
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="size-3" aria-hidden="true" />
              <span className="hidden sm:inline">{l.label}</span>
              <span className="text-[10px] opacity-70">{l.sub}</span>
              {engineHere ? (
                <span
                  className={`pulse-dot ${l.dotCls}`}
                  aria-label="Engine active in this pipeline"
                />
              ) : null}
            </Link>
          )
        })}
      </div>

      <SettingsDrawer />

      <button
        type="button"
        onClick={() => void logout()}
        className="flex items-center gap-1 rounded-md border border-border bg-secondary/60 px-2 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-crimson/50 hover:text-crimson"
        aria-label="Log out of the dashboard"
      >
        <LogOut className="size-3" aria-hidden="true" />
        <span className="hidden md:inline">LOGOUT</span>
      </button>
    </nav>
  )
}
