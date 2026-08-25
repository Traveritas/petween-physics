/**
 * client/config.ts — the plugin's tunable configuration.
 *
 * History: these started as compile-time constants (no cordis Config schema —
 * see the "no schema form" note below). They are now RUNTIME state: the host
 * half persists them at `$DSH_HOME/motion-pet-physics/config.json` and serves
 * GET/PUT `/api/motion-pet-physics/config`; this module stays the single
 * source of truth for the shape, the defaults AND the accepted ranges — the
 * host's PUT validation rejects out-of-range values using CONFIG_NUMERIC_FIELDS,
 * and the settings card binds the same bounds to its inputs.
 *
 * Why still no cordis Config schema (investigated against dsh 0.1.0-rc.7):
 * 1. The Plugins settings tab renders ONLY hand-written cards that a
 *    plugin's own browser half registers under `settings.plugin.item`, keyed
 *    on a settings namespace the HOST serves through the settings-scope
 *    system (dsh-client-ui-settings-plugins/README.md: "A served namespace no
 *    card claims renders nothing"); no surface renders a plugin's `Config`
 *    export as a form.
 * 2. The installed shell's frozen module table exposes only
 *    react/cordis/slots/primitives (dsh-web-frontend dist, staticModules
 *    builder) — no schema-form module external bundles may share.
 * 3. Browser-side plugin entries are created without entry config
 *    (`loader.create({ name })` in the shell boot), so a client half has no
 *    config channel to read even off-UI.
 * Our own config.json + HTTP route + settings.section card replaces all of
 * that with one owned path (see README "Configuration").
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

/**
 * A partial config for PUT: every level optional (the host merges present
 * fields onto the current on-disk config). The settings card sends complete
 * drafts; hand-rolled callers may patch single fields.
 */
export interface PhysicsConfigPatch {
  physics?: Partial<PhysicsConfig>
  bounceAnimation?: Partial<BounceAnimationConfig>
  flashPose?: Partial<FlashPoseConfig>
  sampleWindowMs?: number
  effectDebounceMs?: number
  applyFalseTolerance?: number
}

/** The six pose slots the main plugin's resolver knows (flashPose.poseKey). */
export const POSE_KEYS = ['idle', 'thinking', 'working', 'waiting', 'success', 'error'] as const
export type PoseKeyOption = (typeof POSE_KEYS)[number]

/** Range spec for one numeric config field (host validation + card bounds). */
export interface NumericFieldSpec {
  readonly min: number
  readonly max: number
  /** Set when only whole numbers make sense (e.g. frame tolerances). */
  readonly integer?: boolean
}

const NUMERIC_FIELDS_SOURCE = {
  'physics.gravity': { min: 100, max: 100_000 },
  'physics.restitution': { min: 0, max: 1 },
  'physics.friction': { min: 0, max: 1 },
  'physics.throwMultiplier': { min: 0, max: 10 },
  'physics.minThrowSpeed': { min: 0, max: 10_000 },
  'physics.settleSpeed': { min: 0, max: 10_000 },
  'physics.maxSpeed': { min: 100, max: 100_000 },
  'physics.maxFlightMs': { min: 500, max: 600_000 },
  'flashPose.holdMs': { min: 0, max: 60_000 },
  sampleWindowMs: { min: 10, max: 2_000 },
  effectDebounceMs: { min: 0, max: 5_000 },
  applyFalseTolerance: { min: 1, max: 60, integer: true },
}

/**
 * Accepted numeric ranges, keyed by config path. Enforced by the host's PUT
 * validation (out-of-range → 400 with the expected range in the message) and
 * mirrored by the settings card's input bounds — one table for both halves.
 */
export type NumericConfigField = keyof typeof NUMERIC_FIELDS_SOURCE
export const CONFIG_NUMERIC_FIELDS: Record<NumericConfigField, NumericFieldSpec> = NUMERIC_FIELDS_SOURCE

/** Max length for `bounceAnimation.id` (a library id, not free prose). */
export const ANIMATION_ID_MAX_LENGTH = 200

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
