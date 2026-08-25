/**
 * host/storage.ts — atomic JSON persistence for config.json.
 *
 * Same discipline as the main plugin's host/storage.ts (spec §18.2 there):
 * temp file → write + fsync → rename, with concurrent writers serialized
 * through the official `withFileLock` (the official `writeFileAtomic`
 * deliberately skips fsync, so the write is hand-rolled). Copied, not shared:
 * this companion is an independent package and must not import main-plugin
 * runtime code.
 */
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

/**
 * Replace `filePath` with `data` atomically:
 * `<path>.tmp` → write + fsync + close → rename → best-effort dir fsync.
 */
export async function writeJsonAtomic<T>(filePath: string, data: T): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const content = JSON.stringify(data, null, 2)
  await withFileLock(filePath, async () => {
    const tmp = `${filePath}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tmp, filePath)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    // Best effort: directory entry durability. Unsupported on some platforms.
    try {
      const dirHandle = await open(dir, 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch {
      /* directory fsync not supported — rename alone is enough here */
    }
  })
}
