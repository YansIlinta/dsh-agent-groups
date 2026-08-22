/**
 * Key-value table persistence abstraction. The production backend is the DSH
 * storage domain (durable JSON under the browser host); the memory backend is
 * for tests and for isolated slices. `update` is the atomic read-modify-write
 * primitive used for task revision CAS.
 * @module @dsh-agent-groups/host
 */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

export interface TableStore<K extends string, V> {
  readonly name: string
  get(key: K): V | undefined
  put(key: K, value: V): Promise<void>
  /** Atomic read-modify-write; rejects with `missing-key` when absent. */
  update(key: K, fn: (current: V) => V): Promise<V>
  delete(key: K): Promise<boolean>
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
}

/** Simple in-memory table implementing the same contract. */
export class MemoryStore<K extends string, V> implements TableStore<K, V> {
  readonly name: string
  private readonly map = new Map<K, V>()

  constructor(name: string) {
    this.name = name
  }

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  async put(key: K, value: V): Promise<void> {
    this.map.set(key, value)
  }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.map.get(key)
    if (current === undefined) {
      throw new Error(`missing-key: ${key}`)
    }
    const next = fn(current)
    this.map.set(key, next)
    return next
  }

  async delete(key: K): Promise<boolean> {
    return this.map.delete(key)
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries()
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }

  get size(): number {
    return this.map.size
  }
}

/** Durable table over one DSH storage-domain KV table. */
export class DomainStore<K extends string, V> implements TableStore<K, V> {
  readonly name: string
  private readonly table: KvTable<K, V>

  constructor(name: string, table: KvTable<K, V>) {
    this.name = name
    this.table = table
  }

  get(key: K): V | undefined {
    return this.table.get(key)
  }

  put(key: K, value: V): Promise<void> {
    return this.table.put(key, value)
  }

  update(key: K, fn: (current: V) => V): Promise<V> {
    return this.table.update(key, fn)
  }

  delete(key: K): Promise<boolean> {
    return this.table.delete(key)
  }

  entries(): IterableIterator<[K, V]> {
    return this.table.entries()
  }

  keys(): IterableIterator<K> {
    return this.table.keys()
  }

  get size(): number {
    return this.table.size
  }
}

/** Bundled set of named tables a service family operates over. */
export type StoreMap = Readonly<Record<string, TableStore<string, unknown>>>

/** Table rows scoped by a `${scope}:${id}` key prefix. */
export function scopedKey(scope: string, id: string): string {
  return `${scope}:${id}`
}

export function unscopedKey(key: string): { scope: string; id: string } {
  const idx = key.indexOf(':')
  if (idx < 0) return { scope: key, id: '' }
  return { scope: key.slice(0, idx), id: key.slice(idx + 1) }
}
