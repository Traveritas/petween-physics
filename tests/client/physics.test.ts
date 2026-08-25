/**
 * physics.test.ts — the pure integrator, pinned to exact numbers.
 *
 * These tests are the contract for every tunable feel (gravity, bounce,
 * friction, settle): the controller only orchestrates; if a number here
 * moves, the flight feel changed.
 */
import { describe, expect, it } from 'vitest'
import {
  FLOOR_EPSILON_PX,
  MAX_STEP_MS,
  releaseVelocity,
  stepBall,
  type BallState,
  type PhysicsParams,
  type ViewportBounds,
} from '../../src/client/physics'

const PARAMS: PhysicsParams = { gravity: 3000, restitution: 0.6, friction: 0, settleSpeed: 120 }
/** 1000×800 viewport, 100px pet box → walls at x∈[0,900], y∈[0,700]. */
const BOUNDS: ViewportBounds = { width: 1000, height: 800, boxSize: 100 }

const ball = (x: number, y: number, vx: number, vy: number): BallState => ({ x, y, vx, vy, resting: false })

describe('stepBall — free flight', () => {
  it('integrates one gravity step (semi-implicit Euler)', () => {
    // vy is updated before the position update: vy' = g·dt, y' = y + vy'·dt.
    const { state, walls } = stepBall(ball(500, 100, 0, 0), 40, PARAMS, BOUNDS)
    expect(state).toEqual({ x: 500, y: 100 + 3000 * 0.04 * 0.04, vx: 0, vy: 3000 * 0.04, resting: false })
    expect(walls).toEqual([])
  })

  it('moves horizontally untouched when gravity is zero', () => {
    const { state, walls } = stepBall(ball(0, 500, 100, 0), 40, { ...PARAMS, gravity: 0 }, BOUNDS)
    expect(state.x).toBeCloseTo(100 * 0.04, 10)
    expect(state.y).toBe(500)
    expect(walls).toEqual([])
  })

  it('is a no-op once resting (and reports no walls)', () => {
    const resting: BallState = { x: 500, y: 700, vx: 0, vy: 0, resting: true }
    const { state, walls } = stepBall(resting, 100, PARAMS, BOUNDS)
    expect(state).toEqual(resting)
    expect(walls).toEqual([])
  })
})

describe('stepBall — the four walls', () => {
  it('bounces off the left wall: clamped inside, vx reversed × restitution', () => {
    const { state, walls } = stepBall(ball(-50, 400, -200, 0), 16, { ...PARAMS, gravity: 0 }, BOUNDS)
    expect(state.x).toBe(0)
    expect(state.vx).toBeCloseTo(200 * 0.6, 10)
    expect(walls).toEqual(['left'])
  })

  it('bounces off the right wall', () => {
    const { state, walls } = stepBall(ball(950, 400, 200, 0), 16, { ...PARAMS, gravity: 0 }, BOUNDS)
    expect(state.x).toBe(900)
    expect(state.vx).toBeCloseTo(-200 * 0.6, 10)
    expect(walls).toEqual(['right'])
  })

  it('bounces off the top wall', () => {
    const { state, walls } = stepBall(ball(500, -30, 0, -100), 16, { ...PARAMS, gravity: 0 }, BOUNDS)
    expect(state.y).toBe(0)
    expect(state.vy).toBeCloseTo(100 * 0.6, 10)
    expect(walls).toEqual(['top'])
  })

  it('bounces off the bottom wall', () => {
    // 400 px/s into the floor → 240 px/s rebound, above settleSpeed.
    const { state, walls } = stepBall(ball(500, 750, 0, 400), 16, { ...PARAMS, gravity: 0 }, BOUNDS)
    expect(state.y).toBe(700)
    expect(state.vy).toBeCloseTo(-400 * 0.6, 10)
    expect(state.resting).toBe(false)
    expect(walls).toEqual(['bottom'])
  })

  it('clamps position without reporting a wall when moving away', () => {
    // Placed outside but already moving inward (e.g. released from a §27
    // drag position): snap inside, but this is not a collision.
    const { state, walls } = stepBall(ball(-50, 400, 200, 0), 16, { ...PARAMS, gravity: 0 }, BOUNDS)
    expect(state.x).toBe(0)
    expect(state.vx).toBe(200)
    expect(walls).toEqual([])
  })

  it('reports both walls on a corner hit', () => {
    const { state, walls } = stepBall(ball(990, 790, 2000, 2000), 16, { ...PARAMS, gravity: 0 }, BOUNDS)
    expect(state.x).toBe(900)
    expect(state.y).toBe(700)
    expect(walls).toEqual(['right', 'bottom'])
  })
})

describe('stepBall — friction, settle, clamps', () => {
  it('decays horizontal velocity continuously (air drag)', () => {
    const { state } = stepBall(ball(500, 400, 100, 0), 40, { ...PARAMS, gravity: 0, friction: 1 }, BOUNDS)
    expect(state.vx).toBeCloseTo(100 * (1 - 1 * 0.04), 10)
  })

  it('never lets friction reverse horizontal velocity', () => {
    // friction·dt > 1 would flip the sign; the floor at zero wins.
    const { state } = stepBall(ball(500, 400, 100, 0), 40, { ...PARAMS, gravity: 0, friction: 100 }, BOUNDS)
    expect(state.vx).toBe(0)
  })

  it('settles on the floor below settleSpeed (velocities zeroed, still reports the wall)', () => {
    // After the floor bounce the speed is √(30² + 88.8²) ≈ 93.7 < 120.
    // (x still travels its 30px/s · 16ms slice before the floor clamps y.)
    const { state, walls } = stepBall(ball(500, 700, 30, 100), 16, PARAMS, BOUNDS)
    expect(state).toEqual({ x: 500 + 30 * 0.016, y: 700, vx: 0, vy: 0, resting: true })
    expect(walls).toEqual(['bottom'])
  })

  it('does not settle mid-air below settleSpeed (gravity is still pulling)', () => {
    const { state } = stepBall(ball(500, 100, 0, 50), 16, PARAMS, BOUNDS)
    expect(state.resting).toBe(false)
  })

  it('treats floor contact within the epsilon as on-floor', () => {
    const maxY = 700
    const { state } = stepBall({ x: 500, y: maxY - FLOOR_EPSILON_PX / 2, vx: 30, vy: -20, resting: false }, 16, PARAMS, BOUNDS)
    expect(state.resting).toBe(true)
    expect(state.y).toBe(maxY)
  })

  it('clamps dt to MAX_STEP_MS', () => {
    const long = stepBall(ball(500, 100, 0, 0), 10_000, PARAMS, BOUNDS)
    const capped = stepBall(ball(500, 100, 0, 0), MAX_STEP_MS, PARAMS, BOUNDS)
    expect(long).toEqual(capped)
  })

  it('pins the box when it fills the viewport (no thrash)', () => {
    const full: ViewportBounds = { width: 1000, height: 800, boxSize: 1000 }
    const { state } = stepBall(ball(500, 300, 500, 0), 16, { ...PARAMS, gravity: 0 }, full)
    expect(state.x).toBe(0)
    expect(state.vx).toBeCloseTo(-500 * 0.6, 10)
  })
})

describe('releaseVelocity', () => {
  const BASE = { sampleWindowMs: 120, throwMultiplier: 1, minThrowSpeed: 350, maxSpeed: 4000 }

  it('derives velocity from the oldest in-window sample to the newest', () => {
    const samples = [
      { x: 100, y: 100, t: 1000 },
      { x: 300, y: 100, t: 1100 },
    ]
    expect(releaseVelocity(samples, 1100, BASE)).toEqual({ vx: 2000, vy: 0 })
  })

  it('ignores samples older than the window', () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 500, y: 0, t: 500 }, // stale: far outside the 120ms window ending at 1000
      { x: 100, y: 0, t: 1000 },
      { x: 120, y: 0, t: 1010 },
    ]
    // Only the last two count: 20px / 10ms = 2000 px/s.
    expect(releaseVelocity(samples, 1010, BASE)).toEqual({ vx: 2000, vy: 0 })
  })

  it('returns null when the window holds fewer than two samples', () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 50, y: 0, t: 500 },
      { x: 100, y: 0, t: 1000 },
    ]
    expect(releaseVelocity(samples, 1000, BASE)).toBeNull()
  })

  it('returns null for zero elapsed time', () => {
    const samples = [
      { x: 100, y: 100, t: 1000 },
      { x: 400, y: 100, t: 1000 },
    ]
    expect(releaseVelocity(samples, 1000, BASE)).toBeNull()
  })

  it('parks (null) below minThrowSpeed — that was a placement, not a throw', () => {
    const samples = [
      { x: 100, y: 100, t: 1000 },
      { x: 120, y: 100, t: 1100 }, // 200 px/s < 350
    ]
    expect(releaseVelocity(samples, 1100, BASE)).toBeNull()
  })

  it('applies the throw multiplier before the speed gates', () => {
    const samples = [
      { x: 100, y: 100, t: 1000 },
      { x: 120, y: 100, t: 1100 }, // raw 200 px/s
    ]
    // ×2 = 400 px/s clears minThrowSpeed.
    expect(releaseVelocity(samples, 1100, { ...BASE, throwMultiplier: 2 })).toEqual({ vx: 400, vy: 0 })
    // ×0.5 = 100 px/s does not — the multiplier can demote a throw to a park.
    expect(releaseVelocity(samples, 1100, { ...BASE, throwMultiplier: 0.5 })).toBeNull()
  })

  it('clamps the magnitude to maxSpeed, preserving direction', () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 3000, y: 4000, t: 100 }, // 5000 px/s at atan2(4,3)
    ]
    const v = releaseVelocity(samples, 100, BASE)
    expect(v).not.toBeNull()
    expect(Math.hypot(v!.vx, v!.vy)).toBeCloseTo(4000, 8)
    expect(v!.vx).toBeCloseTo(2400, 8)
    expect(v!.vy).toBeCloseTo(3200, 8)
  })
})
