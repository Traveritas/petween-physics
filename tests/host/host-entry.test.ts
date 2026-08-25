/**
 * host-entry.test.ts — the host half's one job: install the factory-default
 * bounce animation exactly once, and only when the library does not already
 * hold it (the user's customized version outranks our default).
 *
 * The real schema validation lives in the main plugin's registerAnimation
 * (verified on the real machine during install); here we pin the wiring and
 * the documented invariants the definition itself must satisfy.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index'
import {
  BOUNCE_POP_ANIMATION,
  BOUNCE_POP_ANIMATION_ID,
  ensureBounceAnimation,
} from '../../src/host/bounce-animation'
import type { AnimationDefinitionMirror, MotionPetHostService } from '../../src/host/types'

const makeService = (): { service: MotionPetHostService; registered: AnimationDefinitionMirror[] } => {
  const existing = new Set<string>()
  const registered: AnimationDefinitionMirror[] = []
  const service: MotionPetHostService = {
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
    const failing: MotionPetHostService = {
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
  it('registers the default through the injected service', async () => {
    const { service, registered } = makeService()
    apply({ 'motion-pet': service } as unknown as Context)
    await flush()
    expect(registered).toHaveLength(1)
    expect(registered[0]!.id).toBe(BOUNCE_POP_ANIMATION_ID)
  })

  it('does not overwrite when the library already holds the id', async () => {
    const { service, registered } = makeService()
    apply({ 'motion-pet': service } as unknown as Context)
    await flush()
    expect(registered).toHaveLength(1)
    apply({ 'motion-pet': service } as unknown as Context)
    await flush()
    expect(registered).toHaveLength(1)
  })

  it('stays idle (warns, no throw) when the service is missing or unsupported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      apply({} as unknown as Context)
      apply({ 'motion-pet': { version: 2 as unknown as 1 } as unknown as MotionPetHostService } as unknown as Context)
      await flush()
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('warns instead of crashing when registration rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const failing: MotionPetHostService = {
        version: 1,
        hasAnimation: async () => false,
        registerAnimation: async () => {
          throw new Error('INVALID_DEFINITION')
        },
      }
      expect(() => apply({ 'motion-pet': failing } as unknown as Context)).not.toThrow()
      await flush()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
