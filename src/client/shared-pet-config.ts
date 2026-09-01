/**
 * client/shared-pet-config.ts — the consumer half of §12 pet-package
 * pluginConfigs (petween docs/preset-authority-eval.md 评估二, P2).
 *
 * A pet package can carry an opaque config blob for this plugin on the pet
 * record (`pluginConfigs['petween-physics']`). The main plugin only stores
 * and serves the blob — PULLING it, REWRITING its animation ids with the
 * import-time remap, VALIDATING it against our own strict schema, ASKING the
 * user, and APPLYING it through our own PUT route are all this plugin's
 * policy ("the main plugin provides capabilities, never policies").
 *
 * This center owns the pull pipeline up to the pending offer; the settings
 * card owns the confirm/apply UX:
 *
 *   checkActivePet(petId)          (boot once + on active-pet change)
 *     → GET /api/petween/pets/<id> → pocket (absent/old provider → silent)
 *     → rewrite slideAnimationId / bounceAnimation.id via animationIdRemap
 *     → validateConfigPatch (our strict REJECT policy; invalid → silent)
 *     → merged ≡ current config?   → silent (already in effect)
 *     → content key already handled? → silent (applied/dismissed before)
 *     → otherwise set the pending offer the card renders
 *
 * Bookkeeping: a handled offer is remembered by its CANONICAL CONTENT key
 * (deterministic JSON, sorted keys) in localStorage — string equality, no
 * hash function, so there are no collisions; the list is capped at 16 and
 * the key covers content only (not the pet id), so re-importing the same
 * personality under a new pet never re-prompts. When localStorage is
 * unusable (privacy mode) an in-memory set covers the session.
 *
 * Pure TS, no React/DSH. The default singleton {@link sharedPetConfigCenter}
 * is what the client entry and the card share; tests construct their own
 * with injected seams.
 */
import { getPetPluginConfigShare, type PetPluginConfigShare } from './api'
import { validateConfigPatch, type PhysicsConfigPatch, type ThrowPhysicsPluginConfig } from './config'
import { physicsConfigHub } from './config-hub'

/** Our cordis name = the pluginConfigs namespace key on the pet record. */
export const PLUGIN_ID = 'petween-physics'

const STORAGE_KEY = 'petween-physics:handled-shared-configs'
/** Bounded history: enough to never re-prompt, small enough to never matter. */
const MAX_HANDLED_KEYS = 16

/** One display row of the confirmation summary: a blob leaf that differs from the current config. */
export interface SharedConfigChange {
  /** Dotted config path ('physics.gravity'); the card maps it to a label. */
  path: string
  from: unknown
  to: unknown
}

/** A pulled blob that survived every gate and waits for the user's decision. */
export interface PendingSharedPetConfig {
  petId: string
  petName: string
  /** The remapped, strictly validated blob — PUT it verbatim (host merges). */
  patch: PhysicsConfigPatch
  changes: SharedConfigChange[]
  /** Canonical content key used for the applied/dismissed bookkeeping. */
  key: string
}

/**
 * Deterministic JSON for config-shaped values (objects serialize with sorted
 * keys, so key order never affects equality). Doubles as the deep-equal
 * oracle: canonicalize(a) === canonicalize(b) ⇔ a and b are the same JSON.
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * Rewrite the two fields that reference main-plugin animation ids — the
 * ground-slide one-shot and the wall-impact animation — using the import-time
 * remap. Everything else is returned byte-identical (the blob is opaque to
 * us beyond these two references); a missing remap leaves the blob untouched.
 */
export function rewriteSharedAnimationIds(config: unknown, remap: Record<string, string> | undefined): unknown {
  if (remap === undefined || typeof config !== 'object' || config === null || Array.isArray(config)) {
    return config
  }
  const rewritten = structuredClone(config) as Record<string, unknown>
  if (typeof rewritten.slideAnimationId === 'string') {
    const to = remap[rewritten.slideAnimationId]
    if (to !== undefined) rewritten.slideAnimationId = to
  }
  const bounce = rewritten.bounceAnimation
  if (typeof bounce === 'object' && bounce !== null && !Array.isArray(bounce)) {
    const record = bounce as Record<string, unknown>
    if (typeof record.id === 'string') {
      const to = remap[record.id]
      if (to !== undefined) record.id = to
    }
  }
  return rewritten
}

/** Collect the blob leaves that would actually change the current config (the card's summary). */
function collectChanges(patch: unknown, base: unknown, path: string, out: SharedConfigChange[]): void {
  if (typeof patch === 'object' && patch !== null && !Array.isArray(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      const baseValue =
        typeof base === 'object' && base !== null && !Array.isArray(base)
          ? (base as Record<string, unknown>)[key]
          : undefined
      collectChanges(value, baseValue, path === '' ? key : `${path}.${key}`, out)
    }
    return
  }
  if (canonicalize(patch) !== canonicalize(base)) {
    out.push({ path, from: base ?? null, to: patch ?? null })
  }
}

/** localStorage when it actually works (privacy modes throw on access). */
function usableLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage
    const probe = 'petween-physics:storage-probe'
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return storage
  } catch {
    return null
  }
}

export interface SharedPetConfigCenterOptions {
  /** Test seam; production reads the main plugin's pet record over HTTP. */
  fetchShare?: (petId: string) => Promise<PetPluginConfigShare | null>
  /** Test seam; production reads the live config off the shared hub. */
  getConfig?: () => ThrowPhysicsPluginConfig
  /** Test seam; production uses localStorage (with an in-memory fallback). */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

export class SharedPetConfigCenter {
  private readonly fetchShare: (petId: string) => Promise<PetPluginConfigShare | null>
  private readonly getConfig: () => ThrowPhysicsPluginConfig
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Session-level bookkeeping; also the fallback when storage is unusable. */
  private readonly memoryHandled = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private pending: PendingSharedPetConfig | null = null
  /** The pet the last pull targeted; repeat pushes of the same id are free. */
  private lastRequestedPetId: string | null = null
  /** Bumped per pull; only the newest pull may write the pending offer. */
  private pullSeq = 0

  constructor(options: SharedPetConfigCenterOptions = {}) {
    this.fetchShare = options.fetchShare ?? ((petId) => getPetPluginConfigShare(petId, PLUGIN_ID))
    this.getConfig = options.getConfig ?? (() => physicsConfigHub.getConfig())
    this.storage = options.storage === undefined ? usableLocalStorage() : options.storage
  }

  getSnapshot(): PendingSharedPetConfig | null {
    return this.pending
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The single pull trigger (client entry: boot once after the hub load, then
   * on every active-pet change). Repeat calls for the same pet are ignored —
   * stage snapshots push often (position, scale), the pet id is what matters.
   * Every failure mode is silent by contract: no pocket, an old main plugin
   * without the field, a rejected request — none of them may disturb the user.
   */
  async checkActivePet(petId: string | null | undefined): Promise<void> {
    if (typeof petId !== 'string' || petId === '') return
    if (petId === this.lastRequestedPetId) return
    this.lastRequestedPetId = petId
    const seq = ++this.pullSeq
    let share: PetPluginConfigShare | null
    try {
      share = await this.fetchShare(petId)
    } catch {
      return // unknown pet / network down / old provider: stay silent
    }
    if (seq !== this.pullSeq) return // a newer pet switch supersedes this pull
    this.setPending(this.plan(petId, share))
  }

  /**
   * Record an offer as handled (applied or ignored) and clear it. The card
   * calls this only AFTER a successful apply, or directly on ignore.
   */
  dismiss(offer: PendingSharedPetConfig): void {
    this.recordHandled(offer.key)
    if (this.pending !== null && this.pending.key === offer.key) this.setPending(null)
  }

  /** Run every gate; null means "nothing to offer" (each reason documented inline). */
  private plan(petId: string, share: PetPluginConfigShare | null): PendingSharedPetConfig | null {
    if (share === null) return null // pet carries no blob for us
    const rewritten = rewriteSharedAnimationIds(share.config, share.animationIdRemap)
    const current = this.getConfig()
    let merged: ThrowPhysicsPluginConfig
    try {
      merged = validateConfigPatch(rewritten, current)
    } catch {
      return null // our own strict REJECT policy: this blob could never apply
    }
    if (canonicalize(merged) === canonicalize(current)) return null // already in effect
    const key = canonicalize(rewritten)
    if (this.isHandled(key)) return null // applied or dismissed before
    const changes: SharedConfigChange[] = []
    collectChanges(rewritten, current, '', changes)
    return { petId, petName: share.petName, patch: rewritten as PhysicsConfigPatch, changes, key }
  }

  private setPending(next: PendingSharedPetConfig | null): void {
    this.pending = next
    // Snapshot: a listener that unsubscribes itself mid-emit must not skip the next one.
    const listeners = [...this.listeners]
    for (const listener of listeners) listener()
  }

  private readHandled(): string[] {
    if (this.storage === null) return []
    try {
      const raw = this.storage.getItem(STORAGE_KEY)
      if (raw === null) return []
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((key): key is string => typeof key === 'string')
    } catch {
      return [] // a corrupt entry just loses the history, never the session
    }
  }

  private isHandled(key: string): boolean {
    return this.memoryHandled.has(key) || this.readHandled().includes(key)
  }

  private recordHandled(key: string): void {
    this.memoryHandled.add(key) // covers this session even if storage fails
    if (this.storage === null) return
    try {
      const next = [key, ...this.readHandled().filter((handled) => handled !== key)].slice(0, MAX_HANDLED_KEYS)
      this.storage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* the memory set already covers this session */
    }
  }
}

/** The app-wide center shared by the client entry (pull triggers) and the settings card (confirm UX). */
export const sharedPetConfigCenter = new SharedPetConfigCenter()
