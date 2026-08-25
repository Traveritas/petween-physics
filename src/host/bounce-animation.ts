/**
 * host/bounce-animation.ts — the factory-default wall-impact animation and
 * its one-time installation into the main plugin's shared library.
 *
 * WHY `kind: 'interaction'`: the effect is a pure squash deformation that
 * must NOT swap the pose (the pet keeps whatever its state machine shows —
 * the plugin's optional flashPose covers "change the image on impact"
 * separately). The main plugin's schema rejects a `transition` without
 * exactly one pose-swap event, and rejects pose-swap inside `interaction`
 * — so `interaction` is the only kind that expresses "deform, never swap".
 *
 * The definition mirrors the shape of petween's documented custom
 * examples (docs/motion-format.md §10): strength-parameterized squash with
 * `spring-soft` recovery, same keyframe times and easings on both tracks
 * (the shared `transition` layer requires per-interval easing consistency).
 */
import type { AnimationDefinitionMirror, PetweenHostService } from './types'

/** Library id: `user:<pack>-<name>` convention (pack = this companion). */
export const BOUNCE_POP_ANIMATION_ID = 'user:physics-bounce-pop'

/** ~260ms squash-and-recover impact deformation. */
export const BOUNCE_POP_ANIMATION: AnimationDefinitionMirror = {
  version: 1,
  id: BOUNCE_POP_ANIMATION_ID,
  name: 'Physics Bounce Pop',
  kind: 'interaction',
  durationMs: 260,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.scaleX',
      keyframes: [
        { at: 0, value: 1 },
        { at: 0.3, value: { base: 1, parameter: 'strength', amount: 0.22 }, easing: 'spring-soft' },
        { at: 0.6, value: { base: 1, parameter: 'strength', amount: -0.12 }, easing: 'spring-soft' },
        { at: 1, value: 1 },
      ],
    },
    {
      property: 'transition.scaleY',
      keyframes: [
        { at: 0, value: 1 },
        { at: 0.3, value: { base: 1, parameter: 'strength', amount: -0.24 }, easing: 'spring-soft' },
        { at: 0.6, value: { base: 1, parameter: 'strength', amount: 0.14 }, easing: 'spring-soft' },
        { at: 1, value: 1 },
      ],
    },
  ],
  parameters: { strength: { default: 1, min: 0, max: 1.8 } },
}

/**
 * First-install guard: register the factory default only when the library
 * does not already hold it. Re-registering would overwrite, which is the
 * wrong behavior for an upgrade path — the user may have customized the
 * animation in the main plugin's editor, and their edit outranks our
 * default. A failure here is non-fatal for the plugin (the effect is
 * optional eye candy); the caller decides how to report it.
 */
export async function ensureBounceAnimation(
  service: Pick<PetweenHostService, 'hasAnimation' | 'registerAnimation'>,
): Promise<'registered' | 'already-present'> {
  if (await service.hasAnimation(BOUNCE_POP_ANIMATION_ID)) return 'already-present'
  await service.registerAnimation(BOUNCE_POP_ANIMATION)
  return 'registered'
}
