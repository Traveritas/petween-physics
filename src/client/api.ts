/**
 * client/api.ts — typed fetch wrapper for this plugin's host route (plus the
 * one cross-plugin READ of the main plugin's animation library for the
 * settings card's id dropdown). Same-origin only; every failure is an
 * {@link ApiError} carrying the host error code (`INVALID_CONFIG`, …) or
 * `NETWORK`/`HTTP_*`.
 *
 * Endpoints:
 * - GET /api/petween-physics/config → { config }        (this plugin's host)
 * - PUT /api/petween-physics/config → { config } | 400 INVALID_CONFIG
 * - GET /api/petween/animations     → { customs, warnings } (main plugin,
 *   read-only; failures degrade to the hardcoded builtin list)
 * - GET /api/petween/pets/<id>      → { pet } (main plugin, read-only; the
 *   §12 pet-package pluginConfigs pocket lives on the pet record)
 */
import type { PhysicsConfigPatch, ThrowPhysicsPluginConfig } from './config'

const CONFIG_URL = '/api/petween-physics/config'
const PETWEEN_ANIMATIONS_URL = '/api/petween/animations'
const PETWEEN_PETS_URL = '/api/petween/pets'

export class ApiError extends Error {
  override readonly name = 'ApiError'
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

/** Host error bodies: `{ error: { code, message, details? } }`. */
interface ErrorBody {
  error?: string | { code?: string; message?: string; details?: unknown }
}

async function parseError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`
  let message = response.statusText !== '' ? response.statusText : `request failed (${response.status})`
  let details: unknown
  try {
    const body = (await response.json()) as ErrorBody
    if (typeof body.error === 'string') {
      code = body.error
      message = body.error
    } else if (typeof body.error === 'object' && body.error !== null) {
      if (typeof body.error.code === 'string') code = body.error.code
      if (typeof body.error.message === 'string') message = body.error.message
      details = body.error.details
    }
  } catch {
    // non-JSON error body: keep the HTTP-derived code/message
  }
  return new ApiError(response.status, code, message, details)
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new ApiError(0, 'NETWORK', error instanceof Error ? error.message : 'network error')
  }
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as T
}

export function getPhysicsConfig(): Promise<{ config: ThrowPhysicsPluginConfig }> {
  return request(CONFIG_URL)
}

/**
 * PUT a partial or complete config; the host validates against the current
 * on-disk config and answers with the full merged config.
 */
export function putPhysicsConfig(patch: PhysicsConfigPatch): Promise<{ config: ThrowPhysicsPluginConfig }> {
  return request(CONFIG_URL, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/**
 * The subset of the main plugin's AnimationDefinition the card needs.
 * kind/repeatMode come from the definition's `kind` / `repeat.mode` — the
 * card filters the dropdowns to one-shot interactions (a repeat 'loop'
 * animation played through the service would run forever and never settle).
 */
export interface AnimationOption {
  id: string
  name: string
  kind: string
  repeatMode: string
}

/**
 * What GET /api/petween/animations actually answers: `customs` carries FULL
 * AnimationDefinitions (petween src/motion/animation-definition.ts), not
 * bare id/name pairs. Parsed defensively: a missing kind/repeat degrades to
 * empty strings, which the card's filter then keeps out of the dropdowns.
 */
interface AnimationsResponse {
  customs: Array<{ id: string; name: string; kind?: unknown; repeat?: { mode?: unknown } }>
  warnings?: string[]
}

/**
 * Read the main plugin's custom animation library for the impact/slide
 * animation dropdowns (id/name plus the kind/repeat fields the card's filter
 * needs). A failure (main plugin absent/old) is the CALLER's signal to fall
 * back to the builtin list — never a card crash.
 */
export async function getPetweenAnimations(): Promise<{ customs: AnimationOption[]; warnings: string[] }> {
  const body = await request<AnimationsResponse>(PETWEEN_ANIMATIONS_URL)
  return {
    customs: body.customs.map((custom) => ({
      id: custom.id,
      name: custom.name,
      kind: typeof custom.kind === 'string' ? custom.kind : '',
      repeatMode: typeof custom.repeat?.mode === 'string' ? custom.repeat.mode : '',
    })),
    warnings: body.warnings ?? [],
  }
}

/**
 * This plugin's pocket of a pet record's §12 pluginConfigs: an opaque config
 * blob plus the import-time animation-id remap (requestedId → finalId; the
 * main plugin injects the map but never rewrites the blob — that is our job
 * at apply time, see client/shared-pet-config.ts).
 */
export interface PetPluginConfigShare {
  /** The sharing pet's display name (for the confirmation banner). */
  petName: string
  config: unknown
  animationIdRemap?: Record<string, string>
}

/** What GET /api/petween/pets/<id> answers; parsed defensively — an older main plugin has no pluginConfigs at all. */
interface PetResponse {
  pet?: {
    name?: unknown
    pluginConfigs?: unknown
  }
}

/** Keep only string→string pairs of a defensively-read remap. */
function sanitizeRemap(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const remap: Record<string, string> = {}
  for (const [from, to] of Object.entries(raw)) {
    if (typeof to === 'string') remap[from] = to
  }
  return Object.keys(remap).length > 0 ? remap : undefined
}

/**
 * Read this plugin's pluginConfigs pocket off a pet record (main plugin,
 * read-only; GETs carry no cross-origin fence). Returns null when the pocket
 * or the whole field is absent (pet without a blob, older main plugin) — an
 * HTTP/network failure still throws for the caller to swallow silently.
 */
export async function getPetPluginConfigShare(petId: string, pluginId: string): Promise<PetPluginConfigShare | null> {
  const body = await request<PetResponse>(`${PETWEEN_PETS_URL}/${encodeURIComponent(petId)}`)
  const pet = body.pet
  if (pet === undefined || typeof pet.pluginConfigs !== 'object' || pet.pluginConfigs === null) return null
  const raw = (pet.pluginConfigs as Record<string, unknown>)[pluginId]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !('config' in raw)) return null
  const entry = raw as { config: unknown; animationIdRemap?: unknown }
  const remap = sanitizeRemap(entry.animationIdRemap)
  return {
    petName: typeof pet.name === 'string' && pet.name !== '' ? pet.name : petId,
    config: entry.config,
    ...(remap === undefined ? {} : { animationIdRemap: remap }),
  }
}
