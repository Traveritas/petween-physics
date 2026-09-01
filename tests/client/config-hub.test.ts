/**
 * config-hub.test.ts — the lightweight config center with an injected fetch
 * seam: memoized load, subscribe/broadcast, update (PUT + merged broadcast),
 * and the failure paths (load falls back to DEFAULT_CONFIG + error state,
 * save failure keeps the last known-good config).
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type PhysicsConfigPatch, type ThrowPhysicsPluginConfig } from '../../src/client/config'
import { PhysicsConfigHub } from '../../src/client/config-hub'

const configWith = (overrides: {
  gravity?: number
  sampleWindowMs?: number
}): ThrowPhysicsPluginConfig => ({
  ...structuredClone(DEFAULT_CONFIG),
  sampleWindowMs: overrides.sampleWindowMs ?? DEFAULT_CONFIG.sampleWindowMs,
  physics: { ...DEFAULT_CONFIG.physics, gravity: overrides.gravity ?? DEFAULT_CONFIG.physics.gravity },
})

/** A manually settled promise, for exact control over save completion order. */
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('load()', () => {
  it('fetches once and caches: concurrent callers share one GET', async () => {
    const fetchConfig = vi.fn(async () => ({ config: configWith({ gravity: 5000 }) }))
    const hub = new PhysicsConfigHub({ fetchConfig })
    const [a, b] = await Promise.all([hub.load(), hub.load()])
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(hub.getConfig().physics.gravity).toBe(5000)
    expect(hub.getSnapshot()).toMatchObject({ loaded: true, loadError: null, saving: false, saveError: null })
  })

  it('falls back to DEFAULT_CONFIG and surfaces the error on failure (retryable)', async () => {
    let fail = true
    const fetchConfig = vi.fn(async () => {
      if (fail) throw new Error('boom')
      return { config: configWith({ gravity: 5000 }) }
    })
    const hub = new PhysicsConfigHub({ fetchConfig })
    const snapshot = await hub.load()
    // Silent fallback: the config stays fully usable…
    expect(hub.getConfig()).toEqual(DEFAULT_CONFIG)
    expect(snapshot.config).toEqual(DEFAULT_CONFIG)
    // …and the error state is exposed for the card.
    expect(snapshot.loaded).toBe(false)
    expect(snapshot.loadError).toBe('boom')
    // A failed load may be retried and then memoizes the success.
    fail = false
    await hub.load()
    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(hub.getConfig().physics.gravity).toBe(5000)
    expect(hub.getSnapshot().loadError).toBeNull()
  })

  it('notifies subscribers when the snapshot changes', async () => {
    const hub = new PhysicsConfigHub({ fetchConfig: async () => ({ config: configWith({ gravity: 5000 }) }) })
    const listener = vi.fn()
    const unsubscribe = hub.subscribe(listener)
    await hub.load()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]![0].config.physics.gravity).toBe(5000)
    unsubscribe()
    await hub.load() // memoized: no snapshot change, no callback
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('getConfig() default clones (L4)', () => {
  it('before the first load, returns a per-instance clone — mutating it never touches DEFAULT_CONFIG', () => {
    const hub = new PhysicsConfigHub({ fetchConfig: () => new Promise(() => {}) }) // never lands
    const config = hub.getConfig()
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(config).not.toBe(DEFAULT_CONFIG)
    config.physics.gravity = 99_999
    expect(DEFAULT_CONFIG.physics.gravity).not.toBe(99_999)
  })

  it('the load-failure fallback is also a clone', async () => {
    const hub = new PhysicsConfigHub({
      fetchConfig: async () => {
        throw new Error('boom')
      },
    })
    await hub.load()
    const fallen = hub.getConfig()
    expect(fallen).toEqual(DEFAULT_CONFIG)
    expect(fallen).not.toBe(DEFAULT_CONFIG)
    fallen.physics.gravity = 99_999
    expect(DEFAULT_CONFIG.physics.gravity).not.toBe(99_999)
  })
})

describe('update()', () => {
  it('PUTs the patch, broadcasts the merged server config, and tracks saving', async () => {
    const sendConfig = vi.fn(async (patch: PhysicsConfigPatch) => ({
      config: configWith({ gravity: patch.physics?.gravity ?? DEFAULT_CONFIG.physics.gravity }),
    }))
    const hub = new PhysicsConfigHub({ sendConfig })
    await hub.load()
    const listener = vi.fn()
    hub.subscribe(listener)
    const promise = hub.update({ physics: { gravity: 7000 } })
    expect(hub.getSnapshot().saving).toBe(true) // in flight
    await promise
    expect(sendConfig).toHaveBeenCalledWith({ physics: { gravity: 7000 } })
    expect(hub.getConfig().physics.gravity).toBe(7000)
    const snapshot = hub.getSnapshot()
    expect(snapshot.saving).toBe(false)
    expect(snapshot.saveError).toBeNull()
    expect(snapshot.loaded).toBe(true)
    // saving=true → merged broadcast: two listener calls in total.
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('a failed save keeps the last known-good config and exposes saveError', async () => {
    const sendConfig = vi.fn(async () => {
      throw new Error('disk full')
    })
    const hub = new PhysicsConfigHub({
      fetchConfig: async () => ({ config: configWith({ gravity: 5000 }) }),
      sendConfig,
    })
    await hub.load()
    await hub.update({ physics: { gravity: 7000 } })
    expect(hub.getConfig().physics.gravity).toBe(5000) // unchanged
    expect(hub.getSnapshot().saving).toBe(false)
    expect(hub.getSnapshot().saveError).toBe('disk full')
  })

  it('reset() sends the full DEFAULT_CONFIG', async () => {
    const sendConfig = vi.fn(async () => ({ config: structuredClone(DEFAULT_CONFIG) }))
    const hub = new PhysicsConfigHub({
      fetchConfig: async () => ({ config: configWith({ gravity: 9000, sampleWindowMs: 500 }) }),
      sendConfig,
    })
    await hub.load()
    expect(hub.getConfig().sampleWindowMs).toBe(500)
    await hub.reset()
    expect(sendConfig).toHaveBeenCalledWith(structuredClone(DEFAULT_CONFIG))
    expect(hub.getConfig()).toEqual(DEFAULT_CONFIG)
  })

  it('overlapping saves are latest-wins: an older save completing last never rolls the snapshot back', async () => {
    const first = deferred<{ config: ThrowPhysicsPluginConfig }>()
    const second = deferred<{ config: ThrowPhysicsPluginConfig }>()
    const sendConfig = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const hub = new PhysicsConfigHub({
      fetchConfig: async () => ({ config: configWith({ gravity: 5000 }) }),
      sendConfig,
    })
    await hub.load()
    const stale = hub.update({ physics: { gravity: 7000 } })
    const fresh = hub.update({ physics: { gravity: 9000 } })
    // The newer save lands first and takes ownership of the snapshot.
    second.resolve({ config: configWith({ gravity: 9000 }) })
    await fresh
    expect(hub.getConfig().physics.gravity).toBe(9000)
    expect(hub.getSnapshot().saving).toBe(false)
    // The older save completes afterwards: its response is dropped whole —
    // config, saving and saveError stay as the newer save left them.
    first.resolve({ config: configWith({ gravity: 7000 }) })
    await stale
    expect(hub.getConfig().physics.gravity).toBe(9000)
    expect(hub.getSnapshot()).toMatchObject({ saving: false, saveError: null })
  })

  it('overlapping saves completing in issue order are unaffected (latest data still wins)', async () => {
    const first = deferred<{ config: ThrowPhysicsPluginConfig }>()
    const second = deferred<{ config: ThrowPhysicsPluginConfig }>()
    const sendConfig = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const hub = new PhysicsConfigHub({
      fetchConfig: async () => ({ config: configWith({ gravity: 5000 }) }),
      sendConfig,
    })
    await hub.load()
    const stale = hub.update({ physics: { gravity: 7000 } })
    const fresh = hub.update({ physics: { gravity: 9000 } })
    // In-order completion: the first response is already superseded when it
    // lands (the second save is in flight), so `saving` stays true and the
    // intermediate config is skipped rather than flashed.
    first.resolve({ config: configWith({ gravity: 7000 }) })
    await stale
    expect(hub.getConfig().physics.gravity).toBe(5000)
    expect(hub.getSnapshot().saving).toBe(true)
    second.resolve({ config: configWith({ gravity: 9000 }) })
    await fresh
    expect(hub.getConfig().physics.gravity).toBe(9000)
    expect(hub.getSnapshot()).toMatchObject({ saving: false, saveError: null })
  })
})
