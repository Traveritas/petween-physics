/**
 * host/config.ts — config.json persistence for the runtime configuration
 * (the settings card's backend).
 *
 * The validation walkers live in ../client/config.ts (single source of truth
 * for shape/defaults/ranges; the browser half strictly pre-checks pet-package
 * shared blobs with the exact same REJECT policy) and are re-exported here
 * for the host route and tests:
 * - strict (PUT): unknown fields and bad values become issues → 400.
 * - lenient (load): a hand-edited or legacy file keeps every KNOWN valid
 *   field and silently resets the rest onto defaults; only unparsable JSON
 *   counts as "corrupt" (warn + rewrite the defaults).
 */
import { readFile } from 'node:fs/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  DEFAULT_CONFIG,
  repairConfig,
  validateConfigPatch,
  type ThrowPhysicsPluginConfig,
} from '../client/config'
import { writeJsonAtomic } from './storage'

export { ConfigValidationError, repairConfig, validateConfigPatch } from '../client/config'
export type { ConfigIssue } from '../client/config'

export function defaultConfigPath(): string {
  return dshHomePath('petween-physics', 'config.json')
}

export interface PhysicsConfigStoreOptions {
  /** Defaults to `$DSH_HOME/petween-physics/config.json`. */
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
      console.warn('petween-physics: config.json is corrupt — restoring defaults', error)
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
