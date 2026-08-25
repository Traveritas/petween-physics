/**
 * dsh-motion-pet-physics host half — a thin companion that
 * 1. installs the factory-default wall-impact animation into the main
 *    plugin's shared animation library (once, never overwriting user edits), and
 * 2. serves GET/PUT `/api/motion-pet-physics/config` — the persisted,
 *    runtime-editable configuration the browser half's settings card writes.
 *
 * The heavy lifting (validation, atomic persistence, namespace enforcement)
 * for animations belongs to the main plugin's `motion-pet` service; the
 * config route's validation/persistence lives in src/host/. The browser half
 * in src/client/ owns all runtime behavior.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ensureBounceAnimation } from './host/bounce-animation'
import { PhysicsConfigStore } from './host/config'
import { registerConfigRoutes, type ConfigRoutesDeps } from './host/routes'
import type { MotionPetHostService } from './host/types'

export const name = 'motion-pet-physics'
/**
 * Cordis loads this entry while the main plugin's `motion-pet` service AND
 * the shell's `webServer` both exist (and unloads it when either goes away)
 * — the companion can never run without its host, and the config route
 * needs the HTTP surface.
 */
export const inject = ['motion-pet', 'webServer']

// Community mount-once convention (main-plugin pattern): the bundle patch and
// a standalone install can both load this module; the second fiber must not
// double-register the route (a duplicate (kind, path) registration throws).
// The flag is set only after registration succeeded (inside the effect
// below), so a mid-init failure never wedges later in-process reloads behind
// a stale flag.
const MOUNT_FLAG = Symbol.for('dsh-motion-pet-physics/host')

export function apply(ctx: Context) {
  const registry = globalThis as unknown as Record<symbol, true | undefined>
  if (registry[MOUNT_FLAG] === true) return

  // Runtime cast per the companion contract: this package declares its own
  // local interface mirror instead of importing main-plugin types.
  const service = (ctx as { 'motion-pet'?: MotionPetHostService })['motion-pet']
  if (service === undefined) {
    // Defensive: `inject` guarantees presence; a missing service means the
    // loader contract changed under us. Fail soft — no animation, no crash.
    console.warn('motion-pet-physics: motion-pet service missing at apply time')
    return
  }
  if (service.version !== 1) {
    console.warn(`motion-pet-physics: unsupported motion-pet service version ${String(service.version)}`)
    return
  }

  const store = new PhysicsConfigStore()
  const deps: ConfigRoutesDeps = {
    loadConfig: () => store.load(),
    updateConfig: (patch) => store.update(patch),
  }

  // ctx.effect runs the callback synchronously while the fiber is active, so
  // the flag check above and the flag set below stay atomic against a second
  // fiber.
  return ctx.effect(() => {
    const disposeRoutes = registerConfigRoutes(ctx, deps)
    // Mark as mounted only once the registration succeeded: a mid-init throw
    // must not wedge later in-process reloads behind a stale flag.
    registry[MOUNT_FLAG] = true
    // Fire-and-forget: registration is idempotent and non-load-bearing for
    // the plugin's function (the client half degrades gracefully when the
    // default animation is absent). A rejection means the definition no
    // longer passes the main plugin's schema — worth a warning, never a
    // plugin crash.
    void ensureBounceAnimation(service).catch((error: unknown) => {
      console.warn('motion-pet-physics: failed to register the default bounce animation', error)
    })
    return () => {
      disposeRoutes()
      registry[MOUNT_FLAG] = undefined
    }
  }, 'motion-pet-physics: config route')
}
