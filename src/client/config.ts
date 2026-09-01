/**
 * client/config.ts — the plugin's tunable configuration.
 *
 * History: these started as compile-time constants (no cordis Config schema —
 * see the "no schema form" note below). They are now RUNTIME state: the host
 * half persists them at `$DSH_HOME/petween-physics/config.json` and serves
 * GET/PUT `/api/petween-physics/config`; this module stays the single
 * source of truth for the shape, the defaults AND the accepted ranges — the
 * host's PUT validation rejects out-of-range values using CONFIG_NUMERIC_FIELDS,
 * and the settings card binds the same bounds to its inputs. The validation
 * walkers themselves also live here (node-dependency-free): the browser half
 * strictly pre-checks pet-package shared config blobs with the exact host
 * REJECT policy before offering them (see client/shared-pet-config.ts), and
 * the host re-exports them for its PUT route (the second line of defense —
 * host/config.ts).
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
  /**
   * Predicted rebound height (px) below which a floor hit becomes a ground
   * slide (no rebound, no wall effects; vx decays under groundFriction until
   * settleSpeed). 0 keeps the legacy always-bounce behavior — raise it to
   * slide sooner, if you actually want the machine-gun low bounces set 0.
   */
  minBounceHeightPx: number
  /** Horizontal decay per second while sliding on the floor (same formula as air friction). */
  groundFriction: number
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
  /**
   * Animation played ONCE when the ground slide begins (the bounces fell
   * below minBounceHeightPx and the pet starts skidding). Null = silent
   * slide. Any library id works; an unknown id degrades to nothing at
   * play time through the main plugin's service.
   */
  slideAnimationId: string | null
  /**
   * Whether the one-shot slide animation preempts an in-flight animation
   * when the slide begins (same semantics as bounceAnimation.interrupt).
   * Default true keeps the original behavior; irrelevant while
   * slideAnimationId is null.
   */
  slideInterrupt: boolean
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
  slideAnimationId?: string | null
  slideInterrupt?: boolean
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
  'physics.minBounceHeightPx': { min: 0, max: 2_000 },
  'physics.groundFriction': { min: 0, max: 50 },
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
    minBounceHeightPx: 12,
    groundFriction: 2,
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
  slideAnimationId: null,
  slideInterrupt: true,
  sampleWindowMs: 120,
  effectDebounceMs: 150,
  applyFalseTolerance: 2,
}

/* ---------------------------------------------------------------------------
 * Validation walkers (moved here from host/config.ts so the browser half can
 * strictly pre-check shared config blobs with the exact same policy).
 *
 * Policy (picked deliberately, and applied consistently): REJECT, never
 * clamp. The host's PUT route answers 400 INVALID_CONFIG with the expected
 * range in the message ("expected a number between 100 and 100000") — a
 * silent clamp would let a broken caller write values the user never chose,
 * and the ranges live in one table (CONFIG_NUMERIC_FIELDS) shared with the
 * card's input bounds, so a value the card can send is a value we accept.
 *
 * Two walkers, one shape:
 * - strict (PUT / shared-blob pre-check): unknown fields and bad values
 *   become issues → ConfigValidationError.
 * - lenient (file load): a hand-edited or legacy file keeps every KNOWN
 *   valid field and silently resets the rest onto defaults.
 * ------------------------------------------------------------------------- */

/** One field-level problem; `path` is a dotted config path ('' = the root). */
export interface ConfigIssue {
  path: string
  message: string
}

export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError'
  constructor(readonly issues: ConfigIssue[]) {
    super(issues.map((issue) => `${issue.path === '' ? 'config' : issue.path}: ${issue.message}`).join('; '))
  }
}

const PHYSICS_SECTION = 'physics'
const BOUNCE_SECTION = 'bounceAnimation'
const FLASH_SECTION = 'flashPose'
const SLIDE_ANIMATION_FIELD = 'slideAnimationId'
const SLIDE_INTERRUPT_FIELD = 'slideInterrupt'
const TOP_LEVEL_NUMERIC = ['sampleWindowMs', 'effectDebounceMs', 'applyFalseTolerance'] as const
type SectionKey = typeof PHYSICS_SECTION | typeof BOUNCE_SECTION | typeof FLASH_SECTION

const SECTION_FIELDS: Record<SectionKey, readonly string[]> = {
  physics: [
    'gravity',
    'restitution',
    'friction',
    'throwMultiplier',
    'minThrowSpeed',
    'settleSpeed',
    'maxSpeed',
    'maxFlightMs',
    'minBounceHeightPx',
    'groundFriction',
  ],
  bounceAnimation: ['enabled', 'id', 'interrupt'],
  flashPose: ['enabled', 'poseKey', 'holdMs'],
}

type Target = { [key: string]: unknown }

function checkNumber(path: string, value: unknown, target: Target, field: string, issues: ConfigIssue[]): void {
  const range = CONFIG_NUMERIC_FIELDS[path as keyof typeof CONFIG_NUMERIC_FIELDS]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: 'expected a finite number' })
    return
  }
  if (range !== undefined) {
    if (value < range.min || value > range.max) {
      issues.push({ path, message: `expected a number between ${range.min} and ${range.max}` })
      return
    }
    if (range.integer && !Number.isInteger(value)) {
      issues.push({ path, message: 'expected an integer' })
      return
    }
  }
  target[field] = value
}

function checkBoolean(path: string, value: unknown, target: Target, field: string, issues: ConfigIssue[]): void {
  if (typeof value !== 'boolean') {
    issues.push({ path, message: 'expected a boolean' })
    return
  }
  target[field] = value
}

/** Validate one section field; in lenient mode bad fields are just skipped. */
function checkSectionField(
  section: SectionKey,
  field: string,
  value: unknown,
  merged: ThrowPhysicsPluginConfig,
  issues: ConfigIssue[],
): void {
  const target = merged[section] as unknown as Target
  const path = `${section}.${field}`
  if (section === BOUNCE_SECTION && field === 'id') {
    if (typeof value !== 'string' || value.length === 0 || value.length > ANIMATION_ID_MAX_LENGTH) {
      issues.push({ path, message: `expected a non-empty id of at most ${ANIMATION_ID_MAX_LENGTH} characters` })
      return
    }
    target[field] = value
    return
  }
  if (section === FLASH_SECTION && field === 'poseKey') {
    if (typeof value !== 'string' || !(POSE_KEYS as readonly string[]).includes(value)) {
      issues.push({ path, message: `expected one of ${POSE_KEYS.join(' | ')}` })
      return
    }
    target[field] = value
    return
  }
  if (field === 'enabled' || field === 'interrupt') {
    checkBoolean(path, value, target, field, issues)
    return
  }
  checkNumber(path, value, target, field, issues)
}

/**
 * Walk a patch over the DEFAULT_CONFIG shape, merging valid fields onto a
 * clone of `base`. Strict mode (PUT) collects every problem and throws
 * {@link ConfigValidationError}; lenient mode (file load) skips them.
 */
function mergeConfig(patch: unknown, base: ThrowPhysicsPluginConfig, strict: boolean): ThrowPhysicsPluginConfig {
  const merged = structuredClone(base)
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    if (strict) throw new ConfigValidationError([{ path: '', message: 'expected a config object' }])
    return merged
  }
  const issues: ConfigIssue[] = []
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === PHYSICS_SECTION || key === BOUNCE_SECTION || key === FLASH_SECTION) {
      const section = key as SectionKey
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        issues.push({ path: key, message: 'expected an object' })
        continue
      }
      for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
        if (!SECTION_FIELDS[section].includes(field)) {
          if (strict) issues.push({ path: `${key}.${field}`, message: 'unknown field' })
          continue
        }
        checkSectionField(section, field, fieldValue, merged, issues)
      }
      continue
    }
    if (key === SLIDE_ANIMATION_FIELD) {
      // null (default, no slide animation) or a non-empty library id.
      if (
        value !== null &&
        (typeof value !== 'string' || value.length === 0 || value.length > ANIMATION_ID_MAX_LENGTH)
      ) {
        issues.push({
          path: key,
          message: `expected null or a non-empty id of at most ${ANIMATION_ID_MAX_LENGTH} characters`,
        })
        continue
      }
      ;(merged as unknown as Target)[key] = value
      continue
    }
    if (key === SLIDE_INTERRUPT_FIELD) {
      // Boolean, like bounceAnimation.interrupt; absent on legacy files → default.
      checkBoolean(key, value, merged as unknown as Target, key, issues)
      continue
    }
    if ((TOP_LEVEL_NUMERIC as readonly string[]).includes(key)) {
      checkNumber(key, value, merged as unknown as Target, key, issues)
      continue
    }
    if (strict) issues.push({ path: key, message: 'unknown field' })
  }
  if (strict && issues.length > 0) throw new ConfigValidationError(issues)
  return merged
}

/**
 * PUT path: strictly validate the (partial or complete) patch against the
 * current config. Unknown fields and out-of-range numbers reject with 400.
 */
export function validateConfigPatch(patch: unknown, base: ThrowPhysicsPluginConfig): ThrowPhysicsPluginConfig {
  return mergeConfig(patch, base, true)
}

/**
 * File-load path: keep every known valid field of a hand-edited/legacy file,
 * silently reset the rest onto defaults. Never throws.
 */
export function repairConfig(raw: unknown): ThrowPhysicsPluginConfig {
  return mergeConfig(raw, DEFAULT_CONFIG, false)
}
