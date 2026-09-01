// @vitest-environment jsdom
/**
 * Client entry tests: the cordis apply() wiring — the petween/client service
 * version guard, the boot-time resyncAnimations nudge, the settings.section
 * slot registration, the visibilitychange → settleIfHidden lease safety
 * net with its dispose-time cleanup, and the §12 shared pet-config pull
 * triggers (boot after hub load + active-pet change, both gated on a loaded
 * hub), plus the §12 P3 export-time config provider registration. The
 * ThrowController, the config hub and the shared-config center are
 * mocked: the wiring, not them, is under test here.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_CONFIG, type ThrowPhysicsPluginConfig } from '../../src/client/config'
import { apply } from '../../src/client/index'
import type { PetweenClientService, StageSnapshot } from '../../src/client/types'

interface FakeController {
  settleIfHidden: Mock<() => void>
  dispose: Mock<() => void>
  options: unknown
}

const mocks = vi.hoisted(() => ({
  controllers: [] as FakeController[],
  hubLoad: vi.fn<() => Promise<unknown>>(async () => ({})),
  hubGetSnapshot: vi.fn(() => ({ loaded: false }) as { loaded: boolean }),
  // Self-contained default: vi.hoisted runs before the imports above land.
  hubGetConfig: vi.fn(() => ({ from: 'hub' }) as unknown as ThrowPhysicsPluginConfig),
  checkActivePet: vi.fn(),
}))

vi.mock('../../src/client/throw-controller', () => ({
  ThrowController: class {
    readonly settleIfHidden = vi.fn()
    readonly dispose = vi.fn()
    constructor(readonly options: unknown) {
      mocks.controllers.push(this as unknown as FakeController)
    }
  },
}))

vi.mock('../../src/client/config-hub', () => ({
  // PhysicsCard imports the class as a type; the mock still needs the binding.
  PhysicsConfigHub: class {},
  physicsConfigHub: { load: mocks.hubLoad, getSnapshot: mocks.hubGetSnapshot, getConfig: mocks.hubGetConfig },
}))

vi.mock('../../src/client/shared-pet-config', () => ({
  PLUGIN_ID: 'petween-physics',
  SharedPetConfigCenter: class {},
  sharedPetConfigCenter: { checkActivePet: mocks.checkActivePet },
}))

type FakeService = PetweenClientService & {
  resyncAnimations: Mock<() => Promise<void>>
  registerSharedPluginConfigProvider: Mock<(pluginId: string, provider: () => unknown) => () => void>
}

const makeService = (): FakeService => ({
  version: 1,
  getStageSnapshot: vi.fn(() => null),
  subscribeStage: vi.fn(() => () => {}),
  subscribeUserDrag: vi.fn(() => () => {}),
  requestPositionControl: vi.fn(() => null),
  playAnimation: vi.fn(() => null),
  flashPose: vi.fn(() => false),
  resyncAnimations: vi.fn(async () => {}),
  registerSharedPluginConfigProvider: vi.fn(() => () => {}),
})

const makeCtx = (service: unknown) => {
  const disposeInject = vi.fn()
  const disposeRegister = vi.fn()
  const slots = {
    inject: vi.fn((_name: string, loader: () => unknown) => {
      loader() // run the registration callback: it IS part of the wiring
      return disposeInject
    }),
    register: vi.fn((_options: unknown, _component: unknown) => disposeRegister),
  }
  const ctx = { 'petween/client': service, slots } as unknown as ClientContext
  return { ctx, slots, disposeInject, disposeRegister }
}

describe('client entry apply()', () => {
  beforeEach(() => {
    mocks.controllers.length = 0
    mocks.hubLoad.mockClear()
    mocks.hubGetSnapshot.mockReturnValue({ loaded: false })
    mocks.hubGetConfig.mockReset().mockReturnValue({ from: 'hub' } as unknown as ThrowPhysicsPluginConfig)
    mocks.checkActivePet.mockClear()
  })

  it('boots the controller, shares one hub load, nudges resyncAnimations once, registers the settings card', () => {
    const service = makeService()
    const { ctx, slots } = makeCtx(service)
    const dispose = apply(ctx)

    expect(typeof dispose).toBe('function')
    expect(mocks.hubLoad).toHaveBeenCalledTimes(1)
    expect(service.resyncAnimations).toHaveBeenCalledTimes(1)
    expect(mocks.controllers).toHaveLength(1)
    expect(slots.inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(slots.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'settings.section', id: 'petween-physics', order: 135 }),
      expect.any(Function),
    )
  })

  it('settles the controller on visibilitychange; dispose removes the listener and cleans up', () => {
    const { ctx, disposeInject } = makeCtx(makeService())
    const dispose = apply(ctx)
    if (dispose === undefined) throw new Error('apply returned no dispose')
    const controller = mocks.controllers[0]!

    document.dispatchEvent(new Event('visibilitychange'))
    expect(controller.settleIfHidden).toHaveBeenCalledTimes(1)

    dispose()
    expect(controller.dispose).toHaveBeenCalledTimes(1)
    expect(disposeInject).toHaveBeenCalledTimes(1)

    document.dispatchEvent(new Event('visibilitychange'))
    expect(controller.settleIfHidden).toHaveBeenCalledTimes(1) // listener gone
  })

  it('boots fine against an older provider without resyncAnimations (optional widening)', () => {
    const service = makeService() as Partial<FakeService>
    delete service.resyncAnimations
    const dispose = apply(makeCtx(service).ctx)
    expect(typeof dispose).toBe('function')
    expect(mocks.controllers).toHaveLength(1)
  })

  it('swallows a failed resyncAnimations (the regular poll stays in charge)', async () => {
    const service = makeService()
    service.resyncAnimations.mockRejectedValue(new Error('fetch down'))
    apply(makeCtx(service).ctx)
    expect(service.resyncAnimations).toHaveBeenCalledTimes(1)
    // Flush the rejected chain through the entry's .catch; an unhandled
    // rejection here fails the file.
    await Promise.resolve()
    await Promise.resolve()
  })

  it('stays loaded-but-idle when the service is missing or version-incompatible', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { ctx, slots } = makeCtx({ version: 2 })
      expect(apply(ctx)).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(mocks.hubLoad).not.toHaveBeenCalled()
      expect(slots.inject).not.toHaveBeenCalled()
      expect(mocks.controllers).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('pulls the shared pet config once after the boot hub load (the boot activePetId)', async () => {
    mocks.hubGetSnapshot.mockReturnValue({ loaded: true })
    const service = makeService()
    service.getStageSnapshot = vi.fn(() => ({ activePetId: 'pet-a' }) as unknown as StageSnapshot)
    apply(makeCtx(service).ctx)
    // Flush the hub.load().then(...) chain that issues the boot pull.
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.checkActivePet).toHaveBeenCalledTimes(1)
    expect(mocks.checkActivePet).toHaveBeenCalledWith('pet-a')
  })

  it('re-pulls when the stage subscription reports a new active pet; undefined/null stay silent', () => {
    mocks.hubGetSnapshot.mockReturnValue({ loaded: true })
    const service = makeService()
    let stageListener: ((snapshot: StageSnapshot | null) => void) | undefined
    service.subscribeStage = vi.fn((listener: (snapshot: StageSnapshot | null) => void) => {
      stageListener = listener
      return () => {}
    })
    apply(makeCtx(service).ctx)
    if (stageListener === undefined) throw new Error('stage listener not registered')
    const push = stageListener

    push({ activePetId: 'pet-b' } as unknown as StageSnapshot) // active pet changed
    expect(mocks.checkActivePet).toHaveBeenCalledTimes(1)
    expect(mocks.checkActivePet).toHaveBeenCalledWith('pet-b')

    push({ activePetId: null } as unknown as StageSnapshot) // no active pet
    push({} as unknown as StageSnapshot) // provider predates the additive field
    push(null) // no session
    expect(mocks.checkActivePet).toHaveBeenCalledTimes(1)
  })

  it('does not pull before the hub load lands (the DEFAULT fallback must not drive the no-op check)', async () => {
    // beforeEach default: hubGetSnapshot → { loaded: false }
    const service = makeService()
    service.getStageSnapshot = vi.fn(() => ({ activePetId: 'pet-a' }) as unknown as StageSnapshot)
    apply(makeCtx(service).ctx)
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.checkActivePet).not.toHaveBeenCalled()
  })

  it('dispose unsubscribes the stage watcher', () => {
    const service = makeService()
    const unsubscribe = vi.fn()
    service.subscribeStage = vi.fn(() => unsubscribe)
    const dispose = apply(makeCtx(service).ctx)
    if (dispose === undefined) throw new Error('apply returned no dispose')
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('registers the §12 export config provider once the boot hub load lands; dispose unregisters', async () => {
    mocks.hubGetSnapshot.mockReturnValue({ loaded: true })
    const current = structuredClone(DEFAULT_CONFIG)
    mocks.hubGetConfig.mockReturnValue(current)
    const service = makeService()
    const unregister = vi.fn()
    service.registerSharedPluginConfigProvider.mockReturnValue(unregister)
    const dispose = apply(makeCtx(service).ctx)
    if (dispose === undefined) throw new Error('apply returned no dispose')
    // Flush the hub.load().then(...) chain that performs the registration.
    await Promise.resolve()
    await Promise.resolve()

    expect(service.registerSharedPluginConfigProvider).toHaveBeenCalledTimes(1)
    expect(service.registerSharedPluginConfigProvider).toHaveBeenCalledWith('petween-physics', expect.any(Function))
    const provider = service.registerSharedPluginConfigProvider.mock.calls[0]![1]
    const served = provider()
    expect(served).toEqual(current)
    expect(served).not.toBe(current) // a clone: export must not observe later live mutations

    dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('stays silent against an older provider without registerSharedPluginConfigProvider (optional widening)', async () => {
    mocks.hubGetSnapshot.mockReturnValue({ loaded: true })
    const service = makeService() as Partial<FakeService>
    delete service.registerSharedPluginConfigProvider
    const dispose = apply(makeCtx(service).ctx)
    expect(typeof dispose).toBe('function')
    await Promise.resolve()
    await Promise.resolve()
    expect(() => dispose!()).not.toThrow()
  })

  it('does not register the provider while the hub is not loaded (a failed boot load stays silent)', async () => {
    // beforeEach default: hubGetSnapshot → { loaded: false }
    const service = makeService()
    apply(makeCtx(service).ctx)
    await Promise.resolve()
    await Promise.resolve()
    expect(service.registerSharedPluginConfigProvider).not.toHaveBeenCalled()
  })

  it('a dispose before the boot load lands keeps the provider unregistered', async () => {
    mocks.hubGetSnapshot.mockReturnValue({ loaded: true })
    let resolveLoad!: (value: unknown) => void
    // Once-only: later tests keep the hoisted default implementation.
    mocks.hubLoad.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
    )
    const service = makeService()
    const dispose = apply(makeCtx(service).ctx)
    if (dispose === undefined) throw new Error('apply returned no dispose')
    dispose()
    resolveLoad({})
    await Promise.resolve()
    await Promise.resolve()
    expect(service.registerSharedPluginConfigProvider).not.toHaveBeenCalled()
  })

  it('a throwing registerSharedPluginConfigProvider stays silent and does not break the boot pull', async () => {
    mocks.hubGetSnapshot.mockReturnValue({ loaded: true })
    const service = makeService()
    service.registerSharedPluginConfigProvider.mockImplementation(() => {
      throw new Error('broken provider method')
    })
    service.getStageSnapshot = vi.fn(() => ({ activePetId: 'pet-a' }) as unknown as StageSnapshot)
    apply(makeCtx(service).ctx)
    await Promise.resolve()
    await Promise.resolve()
    expect(service.registerSharedPluginConfigProvider).toHaveBeenCalledTimes(1)
    expect(mocks.checkActivePet).toHaveBeenCalledWith('pet-a') // the pull survived
  })
})
