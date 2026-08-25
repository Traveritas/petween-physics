/**
 * host/config.ts — config.json persistence + validation for the runtime
 * configuration (the settings card's backend).
 *
 * Validation policy (picked deliberately, and applied consistently):
 * REJECT, never clamp. The PUT route answers 400 INVALID_CONFIG with the
 * expected range in the message ("expected a number between 100 and 100000")
 * — a silent clamp would let a broken card write values the user never chose,
 * and the ranges live in one table (CONFIG_NUMERIC_FIELDS) shared with the
 * card's input bounds, so a value the card can send is a value we accept.
 *
 * Two walkers, one shape:
 * - strict (PUT): unknown fields and bad values become issues → 400.
 * - lenient (load): a hand-edited or legacy file keeps every KNOWN valid
 *   field and silently resets the rest onto defaults; only unparsable JSON
 *   counts as "corrupt" (warn + rewrite the defaults).
 */
import { readFile } from 'node:fs/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  ANIMATION_ID_MAX_LENGTH,
  CONFIG_NUMERIC_FIELDS,
  DEFAULT_CONFIG,
  POSE_KEYS,
  type ThrowPhysicsPluginConfig,
} from '../client/config'
import { writeJsonAtomic } from './storage'

export function defaultConfigPath(): string {
  return dshHomePath('motion-pet-physics', 'config.json')
}

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

export interface PhysicsConfigStoreOptions {
  /** Defaults to `$DSH_HOME/motion-pet-physics/config.json`. */
  configPath?: string
}

export class PhysicsConfigStore {
  readonly configPath: string
  /** Serializes update() so concurrent PUTs never lose each other's fields. */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(options: PhysicsConfigStoreOptions = {}) {
    this.configPath = options.configPath ?? defaultConfigPath()
  }

  /**
   * Missing file → defaults (no write; first install stays clean).
   * Unparsable JSON → warn + rewrite the defaults (self-healing).
   * Parsable but partially wrong → lenient field-wise repair.
   */
  async load(): Promise<ThrowPhysicsPluginConfig> {
    let text: string
    try {
      text = await readFile(this.configPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG)
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      console.warn('motion-pet-physics: config.json is corrupt — restoring defaults', error)
      const config = structuredClone(DEFAULT_CONFIG)
      await this.save(config)
      return config
    }
    return repairConfig(raw)
  }

  /** Atomic save (temp + fsync + rename, see host/storage.ts). */
  async save(config: ThrowPhysicsPluginConfig): Promise<void> {
    await writeJsonAtomic(this.configPath, config)
  }

  /**
   * Serialized read-merge-write: the patch is strictly validated against the
   * CURRENT on-disk config and atomically saved, as one unit per caller.
   * Concurrent PUTs queue behind each other instead of clobbering.
   */
  update(patch: unknown): Promise<ThrowPhysicsPluginConfig> {
    const run = this.writeChain.then(async () => {
      const config = validateConfigPatch(patch, await this.load())
      await this.save(config)
      return config
    })
    // A failed update (invalid patch, disk error) must not poison the queue.
    this.writeChain = run.catch(() => undefined)
    return run
  }
}
