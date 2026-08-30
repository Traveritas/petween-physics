/**
 * throw-controller.test.ts — the orchestrator over a fake petween
 * service, with a manual clock and a manual frame pump.
 *
 * What is pinned here:
 * - the lease discipline (no lease while idle/sampling; commit+release on
 *   settle; bare release when interrupted);
 * - the user's hand always wins (drag start aborts a flight);
 * - wall effects fire once per wall inside the debounce window, and re-arm
 *   once the window has elapsed;
 * - session loss and dispose clean everything up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONFIG,
  type BounceAnimationConfig,
  type FlashPoseConfig,
  type PhysicsConfig,
  type ThrowPhysicsPluginConfig,
} from '../../src/client/config'
import { ThrowController, type ThrowControllerDeps } from '../../src/client/throw-controller'
import type { PetweenClientService, PositionDriver, StageSnapshot } from '../../src/client/types'

class FakeDriver implements PositionDriver {
  readonly applyCalls: Array<{ x: number; y: number }> = []
  applyResult = true
  commits = 0
  releases = 0
  /** M5a: every lease call in order ('apply'/'commit'/'release'). */
  readonly calls: string[] = []
  /** Set to make commit() reject (the M5a failure path). */
  commitError: Error | null = null
  /** Set to make commit() never settle (the 20s safety-valve path). */
  hangCommit = false
  private readonly dragListeners = new Set<(phase: 'start' | 'end') => void>()

  apply(x: number, y: number): boolean {
    this.applyCalls.push({ x, y })
    this.calls.push('apply')
    return this.applyResult
  }

  commit(): Promise<void> {
    this.commits += 1
    this.calls.push('commit')
    if (this.hangCommit) return new Promise<void>(() => {})
    return this.commitError === null ? Promise.resolve() : Promise.reject(this.commitError)
  }

  release(): void {
    this.releases += 1
    this.calls.push('release')
  }

  onUserDrag(listener: (phase: 'start' | 'end') => void): () => void {
    this.dragListeners.add(listener)
    return () => {
      this.dragListeners.delete(listener)
    }
  }

  /** Simulate a driver-level drag phase (defaults to the user-grab 'start'). */
  emitUserDrag(phase: 'start' | 'end' = 'start'): void {
    for (const listener of [...this.dragListeners]) listener(phase)
  }
}

class FakeService {
  snapshot: StageSnapshot | null = null
  grantLease = true
  leaseRequests = 0
  readonly drivers: FakeDriver[] = []
  readonly plays: Array<{ id: string; options: { interrupt: boolean } | undefined }> = []
  readonly flashes: Array<{ poseKey: string; holdMs: number }> = []
  readonly stageUnsubscribed: number[] = []
  readonly dragUnsubscribed: number[] = []
  private readonly stageListeners = new Set<(snapshot: StageSnapshot | null) => void>()
  private readonly dragListeners = new Set<(phase: 'start' | 'end') => void>()
  private stageSubscriptions = 0
  private dragSubscriptions = 0

  readonly service: PetweenClientService = {
    version: 1,
    getStageSnapshot: () => this.snapshot,
    subscribeStage: (listener) => {
      this.stageSubscriptions += 1
      this.stageListeners.add(listener)
      listener(this.snapshot)
      return () => {
        this.stageUnsubscribed.push(this.stageSubscriptions)
        this.stageListeners.delete(listener)
      }
    },
    subscribeUserDrag: (listener) => {
      this.dragSubscriptions += 1
      this.dragListeners.add(listener)
      return () => {
        this.dragUnsubscribed.push(this.dragSubscriptions)
        this.dragListeners.delete(listener)
      }
    },
    requestPositionControl: () => {
      this.leaseRequests += 1
      if (!this.grantLease || this.snapshot === null) return null
      const driver = new FakeDriver()
      this.drivers.push(driver)
      return driver
    },
    playAnimation: (id, options) => {
      this.plays.push({ id, options: options as { interrupt: boolean } | undefined })
      return {}
    },
    flashPose: (poseKey, holdMs) => {
      this.flashes.push({ poseKey, holdMs })
      return true
    },
  }

  pushStage(snapshot: StageSnapshot | null): void {
    this.snapshot = snapshot
    for (const listener of [...this.stageListeners]) listener(snapshot)
  }

  emitDrag(phase: 'start' | 'end'): void {
    for (const listener of [...this.dragListeners]) listener(phase)
  }
}

interface Harness {
  service: FakeService
  controller: ThrowController
  clock: { value: number }
  hidden: { value: boolean }
  /** Swap the live config (simulates a settings-card save landing). */
  setConfig: (next: ThrowPhysicsPluginConfig) => void
  pumpFrames: (times?: number) => void
}

const VIEWPORT = { width: 1000, height: 800 }

const snapshotAt = (x: number, y: number, overrides: Partial<StageSnapshot> = {}): StageSnapshot => ({
  x,
  y,
  scale: 1,
  stageSize: 100, // bounding box 100px: walls at x∈[0,900], y∈[0,700]
  visualState: 'idle',
  activityMode: null,
  started: true,
  ...overrides,
})

/** Let the settle path's async commit+release chain run out. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let consoleWarn: ReturnType<typeof vi.spyOn> | undefined

beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  consoleWarn?.mockRestore()
})

/** Test overrides merge over the defaults at every level (partial physics etc.). */
interface HarnessOverrides {
  physics?: Partial<PhysicsConfig>
  bounceAnimation?: Partial<BounceAnimationConfig>
  flashPose?: Partial<FlashPoseConfig>
  slideAnimationId?: string | null
  slideInterrupt?: boolean
  sampleWindowMs?: number
  effectDebounceMs?: number
  applyFalseTolerance?: number
}

const makeHarness = (configOverrides: HarnessOverrides = {}): Harness => {
  const service = new FakeService()
  let config: ThrowPhysicsPluginConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    sampleWindowMs: configOverrides.sampleWindowMs ?? DEFAULT_CONFIG.sampleWindowMs,
    effectDebounceMs: configOverrides.effectDebounceMs ?? DEFAULT_CONFIG.effectDebounceMs,
    applyFalseTolerance: configOverrides.applyFalseTolerance ?? DEFAULT_CONFIG.applyFalseTolerance,
    slideAnimationId: configOverrides.slideAnimationId ?? DEFAULT_CONFIG.slideAnimationId,
    slideInterrupt: configOverrides.slideInterrupt ?? DEFAULT_CONFIG.slideInterrupt,
    physics: { ...DEFAULT_CONFIG.physics, ...(configOverrides.physics ?? {}) },
    bounceAnimation: { ...DEFAULT_CONFIG.bounceAnimation, ...(configOverrides.bounceAnimation ?? {}) },
    flashPose: { ...DEFAULT_CONFIG.flashPose, ...(configOverrides.flashPose ?? {}) },
  }
  const clock = { value: 0 }
  const hidden = { value: false }
  let queue: Array<{ callback: () => void; cancelled: boolean }> = []
  const deps: ThrowControllerDeps = {
    service: service.service,
    // Use-time read (the settings card edits the config at runtime); the
    // harness swaps `config` to prove the controller notices.
    getConfig: () => config,
    now: () => clock.value,
    getViewport: () => VIEWPORT,
    scheduleFrame: (callback) => {
      const entry = { callback, cancelled: false }
      queue.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    isHidden: () => hidden.value,
  }
  const controller = new ThrowController(deps)
  return {
    service,
    controller,
    clock,
    hidden,
    setConfig: (next: ThrowPhysicsPluginConfig) => {
      config = next
    },
    pumpFrames: (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        const batch = queue
        queue = []
        for (const entry of batch) if (!entry.cancelled) entry.callback()
      }
    },
  }
}

/**
 * Perform a drag whose release samples imply the given velocity: two 50ms
 * moves at constant speed (sampling starts at the gesture's start
 * position). Returns nothing; assert on the harness.
 */
const performDrag = (
  h: Harness,
  from: { x: number; y: number },
  velocity: { vx: number; vy: number },
  snapshot: (x: number, y: number) => StageSnapshot = snapshotAt,
): void => {
  h.service.pushStage(snapshot(from.x, from.y))
  h.service.emitDrag('start')
  h.clock.value += 50
  h.service.pushStage(snapshot(from.x + velocity.vx * 0.05, from.y + velocity.vy * 0.05))
  h.clock.value += 50
  h.service.pushStage(snapshot(from.x + velocity.vx * 0.1, from.y + velocity.vy * 0.1))
  h.service.emitDrag('end')
}

describe('idle + sampling', () => {
  it('never requests the lease while merely observing', () => {
    const h = makeHarness()
    h.service.pushStage(snapshotAt(100, 100))
    expect(h.service.leaseRequests).toBe(0)
  })

  it('samples during a drag but parks (no lease) on a slow release', () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 200, vy: 0 }) // 200 px/s < 350
    expect(h.service.leaseRequests).toBe(0)
    expect(h.service.drivers).toHaveLength(0)
  })

  it('parks when the release has too few samples in the window', () => {
    const h = makeHarness()
    h.service.pushStage(snapshotAt(100, 100))
    h.service.emitDrag('start')
    // One tiny move, long ago: the 120ms window at 'end' holds one sample.
    h.clock.value += 50
    h.service.pushStage(snapshotAt(120, 100))
    h.clock.value += 500
    h.service.emitDrag('end')
    expect(h.service.leaseRequests).toBe(0)
  })
})

describe('throw → flight', () => {
  it('computes the release velocity from samples and starts driving apply', () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    expect(h.service.leaseRequests).toBe(1)
    const driver = h.service.drivers[0]!
    // Flight starts at the last snapshot position (300,100); first 16ms
    // frame: x = 300 + 2000·0.016, vy = 3000·0.016, y = 100 + vy·dt.
    h.clock.value += 16
    h.pumpFrames(1)
    expect(driver.applyCalls).toHaveLength(1)
    expect(driver.applyCalls[0]!.x).toBeCloseTo(332, 6)
    expect(driver.applyCalls[0]!.y).toBeCloseTo(100.768, 6)
  })

  it('applies the throw multiplier to the sampled velocity', () => {
    const h = makeHarness({ physics: { throwMultiplier: 2 } })
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 }) // 2000 × 2 = 4000
    h.clock.value += 16
    h.pumpFrames(1)
    const driver = h.service.drivers[0]!
    expect(driver.applyCalls[0]!.x).toBeCloseTo(300 + 4000 * 0.016, 6)
  })

  it('clamps the release speed to maxSpeed (flight may start past a wall)', () => {
    const h = makeHarness()
    // Raw 10000 px/s → clamped to 4000; the release position (x=1100) is
    // already past the right wall, so frame 1 clamps back to 900 and fires.
    performDrag(h, { x: 100, y: 100 }, { vx: 10_000, vy: 0 })
    h.clock.value += 16
    h.pumpFrames(1)
    const driver = h.service.drivers[0]!
    expect(driver.applyCalls[0]!.x).toBe(900)
    expect(h.service.plays).toHaveLength(1)
    expect(h.service.plays[0]!.id).toBe('user:physics-bounce-pop')
    expect(h.service.plays[0]!.options?.interrupt).toBe(true)
  })

  it('gives up silently when the lease is taken', () => {
    const h = makeHarness()
    h.service.grantLease = false
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    expect(h.service.leaseRequests).toBe(1)
    expect(h.service.drivers).toHaveLength(0)
    h.clock.value += 16
    h.pumpFrames(1) // no crash, nothing scheduled
    expect(h.service.plays).toHaveLength(0)
  })

  it('follows the release position into the bounds (no wall effect when moving away)', () => {
    const h = makeHarness()
    // Released past the right wall (x=960) but moving left: frame 1 clamps
    // back inside with NO wall effect — there was no approach velocity.
    performDrag(h, { x: 1000, y: 100 }, { vx: -400, vy: 0 })
    h.clock.value += 16
    h.pumpFrames(1)
    const driver = h.service.drivers[0]!
    expect(driver.applyCalls[0]!.x).toBe(900)
    expect(h.service.plays).toHaveLength(0)
  })

  it('commits then releases on settle', async () => {
    // restitution 0 + the legacy threshold 0: the first floor contact kills
    // vy, speed 0 < settle (the default minBounceHeightPx would slide instead).
    const h = makeHarness({ physics: { restitution: 0, minBounceHeightPx: 0 } })
    performDrag(h, { x: 500, y: 690 }, { vx: 0, vy: 400 })
    const driver = h.service.drivers[0]!
    h.clock.value += 16
    h.pumpFrames(1)
    expect(driver.applyCalls.length).toBeGreaterThan(0)
    expect(driver.applyCalls.at(-1)!.y).toBe(700)
    await flushMicrotasks()
    expect(driver.commits).toBe(1)
    expect(driver.releases).toBe(1)
    // The settle fired the bottom-wall effect exactly once.
    expect(h.service.plays).toHaveLength(1)
    // No further frames after settle.
    const applied = driver.applyCalls.length
    h.clock.value += 16
    h.pumpFrames(1)
    expect(driver.applyCalls.length).toBe(applied)
  })

  it('uses the latest config for the next gesture (runtime-editable config)', () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    let driver = h.service.drivers[0]!
    h.clock.value += 16
    h.pumpFrames(1)
    expect(driver.applyCalls[0]!.x).toBeCloseTo(300 + 2000 * 0.016, 6) // multiplier 1
    // The settings card saved a new throwMultiplier: the controller reads
    // the config at use time, so the NEXT gesture flies with the new value
    // (no re-instantiation needed). maxSpeed rises too so 2000×3 stays
    // unclamped (the clamp would mask the multiplier change).
    h.setConfig({
      ...structuredClone(DEFAULT_CONFIG),
      physics: { ...DEFAULT_CONFIG.physics, throwMultiplier: 3, maxSpeed: 100_000 },
    })
    h.clock.value += 16
    h.pumpFrames(1) // let the old flight settle out (it ends on this frame batch)
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    driver = h.service.drivers[1]!
    h.clock.value += 16
    h.pumpFrames(1)
    expect(driver.applyCalls[0]!.x).toBeCloseTo(300 + 6000 * 0.016, 6) // 2000 × 3
  })
})

describe('wall effects', () => {
  it('fires the bounce animation when a real wall is hit', () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 4000, vy: 0 }) // release at x=500
    for (let i = 0; i < 6; i++) {
      h.clock.value += 16
      h.pumpFrames(1) // x reaches 884 — not yet at the 900 wall
    }
    expect(h.service.plays).toHaveLength(0)
    h.clock.value += 16
    h.pumpFrames(1) // frame 7 crosses 900
    expect(h.service.plays).toHaveLength(1)
    expect(h.service.plays[0]!.id).toBe('user:physics-bounce-pop')
  })

  it('debounces same-wall jitter and re-arms after the window (pinned box)', () => {
    // A box as large as the viewport pins x (and y onto the "floor"):
    // every frame hits a wall — corner-jitter style. restitution 1 keeps
    // the rattle alive (with 0.6 the speed decays below settleSpeed and
    // the flight settles within ~7 frames). Frame cadence with vx=4000:
    // right fires t16, left fires t32, every following hit sits inside
    // the 150ms window until t176 (right again, 160ms after its fire)
    // and t192 (left again).
    const h = makeHarness({ physics: { gravity: 0, restitution: 1 } })
    const bigStage = (x: number, y: number): StageSnapshot => snapshotAt(x, y, { stageSize: 1000 })
    performDrag(h, { x: 0, y: 300 }, { vx: 10_000, vy: 0 }, bigStage) // clamped to 4000
    expect(h.service.leaseRequests).toBe(1)
    for (let i = 0; i < 10; i++) {
      h.clock.value += 16
      h.pumpFrames(1) // t=160: only the first two hits fired
    }
    expect(h.service.plays).toHaveLength(2)
    for (let i = 0; i < 2; i++) {
      h.clock.value += 16
      h.pumpFrames(1) // t=176/192: both walls re-arm and fire again
    }
    expect(h.service.plays).toHaveLength(4)
  })

  it('plays the flash pose effect independently of the animation', () => {
    const h = makeHarness({
      bounceAnimation: { enabled: false, id: 'user:physics-bounce-pop', interrupt: true },
      flashPose: { enabled: true, poseKey: 'success', holdMs: 800 },
    })
    performDrag(h, { x: 100, y: 100 }, { vx: 4000, vy: 0 })
    let frames = 0
    while (h.service.flashes.length < 1 && frames < 50) {
      h.clock.value += 16
      h.pumpFrames(1)
      frames += 1
    }
    expect(h.service.plays).toHaveLength(0) // animation disabled
    expect(h.service.flashes).toHaveLength(1)
    expect(h.service.flashes[0]).toEqual({ poseKey: 'success', holdMs: 800 })
  })
})

describe('ground slide (minBounceHeightPx)', () => {
  it('plays the slide animation once at slide entry, fires no bounce effects while sliding, settles + commits', async () => {
    const h = makeHarness({ slideAnimationId: 'builtin:click-wiggle' })
    // A downward throw with real gravity: bounces shrink below the 12px
    // threshold, the pet starts sliding, decays under groundFriction and
    // settles (commit) — no bottom-wall machine-gun along the way.
    performDrag(h, { x: 450, y: 100 }, { vx: 300, vy: 600 })
    const driver = h.service.drivers[0]!
    expect(driver).toBeDefined()

    let frames = 0
    while (driver.releases === 0 && frames < 600) {
      h.clock.value += 16
      h.pumpFrames(1)
      frames += 1
    }
    await flushMicrotasks()
    expect(driver.commits).toBe(1) // settled and persisted
    expect(driver.releases).toBe(1)

    const slidePlays = h.service.plays.filter((play) => play.id === 'builtin:click-wiggle')
    expect(slidePlays).toHaveLength(1) // exactly one slide animation, at entry
    // While sliding no bounce/flash effects fire: every play after the slide
    // animation is the slide itself (the last bottom bounce precedes it).
    const slideIndex = h.service.plays.findIndex((play) => play.id === 'builtin:click-wiggle')
    expect(h.service.plays.slice(slideIndex + 1)).toEqual([])
    // The settle position is on the floor (y = 700 = viewport 800 - box 100).
    expect(driver.applyCalls.at(-1)!.y).toBe(700)
  })

  it('slideAnimationId null (default) plays nothing at slide entry', async () => {
    const h = makeHarness({ bounceAnimation: { enabled: false, id: 'user:physics-bounce-pop', interrupt: true } })
    performDrag(h, { x: 450, y: 100 }, { vx: 300, vy: 600 })
    const driver = h.service.drivers[0]!
    let frames = 0
    while (driver.releases === 0 && frames < 600) {
      h.clock.value += 16
      h.pumpFrames(1)
      frames += 1
    }
    await flushMicrotasks()
    expect(driver.commits).toBe(1)
    expect(h.service.plays).toEqual([]) // bounce disabled, slide unset: silent slide
  })

  it('passes the configured slideInterrupt to the slide animation (default true)', () => {
    const h = makeHarness({ slideAnimationId: 'builtin:click-wiggle' })
    performDrag(h, { x: 450, y: 100 }, { vx: 300, vy: 600 })
    let frames = 0
    while (!h.service.plays.some((play) => play.id === 'builtin:click-wiggle') && frames < 600) {
      h.clock.value += 16
      h.pumpFrames(1)
      frames += 1
    }
    const slide = h.service.plays.find((play) => play.id === 'builtin:click-wiggle')
    expect(slide?.options).toEqual({ interrupt: true })
  })

  it('passes slideInterrupt=false to the slide animation when configured', () => {
    const h = makeHarness({ slideAnimationId: 'builtin:click-wiggle', slideInterrupt: false })
    performDrag(h, { x: 450, y: 100 }, { vx: 300, vy: 600 })
    let frames = 0
    while (!h.service.plays.some((play) => play.id === 'builtin:click-wiggle') && frames < 600) {
      h.clock.value += 16
      h.pumpFrames(1)
      frames += 1
    }
    const slide = h.service.plays.find((play) => play.id === 'builtin:click-wiggle')
    expect(slide?.options).toEqual({ interrupt: false })
  })
})

describe('settle commit/release contract (M5a)', () => {
  it('commit lands strictly before release (order pinned)', async () => {
    const h = makeHarness({ physics: { restitution: 0, minBounceHeightPx: 0 } })
    performDrag(h, { x: 500, y: 690 }, { vx: 0, vy: 400 })
    const driver = h.service.drivers[0]!
    h.clock.value += 16
    h.pumpFrames(1)
    await flushMicrotasks()
    expect(driver.commits).toBe(1)
    expect(driver.releases).toBe(1)
    // Releasing first would let a remote overlay coordinate overwrite the
    // settled position — the order is the contract.
    expect(driver.calls.indexOf('commit')).toBeLessThan(driver.calls.indexOf('release'))
  })

  it('a failed commit still releases the lease and only warns', async () => {
    const h = makeHarness({ physics: { restitution: 0, minBounceHeightPx: 0 } })
    performDrag(h, { x: 500, y: 690 }, { vx: 0, vy: 400 })
    const driver = h.service.drivers[0]!
    driver.commitError = new Error('host gone')
    h.clock.value += 16
    h.pumpFrames(1)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(driver.commits).toBe(1)
    expect(driver.releases).toBe(1) // the lease is never stranded on a failed commit
    expect(consoleWarn).toHaveBeenCalledWith('petween-physics: settle commit failed', expect.any(Error))
  })

  it('releases the lease via the 20s safety valve when commit never settles', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness({ physics: { restitution: 0, minBounceHeightPx: 0 } })
      performDrag(h, { x: 500, y: 690 }, { vx: 0, vy: 400 })
      const driver = h.service.drivers[0]!
      driver.hangCommit = true
      h.clock.value += 16
      h.pumpFrames(1) // settle path starts a commit that never settles
      expect(driver.commits).toBe(1)
      expect(driver.releases).toBe(0) // the hung commit holds the chain
      await vi.advanceTimersByTimeAsync(19_999)
      expect(driver.releases).toBe(0) // the valve opens at exactly 20s
      await vi.advanceTimersByTimeAsync(1)
      expect(driver.releases).toBe(1) // ...and always releases afterwards
      expect(consoleWarn).toHaveBeenCalledWith('petween-physics: settle commit failed', expect.any(Error))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('interruptions', () => {
  it('aborts the flight (bare release) when the user grabs the pet mid-air — the hand wins', async () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    const driver = h.service.drivers[0]!
    h.clock.value += 16
    h.pumpFrames(1)
    driver.emitUserDrag()
    expect(driver.releases).toBe(1)
    await flushMicrotasks()
    expect(driver.commits).toBe(0) // interrupted flights never persist
    const applied = driver.applyCalls.length
    h.clock.value += 16
    h.pumpFrames(1)
    expect(driver.applyCalls.length).toBe(applied) // flight is over
  })

  it("the launching gesture's trailing driver-level 'end' must NOT abort the flight (petween end-fan regression)", () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    const driver = h.service.drivers[0]!
    // Real petween order on pointerup: the service-level 'end' fans first
    // (startFlight takes the lease and registers the mid-air-catch listener),
    // then the SAME gesture's driver-level 'end' reaches the fresh lease —
    // a resume signal ("apply is honored again"), not a grab. A
    // phase-agnostic listener killed the flight in the same call stack that
    // started it; only 'start' may abort.
    driver.emitUserDrag('end')
    expect(driver.releases).toBe(0)
    expect(driver.commits).toBe(0)
    h.clock.value += 16
    h.pumpFrames(1) // still flying
    expect(driver.applyCalls.length).toBeGreaterThan(0)
    expect(driver.releases).toBe(0)
  })

  it('aborts when driver.apply keeps rejecting (lease lost elsewhere)', async () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    const driver = h.service.drivers[0]!
    driver.applyResult = false
    h.clock.value += 16
    h.pumpFrames(1) // streak 1 — tolerated
    expect(driver.releases).toBe(0)
    h.clock.value += 16
    h.pumpFrames(1) // streak 2 — abort
    expect(driver.releases).toBe(1)
    await flushMicrotasks()
    expect(driver.commits).toBe(0)
  })

  it('commits and releases when the page becomes hidden mid-flight', async () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    const driver = h.service.drivers[0]!
    h.hidden.value = true
    h.clock.value += 16
    h.pumpFrames(1)
    await flushMicrotasks()
    expect(driver.commits).toBe(1)
    expect(driver.releases).toBe(1)
  })

  it('settleIfHidden() lands the flight with NO frame — the visibilitychange path (rAF never fires hidden)', async () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    const driver = h.service.drivers[0]!
    h.hidden.value = true
    // The entry file's visibilitychange listener calls settleIfHidden(); no
    // frame is pumped because a hidden page never runs rAF callbacks.
    h.controller.settleIfHidden()
    expect(driver.commits).toBe(1)
    await flushMicrotasks()
    expect(driver.releases).toBe(1)
    // The flight is over: a stale frame callback must not reanimate it.
    const applied = driver.applyCalls.length
    h.clock.value += 16
    h.pumpFrames(1)
    expect(driver.applyCalls.length).toBe(applied)
  })

  it('settleIfHidden() is a no-op while visible or without a live flight', () => {
    const h = makeHarness()
    h.controller.settleIfHidden() // idle: no crash, nothing started
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    const driver = h.service.drivers[0]!
    h.controller.settleIfHidden() // page still visible: keep flying
    expect(driver.commits).toBe(0)
    expect(driver.releases).toBe(0)
  })

  it('clears everything when the session disappears (stage pushes null)', async () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    const driver = h.service.drivers[0]!
    h.clock.value += 16
    h.pumpFrames(1)
    h.service.pushStage(null)
    expect(driver.releases).toBe(1)
    await flushMicrotasks()
    expect(driver.commits).toBe(0)
    // A stale drag 'end' after session loss must not start anything.
    h.service.emitDrag('end')
    expect(h.service.leaseRequests).toBe(1)
  })

  it('force-settles at the flight ceiling (no endless elastic bouncing)', async () => {
    const h = makeHarness({ physics: { restitution: 1, maxFlightMs: 100 } })
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    const driver = h.service.drivers[0]!
    h.clock.value += 60
    h.pumpFrames(1) // 60ms in: still flying
    expect(driver.releases).toBe(0)
    h.clock.value += 60
    h.pumpFrames(1) // 120ms in: past the 100ms ceiling
    await flushMicrotasks()
    expect(driver.commits).toBe(1)
    expect(driver.releases).toBe(1)
  })
})

describe('dispose', () => {
  it('unsubscribes, releases the lease, stops frames', async () => {
    const h = makeHarness()
    performDrag(h, { x: 100, y: 100 }, { vx: 2000, vy: 0 })
    const driver = h.service.drivers[0]!
    h.clock.value += 16
    h.pumpFrames(1)
    h.controller.dispose()
    expect(h.service.stageUnsubscribed.length).toBe(1)
    expect(h.service.dragUnsubscribed.length).toBe(1)
    expect(driver.releases).toBe(1)
    await flushMicrotasks()
    expect(driver.commits).toBe(0)
    const applied = driver.applyCalls.length
    h.clock.value += 16
    h.pumpFrames(1)
    expect(driver.applyCalls.length).toBe(applied)
  })

  it('drops sampling state on dispose', () => {
    const h = makeHarness()
    h.service.pushStage(snapshotAt(100, 100))
    h.service.emitDrag('start')
    h.controller.dispose()
    // Stale 'end' after dispose: nothing may start.
    h.service.emitDrag('end')
    expect(h.service.leaseRequests).toBe(0)
  })
})

describe('flight bounds from the snapshot widening (petween ≥2026-08-27)', () => {
  it('prefers the snapshot viewport over the injected fallback', () => {
    const h = makeHarness()
    // The provider snapshot says 900px wide (deps still say 1000): released
    // at 860 — inside the stale bounds, past the live ones — moving away.
    const snap = (x: number, y: number): StageSnapshot =>
      snapshotAt(x, y, { viewport: { width: 900, height: 800 } })
    performDrag(h, { x: 860, y: 100 }, { vx: -400, vy: 0 }, snap)
    h.clock.value += 16
    h.pumpFrames(1)
    const driver = h.service.drivers[0]!
    expect(driver.applyCalls[0]!.x).toBe(800) // 900 − 100, not the deps' 900
    expect(h.service.plays).toHaveLength(0) // moving away: no wall effect
  })

  it('wall contact follows the bodyRect insets — the image touches, not the padding', () => {
    const h = makeHarness({ physics: { gravity: 0, restitution: 0.6, friction: 0 } })
    // Square 100px with a 30px transparent margin on the left: the visible
    // body touches the left wall when the SQUARE reaches −30.
    const snap = (x: number, y: number): StageSnapshot =>
      snapshotAt(x, y, { bodyRect: { x: x + 30, y, width: 40, height: 100 } })
    performDrag(h, { x: 500, y: 100 }, { vx: -4000, vy: 0 }, snap)
    const driver = h.service.drivers[0]!
    for (let frame = 0; frame < 30; frame += 1) {
      h.clock.value += 16
      h.pumpFrames(1)
    }
    expect(Math.min(...driver.applyCalls.map((call) => call.x))).toBe(-30)
    expect(h.service.plays.length).toBeGreaterThanOrEqual(1) // the wall effect fired at image contact
  })
})
