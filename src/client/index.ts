/**
 * petween-physics browser half — two surfaces over one config:
 * 1. the ThrowController (the plugin's whole runtime behavior): fetch the
 *    main plugin's `petween/client` service off the cordis context, bind
 *    it to the browser environment, read the LATEST config from the hub at
 *    use time (per gesture / per frame);
 * 2. the settings.section card that edits the config at runtime (the host
 *    half's /api/petween-physics/config persists it);
 * 3. the §12 pet-package pull: on boot and on active-pet change, offer a
 *    companion config shared through the pet record's pluginConfigs pocket
 *    (client/shared-pet-config.ts) for the card to confirm/apply;
 * 4. the §12 pet-package P3 push: register an export-time config provider so
 *    a pet whose record carries no stored blob still ships our current config.
 *
 * `inject` makes cordis load this entry only while the main plugin's service
 * and the shell's slot registry exist.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the SlotMap merge so the 'settings.section' slot name
// type-checks. VALUE-importing this package is forbidden (bundle purity).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { physicsConfigHub } from './config-hub'
import { PhysicsCard } from './settings/PhysicsCard'
import { PLUGIN_ID, sharedPetConfigCenter } from './shared-pet-config'
import { ThrowController } from './throw-controller'
import { petweenClientServiceOf } from './types'

export const inject = ['petween/client', 'slots']

export function apply(ctx: ClientContext) {
  const service = petweenClientServiceOf(ctx)
  if (service === null) {
    // inject guarantees presence; a miss means a broken/unknown service
    // version. Stay loaded-but-idle rather than throwing every boot.
    console.warn('petween-physics: petween/client service missing or unsupported')
    return
  }
  // One memoized GET serves the controller AND the card; until it lands (or
  // if it fails) the controller runs on DEFAULT_CONFIG — the hub broadcast is
  // irrelevant to it because it reads getConfig() at use time. The boot-time
  // §12 shared-config pull rides the SAME load (see below).
  //
  // §12 pet-package pull: offer a companion config shared through the pet
  // record once per boot (only AFTER the hub load, so the center's no-op
  // check compares against the REAL config, not the DEFAULT fallback) and
  // again whenever the active pet changes. StageSnapshot.activePetId is an
  // optional v1 widening — old providers lack it, and every gap here stays
  // silent by design (the center additionally dedupes repeat pet ids).
  const checkSharedConfig = (petId: string | null | undefined): void => {
    if (typeof petId !== 'string' || petId === '') return
    if (!physicsConfigHub.getSnapshot().loaded) return
    void sharedPetConfigCenter.checkActivePet(petId)
  }
  // §12 pet-package P3: let the main plugin collect our CURRENT config at
  // export time, so a pet whose record carries no stored blob still ships the
  // full personality. Registration waits for the hub load — the provider must
  // serve the REAL config, never the DEFAULT fallback — and the method is an
  // optional widening (older providers lack it). Every gap stays silent.
  // ThrowPhysicsPluginConfig is all public tunables, so the whole snapshot
  // goes (cloned: the export must not observe later live mutations).
  let disposed = false
  let unregisterConfigProvider: (() => void) | null = null
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
  void physicsConfigHub.load().then(() => {
    registerConfigProvider()
    checkSharedConfig(service.getStageSnapshot()?.activePetId)
  })
  const unsubscribeStage = service.subscribeStage((snapshot) => checkSharedConfig(snapshot?.activePetId))
  // Close the boot-time register→play window in one nudge: without it the
  // main plugin's animation registry only syncs on its 3s poll (unbounded
  // while the page is hidden). Optional in the v1 mirror — older providers
  // lack it. Fire-and-forget: a failure just leaves the poll in charge.
  if (service.resyncAnimations !== undefined) {
    void service.resyncAnimations().catch(() => {
      /* sync falls back to the provider's regular poll */
    })
  }
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
  })
  // §23 for real: rAF callbacks never fire while the page is hidden, so the
  // controller's in-frame hidden check alone would freeze a flight mid-air
  // with the lease held. The visibilitychange listener lands it immediately.
  const onVisibilityChange = (): void => controller.settleIfHidden()
  document.addEventListener('visibilitychange', onVisibilityChange)
  // Settings card seat — `settings.section` (list slot, id/order/label
  // options; dsh-client-ui-settings lib/types/client/contract/slots.d.ts).
  // WHY this and not `settings.plugin.item` (the Plugins tab's card slot):
  // that slot is KEYED on a settings namespace the HOST must serve through
  // the settings-scope system — its tab controller dispatches only keys in
  // `ctx.settingsScope.describe()` (dsh-client-ui-settings-plugins
  // lib/\client.js, ConfigurablePluginsTabController.publish), and a card
  // whose namespace is not served "is never dispatched". Migrating this
  // plugin's persistence into the DSH settings document would be a different
  // architecture; `settings.section` renders our card with the plain
  // slot contract the main plugin already verified working (order 130) —
  // 135 lands right after it.
  const disposeCard = ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'petween-physics', order: 135, label: 'Petween Physics' },
      PhysicsCard,
    ),
  )
  return () => {
    disposed = true
    unregisterConfigProvider?.()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    unsubscribeStage()
    disposeCard()
    controller.dispose()
  }
}
