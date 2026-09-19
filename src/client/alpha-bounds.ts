/**
 * client/alpha-bounds.ts — the visible-pixel (alpha) tight bounds of a pose
 * image, for the collision.ignoreTransparentPixels setting.
 *
 * Two layers, deliberately split:
 * - {@link computeAlphaBounds}: the pure scanner over raw RGBA pixels. The
 *   collision model needs a RECTANGLE, so the scan yields the tight bounding
 *   box of every pixel whose alpha reaches the threshold — an L-shaped pose
 *   produces the box around the whole L, not two boxes. Normalized to
 *   fractions of the image so one scan serves every stage size, user scale
 *   and pose zoom (the consumer multiplies by the live <img> box).
 * - {@link createAlphaBoundsScanner}: the URL-keyed async cache around it.
 *   One scan per (url, threshold), ever — a pose image is immutable (asset
 *   ids are content-stable; a re-import gets a new id). Failures are NOT
 *   cached: a transient load failure retries on the next trigger (drag start
 *   / pose swap), and a permanently dead URL costs one failed fetch per
 *   gesture on localhost.
 *
 * Poses are static PNG/WebP/JPEG by the main plugin's upload contract (no
 * GIF/APNG), so a single raster is the truth for the whole file. JPEG has no
 * alpha at all: every pixel reads 255 and the scan is a harmless full box.
 * The DOM raster is downscaled to ≤512px before readback (a 4096² original
 * would otherwise allocate a 67MB ImageData for a few fractions); bilinear
 * bleed at transparent edges can only WIDEN the box by a fraction of a
 * downscaled pixel — the safe direction for a collision box.
 */

/**
 * Tight visible-pixel bounds, normalized within the image: each value is the
 * fully-transparent margin as a FRACTION of the image's own width/height
 * from that edge (0..1; left+right < 1 whenever any pixel is visible).
 */
export interface NormalizedAlphaBounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** Raw RGBA pixels; the DOM layer hands over an ImageData, tests a literal. */
export interface RgbaPixels {
  readonly data: ArrayLike<number>
  readonly width: number
  readonly height: number
}

/** Clamp a hand-set threshold into the sane 1..255 band (>=1 ignores only fully-transparent). */
function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(255, Math.max(1, Math.round(value)))
}

/**
 * Scan RGBA pixels for the tight bounding box of every pixel with alpha ≥
 * threshold. Null when nothing is visible (the caller falls back to the
 * unrefined image box — an all-transparent pose image is data corruption,
 * not a collision shape).
 */
export function computeAlphaBounds(pixels: RgbaPixels, alphaThreshold: number): NormalizedAlphaBounds | null {
  const { data, width, height } = pixels
  if (!(width > 0) || !(height > 0)) return null
  const threshold = clampThreshold(alphaThreshold)
  let minX = -1
  let maxX = -1
  let minY = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width
    for (let x = 0; x < width; x += 1) {
      if (data[(rowOffset + x) * 4 + 3]! >= threshold) {
        if (minX === -1) {
          minX = x
          minY = y
        } else if (x < minX) {
          minX = x
        }
        if (x > maxX) maxX = x
        maxY = y
      }
    }
  }
  if (minX === -1) return null
  return {
    left: minX / width,
    top: minY / height,
    right: (width - 1 - maxX) / width,
    bottom: (height - 1 - maxY) / height,
  }
}

/** Longest canvas side the DOM scanner rasterizes (downscale cap, px). */
export const DEFAULT_MAX_SCAN_SIZE = 512

/**
 * Rasterize one same-origin image URL and scan it. Any failure (dead URL,
 * decode error, canvas readback) rejects — the cache layer turns that into a
 * retryable null. Kept as a separate function so tests can stub the whole
 * DOM part and the factory below stays logic-only.
 */
async function scanUrlViaCanvas(
  url: string,
  threshold: number,
  maxScanSize: number,
): Promise<NormalizedAlphaBounds | null> {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error(`pose image failed to load: ${url}`))
    image.src = url
  })
  const naturalWidth = image.naturalWidth
  const naturalHeight = image.naturalHeight
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null
  const scale = Math.min(1, maxScanSize / Math.max(naturalWidth, naturalHeight))
  const width = Math.max(1, Math.round(naturalWidth * scale))
  const height = Math.max(1, Math.round(naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  context.clearRect(0, 0, width, height) // transparent base — JPEG stays opaque, PNG margins read 0
  context.drawImage(image, 0, 0, width, height)
  return computeAlphaBounds(context.getImageData(0, 0, width, height), threshold)
}

export interface AlphaBoundsScannerOptions {
  /** Reads the alpha threshold (1..255) at SCAN time — use-time config, like the rest of the plugin. */
  getThreshold: () => number
  /** Test seam replacing the whole DOM raster + scan. */
  scanImage?: (url: string, threshold: number) => Promise<NormalizedAlphaBounds | null>
  /** Downscale cap; defaults to {@link DEFAULT_MAX_SCAN_SIZE}. */
  maxScanSize?: number
}

/**
 * Build the URL→bounds resolver: per-(url, threshold) promise cache with
 * in-flight dedupe; failures resolve null AND drop their cache entry so the
 * next trigger retries. The returned function never rejects.
 */
export function createAlphaBoundsScanner(
  options: AlphaBoundsScannerOptions,
): (url: string) => Promise<NormalizedAlphaBounds | null> {
  const maxScanSize = options.maxScanSize ?? DEFAULT_MAX_SCAN_SIZE
  const scanImage = options.scanImage ?? ((url, threshold) => scanUrlViaCanvas(url, threshold, maxScanSize))
  const cache = new Map<string, Promise<NormalizedAlphaBounds | null>>()
  return (url: string): Promise<NormalizedAlphaBounds | null> => {
    const threshold = clampThreshold(options.getThreshold())
    const key = `${threshold}:${url}`
    let entry = cache.get(key)
    if (entry === undefined) {
      entry = scanImage(url, threshold).catch(() => null)
      cache.set(key, entry)
      // Don't pin failures: a null answer frees the slot for a later retry.
      void entry.then((bounds) => {
        if (bounds === null) cache.delete(key)
      })
    }
    return entry
  }
}
