/**
 * pose-collision-bounds.test.ts — the (petId, poseKey) → alpha-bounds
 * pipeline over injected seams: pose→asset mapping off the pet record,
 * asset→URL construction, pet-record in-flight dedupe and per-ask freshness,
 * and the never-reject contract every consumer relies on.
 */
import { describe, expect, it, vi } from 'vitest'
import type { NormalizedAlphaBounds } from '../../src/client/alpha-bounds'
import { createPoseCollisionBoundsProvider } from '../../src/client/pose-collision-bounds'

const TIGHT: NormalizedAlphaBounds = { left: 0.2, top: 0.1, right: 0.05, bottom: 0.15 }

type FetchPoseAssets = (petId: string) => Promise<Record<string, string> | null>
type ScanImage = (url: string, threshold: number) => Promise<NormalizedAlphaBounds | null>

const makeProvider = (fetchPoseAssets: FetchPoseAssets, scanImage: ScanImage = async () => TIGHT) =>
  createPoseCollisionBoundsProvider({ fetchPoseAssets, getThreshold: () => 1, scanImage })

describe('createPoseCollisionBoundsProvider', () => {
  it('maps poseKey → assetId → /petween-assets/<id> → scan, and passes bounds through', async () => {
    const fetchPoseAssets = vi.fn(async () => ({ idle: 'a1' }))
    const scanImage = vi.fn(async () => TIGHT)
    const provider = makeProvider(fetchPoseAssets, scanImage)
    await expect(provider('pet-1', 'idle')).resolves.toEqual(TIGHT)
    expect(fetchPoseAssets).toHaveBeenCalledWith('pet-1')
    expect(scanImage).toHaveBeenCalledWith('/petween-assets/a1', 1)
  })

  it('a pose without an asset answers null without scanning', async () => {
    const fetchPoseAssets = vi.fn(async () => ({ idle: 'a1' }))
    const scanImage = vi.fn(async () => TIGHT)
    const provider = makeProvider(fetchPoseAssets, scanImage)
    await expect(provider('pet-1', 'working')).resolves.toBeNull()
    expect(scanImage).not.toHaveBeenCalled()
  })

  it('never rejects: a failed record fetch or scan answers null', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('network down')
    })
    await expect(makeProvider(failingFetch)('pet-1', 'idle')).resolves.toBeNull()
    const rejectingScan = vi.fn(async () => {
      throw new Error('canvas tainted')
    })
    const provider = makeProvider(vi.fn(async () => ({ idle: 'a1' })), rejectingScan)
    await expect(provider('pet-1', 'idle')).resolves.toBeNull()
  })

  it('empty pet or pose identifiers answer null without any fetch', async () => {
    const fetchPoseAssets = vi.fn()
    const provider = makeProvider(fetchPoseAssets)
    await expect(provider('', 'idle')).resolves.toBeNull()
    await expect(provider('pet-1', '')).resolves.toBeNull()
    expect(fetchPoseAssets).not.toHaveBeenCalled()
  })

  it('dedupes concurrent pet-record fetches, but re-fetches on the next ask (freshness)', async () => {
    // The first fetch is gated by hand (to hold two callers in flight);
    // every later fetch resolves at once.
    let releaseFirst: ((value: Record<string, string> | null) => void) | undefined
    let first = true
    const fetchPoseAssets = vi.fn((): Promise<Record<string, string> | null> => {
      if (!first) return Promise.resolve({ idle: 'a1' })
      first = false
      return new Promise((resolve) => {
        releaseFirst = resolve
      })
    })
    const provider = makeProvider(fetchPoseAssets)
    const firstCall = provider('pet-1', 'idle')
    const secondCall = provider('pet-1', 'idle') // in flight → shares the fetch
    releaseFirst?.({ idle: 'a1' })
    await Promise.all([firstCall, secondCall])
    expect(fetchPoseAssets).toHaveBeenCalledTimes(1)
    await provider('pet-1', 'idle') // settled → a fresh ask re-reads the record
    expect(fetchPoseAssets).toHaveBeenCalledTimes(2)
  })

  it('the scan cache spans pets: two pets sharing an asset scan once', async () => {
    const fetchPoseAssets = vi.fn(async (petId: string) => ({ idle: petId === 'pet-1' ? 'shared' : 'shared' }))
    const scanImage = vi.fn(async () => TIGHT)
    const provider = makeProvider(fetchPoseAssets, scanImage)
    await provider('pet-1', 'idle')
    await provider('pet-2', 'idle')
    expect(fetchPoseAssets).toHaveBeenCalledTimes(2)
    expect(scanImage).toHaveBeenCalledTimes(1) // same URL, one scan
  })
})
