/**
 * petween-physics browser half — two surfaces over one config:
 * 1. the ThrowController (the plugin's whole runtime behavior): fetch the
 *    main plugin's `petween/client` service off the cordis context, bind
 *    it to the browser environment, read the LATEST config from the hub at
 *    use time (per gesture / per frame);
 * 2. the settings.section card that edits the config at runtime (the host
 *    half's /api/petween-physics/config persists it).
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
  // irrelevant to it because it reads getConfig() at use time.
  void physicsConfigHub.load()
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
    disposeCard()
    controller.dispose()
  }
}
