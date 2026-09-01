/**
 * client/api.ts — getPetweenAnimations parsing: the main plugin answers with
 * FULL AnimationDefinitions, and the card's dropdown filter depends on the
 * kind / repeat.mode extraction staying correct (and degrading safely when
 * metadata is missing).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPetPluginConfigShare, getPetweenAnimations } from '../../src/client/api'

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

describe('getPetPluginConfigShare', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads this plugin’s pocket off the pet record, sanitizing the remap', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        pet: {
          id: 'pet-1',
          name: '女仆',
          pluginConfigs: {
            'petween-physics': {
              config: { physics: { gravity: 5000 }, slideAnimationId: 'user:old' },
              animationIdRemap: { 'user:old': 'user:new', 'user:bad': 42 }, // non-string values drop out
            },
            'some-other-plugin': { config: { not: 'ours' } },
          },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const share = await getPetPluginConfigShare('pet-1', 'petween-physics')

    expect(fetchMock).toHaveBeenCalledWith('/api/petween/pets/pet-1', undefined)
    expect(share).toEqual({
      petName: '女仆',
      config: { physics: { gravity: 5000 }, slideAnimationId: 'user:old' },
      animationIdRemap: { 'user:old': 'user:new' },
    })
  })

  it('returns null when the pet record has no pluginConfigs field at all (old main plugin)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ pet: { id: 'pet-1', name: 'Legacy Pet' } })),
    )
    expect(await getPetPluginConfigShare('pet-1', 'petween-physics')).toBeNull()
  })

  it('returns null when our pocket is absent or malformed (no config field)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse({
          pet: {
            name: 'P',
            pluginConfigs: { 'petween-physics': { animationIdRemap: { a: 'b' } } }, // no config
          },
        }),
      ),
    )
    expect(await getPetPluginConfigShare('pet-1', 'petween-physics')).toBeNull()
  })

  it('falls back to the pet id when the record has no usable name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse({ pet: { pluginConfigs: { 'petween-physics': { config: { physics: { gravity: 5000 } } } } } }),
      ),
    )
    const share = await getPetPluginConfigShare('pet-1', 'petween-physics')
    expect(share?.petName).toBe('pet-1')
    expect(share?.animationIdRemap).toBeUndefined() // absent remap stays absent
  })
})
