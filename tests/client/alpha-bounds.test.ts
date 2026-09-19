/**
 * alpha-bounds.test.ts — the pure visible-pixel scanner and the URL cache
 * around it. The DOM raster (Image + canvas) is entry wiring and stays
 * untested, like every other environment seam; everything computable is
 * pinned here over synthetic RGBA buffers and an injected scanImage.
 */
import { describe, expect, it, vi } from 'vitest'
import { computeAlphaBounds, createAlphaBoundsScanner, type NormalizedAlphaBounds } from '../../src/client/alpha-bounds'

/** Build an RGBA buffer where only the listed cells reach `alpha`. */
const pixels = (width: number, height: number, cells: ReadonlyArray<readonly [number, number]>, alpha = 255) => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y] of cells) data[(y * width + x) * 4 + 3]! = alpha
  return { data, width, height }
}

describe('computeAlphaBounds', () => {
  it('a fully opaque image has zero margins on every side', () => {
    expect(computeAlphaBounds(pixels(3, 2, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]), 1)).toEqual({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    })
  })

  it('a centered body in a 4×4 image leaves 0.25 transparent margins', () => {
    const center = [[1, 1], [2, 1], [1, 2], [2, 2]] as const
    expect(computeAlphaBounds(pixels(4, 4, center), 1)).toEqual({
      left: 0.25,
      top: 0.25,
      right: 0.25,
      bottom: 0.25,
    })
  })

  it('an L-shaped pose yields the bounding box of the whole L, not per-limb boxes', () => {
    // Column x=0 full height plus the bottom row y=3: touches all four edges.
    const l = [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3], [2, 3], [3, 3]] as const
    expect(computeAlphaBounds(pixels(4, 4, l), 1)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })

  it('disjoint blobs union into one box (a pixel at each corner)', () => {
    const corners = [[0, 0], [3, 0], [0, 3], [3, 3]] as const
    expect(computeAlphaBounds(pixels(4, 4, corners), 1)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })

  it('margins are asymmetric when the body hugs one side', () => {
    // Cells at x∈[2,3], y∈[0,1] in a 4×4: left 0.5, top 0, right 0, bottom 0.5.
    const cells = [[2, 0], [3, 0], [2, 1], [3, 1]] as const
    expect(computeAlphaBounds(pixels(4, 4, cells), 1)).toEqual({ left: 0.5, top: 0, right: 0, bottom: 0.5 })
  })

  it('a fully transparent image answers null (fallback, not an empty box)', () => {
    expect(computeAlphaBounds(pixels(4, 4, []), 1)).toBeNull()
  })

  it('a 1×1 image degenerates to zero margins or null', () => {
    expect(computeAlphaBounds(pixels(1, 1, [[0, 0]]), 1)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(computeAlphaBounds(pixels(1, 1, []), 1)).toBeNull()
  })

  it('threshold: alpha ≥ threshold counts; below is transparent', () => {
    const faint = pixels(4, 4, [[2, 2]], 1)
    expect(computeAlphaBounds(faint, 1)).toEqual({ left: 0.5, top: 0.5, right: 0.25, bottom: 0.25 })
    expect(computeAlphaBounds(faint, 2)).toBeNull() // the only pixel no longer counts
    // Alpha 0 never counts regardless of threshold.
    expect(computeAlphaBounds(pixels(2, 2, [[0, 0], [1, 1]], 0), 1)).toBeNull()
  })
})

describe('createAlphaBoundsScanner', () => {
  const bounds = (left: number): NormalizedAlphaBounds => ({ left, top: 0, right: 0, bottom: 0 })

  it('scans once per (url, threshold) and dedupes in-flight callers', async () => {
    const scanImage = vi.fn(async () => bounds(0.1))
    const scanner = createAlphaBoundsScanner({ getThreshold: () => 1, scanImage })
    const [a, b] = await Promise.all([scanner('/petween-assets/a1'), scanner('/petween-assets/a1')])
    expect(a).toEqual(bounds(0.1))
    expect(b).toEqual(bounds(0.1))
    await scanner('/petween-assets/a1')
    expect(scanImage).toHaveBeenCalledTimes(1)
    expect(scanImage).toHaveBeenCalledWith('/petween-assets/a1', 1)
  })

  it('a different threshold or URL rescans; the threshold is read at scan time', async () => {
    let threshold = 1
    const scanImage = vi.fn(async () => bounds(0.2))
    const scanner = createAlphaBoundsScanner({ getThreshold: () => threshold, scanImage })
    await scanner('/petween-assets/a1')
    await scanner('/petween-assets/a1') // cached
    threshold = 16
    await scanner('/petween-assets/a1') // new threshold → rescan
    await scanner('/petween-assets/b2') // new url
    expect(scanImage).toHaveBeenCalledTimes(3)
    expect(scanImage).toHaveBeenLastCalledWith('/petween-assets/b2', 16)
  })

  it('failures resolve null AND free the cache slot for a retry', async () => {
    let calls = 0
    const scanImage = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('image load failed')
      return bounds(0.3)
    })
    const scanner = createAlphaBoundsScanner({ getThreshold: () => 1, scanImage })
    await expect(scanner('/petween-assets/a1')).resolves.toBeNull()
    await expect(scanner('/petween-assets/a1')).resolves.toEqual(bounds(0.3))
    expect(scanImage).toHaveBeenCalledTimes(2)
  })
})
