/**
 * Execution Latency Trace
 * 
 * Measures end-to-end latency from trigger detection through dashboard rendering.
 * All operations must be fire-and-forget to never block execution.
 */

export interface TracePoint {
  name: string
  ms: number // milliseconds since start
  duration?: number // duration of this phase
}

export interface ExecutionTrace {
  traceId: string
  startMs: number
  points: TracePoint[]
  completed: boolean
}

const MAX_TRACES = 1000
const traces = new Map<string, ExecutionTrace>()

/**
 * Start a new execution trace.
 */
export function startTrace(traceId: string): ExecutionTrace {
  const startMs = performance.now()
  const trace: ExecutionTrace = {
    traceId,
    startMs,
    points: [],
    completed: false,
  }
  traces.set(traceId, trace)
  if (traces.size > MAX_TRACES) {
    const first = traces.keys().next().value as string | undefined
    if (first) traces.delete(first)
  }
  return trace
}

/**
 * Record a trace point with the duration since the previous point.
 */
export function recordPoint(traceId: string | undefined, name: string): void {
  if (!traceId) return
  const trace = traces.get(traceId)
  if (!trace) return

  const now = performance.now()
  const ms = now - trace.startMs
  const duration = trace.points.length > 0 ? ms - trace.points[trace.points.length - 1].ms : 0

  trace.points.push({ name, ms, duration })
}

/**
 * Complete a trace and log the summary.
 */
export function completeTrace(traceId: string | undefined): void {
  if (!traceId) return
  const trace = traces.get(traceId)
  if (!trace) return

  trace.completed = true
  const totalMs = performance.now() - trace.startMs

  // Only build the summary string when we actually intend to log it.
  // completeTrace() runs on every 20Hz strategy tick, so an unconditional
  // .map().join() here allocated wasted per-tick garbage.
  if (totalMs > 100) {
    const summary = trace.points.map((p) => `${p.name}: ${p.duration?.toFixed(1) ?? "0.0"}ms`).join(" → ")
    console.log(`[LATENCY] ${traceId}: ${summary} (total ${totalMs.toFixed(1)}ms)`)
  }
}

/**
 * Get all recent traces (last 100).
 */
export function getRecentTraces(): ExecutionTrace[] {
  return Array.from(traces.values()).slice(-100)
}

/**
 * Get latency statistics for a given phase name.
 */
export function getPhaseStats(phaseName: string): { count: number; minMs: number; maxMs: number; avgMs: number } | null {
  const durations: number[] = []
  for (const trace of traces.values()) {
    const point = trace.points.find((p) => p.name === phaseName)
    if (point && point.duration !== undefined) {
      durations.push(point.duration)
    }
  }

  if (durations.length === 0) return null

  return {
    count: durations.length,
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
  }
}
