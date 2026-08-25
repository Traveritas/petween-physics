/**
 * dsh-motion-pet-physics host half — a thin companion that installs the
 * factory-default wall-impact animation into the main plugin's shared
 * animation library.
 *
 * The heavy lifting (validation, atomic persistence, namespace enforcement)
 * all belongs to the main plugin's `motion-pet` service; this half only
 * decides WHEN to register: once, and only if the user has not already got
 * (or customized) the animation. The browser half in src/client/ owns all
 * runtime behavior.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ensureBounceAnimation } from './host/bounce-animation'
import type { MotionPetHostService } from './host/types'

export const name = 'motion-pet-physics'
/**
 * Cordis loads this entry when the main plugin's `motion-pet` service
 * appears (and unloads it when the main plugin goes away) — the companion
 * can never run without its host.
 */
export const inject = ['motion-pet']

export function apply(ctx: Context) {
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
  // Fire-and-forget: registration is idempotent and non-load-bearing for the
  // plugin's function (the client half degrades gracefully when the default
  // animation is absent). A rejection means the definition no longer passes
  // the main plugin's schema — worth a warning, never a plugin crash.
  void ensureBounceAnimation(service).catch((error: unknown) => {
    console.warn('motion-pet-physics: failed to register the default bounce animation', error)
  })
}
