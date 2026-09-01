/**
 * SharedPetConfigCenter tests: the §12 pluginConfigs pull pipeline — the
 * remap rewrite (exactly the two animation-id fields, everything else
 * untouched), the strict-validation gate, the deep-equal no-op skip, the
 * handled-key dedup (content-keyed, pet-independent, storage-persisted), the
 * same-pet repeat short-circuit, newest-pull-wins ordering, and the silent
 * failure modes (no pocket, old provider, request failure).
 */
import { describe, expect, it, vi } from 'vitest'
import type { PetPluginConfigShare } from '../../src/client/api'
import { DEFAULT_CONFIG, type ThrowPhysicsPluginConfig } from '../../src/client/config'
import {
  canonicalize,
  rewriteSharedAnimationIds,
  SharedPetConfigCenter,
} from '../../src/client/shared-pet-config'

interface Seams {
  center: SharedPetConfigCenter
  fetchShare: ReturnType<typeof vi.fn<(petId: string) => Promise<PetPluginConfigShare | null>>>
  storageMap: Map<string, string>
}

const makeCenter = (
  share: PetPluginConfigShare | null,
  config: ThrowPhysicsPluginConfig = structuredClone(DEFAULT_CONFIG),
): Seams => {
  const storageMap = new Map<string, string>()
  const fetchShare = vi.fn(async () => share)
  const center = new SharedPetConfigCenter({
    fetchShare,
    getConfig: () => config,
    storage: {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageMap.set(key, value)
      },
    },
  })
  return { center, fetchShare, storageMap }
}

const SHARE: PetPluginConfigShare = {
  petName: '女仆',
  config: {
    physics: { gravity: 5000 },
    slideAnimationId: 'user:slide-old',
    bounceAnimation: { id: 'user:bounce-old', enabled: true },
    sampleWindowMs: 240,
  },
  animationIdRemap: {
    'user:slide-old': 'user:slide-new',
    'user:bounce-old': 'user:bounce-new',
    'user:unrelated': 'user:whatever',
  },
}

describe('SharedPetConfigCenter', () => {
  it('offers a pulled blob with ONLY the two animation-id fields rewritten, plus a change summary', async () => {
    const { center } = makeCenter(SHARE)
    const listener = vi.fn()
    center.subscribe(listener)

    await center.checkActivePet('pet-1')

    const offer = center.getSnapshot()
    expect(listener).toHaveBeenCalled()
    expect(offer).not.toBeNull()
    expect(offer!.petId).toBe('pet-1')
    expect(offer!.petName).toBe('女仆')
    expect(offer!.patch).toEqual({
      physics: { gravity: 5000 },
      slideAnimationId: 'user:slide-new', // remapped
      bounceAnimation: { id: 'user:bounce-new', enabled: true }, // id remapped, sibling untouched
      sampleWindowMs: 240, // not an animation id: zero-touch
    })
    const byPath = new Map(offer!.changes.map((change) => [change.path, change]))
    expect(byPath.get('physics.gravity')).toEqual({ path: 'physics.gravity', from: 3000, to: 5000 })
    expect(byPath.get('slideAnimationId')).toEqual({ path: 'slideAnimationId', from: null, to: 'user:slide-new' })
    expect(byPath.get('bounceAnimation.id')?.to).toBe('user:bounce-new')
    expect(byPath.get('sampleWindowMs')?.to).toBe(240)
    expect(byPath.has('physics.restitution')).toBe(false) // not in the blob: not a change
  })

  it('keeps the blob as-is when the remap is absent', async () => {
    const { center } = makeCenter({ petName: 'P', config: { slideAnimationId: 'user:slide-old' } })
    await center.checkActivePet('pet-1')
    expect(center.getSnapshot()?.patch).toEqual({ slideAnimationId: 'user:slide-old' })
  })

  it('skips a blob that deep-equals the current config (full and partial)', async () => {
    const full = makeCenter({ petName: 'P', config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as unknown })
    await full.center.checkActivePet('pet-1')
    expect(full.center.getSnapshot()).toBeNull()

    const partial = makeCenter({ petName: 'P', config: { physics: { gravity: 3000 } } }) // == current
    await partial.center.checkActivePet('pet-1')
    expect(partial.center.getSnapshot()).toBeNull()
    expect(partial.fetchShare).toHaveBeenCalledTimes(1) // pulled, then gated — never shown
  })

  it('rejects an invalid blob silently (the strict REJECT pre-check): out-of-range AND unknown fields', async () => {
    const outOfRange = makeCenter({ petName: 'P', config: { physics: { gravity: 5 } } }) // min is 100
    await outOfRange.center.checkActivePet('pet-1')
    expect(outOfRange.center.getSnapshot()).toBeNull()

    const unknown = makeCenter({ petName: 'P', config: { notAField: true } })
    await unknown.center.checkActivePet('pet-1')
    expect(unknown.center.getSnapshot()).toBeNull()
  })

  it('stays silent when the pet has no pocket and when the request fails', async () => {
    const noPocket = makeCenter(null)
    await noPocket.center.checkActivePet('pet-1')
    expect(noPocket.center.getSnapshot()).toBeNull()

    const failing = new SharedPetConfigCenter({
      fetchShare: vi.fn(async () => {
        throw new Error('main plugin absent')
      }),
      getConfig: () => structuredClone(DEFAULT_CONFIG),
      storage: null,
    })
    await failing.checkActivePet('pet-1') // must not reject
    expect(failing.getSnapshot()).toBeNull()
  })

  it('never fetches for a null/undefined/empty pet id (old provider or no active pet)', async () => {
    const { center, fetchShare } = makeCenter(SHARE)
    await center.checkActivePet(null)
    await center.checkActivePet(undefined)
    await center.checkActivePet('')
    expect(fetchShare).not.toHaveBeenCalled()
    expect(center.getSnapshot()).toBeNull()
  })

  it('short-circuits repeat checks for the same pet id (stage snapshots push often)', async () => {
    const { center, fetchShare } = makeCenter(SHARE)
    await center.checkActivePet('pet-1')
    await center.checkActivePet('pet-1')
    expect(fetchShare).toHaveBeenCalledTimes(1)
    expect(center.getSnapshot()).not.toBeNull()
  })

  it('a dismissed offer never re-prompts: another pet, reordered keys, even a fresh center on the same storage', async () => {
    const { center, storageMap } = makeCenter(SHARE)
    await center.checkActivePet('pet-1')
    const offer = center.getSnapshot()
    expect(offer).not.toBeNull()

    center.dismiss(offer!)
    expect(center.getSnapshot()).toBeNull()

    // Same personality, DIFFERENT pet and different key order: content-keyed
    // dedup must still recognize it.
    const reordered: PetPluginConfigShare = {
      petName: '女仆二号',
      config: {
        sampleWindowMs: 240,
        bounceAnimation: { enabled: true, id: 'user:bounce-old' },
        slideAnimationId: 'user:slide-old',
        physics: { gravity: 5000 },
      },
      animationIdRemap: SHARE.animationIdRemap,
    }
    expect(canonicalize(reordered.config)).toBe(canonicalize(SHARE.config)) // the test premise

    const fresh = new SharedPetConfigCenter({
      fetchShare: vi.fn(async () => reordered),
      getConfig: () => structuredClone(DEFAULT_CONFIG),
      storage: {
        getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storageMap.set(key, value)
        },
      },
    })
    await fresh.checkActivePet('pet-2')
    expect(fresh.getSnapshot()).toBeNull()
  })

  it('lets the newest pull win: a slower in-flight pull for a previous pet never lands', async () => {
    let resolveSlow: ((share: PetPluginConfigShare | null) => void) | null = null
    const fetchShare = vi.fn((petId: string) => {
      if (petId === 'pet-slow') {
        return new Promise<PetPluginConfigShare | null>((resolve) => {
          resolveSlow = resolve
        })
      }
      return Promise.resolve(null)
    })
    const center = new SharedPetConfigCenter({
      fetchShare,
      getConfig: () => structuredClone(DEFAULT_CONFIG),
      storage: null,
    })

    const slowPull = center.checkActivePet('pet-slow')
    await center.checkActivePet('pet-fast') // user switched pets mid-pull
    resolveSlow!(SHARE)
    await slowPull

    expect(center.getSnapshot()).toBeNull() // the stale offer was dropped
  })

  it('an offer for a new pet replaces the previous one; a pet without a blob clears it', async () => {
    const storageMap = new Map<string, string>()
    const config = structuredClone(DEFAULT_CONFIG)
    const center = new SharedPetConfigCenter({
      fetchShare: vi.fn(async (petId: string) => (petId === 'pet-empty' ? null : SHARE)),
      getConfig: () => config,
      storage: {
        getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storageMap.set(key, value)
        },
      },
    })
    await center.checkActivePet('pet-1')
    expect(center.getSnapshot()?.petId).toBe('pet-1')
    await center.checkActivePet('pet-2')
    expect(center.getSnapshot()?.petId).toBe('pet-2')
    await center.checkActivePet('pet-empty')
    expect(center.getSnapshot()).toBeNull()
  })
})

describe('rewriteSharedAnimationIds / canonicalize units', () => {
  it('returns non-object blobs and remap-less calls untouched (same reference)', () => {
    expect(rewriteSharedAnimationIds('just-a-string', { a: 'b' })).toBe('just-a-string')
    expect(rewriteSharedAnimationIds(null, { a: 'b' })).toBe(null)
    const blob = { slideAnimationId: 'user:x' }
    expect(rewriteSharedAnimationIds(blob, undefined)).toBe(blob)
  })

  it('does not mutate the input blob while rewriting', () => {
    const blob = { slideAnimationId: 'user:old', bounceAnimation: { id: 'user:old-b' } }
    const rewritten = rewriteSharedAnimationIds(blob, { 'user:old': 'user:new', 'user:old-b': 'user:new-b' })
    expect(blob.slideAnimationId).toBe('user:old')
    expect(blob.bounceAnimation.id).toBe('user:old-b')
    expect(rewritten).toEqual({ slideAnimationId: 'user:new', bounceAnimation: { id: 'user:new-b' } })
  })

  it('canonicalize is key-order insensitive and type sensitive', () => {
    expect(canonicalize({ a: 1, b: [true, null] })).toBe(canonicalize({ b: [true, null], a: 1 }))
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }))
  })
})
