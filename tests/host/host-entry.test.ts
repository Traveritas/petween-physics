/**
 * host-entry.test.ts — the host half's jobs: install the factory-default
 * bounce animation exactly once (only when the library does not already hold
 * it — the user's customized version outranks our default), and register the
 * /api/petween-physics/config route exactly once per in-process mount
 * (the Symbol.for mount-once flag guards against bundle-patch + standalone
 * double loads; the flag clears on dispose so reloads work).
 *
 * The real schema validation lives in the main plugin's registerAnimation
 * (verified on the real machine during install); here we pin the wiring and
 * the documented invariants the definition itself must satisfy.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index'
import {
  BOUNCE_POP_ANIMATION,
  BOUNCE_POP_ANIMATION_ID,
  ensureBounceAnimation,
} from '../../src/host/bounce-animation'
import type { AnimationDefinitionMirror, PetweenHostService } from '../../src/host/types'

// apply() runs the one-time config-dir migration (host/migrate.ts) against
// dshHomePath() before the store exists. Point $DSH_HOME at a throwaway
// tmpdir so these tests can never touch real user data. dshHomePath reads
// the env on every call, so the per-file override sticks.
const PREVIOUS_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'petween-physics-entry-'))
afterAll(() => {
  rmSync(process.env.DSH_HOME!, { recursive: true, force: true })
  if (PREVIOUS_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_DSH_HOME
})

const makeService = (): { service: PetweenHostService; registered: AnimationDefinitionMirror[] } => {
  const existing = new Set<string>()
  const registered: AnimationDefinitionMirror[] = []
  const service: PetweenHostService = {
    version: 1,
    hasAnimation: async (id) => existing.has(id),
    registerAnimation: async (definition) => {
      existing.add(definition.id)
      registered.push(definition)
    },
  }
  return { service, registered }
}

/** Flush the fire-and-forget registration chain kicked off by apply(). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Fake host context: a webServer registry that records (and would reject)
 * duplicate route registrations, plus a synchronous ctx.effect that hands
 * back the callback's disposer — the two things apply() touches.
 */
interface FakeHost {
  ctx: Context
  registeredPaths: string[]
  effectDisposers: Array<() => void>
}

const makeHost = (): FakeHost => {
  const registeredPaths: string[] = []
  const effectDisposers: Array<() => void> = []
  const ctx = {
    webServer: {
      register: (route: { kind: string; path: string }) => {
        // Mirror the real webServer: a duplicate (kind, path) throws.
        if (registeredPaths.includes(`${route.kind} ${route.path}`)) {
          throw new Error(`duplicate route registration: ${route.kind} ${route.path}`)
        }
        registeredPaths.push(`${route.kind} ${route.path}`)
        return () => {
          const index = registeredPaths.indexOf(`${route.kind} ${route.path}`)
          if (index >= 0) registeredPaths.splice(index, 1)
        }
      },
    },
    effect: (setup: () => () => void) => {
      const dispose = setup()
      effectDisposers.push(dispose)
      return dispose
    },
  } as unknown as Context
  return { ctx, registeredPaths, effectDisposers }
}

describe('ensureBounceAnimation', () => {
  it('registers the default when the library does not hold it', async () => {
    const { service, registered } = makeService()
    await expect(ensureBounceAnimation(service)).resolves.toBe('registered')
    expect(registered).toHaveLength(1)
    expect(registered[0]!.id).toBe(BOUNCE_POP_ANIMATION_ID)
  })

  it('never re-registers once present (user edits survive reloads/upgrades)', async () => {
    const { service, registered } = makeService()
    await ensureBounceAnimation(service)
    await expect(ensureBounceAnimation(service)).resolves.toBe('already-present')
    expect(registered).toHaveLength(1)
  })

  it('propagates registration failures to the caller (apply decides severity)', async () => {
    const failing: PetweenHostService = {
      version: 1,
      hasAnimation: async () => false,
      registerAnimation: async () => {
        throw new Error('INVALID_DEFINITION')
      },
    }
    await expect(ensureBounceAnimation(failing)).rejects.toThrow('INVALID_DEFINITION')
  })
})

describe('BOUNCE_POP_ANIMATION — documented schema invariants', () => {
  it('is an interaction-kind pure deformation in the user: namespace', () => {
    expect(BOUNCE_POP_ANIMATION.id).toBe('user:physics-bounce-pop')
    expect(BOUNCE_POP_ANIMATION.kind).toBe('interaction')
    expect(BOUNCE_POP_ANIMATION.events).toBeUndefined() // interaction: no pose-swap
    expect(BOUNCE_POP_ANIMATION.repeat).toEqual({ mode: 'once' })
    expect(BOUNCE_POP_ANIMATION.durationMs).toBe(260)
    expect(BOUNCE_POP_ANIMATION.durationMs).toBeGreaterThanOrEqual(1)
    expect(BOUNCE_POP_ANIMATION.durationMs).toBeLessThanOrEqual(60_000)
  })

  it('declares only whitelisted motion properties, one track each, valid keyframes', () => {
    const seen = new Set<string>()
    for (const track of BOUNCE_POP_ANIMATION.tracks) {
      expect(seen.has(track.property)).toBe(false) // duplicate property rejected
      seen.add(track.property)
      expect(track.property).toMatch(/^(transition|sway|bounce|breathe)\./)
      expect(track.keyframes.length).toBeGreaterThan(0)
      for (const keyframe of track.keyframes) {
        expect(keyframe.at).toBeGreaterThanOrEqual(0)
        expect(keyframe.at).toBeLessThanOrEqual(1)
      }
      const times = track.keyframes.map((k) => k.at)
      expect([...times].sort((a, b) => a - b)).toEqual(times) // pre-sorted
    }
  })

  it('keeps same-layer tracks easing-consistent (shared times and easings)', () => {
    // Both tracks animate the `transition` layer; the main plugin's compiler
    // merges them into one WAAPI list, so per-interval easings must match.
    const [scaleX, scaleY] = BOUNCE_POP_ANIMATION.tracks as unknown as [
      { keyframes: Array<{ at: number; easing?: string }> },
      { keyframes: Array<{ at: number; easing?: string }> },
    ]
    expect(scaleX.keyframes.map((k) => k.at)).toEqual(scaleY.keyframes.map((k) => k.at))
    expect(scaleX.keyframes.map((k) => k.easing)).toEqual(scaleY.keyframes.map((k) => k.easing))
  })
})

describe('host entry apply()', () => {
  it('registers the default animation and the config route through the injected services', async () => {
    const { service, registered } = makeService()
    const host = makeHost()
    const dispose = apply({ ...host.ctx, 'petween': service } as unknown as Context)
    await flush()
    expect(registered).toHaveLength(1)
    expect(registered[0]!.id).toBe(BOUNCE_POP_ANIMATION_ID)
    expect(host.registeredPaths).toEqual(['exact /api/petween-physics/config'])
    expect(host.effectDisposers).toHaveLength(1)
    dispose?.()
  })

  it('migrates a legacy motion-pet-physics config dir onto petween-physics before the store loads', async () => {
    const legacy = join(process.env.DSH_HOME!, 'motion-pet-physics')
    const target = join(process.env.DSH_HOME!, 'petween-physics')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'config.json'), JSON.stringify({ physics: { gravity: 1337 } }))

    const { service, registered } = makeService()
    const host = makeHost()
    const dispose = apply({ ...host.ctx, 'petween': service } as unknown as Context)
    await flush()
    // Entry-level guarantee: the rename happened and content survived, so
    // PhysicsConfigStore (built after the migration) reads the real config.
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe(JSON.stringify({ physics: { gravity: 1337 } }))
    expect(registered).toHaveLength(1) // the rest of apply() ran as usual
    dispose?.()
    // Keep the isolated home clean for the tests that follow.
    rmSync(target, { recursive: true, force: true })
  })

  it('does not overwrite when the library already holds the id', async () => {
    const { service, registered } = makeService()
    const host = makeHost()
    apply({ ...host.ctx, 'petween': service } as unknown as Context)
    await flush()
    expect(registered).toHaveLength(1)
    apply({ ...host.ctx, 'petween': service } as unknown as Context)
    await flush()
    expect(registered).toHaveLength(1)
    host.effectDisposers[0]!()
  })

  it('stays idle (warns, no throw) when the service is missing or unsupported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const host = makeHost()
      apply(host.ctx as unknown as Context)
      apply({
        ...host.ctx,
        'petween': { version: 2 as unknown as 1 } as unknown as PetweenHostService,
      } as unknown as Context)
      await flush()
      expect(warn).toHaveBeenCalledTimes(2)
      expect(host.registeredPaths).toEqual([]) // no route without a usable service
    } finally {
      warn.mockRestore()
    }
  })

  it('warns instead of crashing when registration rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const failing: PetweenHostService = {
        version: 1,
        hasAnimation: async () => false,
        registerAnimation: async () => {
          throw new Error('INVALID_DEFINITION')
        },
      }
      const host = makeHost()
      expect(() =>
        apply({ ...host.ctx, 'petween': failing } as unknown as Context),
      ).not.toThrow()
      await flush()
      expect(warn).toHaveBeenCalledTimes(1)
      // The config route still registered — the animation is optional eye candy.
      expect(host.registeredPaths).toEqual(['exact /api/petween-physics/config'])
      host.effectDisposers[0]!()
    } finally {
      warn.mockRestore()
    }
  })

  it('mount-once: a second in-process apply registers nothing; dispose re-arms', async () => {
    // The Symbol.for flag is process-global — clean it before AND after so
    // this test neither sees nor leaves stale state for other tests.
    const registry = globalThis as unknown as Record<symbol, true | undefined>
    const FLAG = Symbol.for('petween-physics/host')
    registry[FLAG] = undefined
    try {
      const { service, registered } = makeService()
      const host = makeHost()
      const dispose = apply({ ...host.ctx, 'petween': service } as unknown as Context)
      await flush()
      expect(registered).toHaveLength(1)
      expect(host.registeredPaths).toHaveLength(1)

      // Second load (bundle patch + standalone install double-load): the
      // flag short-circuits BEFORE any registration, so no duplicate route
      // (the real webServer would throw) and no second animation attempt.
      apply({ ...host.ctx, 'petween': service } as unknown as Context)
      await flush()
      expect(registered).toHaveLength(1)
      expect(host.registeredPaths).toHaveLength(1)

      // Dispose clears the flag: a reload registers again.
      dispose?.()
      expect(host.registeredPaths).toHaveLength(0)
      apply({ ...host.ctx, 'petween': service } as unknown as Context)
      await flush()
      expect(host.registeredPaths).toEqual(['exact /api/petween-physics/config'])
      host.effectDisposers.at(-1)!()
    } finally {
      registry[FLAG] = undefined
    }
  })
})
