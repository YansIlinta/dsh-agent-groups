/**
 * Idempotent desired-state reconciliation loop inspired by Symphony.
 * It never overlaps ticks, backs off after failures, and leaves semantic
 * planning to the Leader while making session reattachment deterministic.
 */
export interface RuntimeReconcilerOptions {
  readonly intervalMs?: number
  readonly maxBackoffMs?: number
  readonly onError?: (error: unknown) => void
}

export class RuntimeReconciler {
  private timer: NodeJS.Timeout | undefined
  private running = false
  private stopped = true
  private failures = 0

  constructor(
    private readonly reconcile: () => Promise<void>,
    private readonly options: RuntimeReconcilerOptions = {},
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }

  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.reconcile()
      this.failures = 0
    } catch (error) {
      this.failures += 1
      this.options.onError?.(error)
      throw error
    } finally {
      this.running = false
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch(() => undefined)
        .finally(() => {
          const base = this.options.intervalMs ?? 5_000
          const max = this.options.maxBackoffMs ?? 60_000
          const next = this.failures === 0 ? base : Math.min(max, base * (2 ** Math.min(this.failures, 6)))
          this.schedule(next)
        })
    }, delay)
    this.timer.unref?.()
  }
}
