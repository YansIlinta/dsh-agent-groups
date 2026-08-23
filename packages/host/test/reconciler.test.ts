import { describe, expect, it, vi } from 'vitest'
import { RuntimeReconciler } from '../src/runtime/reconciler.js'

describe('RuntimeReconciler', () => {
  it('is idempotent while a reconciliation tick is still active', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reconcile = vi.fn(async () => gate)
    const reconciler = new RuntimeReconciler(reconcile)
    const first = reconciler.runOnce()
    await reconciler.runOnce()
    expect(reconcile).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it('can run again after a completed tick', async () => {
    const reconcile = vi.fn(async () => undefined)
    const reconciler = new RuntimeReconciler(reconcile)
    await reconciler.runOnce()
    await reconciler.runOnce()
    expect(reconcile).toHaveBeenCalledTimes(2)
  })
})
