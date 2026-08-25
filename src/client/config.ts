/**
 * client/config.ts — the plugin's tunable constants.
 *
 * WHY a plain constant (no cordis Config schema): investigated against the
 * installed dsh 0.1.0-rc.7 sources —
 * 1. The Plugins settings tab renders ONLY hand-written cards that a
 *    plugin's own browser half registers under `settings.plugin.item`
 *    (dsh-client-ui-settings-plugins/README.md: "A served namespace no card
 *    claims renders nothing"); no surface renders a plugin's `Config`
 *    export as a form.
 * 2. The installed shell's frozen module table exposes only
 *    react/cordis/slots/primitives (dsh-web-frontend dist, staticModules
 *    builder) — no schema-form module external bundles may share.
 * 3. Browser-side plugin entries are created without entry config
 *    (`loader.create({ name })` in the shell boot), so a client half has no
 *    config channel to read even off-UI.
 * Until DSH ships a generic plugin-config form, editing this file and
 * rebuilding is the supported path (see README "Configuration").
 */

/** Pure-physics tuning (px/second units; positions are viewport px). */
export interface PhysicsConfig {
  /** Downward acceleration in px/s². Larger = snappier falls. */
  gravity: number
  /** Wall restitution 0..1: velocity kept after a bounce. 1 = perfect elastic. */
  restitution: number
  /** Horizontal air drag 0..1 per second: vx *= (1 - friction*dt) each step. */
  friction: number
  /** Release-velocity multiplier; 1 = the hand's real speed. */
  throwMultiplier: number
  /** Below this release speed (px/s) the gesture is a "park", not a throw. */
  minThrowSpeed: number
  /** At/below this speed (px/s) while touching the floor the pet settles. */
  settleSpeed: number
  /** Release-speed clamp (px/s) so a flick cannot teleport the pet. */
  maxSpeed: number
  /** Fallback flight ceiling (ms): force-settle past this (e.g. restitution 1). */
  maxFlightMs: number
}

/** Wall-impact animation effect (played through the main plugin's service). */
export interface BounceAnimationConfig {
  enabled: boolean
  /** Library id; the host half installs this default. */
  id: string
  /** true = preempt in-flight animations at impact (default of the service). */
  interrupt: boolean
}

/** Wall-impact pose flash effect (image swap that reverts after holdMs). */
export interface FlashPoseConfig {
  enabled: boolean
  poseKey: 'idle' | 'thinking' | 'working' | 'waiting' | 'success' | 'error'
  /** ms to hold the flashed pose; <= 0 keeps it until the next state change. */
  holdMs: number
}

export interface ThrowPhysicsPluginConfig {
  physics: PhysicsConfig
  bounceAnimation: BounceAnimationConfig
  flashPose: FlashPoseConfig
  /** Drag-velocity sampling window (ms) ending at release. */
  sampleWindowMs: number
  /** Same-wall effect debounce (ms): corner jitter fires one effect, not a burst. */
  effectDebounceMs: number
  /** Consecutive driver.apply() rejections tolerated before aborting a flight. */
  applyFalseTolerance: number
}

export const DEFAULT_CONFIG: ThrowPhysicsPluginConfig = {
  physics: {
    gravity: 3000,
    restitution: 0.6,
    friction: 0,
    throwMultiplier: 1,
    minThrowSpeed: 350,
    settleSpeed: 120,
    maxSpeed: 4000,
    maxFlightMs: 20_000,
  },
  bounceAnimation: {
    enabled: true,
    id: 'user:physics-bounce-pop',
    interrupt: true,
  },
  flashPose: {
    enabled: false,
    poseKey: 'success',
    holdMs: 800,
  },
  sampleWindowMs: 120,
  effectDebounceMs: 150,
  applyFalseTolerance: 2,
}
