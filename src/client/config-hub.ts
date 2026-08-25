/**
 * client/config-hub.ts — the lightweight config center for this companion
 * (a much smaller sibling of the main plugin's ConfigHub; independent code).
 *
 * Roles:
 * - `load()` — one GET, memoized: the throw controller and the settings card
 *   share the result (whichever mounts first pays it).
 * - `subscribe(cb)` + `getSnapshot()` — useSyncExternalStore-compatible
 *   change notification (the card re-renders on save-state transitions).
 * - `getConfig()` — the synchronous read the ThrowController performs per
 *   gesture/per frame; DEFAULT_CONFIG until the first load lands (a failed
 *   load falls back silently to defaults and only surfaces its error state).
 * - `update(patch)` — PUT + broadcast the merged config on success; a failed
 *   save sets `saveError` for the card to show without touching the last
 *   known-good config.
 *
 * Pure TS, no React/DSH. The default singleton {@link physicsConfigHub} is
 * what the client entry shares; tests construct their own with injected
 * fetchers.
 */
import { getPhysicsConfig, putPhysicsConfig } from './api'
import { DEFAULT_CONFIG, type PhysicsConfigPatch, type ThrowPhysicsPluginConfig } from './config'

export interface PhysicsHubSnapshot {
  /** Always usable: DEFAULT_CONFIG until the first successful load. */
  config: ThrowPhysicsPluginConfig
  /** True once a GET succeeded (or a save established state). */
  loaded: boolean
  /** Last load failure; the form still runs on defaults while set. */
  loadError: string | null
  /** A PUT is in flight (the card's "saving…" indicator). */
  saving: boolean
  /** Last save failure; the config stays at the last known-good value. */
  saveError: string | null
}

export type PhysicsConfigListener = (snapshot: PhysicsHubSnapshot) => void

export interface PhysicsConfigHubOptions {
  /** Test seam; production hits the real same-origin HTTP API. */
  fetchConfig?: () => Promise<{ config: ThrowPhysicsPluginConfig }>
  /** Test seam for PUT. */
  sendConfig?: (patch: PhysicsConfigPatch) => Promise<{ config: ThrowPhysicsPluginConfig }>
}

const INITIAL_SNAPSHOT: PhysicsHubSnapshot = {
  config: DEFAULT_CONFIG,
  loaded: false,
  loadError: null,
  saving: false,
  saveError: null,
}

export class PhysicsConfigHub {
  private readonly fetchConfig: () => Promise<{ config: ThrowPhysicsPluginConfig }>
  private readonly sendConfig: (patch: PhysicsConfigPatch) => Promise<{ config: ThrowPhysicsPluginConfig }>
  private readonly listeners = new Set<PhysicsConfigListener>()
  private snapshot: PhysicsHubSnapshot = INITIAL_SNAPSHOT
  private loadPromise: Promise<PhysicsHubSnapshot> | null = null

  constructor(options: PhysicsConfigHubOptions = {}) {
    this.fetchConfig = options.fetchConfig ?? getPhysicsConfig
    this.sendConfig = options.sendConfig ?? putPhysicsConfig
  }

  /** The first caller triggers the single GET; everyone else shares it. */
  load(): Promise<PhysicsHubSnapshot> {
    if (this.loadPromise !== null) return this.loadPromise
    this.loadPromise = this.fetchConfig().then(
      ({ config }) => {
        this.snapshot = {
          config,
          loaded: true,
          loadError: null,
          saving: this.snapshot.saving,
          saveError: this.snapshot.saveError,
        }
        this.emit()
        return this.snapshot
      },
      (error: unknown) => {
        // Silent fallback: DEFAULT_CONFIG keeps the throw controller fully
        // functional; the error state tells the card (and its retry button).
        this.snapshot = {
          config: DEFAULT_CONFIG,
          loaded: false,
          loadError: error instanceof Error ? error.message : String(error),
          saving: this.snapshot.saving,
          saveError: this.snapshot.saveError,
        }
        this.emit()
        // A failed load may be retried (the card's retry button re-calls load).
        this.loadPromise = null
        return this.snapshot
      },
    )
    return this.loadPromise
  }

  /** Synchronous read for the throw controller (per gesture, per frame). */
  getConfig(): ThrowPhysicsPluginConfig {
    return this.snapshot.config
  }

  getSnapshot(): PhysicsHubSnapshot {
    return this.snapshot
  }

  subscribe(listener: PhysicsConfigListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * PUT a partial config. On success the server-merged config replaces the
   * local one and is broadcast (clone: later caller mutations cannot leak
   * into subscribers). On failure only `saveError` changes — the last
   * known-good config stands.
   */
  async update(patch: PhysicsConfigPatch): Promise<void> {
    this.set({ saving: true, saveError: null })
    try {
      const { config } = await this.sendConfig(patch)
      this.set({ config: structuredClone(config), loaded: true, loadError: null, saving: false, saveError: null })
    } catch (error) {
      this.set({ saving: false, saveError: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Restore the factory defaults (the card's "reset" button). */
  reset(): Promise<void> {
    return this.update(structuredClone(DEFAULT_CONFIG))
  }

  private set(partial: Partial<PhysicsHubSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.snapshot)
  }
}

/** The app-wide hub shared by the throw controller and the settings card. */
export const physicsConfigHub = new PhysicsConfigHub()
