/**
 * client/api.ts — getPetweenAnimations parsing: the main plugin answers with
 * FULL AnimationDefinitions, and the card's dropdown filter depends on the
 * kind / repeat.mode extraction staying correct (and degrading safely when
 * metadata is missing).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPetweenAnimations } from '../../src/client/api'

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('getPetweenAnimations', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extracts kind and repeat.mode as repeatMode from full AnimationDefinitions', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        customs: [
          { id: 'user:pop', name: 'Pop', kind: 'interaction', repeat: { mode: 'once' } },
          {
            id: 'user:sway',
            name: 'Sway',
            kind: 'ambient',
            repeat: { mode: 'random-interval', minDelayMs: 800, maxDelayMs: 1300 },
          },
        ],
        warnings: ['one stale asset'],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { customs, warnings } = await getPetweenAnimations()

    expect(fetchMock).toHaveBeenCalledWith('/api/petween/animations', undefined)
    expect(customs).toEqual([
      { id: 'user:pop', name: 'Pop', kind: 'interaction', repeatMode: 'once' },
      { id: 'user:sway', name: 'Sway', kind: 'ambient', repeatMode: 'random-interval' },
    ])
    expect(warnings).toEqual(['one stale asset'])
  })

  it('degrades missing kind/repeat metadata to empty strings (the card filter keeps those out)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ customs: [{ id: 'user:legacy', name: 'Legacy' }], warnings: [] })),
    )

    const { customs } = await getPetweenAnimations()

    expect(customs).toEqual([{ id: 'user:legacy', name: 'Legacy', kind: '', repeatMode: '' }])
  })
})
