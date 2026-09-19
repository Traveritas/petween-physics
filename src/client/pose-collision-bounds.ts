/**
 * client/pose-collision-bounds.ts — (petId, poseKey) → the alpha-tight
 * bounds of the pose image currently on stage (collision.ignoreTransparentPixels).
 *
 * Pipeline: pet record (poseKey → assetId, one flat lookup — the stage
 * snapshot's poseKey is already the post-fallback slot) → `/petween-assets/<id>`
 * → the cached alpha scan. Every failure is a silent null and the controller
 * keeps the pose-image box; nothing here may ever reject or disturb the user.
 *
 * Freshness policy: the pet record is fetched per ASK (deduped while in
 * flight) and NOT cached — the main plugin's editor can remap a pose to a
 * different asset mid-session, and the next gesture should see it. The alpha
 * scan, by contrast, is cached forever per (url, threshold): asset ids are
 * content-stable, so a re-import landing on the same URL is the same pixels.
 */
import { getPetPoseAssets } from './api'
import { createAlphaBoundsScanner, type NormalizedAlphaBounds } from './alpha-bounds'
import { physicsConfigHub } from './config-hub'

export interface PoseCollisionBoundsOptions {
  /** Reads the pet record's pose→asset map (main plugin HTTP). Test seam. */
  fetchPoseAssets?: (petId: string) => Promise<Record<string, string> | null>
  /** Reads the alpha threshold (1..255) at scan time. Test seam; default = the live config. */
  getThreshold?: () => number
  /** The DOM raster + pixel scan. Test seam; default = the canvas scanner. */
  scanImage?: (url: string, threshold: number) => Promise<NormalizedAlphaBounds | null>
}

/**
 * Build the resolver the ThrowController receives as its
 * `getPoseAlphaBounds` seam. Both entries (DSH browser half, desktop
 * companion) wire the default construction; tests inject fakes for every
 * stage of the pipeline.
 */
export function createPoseCollisionBoundsProvider(
  options: PoseCollisionBoundsOptions = {},
): (petId: string, poseKey: string) => Promise<NormalizedAlphaBounds | null> {
  const fetchPoseAssets = options.fetchPoseAssets ?? getPetPoseAssets
  const scan = createAlphaBoundsScanner({
    getThreshold: options.getThreshold ?? (() => physicsConfigHub.getConfig().collision.alphaThreshold),
    scanImage: options.scanImage,
  })
  /** One in-flight pet-record fetch per pet id — deliberately no result cache (see header). */
  const inflightRecords = new Map<string, Promise<Record<string, string> | null>>()
  const loadPoseAssets = (petId: string): Promise<Record<string, string> | null> => {
    let pending = inflightRecords.get(petId)
    if (pending === undefined) {
      pending = fetchPoseAssets(petId).catch(() => null)
      inflightRecords.set(petId, pending)
      void pending.finally(() => {
        if (inflightRecords.get(petId) === pending) inflightRecords.delete(petId)
      })
    }
    return pending
  }
  return async (petId: string, poseKey: string): Promise<NormalizedAlphaBounds | null> => {
    if (petId === '' || poseKey === '') return null
    const poseAssets = await loadPoseAssets(petId)
    const assetId = poseAssets?.[poseKey]
    if (assetId === undefined) return null
    return scan(`/petween-assets/${encodeURIComponent(assetId)}`)
  }
}
