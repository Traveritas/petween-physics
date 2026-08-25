/**
 * client/throw-controller.ts — the gesture→flight→settle orchestrator.
 *
 * WHY a class with injected seams (no direct window/rAF/document access):
 * every timing-dependent behavior — sampling, flight stepping, aborts,
 * settle commits — must be unit-testable with a fake service and a manual
 * frame pump; the entry file supplies the browser bindings.
 *
 * Lease discipline (the companion contract's one hard rule):
 * - idle/sampling: NO lease held. The drag gesture belongs to the main
 *   plugin; we merely observe stage snapshots and drag phases.
 * - flight: exclusive lease via requestPositionControl(); while held the
 *   main plugin ignores remote overlay coordinates, so the flight must be
 *   short-lived and end in commit() → release() (settle/hidden) or a
 *   bare release() (interrupted — the user's hand or a dead session now
 *   owns the pet).
 *
 * The user's hand ALWAYS wins: a drag 'start' mid-flight aborts it without
 * committing (the drag's own end path persists the position).
 */
import type {
  BounceAnimationConfig,
  FlashPoseConfig,
  PhysicsConfig,
  ThrowPhysicsPluginConfig,
} from './config'
import { releaseVelocity, stepBall, type BallState, type ViewportBounds, type Wall } from './physics'
import type { MotionPetClientService, PositionDriver, StageSnapshot } from './types'

/** One drag-velocity sample (stage top-left at time t). */
interface DragSample {
  x: number
  y: number
  t: number
}

interface Flight {
  driver: PositionDriver
  state: BallState
  /** Frame timestamp of the previous step (ms). */
  lastTime: number
  /** Flight start (ms) — backs the max-flight energy-exhaustion guard. */
  startedAt: number
  /** Consecutive rejected driver.apply() calls. */
  applyFalseStreak: number
  detachDriverDrag: () => void
}

/** All environment touchpoints, injectable for tests. */
export interface ThrowControllerDeps {
  service: MotionPetClientService
  config: ThrowPhysicsPluginConfig
  /** Millisecond clock (performance.now in the browser). */
  now(): number
  /** Live viewport size (StageSnapshot carries no viewport dimensions). */
  getViewport(): { width: number; height: number }
  /** Arrange one frame callback; returns its cancel. */
  scheduleFrame(callback: () => void): () => void
  /** document.hidden — a hidden page must not keep a flight alive (§23). */
  isHidden(): boolean
}

export class ThrowController {
  private readonly deps: ThrowControllerDeps
  private readonly physics: PhysicsConfig
  private readonly bounceAnimation: BounceAnimationConfig
  private readonly flashPose: FlashPoseConfig

  private disposed = false
  private readonly unsubscribeStage: () => void
  private readonly unsubscribeDrag: () => void
  private latestSnapshot: StageSnapshot | null = null
  private sampling = false
  private samples: DragSample[] = []
  private flight: Flight | null = null
  private cancelFrame: (() => void) | null = null
  /** Per-wall last effect time (ms) for the same-wall debounce. */
  private readonly lastEffectAt = new Map<Wall, number>()

  constructor(deps: ThrowControllerDeps) {
    this.deps = deps
    this.physics = deps.config.physics
    this.bounceAnimation = deps.config.bounceAnimation
    this.flashPose = deps.config.flashPose
    // Subscribing pushes the current snapshot immediately (contract), which
    // seeds latestSnapshot before any gesture can happen.
    this.unsubscribeStage = deps.service.subscribeStage((snapshot) => this.onStage(snapshot))
    this.unsubscribeDrag = deps.service.subscribeUserDrag((phase) => this.onUserDrag(phase))
  }

  /** Teardown: unsubscribe everything, kill the flight (bare release), stop frames. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.endFlight(false)
    this.unsubscribeStage()
    this.unsubscribeDrag()
    this.sampling = false
    this.samples = []
    this.latestSnapshot = null
  }

  private onStage(snapshot: StageSnapshot | null): void {
    if (this.disposed) return
    this.latestSnapshot = snapshot
    if (snapshot === null) {
      // Session gone (pet disabled/unmounted): clear EVERYTHING. No commit —
      // the lease's owner is gone and persisting through a dead session
      // would at best throw.
      this.endFlight(false)
      this.sampling = false
      this.samples = []
      return
    }
    if (this.sampling) this.pushSample(snapshot)
    // Mid-flight snapshot pushes (position echoes from our own apply, plus
    // scale changes) need no action: the integrator is authoritative and
    // recomputes bounds from this snapshot every frame.
  }

  private onUserDrag(phase: 'start' | 'end'): void {
    if (this.disposed) return
    if (phase === 'start') {
      // The user grabbed the pet (drag threshold crossed). Abort any flight
      // WITHOUT committing — the drag's own end path owns persistence — and
      // start sampling from the pre-move position.
      this.endFlight(false)
      this.sampling = true
      this.samples = []
      if (this.latestSnapshot !== null) {
        this.samples.push({
          x: this.latestSnapshot.x,
          y: this.latestSnapshot.y,
          t: this.deps.now(),
        })
      }
      return
    }
    if (!this.sampling) return // drag 'end' without our 'start' (or after an abort) — nothing to do
    this.sampling = false
    const snapshot = this.latestSnapshot
    const velocity = releaseVelocity(this.samples, this.deps.now(), {
      sampleWindowMs: this.deps.config.sampleWindowMs,
      throwMultiplier: this.physics.throwMultiplier,
      minThrowSpeed: this.physics.minThrowSpeed,
      maxSpeed: this.physics.maxSpeed,
    })
    // Below minThrowSpeed this was a "park", not a throw — leave the pet be.
    if (velocity === null || snapshot === null) return
    this.startFlight(snapshot, velocity)
  }

  private pushSample(snapshot: StageSnapshot): void {
    this.samples.push({ x: snapshot.x, y: snapshot.y, t: this.deps.now() })
    // Keep the buffer bounded during long drags: anything older than two
    // sampling windows can no longer enter the release computation.
    const cutoff = this.deps.now() - this.deps.config.sampleWindowMs * 2
    let drop = 0
    while (drop < this.samples.length && this.samples[drop]!.t < cutoff) drop += 1
    if (drop > 0) this.samples.splice(0, drop)
  }

  private startFlight(snapshot: StageSnapshot, velocity: { vx: number; vy: number }): void {
    const driver = this.deps.service.requestPositionControl()
    // Lease taken by someone else (or no session): give up without a sound —
    // the thrower can retry on the next gesture.
    if (driver === null) return
    const now = this.deps.now()
    this.flight = {
      driver,
      state: { x: snapshot.x, y: snapshot.y, vx: velocity.vx, vy: velocity.vy, resting: false },
      lastTime: now,
      startedAt: now,
      applyFalseStreak: 0,
      // Mid-air catch: the driver signals a user grab; the service-level
      // 'start' subscription fires too — both routes are idempotent.
      detachDriverDrag: driver.onUserDrag(() => this.endFlight(false)),
    }
    this.scheduleNextFrame()
  }

  private scheduleNextFrame(): void {
    this.cancelFrame?.()
    this.cancelFrame = this.deps.scheduleFrame(() => this.stepFrame())
  }

  private stepFrame(): void {
    const flight = this.flight
    if (flight === null || this.disposed) return
    const now = this.deps.now()
    const dt = now - flight.lastTime
    flight.lastTime = now

    // A hidden page must not animate (performance red line): stop flying,
    // persist where we are, hand the position back.
    if (this.deps.isHidden()) {
      this.endFlight(true)
      return
    }

    // Bounds are recomputed every frame: the user may rescale the pet or
    // resize the window mid-flight, and the flight must follow.
    const viewport = this.deps.getViewport()
    const bounds: ViewportBounds =
      this.latestSnapshot === null
        ? { ...viewport, boxSize: 0 }
        : {
            ...viewport,
            boxSize: this.latestSnapshot.stageSize * this.latestSnapshot.scale,
          }

    const result = stepBall(flight.state, dt, this.physics, bounds)
    flight.state = result.state

    const applied = flight.driver.apply(result.state.x, result.state.y)
    if (!applied) {
      // false = suspended (a drag we may not have heard about yet) or
      // released. Tolerate a couple of frames before giving the lease back.
      flight.applyFalseStreak += 1
      if (flight.applyFalseStreak >= this.deps.config.applyFalseTolerance) {
        this.endFlight(false)
        return
      }
    } else {
      flight.applyFalseStreak = 0
    }

    for (const wall of result.walls) this.fireWallEffects(wall)

    if (result.state.resting) {
      // Settled on the floor below settleSpeed: persist, then hand back.
      this.endFlight(true)
      return
    }
    // Energy-exhaustion guard: a near-elastic setup (restitution ~1,
    // friction 0) would otherwise bounce forever (§23: no endless loops).
    if (now - flight.startedAt > this.deps.config.physics.maxFlightMs) {
      this.endFlight(true)
      return
    }
    this.scheduleNextFrame()
  }

  /**
   * End the flight. commit=true (settle/hidden/timeout): persist the current
   * position, then release. commit=false (interrupted): bare release —
   * whoever interrupted owns the pet and its persistence.
   */
  private endFlight(commit: boolean): void {
    const flight = this.flight
    if (flight === null) return
    this.flight = null
    this.cancelFrame?.()
    this.cancelFrame = null
    flight.detachDriverDrag()
    if (commit) {
      void flight.driver
        .commit()
        .catch((error: unknown) => {
          console.warn('motion-pet-physics: settle commit failed', error)
        })
        // Release strictly after the commit lands: releasing first would let
        // a remote overlay coordinate overwrite the settled position.
        .then(() => {
          flight.driver.release()
        })
    } else {
      flight.driver.release()
    }
  }

  private fireWallEffects(wall: Wall): void {
    const now = this.deps.now()
    const last = this.lastEffectAt.get(wall)
    // Same-wall debounce: corner jitter rebounds must not machine-gun the
    // effect (animation restart every frame would look like a glitch).
    if (last !== undefined && now - last < this.deps.config.effectDebounceMs) return
    this.lastEffectAt.set(wall, now)
    if (this.bounceAnimation.enabled) {
      this.deps.service.playAnimation(this.bounceAnimation.id, {
        interrupt: this.bounceAnimation.interrupt,
      })
    }
    if (this.flashPose.enabled) {
      this.deps.service.flashPose(this.flashPose.poseKey, this.flashPose.holdMs)
    }
  }
}
