/**
 * host/migrate.ts — one-time config-directory rename for the Petween rename
 * (v0.2.0, 2026-08-26), mirroring the main plugin's host/migrate.ts.
 *
 * This companion's data moved from `$DSH_HOME/motion-pet-physics/config.json`
 * to `$DSH_HOME/petween-physics/config.json`. src/index.ts calls
 * {@link migrateLegacyHome} once per boot BEFORE PhysicsConfigStore is
 * constructed, so the store can never read defaults out of an empty new
 * directory while the old config still exists.
 *
 * Policy (strict, old data is never destroyed):
 * 1. target (`$DSH_HOME/petween-physics`) already exists → skip entirely.
 * 2. only the legacy dir exists → `fs.renameSync` onto the target (atomic
 *    within one volume, legacy location gone in the same step).
 * 3. rename fails (EXDEV across volumes, EBUSY/EPERM while held open on
 *    Windows) → `fs.cpSync(..., { recursive: true })` and KEEP the legacy
 *    directory as the safety copy.
 * 4. even the copy fails → warn, best-effort remove a half-written target so
 *    the next boot retries, keep booting on defaults. Never crash the plugin
 *    over its own migration. Exception: if the legacy dir vanished meanwhile,
 *    a concurrent process won the rename — its target is kept (skip).
 */
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs'

/** What {@link migrateLegacyHome} ended up doing. */
export type MigrationOutcome = 'renamed' | 'copied' | 'skipped' | 'failed'

/** Filesystem operations, injectable for tests (defaults: node:fs). */
export interface MigrateLegacyHomeDeps {
  renameDirSync(from: string, to: string): void
  copyDirSync(from: string, to: string): void
}

const defaultDeps: MigrateLegacyHomeDeps = {
  renameDirSync: (from, to) => renameSync(from, to),
  copyDirSync: (from, to) =>
    // force:false + errorOnExist:true: never overwrite anything that snuck
    // onto the target between the existsSync check and here.
    cpSync(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true }),
}

/**
 * Move one legacy data directory onto its new name, never losing data.
 * Synchronous on purpose: it must complete before the config store reads.
 */
export function migrateLegacyHome(
  legacyDir: string,
  targetDir: string,
  deps: MigrateLegacyHomeDeps = defaultDeps,
): MigrationOutcome {
  if (existsSync(targetDir)) return 'skipped'
  if (!existsSync(legacyDir)) return 'skipped'
  try {
    deps.renameDirSync(legacyDir, targetDir)
    return 'renamed'
  } catch {
    // Cross-volume or locked source: copy and keep the legacy directory.
    try {
      deps.copyDirSync(legacyDir, targetDir)
      return 'copied'
    } catch (error) {
      // Concurrency guard: if the legacy dir has vanished since the check at
      // the top, a concurrent process completed the rename migration while we
      // were failing — the target now holds that winner's fully migrated
      // data, and removing it would destroy the only copy. Skip instead.
      if (!existsSync(legacyDir)) return 'skipped'
      // Re-check immediately before the remove: a concurrent winner may have
      // renamed legacy onto the target AFTER the guard above passed — from
      // that moment the target is the winner's ONLY copy and rmSync would
      // destroy it. (A microsecond TOCTOU remains between this check and the
      // rmSync; on Windows a rename onto a non-empty target fails anyway, so
      // the re-check closes every practically reachable interleaving.)
      if (!existsSync(legacyDir)) return 'skipped'
      // Drop a partial copy so the next boot retries from a clean slate;
      // never touch the legacy tree.
      try {
        rmSync(targetDir, { recursive: true, force: true })
      } catch {
        /* best effort — a leftover partial dir just means "skip next boot" */
      }
      console.warn(`petween-physics: failed to migrate ${legacyDir} to ${targetDir}`, error)
      return 'failed'
    }
  }
}
