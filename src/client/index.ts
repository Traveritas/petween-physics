/**
 * dsh-motion-pet-physics browser half — pure wiring: fetch the main
 * plugin's `motion-pet/client` service off the cordis context, bind the
 * ThrowController to the browser environment, return the cleanup function.
 *
 * This companion registers NO slot and renders NO UI; the entire client
 * half is the throw controller observing the pet. `inject` makes cordis
 * load this entry only while the main plugin's service exists.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { DEFAULT_CONFIG } from './config'
import { ThrowController } from './throw-controller'
import { motionPetClientServiceOf } from './types'

export const inject = ['motion-pet/client']

export function apply(ctx: ClientContext) {
  const service = motionPetClientServiceOf(ctx)
  if (service === null) {
    // inject guarantees presence; a miss means a broken/unknown service
    // version. Stay loaded-but-idle rather than throwing every boot.
    console.warn('motion-pet-physics: motion-pet/client service missing or unsupported')
    return
  }
  const controller = new ThrowController({
    service,
    config: DEFAULT_CONFIG,
    now: () => performance.now(),
    getViewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    scheduleFrame: (callback) => {
      const handle = requestAnimationFrame(() => callback())
      return () => cancelAnimationFrame(handle)
    },
    isHidden: () => document.hidden,
  })
  return () => {
    controller.dispose()
  }
}
