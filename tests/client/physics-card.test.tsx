// @vitest-environment jsdom
/**
 * PhysicsCard tests: the settings.section card — group rendering, the
 * debounced auto-save (one PUT per edit burst, 300ms), the reset button, the
 * load-failure fallback (form on defaults + error line + retry re-adopting
 * the real config into an untouched fallback draft), and the
 * impact-animation dropdown sources (default + main-plugin customs + builtins
 * + the current unlisted value, in BOTH dropdowns), plus the slide-interrupt
 * toggle (disabled while 不播放; saves through the same debounce) and the §12
 * shared pet-config banner (summary render / 应用 applies + refreshes the
 * draft / 忽略 dismisses without saving / invalid blobs never show).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AnimationOption, PetPluginConfigShare } from '../../src/client/api'
import {
  DEFAULT_CONFIG,
  type PhysicsConfigPatch,
  type ThrowPhysicsPluginConfig,
} from '../../src/client/config'
import { PhysicsConfigHub } from '../../src/client/config-hub'
import { PhysicsCard } from '../../src/client/settings/PhysicsCard'
import { SharedPetConfigCenter } from '../../src/client/shared-pet-config'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let mounted: boolean

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

interface HubSeams {
  fetchConfig: Mock<() => Promise<{ config: ThrowPhysicsPluginConfig }>>
  sendConfig: Mock<(patch: PhysicsConfigPatch) => Promise<{ config: ThrowPhysicsPluginConfig }>>
}

const makeHub = (
  config: ThrowPhysicsPluginConfig = structuredClone(DEFAULT_CONFIG),
): { hub: PhysicsConfigHub; seams: HubSeams } => {
  const seams: HubSeams = {
    fetchConfig: vi.fn(async () => ({ config })),
    sendConfig: vi.fn(async (patch: PhysicsConfigPatch) => ({
      // Server-side merge semantics: the host validates and merges onto the
      // current config; the fake mirrors that closely enough for the card.
      config: {
        ...structuredClone(config),
        ...patch,
        physics: { ...config.physics, ...patch.physics },
      } as ThrowPhysicsPluginConfig,
    })),
  }
  return { hub: new PhysicsConfigHub(seams), seams }
}

const render = async (
  hub: PhysicsConfigHub,
  customs: AnimationOption[] = [],
  sharedCenter?: SharedPetConfigCenter,
): Promise<void> => {
  const fetchAnimations = vi.fn(async () => ({ customs, warnings: [] }))
  await act(async () => {
    root.render(<PhysicsCard hub={hub} fetchAnimations={fetchAnimations} sharedCenter={sharedCenter} />)
  })
}

/**
 * A SharedPetConfigCenter on test seams: the pull always answers `share`, the
 * current config comes from the rendered hub, and the handled-key bookkeeping
 * lands in an in-memory map instead of localStorage.
 */
const makeCenter = (
  share: PetPluginConfigShare | null,
  hub: PhysicsConfigHub,
): { center: SharedPetConfigCenter; fetchShare: Mock<(petId: string) => Promise<PetPluginConfigShare | null>> } => {
  const storageMap = new Map<string, string>()
  const fetchShare = vi.fn(async () => share)
  const center = new SharedPetConfigCenter({
    fetchShare,
    getConfig: () => hub.getSnapshot().config,
    storage: {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageMap.set(key, value)
      },
    },
  })
  return { center, fetchShare }
}

/** React reads controlled inputs through the native setter + 'input' event. */
const setInputValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const commitWithEnter = (input: HTMLInputElement): void => {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

const gravityInput = (): HTMLInputElement => {
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')
  if (input === null) throw new Error('gravity number field missing (first number input)')
  return input
}

const findButton = (text: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  if (button === undefined) throw new Error(`button "${text}" missing`)
  return button
}

/** The 滑动动画打断在播动画 toggle's checkbox. */
const slideInterruptCheckbox = (): HTMLInputElement => {
  const label = [...container.querySelectorAll('label')].find((l) => l.textContent?.includes('滑动动画打断'))
  const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (input === null || input === undefined) throw new Error('slide interrupt toggle missing')
  return input
}

describe('PhysicsCard', () => {
  it('renders the groups and current values after load; header shows 已保存', async () => {
    const { hub } = makeHub()
    await render(hub)
    expect(container.textContent).toContain('Petween Physics')
    expect(container.textContent).toContain('物理')
    expect(container.textContent).toContain('碰壁动画')
    expect(container.textContent).toContain('碰壁切图')
    expect(container.textContent).toContain('高级')
    expect(container.textContent).toContain('已保存')
    expect(gravityInput().value).toBe('3000')
    expect(container.textContent).toContain('本插件默认 · Physics Bounce Pop')
  })

  it('renders the ground-slide fields; picking a slide animation PUTs the id (null = 不播放)', async () => {
    const { hub, seams } = makeHub()
    await render(hub)
    expect(container.textContent).toContain('落地滑动')
    expect(container.textContent).toContain('最小反弹高度')
    expect(container.textContent).toContain('地面摩擦')

    const slideSelect = [...container.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.textContent === '不播放'),
    )
    if (slideSelect === undefined) throw new Error('slide animation select missing')
    expect(slideSelect.value).toBe('__none__') // DEFAULT slideAnimationId: null

    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('no native select value setter')
    act(() => {
      setter.call(slideSelect, 'builtin:click-wiggle')
      slideSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(seams.sendConfig).toHaveBeenCalledTimes(1)
    expect((seams.sendConfig.mock.calls[0]![0] as ThrowPhysicsPluginConfig).slideAnimationId).toBe(
      'builtin:click-wiggle',
    )
  })

  it('a number edit schedules ONE debounced PUT (300ms) carrying the full config', async () => {
    const { hub, seams } = makeHub()
    await render(hub)
    const input = gravityInput()
    act(() => setInputValue(input, '5000'))
    expect(seams.sendConfig).not.toHaveBeenCalled() // nothing before the debounce
    act(() => commitWithEnter(input))
    expect(container.textContent).toContain('待保存…')
    expect(seams.sendConfig).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(seams.sendConfig).toHaveBeenCalledTimes(1)
    const patch = seams.sendConfig.mock.calls[0]![0] as ThrowPhysicsPluginConfig
    expect(patch.physics.gravity).toBe(5000)
    expect(patch.sampleWindowMs).toBe(DEFAULT_CONFIG.sampleWindowMs) // full config, not a fragment
    expect(container.textContent).toContain('已保存')
  })

  it('unmount inside the debounce window flushes the pending edit instead of dropping it', async () => {
    const { hub, seams } = makeHub()
    await render(hub)
    const input = gravityInput()
    act(() => setInputValue(input, '7000'))
    act(() => commitWithEnter(input))
    expect(seams.sendConfig).not.toHaveBeenCalled() // still inside the window
    act(() => {
      root.unmount()
    })
    mounted = false // afterEach must not unmount again
    expect(seams.sendConfig).toHaveBeenCalledTimes(1)
    const flushed = seams.sendConfig.mock.calls[0]![0] as ThrowPhysicsPluginConfig
    expect(flushed.physics.gravity).toBe(7000)
  })

  it('rapid edits coalesce into one PUT for the final value', async () => {
    const { hub, seams } = makeHub()
    await render(hub)
    const input = gravityInput()
    act(() => setInputValue(input, '4000'))
    act(() => commitWithEnter(input))
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    act(() => setInputValue(input, '6000'))
    act(() => commitWithEnter(input))
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(seams.sendConfig).toHaveBeenCalledTimes(1)
    expect((seams.sendConfig.mock.calls[0]![0] as ThrowPhysicsPluginConfig).physics.gravity).toBe(6000)
  })

  it('恢复默认 PUTs the factory defaults immediately (no debounce) and resets the form', async () => {
    const edited = structuredClone(DEFAULT_CONFIG)
    edited.physics.gravity = 9000
    const { hub, seams } = makeHub(structuredClone(DEFAULT_CONFIG))
    await render(hub)
    // Edit something first so the reset visibly changes the form.
    const input = gravityInput()
    act(() => setInputValue(input, '9000'))
    act(() => commitWithEnter(input))
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect((seams.sendConfig.mock.calls[0]![0] as ThrowPhysicsPluginConfig).physics.gravity).toBe(9000)
    await act(async () => {
      findButton('恢复默认').click()
    })
    expect(seams.sendConfig).toHaveBeenCalledTimes(2)
    expect(seams.sendConfig.mock.calls[1]![0]).toEqual(DEFAULT_CONFIG)
    expect(gravityInput().value).toBe('3000')
  })

  it('a failed load renders the form on defaults plus the error line with a retry', async () => {
    let fail = true
    const seams: HubSeams = {
      fetchConfig: vi.fn(async () => {
        if (fail) throw new Error('offline')
        return { config: structuredClone(DEFAULT_CONFIG) }
      }),
      sendConfig: vi.fn(async (patch: PhysicsConfigPatch) => ({
        config: { ...structuredClone(DEFAULT_CONFIG), ...patch } as ThrowPhysicsPluginConfig,
      })),
    }
    const hub = new PhysicsConfigHub(seams)
    await render(hub)
    expect(container.textContent).toContain('配置加载失败')
    expect(container.textContent).toContain('offline')
    expect(gravityInput().value).toBe('3000') // DEFAULT fallback, still editable
    fail = false
    await act(async () => {
      findButton('重试').click()
    })
    expect(container.textContent).not.toContain('配置加载失败')
  })

  it('a successful retry re-adopts the real config into an untouched fallback draft (no default clobber on save)', async () => {
    const realConfig = structuredClone(DEFAULT_CONFIG)
    realConfig.physics.gravity = 2400
    realConfig.slideAnimationId = 'builtin:click-spin'
    let fail = true
    const seams: HubSeams = {
      fetchConfig: vi.fn(async () => {
        if (fail) throw new Error('offline')
        return { config: structuredClone(realConfig) }
      }),
      sendConfig: vi.fn(async (patch: PhysicsConfigPatch) => ({
        config: {
          ...structuredClone(realConfig),
          ...patch,
          physics: { ...realConfig.physics, ...patch.physics },
        } as ThrowPhysicsPluginConfig,
      })),
    }
    const hub = new PhysicsConfigHub(seams)
    await render(hub)
    expect(container.textContent).toContain('配置加载失败')
    expect(gravityInput().value).toBe('3000') // fallback defaults

    fail = false
    await act(async () => {
      findButton('重试').click()
    })
    expect(container.textContent).not.toContain('配置加载失败')
    expect(gravityInput().value).toBe('2400') // draft re-adopted the real config

    // A later edit must PUT the REAL values, never the fallback defaults.
    const input = gravityInput()
    act(() => setInputValue(input, '2600'))
    act(() => commitWithEnter(input))
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(seams.sendConfig).toHaveBeenCalledTimes(1)
    const patch = seams.sendConfig.mock.calls[0]![0] as ThrowPhysicsPluginConfig
    expect(patch.physics.gravity).toBe(2600)
    expect(patch.slideAnimationId).toBe('builtin:click-spin') // real field kept, not the DEFAULT null
  })

  it('an edited fallback draft is never clobbered by a later successful retry (user edits win)', async () => {
    const realConfig = structuredClone(DEFAULT_CONFIG)
    realConfig.physics.gravity = 2400
    let fail = true
    const seams: HubSeams = {
      fetchConfig: vi.fn(async () => {
        if (fail) throw new Error('offline')
        return { config: structuredClone(realConfig) }
      }),
      // Still offline for saves too: the edit stays local, loadError persists.
      sendConfig: vi.fn(async () => {
        throw new Error('still offline')
      }),
    }
    const hub = new PhysicsConfigHub(seams)
    await render(hub)
    expect(container.textContent).toContain('配置加载失败')

    // Edit the fallback draft while the load is broken.
    const input = gravityInput()
    act(() => setInputValue(input, '5000'))
    act(() => commitWithEnter(input))
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(seams.sendConfig).toHaveBeenCalledTimes(1)

    // The retry succeeds, but the draft keeps the user's edit over the real 2400.
    fail = false
    await act(async () => {
      findButton('重试').click()
    })
    expect(container.textContent).not.toContain('配置加载失败')
    expect(gravityInput().value).toBe('5000')
  })

  it('the slide dropdown shows an unlisted current value (hand-edited config), like the bounce dropdown', async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.slideAnimationId = 'user:old-slide' // e.g. a loop custom the filter drops
    const { hub } = makeHub(config)
    await render(hub)
    const slideSelect = [...container.querySelectorAll<HTMLSelectElement>('select')].find((select) =>
      [...select.options].some((option) => option.textContent === '不播放'),
    )
    if (slideSelect === undefined) throw new Error('slide animation select missing')
    expect(slideSelect.value).toBe('user:old-slide')
    const labels = [...slideSelect.options].map((option) => option.textContent ?? '')
    expect(labels.some((text) => text.includes('当前值') && text.includes('user:old-slide'))).toBe(true)
  })

  it('the slide-interrupt toggle is disabled while 不播放 (default), checked from the config', async () => {
    const { hub } = makeHub()
    await render(hub)
    const checkbox = slideInterruptCheckbox()
    expect(checkbox.checked).toBe(true) // DEFAULT slideInterrupt: true
    expect(checkbox.disabled).toBe(true) // slideAnimationId null = nothing to interrupt for
  })

  it('toggling slide interrupt schedules a debounced PUT carrying slideInterrupt', async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.slideAnimationId = 'builtin:click-wiggle'
    const { hub, seams } = makeHub(config)
    await render(hub)
    const checkbox = slideInterruptCheckbox()
    expect(checkbox.disabled).toBe(false)
    act(() => {
      checkbox.click() // React binds checkbox onChange to click
    })
    expect(seams.sendConfig).not.toHaveBeenCalled() // still inside the debounce
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(seams.sendConfig).toHaveBeenCalledTimes(1)
    const patch = seams.sendConfig.mock.calls[0]![0] as ThrowPhysicsPluginConfig
    expect(patch.slideInterrupt).toBe(false)
    expect(patch.slideAnimationId).toBe('builtin:click-wiggle') // full draft, not a fragment
  })

  it('the animation dropdown lists the default, main-plugin customs, builtins, and an unlisted current value', async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.bounceAnimation.id = 'user:weird-old'
    const { hub } = makeHub(config)
    await render(hub, [{ id: 'user:my-squash', name: 'My Squash', kind: 'interaction', repeatMode: 'once' }])
    const animationSelect = container.querySelectorAll<HTMLSelectElement>('select')[0]!
    const options = [...animationSelect.options].map((option) => option.textContent ?? '')
    expect(options.some((text) => text.includes('本插件默认'))).toBe(true)
    expect(options.some((text) => text.includes('My Squash') && text.includes('user:my-squash'))).toBe(true)
    expect(options.some((text) => text.includes('click-pop'))).toBe(true)
    expect(options.some((text) => text.includes('user:weird-old'))).toBe(true) // current unlisted
    expect(animationSelect.value).toBe('user:weird-old')
  })

  it('filters non-interaction / non-once customs out of BOTH dropdowns (loop plays would never settle)', async () => {
    const { hub } = makeHub()
    await render(hub, [
      { id: 'user:one-shot', name: 'One Shot', kind: 'interaction', repeatMode: 'once' },
      { id: 'user:looper', name: 'Looper', kind: 'interaction', repeatMode: 'loop' },
      { id: 'user:swayer', name: 'Swayer', kind: 'ambient', repeatMode: 'random-interval' },
      { id: 'user:no-meta', name: 'No Meta', kind: '', repeatMode: '' },
    ])
    const bounceSelect = container.querySelectorAll<HTMLSelectElement>('select')[0]!
    const bounceIds = [...bounceSelect.options].map((option) => option.value)
    expect(bounceIds).toContain('user:one-shot')
    expect(bounceIds).not.toContain('user:looper')
    expect(bounceIds).not.toContain('user:swayer')
    expect(bounceIds).not.toContain('user:no-meta') // unparsed metadata never reaches the list
    // The slide dropdown shares the same filtered list.
    const slideSelect = [...container.querySelectorAll<HTMLSelectElement>('select')].find((select) =>
      [...select.options].some((option) => option.textContent === '不播放'),
    )
    if (slideSelect === undefined) throw new Error('slide animation select missing')
    const slideIds = [...slideSelect.options].map((option) => option.value)
    expect(slideIds).toContain('user:one-shot')
    expect(slideIds).not.toContain('user:looper')
    expect(slideIds).not.toContain('user:swayer')
  })

  it('slider edits commit min-anchored step-quantized values (no float tails) and display at step precision', async () => {
    const { hub, seams } = makeHub()
    await render(hub)
    const restitution = container.querySelectorAll<HTMLInputElement>('input[type="range"]')[0]!
    expect(restitution).toBeDefined() // 弹性系数: min 0, max 1, step 0.05
    act(() => setInputValue(restitution, '0.123456'))
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(seams.sendConfig).toHaveBeenCalledTimes(1)
    expect((seams.sendConfig.mock.calls[0]![0] as ThrowPhysicsPluginConfig).physics.restitution).toBe(0.1)
    // Display formats at step precision (0.05 → two decimals), never a raw tail.
    expect(restitution.parentElement!.textContent).toContain('0.10')
  })

  it('a failed main-plugin animations read leaves the static lists (no crash)', async () => {
    const { hub } = makeHub()
    const fetchAnimations = vi.fn(async () => {
      throw new Error('main plugin absent')
    })
    await act(async () => {
      root.render(<PhysicsCard hub={hub} fetchAnimations={fetchAnimations} />)
    })
    const animationSelect = container.querySelectorAll<HTMLSelectElement>('select')[0]!
    const options = [...animationSelect.options].map((option) => option.textContent ?? '')
    expect(options.some((text) => text.includes('本插件默认'))).toBe(true)
    expect(options.some((text) => text.includes('click-pop'))).toBe(true)
  })

  it('shows the §12 shared-config banner with a change summary; 应用 PUTs the blob and refreshes the draft', async () => {
    const { hub, seams } = makeHub()
    const share: PetPluginConfigShare = {
      petName: '女仆',
      config: { physics: { gravity: 5000, restitution: 0.9 }, slideAnimationId: 'builtin:click-wiggle' },
    }
    const { center } = makeCenter(share, hub)
    await render(hub, [], center)
    await act(async () => {
      await center.checkActivePet('pet-1')
    })

    expect(container.textContent).toContain('宠物「女仆」分享了物理配置')
    expect(container.textContent).toContain('重力加速度:3000 → 5000')
    expect(container.textContent).toContain('弹性系数:0.6 → 0.9')
    expect(container.textContent).toContain('滑动动画:不播放 → builtin:click-wiggle')
    expect(seams.sendConfig).not.toHaveBeenCalled() // nothing before the user confirms

    await act(async () => {
      findButton('应用').click()
    })
    expect(seams.sendConfig).toHaveBeenCalledTimes(1)
    const patch = seams.sendConfig.mock.calls[0]![0] as PhysicsConfigPatch
    expect(patch.physics).toEqual({ gravity: 5000, restitution: 0.9 }) // the blob verbatim, host merges
    expect(patch.slideAnimationId).toBe('builtin:click-wiggle')
    expect(container.textContent).not.toContain('分享了物理配置') // dismissed after a successful apply
    expect(gravityInput().value).toBe('5000') // the draft adopted the server-merged config
  })

  it('忽略 dismisses the offer without saving, and the same blob never re-prompts', async () => {
    const { hub, seams } = makeHub()
    const share: PetPluginConfigShare = { petName: '女仆', config: { physics: { gravity: 5000 } } }
    const { center, fetchShare } = makeCenter(share, hub)
    await render(hub, [], center)
    await act(async () => {
      await center.checkActivePet('pet-1')
    })
    expect(container.textContent).toContain('分享了物理配置')

    await act(async () => {
      findButton('忽略').click()
    })
    expect(seams.sendConfig).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('分享了物理配置')

    // A different pet carrying the SAME content: the handled key still silences it.
    await act(async () => {
      await center.checkActivePet('pet-2')
    })
    expect(fetchShare).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('分享了物理配置')
  })

  it('an invalid shared blob never reaches the banner (nothing to apply, no PUT)', async () => {
    const { hub, seams } = makeHub()
    // gravity 5 is below the CONFIG_NUMERIC_FIELDS minimum of 100.
    const { center } = makeCenter({ petName: '坏包', config: { physics: { gravity: 5 } } }, hub)
    await render(hub, [], center)
    await act(async () => {
      await center.checkActivePet('pet-1')
    })
    expect(center.getSnapshot()).toBeNull()
    expect(container.textContent).not.toContain('分享了物理配置')
    expect(seams.sendConfig).not.toHaveBeenCalled()
  })
})
