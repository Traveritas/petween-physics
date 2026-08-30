// @vitest-environment jsdom
/**
 * Client entry tests: the cordis apply() wiring — the petween/client service
 * version guard, the boot-time resyncAnimations nudge, the settings.section
 * slot registration, and the visibilitychange → settleIfHidden lease safety
 * net with its dispose-time cleanup. The ThrowController and the config hub
 * are mocked: the wiring, not the controller, is under test here.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { apply } from '../../src/client/index'
import type { PetweenClientService } from '../../src/client/types'

interface FakeController {
  settleIfHidden: Mock<() => void>
  dispose: Mock<() => void>
  options: unknown
}

const mocks = vi.hoisted(() => ({
  controllers: [] as FakeController[],
  hubLoad: vi.fn<() => Promise<unknown>>(async () => ({})),
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
  physicsConfigHub: { load: mocks.hubLoad },
}))

type FakeService = PetweenClientService & { resyncAnimations: Mock<() => Promise<void>> }

const makeService = (): FakeService => ({
  version: 1,
  getStageSnapshot: vi.fn(() => null),
  subscribeStage: vi.fn(() => () => {}),
  subscribeUserDrag: vi.fn(() => () => {}),
  requestPositionControl: vi.fn(() => null),
  playAnimation: vi.fn(() => null),
  flashPose: vi.fn(() => false),
  resyncAnimations: vi.fn(async () => {}),
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
})
