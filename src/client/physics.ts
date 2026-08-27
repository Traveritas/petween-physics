/**
 * client/physics.ts — the pure ballistic engine (spec: gravity fall inside
 * the viewport, wall bounces, settle-on-floor, ground slide).
 *
 * WHY a pure module with zero DOM/cordis imports: the integrator must be
 * unit-testable to the pixel and reusable independent of how positions are
 * displayed. The controller owns frame timing, leases and effects; this
 * module owns only "where is the ball after dt".
 *
 * Model (positions are viewport px of the bounding-box TOP-LEFT, matching
 * StageSnapshot.x/y; y grows downward like CSS):
 * - gravity accelerates vy every step: vy += gravity * dt;
 * - friction is continuous horizontal air drag: vx *= (1 - friction*dt)
 *   (it therefore also acts on the step a bounce happens in, which is the
 *   "horizontal velocity also damped across a bounce" requirement);
 * - a wall hit clamps the position back inside and reflects the normal
 *   velocity component times restitution; the wall is REPORTED only when
 *   the velocity actually pointed into it (resting against a wall is not
 *   a collision);
 * - a floor hit whose predicted rebound height (vy²/2g after restitution)
 *   falls below minBounceHeightPx stops bouncing: vy pins to 0 and the ball
 *   SLIDES on the floor, vx decaying under groundFriction per second, side
 *   walls clamping without rebound or wall reports (slide = no impact
 *   effects). minBounceHeightPx 0 keeps the legacy bounce-always behavior;
 * - the ball settles (flight over) when it touches the floor and its speed
 *   is below settleSpeed — a complete stop, velocities zeroed. A vertical
 *   low drop can slide and settle within the same step.
 */

/** Which wall(s) the ball hit during one step. */
export type Wall = 'left' | 'right' | 'top' | 'bottom'

/** Integrator state; construct via initialVelocity/ballFromSnapshot helpers or literal. */
export interface BallState {
  x: number
  y: number
  vx: number
  vy: number
  /** true while skidding on the floor after the bounces fell below the threshold. */
  sliding: boolean
  /** true once settled — further steps are no-ops until a new flight starts. */
  resting: boolean
}

export interface PhysicsParams {
  gravity: number
  restitution: number
  friction: number
  settleSpeed: number
  /**
   * Predicted rebound height (px, vy²/2g after restitution) below which a
   * floor hit becomes a ground slide instead of a bounce. 0 = always bounce
   * (the legacy machine-gun low bounce behavior — some users like it).
   */
  minBounceHeightPx: number
  /** Horizontal decay per second while sliding on the floor (same formula as air friction). */
  groundFriction: number
}

/**
 * Flight bounds. The pet's VISIBLE body stays INSIDE the viewport: with the
 * main plugin's bodyRect (2026-08-27) the insets carry the transparent
 * margins between the pose image and the stage square, so walls are hit by
 * the image, not by invisible padding — no insets (older providers) keeps
 * the legacy square bounds. Stricter than the main plugin's drag clamp
 * (32px minimum visible) — a subset, so every physics position passes the
 * driver's own clamp unchanged.
 */
export interface ViewportBounds {
  width: number
  height: number
  boxSize: number
  /** Visible-body margins inside the square (px, >= 0); defaults to none. */
  insets?: { left: number; top: number; right: number; bottom: number }
}

export interface StepResult {
  state: BallState
  walls: Wall[]
}

/** dt clamp: a tab-background gap must not teleport the ball through walls. */
export const MAX_STEP_MS = 40
/** Floor-contact tolerance for the settle check (px). */
export const FLOOR_EPSILON_PX = 0.5

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/**
 * Advance one step. dtMs is clamped to 0..MAX_STEP_MS; a resting state is
 * returned unchanged with no wall reports. Bounded-state safety: when the
 * box is as large as the viewport, maxX/maxY collapse to 0 and the ball is
 * simply pinned to the origin corner instead of thrashing.
 */
export function stepBall(
  state: BallState,
  dtMs: number,
  params: PhysicsParams,
  bounds: ViewportBounds,
): StepResult {
  if (state.resting) return { state: { ...state }, walls: [] }
  const dt = clampNumber(dtMs, 0, MAX_STEP_MS) / 1000
  const restitution = clampNumber(params.restitution, 0, 1)

  // Inset-adjusted travel range for the square top-left: the image rides
  // inside the square, so the square may cross the wall by the inset amount
  // before the VISIBLE body touches it. Degrades to the plain square range
  // without insets. Collapsed ranges (body larger than the viewport) pin
  // like the old bounded-state safety.
  const insets = bounds.insets ?? { left: 0, top: 0, right: 0, bottom: 0 }
  // (avoid -0: a zero inset keeps the plain 0 wall — Object.is-sensitive tests aside,
  // a -0 clamp would also serialize into snapshots as "-0".)
  const minX = insets.left > 0 ? -insets.left : 0
  const minY = insets.top > 0 ? -insets.top : 0
  const maxX = Math.max(minX, bounds.width - bounds.boxSize + (insets.right > 0 ? insets.right : 0))
  const maxY = Math.max(minY, bounds.height - bounds.boxSize + (insets.bottom > 0 ? insets.bottom : 0))
  const walls: Wall[] = []
  let { x, y, vx, vy, sliding } = state

  if (sliding) {
    // Ground slide: gravity off, vy pinned, vx decaying under groundFriction.
    // Side walls clamp WITHOUT rebounding and report nothing — the slide is
    // explicitly the no-more-impact-effects phase.
    vx *= Math.max(0, 1 - Math.max(0, params.groundFriction) * dt)
    x += vx * dt
    y = maxY
    vy = 0
    if (x <= minX) {
      x = minX
      if (vx < 0) vx = 0
    } else if (x >= maxX) {
      x = maxX
      if (vx > 0) vx = 0
    }
  } else {
    // Continuous horizontal air drag (friction is per-second; a step's dt-sized
    // slice applies here, bounce steps included).
    vx *= Math.max(0, 1 - Math.max(0, params.friction) * dt)
    vy += params.gravity * dt
    x += vx * dt
    y += vy * dt

    if (x <= minX) {
      x = minX
      if (vx < 0) {
        vx = -vx * restitution
        walls.push('left')
      }
    } else if (x >= maxX) {
      x = maxX
      if (vx > 0) {
        vx = -vx * restitution
        walls.push('right')
      }
    }
    if (y <= minY) {
      y = minY
      if (vy < 0) {
        vy = -vy * restitution
        walls.push('top')
      }
    } else if (y >= maxY) {
      y = maxY
      if (vy > 0) {
        const bounceVy = vy * restitution
        // Predicted rebound height vy²/2g; gravity ≤ 0 never triggers a slide
        // (the formula's height diverges — keep the legacy bounce behavior).
        const height =
          params.gravity > 0 ? (bounceVy * bounceVy) / (2 * params.gravity) : Number.POSITIVE_INFINITY
        if (height < Math.max(0, params.minBounceHeightPx)) {
          // Rebound too small to see: stop bouncing, slide the rest out. No
          // 'bottom' report — the slide contact is not an impact.
          vy = 0
          sliding = true
        } else {
          vy = -bounceVy
          walls.push('bottom')
        }
      }
    }
  }

  const speed = sliding ? Math.abs(vx) : Math.hypot(vx, vy)
  const onFloor = y >= maxY - FLOOR_EPSILON_PX
  if (onFloor && speed < params.settleSpeed) {
    return { state: { x, y: maxY, vx: 0, vy: 0, sliding: false, resting: true }, walls }
  }
  return { state: { x, y, vx, vy, sliding, resting: false }, walls }
}

/**
 * Compute a release velocity from drag samples (newest last). Returns null
 * when the window carries no usable displacement (single sample, zero
 * elapsed time, too slow to be a throw, or over the speed clamp refusing
 * to normalize — the last cannot happen with finite inputs, but the guard
 * keeps the function total).
 *
 * Pipeline per spec: displacement/time → × throwMultiplier → magnitude
 * clamp to maxSpeed → below minThrowSpeed means "park", not a throw.
 */
export function releaseVelocity(
  samples: ReadonlyArray<{ x: number; y: number; t: number }>,
  nowMs: number,
  options: {
    sampleWindowMs: number
    throwMultiplier: number
    minThrowSpeed: number
    maxSpeed: number
  },
): { vx: number; vy: number } | null {
  // Keep the newest samples inside the window; the OLDEST of those is the
  // reference point (a short window tracks the hand's final flick, not the
  // whole drag history).
  const windowStart = nowMs - options.sampleWindowMs
  let first = 0
  while (first < samples.length && samples[first]!.t < windowStart) first += 1
  const usable = samples.length - first
  if (usable < 2) return null
  const from = samples[first]!
  const to = samples[samples.length - 1]!
  const dt = (to.t - from.t) / 1000
  if (dt <= 0) return null
  let vx = ((to.x - from.x) / dt) * options.throwMultiplier
  let vy = ((to.y - from.y) / dt) * options.throwMultiplier
  const speed = Math.hypot(vx, vy)
  if (!Number.isFinite(speed)) return null
  if (speed < options.minThrowSpeed) return null
  if (speed > options.maxSpeed) {
    const scale = options.maxSpeed / speed
    vx *= scale
    vy *= scale
  }
  return { vx, vy }
}
