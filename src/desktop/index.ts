/**
 * petween-physics desktop entry — the dual-host companion factory for
 * Petween Desktop (Electron shell). Mirrors src/client/index.ts MINUS the
 * cordis/slot wiring: the desktop shell passes the shared `petween/client`
 * service singleton directly and hosts the settings card itself, so this
 * entry only owns the runtime behavior (ThrowController) plus the §12
 * pet-package config pull/push.
 *
 * Dual-host conventions (see README "Desktop host" section):
 * 1. The service arrives via the init context — never acquired from cordis.
 * 2. All HTTP stays root-relative (the desktop local-server serves both the
 *    config route and the main plugin's API same-origin).
 * 3. Behavior classes (ThrowController) stay entry-agnostic; entries only
 *    wire environment seams (clock / viewport / rAF / visibility).
 *
 * The DesktopCompanion shape below is a structural mirror of petween-
 * desktop's canonical interface (same discipline as mirroring petween's
 * service types): this package never depends on the desktop shell.
 */
import type { ComponentType } from 'react'
import { physicsConfigHub } from '../client/config-hub'
import { createPoseCollisionBoundsProvider } from '../client/pose-collision-bounds'
import { PhysicsCard } from '../client/settings/PhysicsCard'
import { PLUGIN_ID, sharedPetConfigCenter } from '../client/shared-pet-config'
import { ThrowController } from '../client/throw-controller'
import type { PetweenClientService } from '../client/types'

export interface DesktopCompanionContext {
  petween: PetweenClientService
}

/**
 * Structural mirror of the shell's controlled settings-card props: the card
 * renders `value` and reports full-config edits through `onChange`.
 */
export interface PluginSettingsCardProps {
  value: unknown
  onChange(next: unknown): void
}

export interface DesktopCompanion {
  id: string
  displayName: string
  description?: string
  /** Optional settings UI the desktop shell hosts in its 插件 section. */
  readonly SettingsCard?: ComponentType<PluginSettingsCardProps>
  /**
   * Optional own persisted config (dual-host plugins that keep their store
   * outside the shell's settings document). When present the settings page
   * edits THIS bag through the card instead of companions.options[id], and
   * the page's apply/cancel bar saves it through this store — load/save are
   * root-relative same-origin HTTP under the desktop local-server.
   */
  readonly configStore?: {
    load(): Promise<unknown>
    /** Persists the config; resolves to the store's normalized result so the
     *  host page can adopt it as its new baseline. */
    save(config: unknown): Promise<unknown>
  }
  init(ctx: DesktopCompanionContext): (() => void) | void
}

/**
 * A failed config-route call with the server's reason when there is one —
 * a bare "HTTP 400" throws away the per-field INVALID_CONFIG diagnostics
 * (which field, which range) the host worked to produce.
 */
async function describePutFailure(response: Response, method: string): Promise<string> {
  const status = `${method} /api/petween-physics/config -> HTTP ${response.status}`
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    if (typeof body.error?.message === 'string' && body.error.message !== '') {
      return `${status}: ${body.error.message}`
    }
  } catch {
    // non-JSON body — keep the status line
  }
  return status
}

export function createPhysicsDesktopCompanion(): DesktopCompanion {
  return {
    id: PLUGIN_ID,
    displayName: '投掷物理（Petween Physics）',
    description: '拖住宠物甩出：重力 + 屏幕边界弹跳 + 可配置撞击特效',
    SettingsCard: PhysicsCard,
    configStore: {
      // GET/PUT /api/petween-physics/config — same route the hub uses; the
      // page bar's PUT propagates exactly like the self-managed card's did.
      load: async () => {
        const response = await fetch('/api/petween-physics/config')
        if (!response.ok) throw new Error(await describePutFailure(response, 'GET'))
        return ((await response.json()) as { config: unknown }).config
      },
      save: async (config) => {
        const response = await fetch('/api/petween-physics/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        })
        if (!response.ok) throw new Error(await describePutFailure(response, 'PUT'))
        return ((await response.json()) as { config: unknown }).config
      },
    },
    init({ petween: service }) {
      let disposed = false
      let unregisterConfigProvider: (() => void) | null = null

      // §12 P3 push: export-time config provider (same gates as the DSH entry).
      const registerConfigProvider = (): void => {
        if (disposed || unregisterConfigProvider !== null) return
        if (service.registerSharedPluginConfigProvider === undefined) return
        if (!physicsConfigHub.getSnapshot().loaded) return
        try {
          unregisterConfigProvider = service.registerSharedPluginConfigProvider(PLUGIN_ID, () =>
            structuredClone(physicsConfigHub.getConfig()),
          )
        } catch {
          /* a broken provider method must not break the boot pull below */
        }
      }

      // §12 pull: offer a companion config shared through the pet record
      // once per boot (after the hub load) and on every active-pet change.
      const checkSharedConfig = (petId: string | null | undefined): void => {
        if (typeof petId !== 'string' || petId === '') return
        if (!physicsConfigHub.getSnapshot().loaded) return
        void sharedPetConfigCenter.checkActivePet(petId)
      }

      void physicsConfigHub.load().then(() => {
        registerConfigProvider()
        checkSharedConfig(service.getStageSnapshot()?.activePetId)
      })
      const unsubscribeStage = service.subscribeStage((snapshot) =>
        checkSharedConfig(snapshot?.activePetId),
      )
      if (service.resyncAnimations !== undefined) {
        void service.resyncAnimations().catch(() => {
          /* sync falls back to the provider's regular poll */
        })
      }

      // The desktop overlay window covers the whole primary display, so the
      // browser viewport IS the OS screen bounds (DIP) — the same getter the
      // DSH entry uses, no desktop-specific math needed.
      const controller = new ThrowController({
        service,
        getConfig: () => physicsConfigHub.getConfig(),
        now: () => performance.now(),
        getViewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
        scheduleFrame: (callback) => {
          const handle = requestAnimationFrame(() => callback())
          return () => cancelAnimationFrame(handle)
        },
        isHidden: () => document.hidden,
        // Alpha-tight collision bounds (collision.ignoreTransparentPixels):
        // same provider as the DSH entry — root-relative HTTP + DOM canvas
        // are both same-origin under the desktop local-server.
        getPoseAlphaBounds: createPoseCollisionBoundsProvider(),
      })

      // §23: rAF never fires while hidden — land a mid-air flight at once.
      const onVisibilityChange = (): void => controller.settleIfHidden()
      document.addEventListener('visibilitychange', onVisibilityChange)

      return () => {
        disposed = true
        unregisterConfigProvider?.()
        document.removeEventListener('visibilitychange', onVisibilityChange)
        unsubscribeStage()
        controller.dispose()
      }
    },
  }
}
