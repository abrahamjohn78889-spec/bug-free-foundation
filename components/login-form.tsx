"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Lock } from "lucide-react"

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (busy || username.length === 0 || password.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      const data = (await res.json()) as { ok: boolean; message: string }
      if (data.ok) {
        const next = searchParams.get("next")
        // Only allow same-app relative redirects (no open-redirect).
        router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/")
        router.refresh()
      } else {
        setError(data.message)
      }
    } catch {
      setError("Network error — is the server running?")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-6 rounded-lg border border-border bg-card p-8"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-10 items-center justify-center rounded-md border border-border text-muted-foreground">
          <Lock className="size-4" aria-hidden="true" />
        </div>
        <h1 className="font-mono text-lg tracking-widest text-foreground">BTC 5M TERMINAL</h1>
        <p className="font-mono text-xs text-muted-foreground">OPERATOR AUTHENTICATION REQUIRED</p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="dashboard-username" className="font-mono text-xs text-muted-foreground">
          USERNAME
        </label>
        <input
          id="dashboard-username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-invalid={error ? true : undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="dashboard-password" className="font-mono text-xs text-muted-foreground">
          PASSWORD
        </label>
        <input
          id="dashboard-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
        />
        {error ? (
          <p id="login-error" role="alert" className="font-mono text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={busy || username.length === 0 || password.length === 0}
        className="h-10 rounded-md bg-primary font-mono text-sm tracking-wider text-primary-foreground transition-opacity disabled:opacity-50"
      >
        {busy ? "AUTHENTICATING..." : "UNLOCK"}
      </button>
    </form>
  )
}
