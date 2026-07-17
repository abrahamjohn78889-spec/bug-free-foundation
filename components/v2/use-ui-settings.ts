"use client"

import { useEffect, useState } from "react"

export type UiSettings = {
  theme: "dark" | "light"
  density: "comfortable" | "compact"
  ambient: boolean
  wallpaper: "none" | "cyber"
  motion: boolean
}

const DEFAULTS: UiSettings = {
  theme: "dark",
  density: "comfortable",
  ambient: true,
  wallpaper: "none",
  motion: true,
}

const KEY = "btc5m.ui"

function read(): UiSettings {
  if (typeof window === "undefined") return DEFAULTS
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<UiSettings>) }
  } catch {
    return DEFAULTS
  }
}

function apply(s: UiSettings) {
  const b = document.body
  const h = document.documentElement
  // Theme lives on <html> so color-scheme + CSS overrides cascade cleanly.
  h.classList.toggle("light", s.theme === "light")
  h.classList.toggle("dark", s.theme !== "light")
  h.style.colorScheme = s.theme === "light" ? "light" : "dark"
  b.classList.toggle("density-compact", s.density === "compact")
  b.classList.toggle("ambient-off", !s.ambient)
  b.classList.toggle("wallpaper-cyber", s.wallpaper === "cyber")
  b.classList.toggle("motion-off", !s.motion)
}

export function useUiSettings(): [UiSettings, (patch: Partial<UiSettings>) => void] {
  const [state, setState] = useState<UiSettings>(DEFAULTS)

  // Hydrate once from localStorage after mount.
  useEffect(() => { setState(read()) }, [])

  // Persist + apply whenever settings change.
  useEffect(() => {
    try { window.localStorage.setItem(KEY, JSON.stringify(state)) } catch {}
    apply(state)
  }, [state])

  const update = (patch: Partial<UiSettings>) => setState((s) => ({ ...s, ...patch }))
  return [state, update]
}
