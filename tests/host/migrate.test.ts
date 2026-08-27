/**
 * host/migrate.ts — one-time rename of this plugin's config directory
 * ($DSH_HOME/motion-pet-physics → $DSH_HOME/petween-physics, v0.2.0).
 * Contract under test: the user's persisted config survives every path, the
 * old tree is never destroyed, and the migration is idempotent.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacyHome, type MigrateLegacyHomeDeps } from '../../src/host/migrate'

/** Roots created during a test; removed afterwards whatever it asserted. */
const roots: string[] = []

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'petween-physics-migrate-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** A realistic legacy home: config.json plus a stray editor backup file. */
function seedLegacyHome(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ physics: { gravity: 2400 }, flashPose: { enabled: true } }))
  writeFileSync(join(dir, 'config.json.bak'), '{"physics":{"gravity":1800}}')
}

/** deps that make renameSync fail the way a cross-volume move does. */
const renameAlwaysFails: Pick<MigrateLegacyHomeDeps, 'renameDirSync'> = {
  renameDirSync: () => {
    const error = new Error('cross-device link') as NodeJS.ErrnoException
    error.code = 'EXDEV'
    throw error
  },
}

describe('migrateLegacyHome', () => {
  it('renames the legacy config dir onto the new path: content identical, legacy gone', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet-physics')
    const target = join(home, 'petween-physics')
    seedLegacyHome(legacy)

    expect(migrateLegacyHome(legacy, target)).toBe('renamed')

    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe(
      JSON.stringify({ physics: { gravity: 2400 }, flashPose: { enabled: true } }),
    )
    expect(readFileSync(join(target, 'config.json.bak'), 'utf8')).toBe('{"physics":{"gravity":1800}}')
    // Idempotent: the second boot sees only the target and does nothing.
    expect(migrateLegacyHome(legacy, target)).toBe('skipped')
  })

  it('skips entirely when the new home already exists: both trees untouched', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet-physics')
    const target = join(home, 'petween-physics')
    seedLegacyHome(legacy)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'config.json'), 'fresh install')

    expect(migrateLegacyHome(legacy, target)).toBe('skipped')

    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe('fresh install')
    expect(readFileSync(join(legacy, 'config.json'), 'utf8')).toBe(
      JSON.stringify({ physics: { gravity: 2400 }, flashPose: { enabled: true } }),
    )
  })

  it('has no side effect when the legacy home never existed (fresh install)', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet-physics')
    const target = join(home, 'petween-physics')

    expect(migrateLegacyHome(legacy, target)).toBe('skipped')
    expect(existsSync(target)).toBe(false) // no directory may be created
    expect(existsSync(legacy)).toBe(false)
  })

  it('falls back to copy-and-keep when rename fails (cross-volume / locked)', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet-physics')
    const target = join(home, 'petween-physics')
    seedLegacyHome(legacy)

    const outcome = migrateLegacyHome(legacy, target, {
      ...renameAlwaysFails,
      copyDirSync: (from, to) => {
        // The real cpSync with the exact options src/host/migrate.ts uses.
        cpSync(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
      },
    })
    expect(outcome).toBe('copied')

    // The safety net: new home readable, legacy tree still there.
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe(
      JSON.stringify({ physics: { gravity: 2400 }, flashPose: { enabled: true } }),
    )
    expect(existsSync(join(legacy, 'config.json'))).toBe(true)
  })

  it('keeps the winner data when a concurrent process renamed the legacy dir away mid-flight (no rm of the target)', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet-physics')
    const target = join(home, 'petween-physics')
    seedLegacyHome(legacy)

    const outcome = migrateLegacyHome(legacy, target, {
      // Race simulation: by the time OUR rename "fails", another process has
      // already completed the rename migration — legacy gone, target fully
      // populated with the only surviving copy of the user's data.
      renameDirSync: (_from, to) => {
        rmSync(legacy, { recursive: true, force: true })
        mkdirSync(to, { recursive: true })
        writeFileSync(join(to, 'config.json'), 'migrated by the winner')
        throw new Error('EPERM: operation not permitted (target appeared)')
      },
      copyDirSync: () => {
        // cpSync would fail the same way: errorOnExist hits the winner's target.
        throw new Error('EEXIST: file already exists')
      },
    })
    expect(outcome).toBe('skipped')
    // The winner's data survives; the old "failed" path would have rmSync'd it.
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe('migrated by the winner')
    expect(existsSync(legacy)).toBe(false)
  })

  it('warns, cleans a partial target and keeps the legacy home when even the copy fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const home = makeHome()
      const legacy = join(home, 'motion-pet-physics')
      const target = join(home, 'petween-physics')
      seedLegacyHome(legacy)

      const outcome = migrateLegacyHome(legacy, target, {
        renameDirSync: () => {
          throw new Error('EXDEV: cross-device link not permitted')
        },
        copyDirSync: () => {
          throw new Error('ENOSPC: no space left on device')
        },
      })
      expect(outcome).toBe('failed')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain('petween-physics:')
      // Partial target removed (next boot retries), legacy data intact.
      expect(existsSync(target)).toBe(false)
      expect(existsSync(join(legacy, 'config.json'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})
