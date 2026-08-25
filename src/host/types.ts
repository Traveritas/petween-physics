/**
 * host/types.ts — self-contained mirrors of the petween host service
 * contract (`petween`, service version 1).
 *
 * WHY a local mirror: this companion is an independent package and must not
 * import the main plugin's runtime code (single-source-of-truth duplication
 * is the accepted cost; the contract is versioned and additive). The shapes
 * below mirror petween@1.0.0 src/host/service.ts and the
 * AnimationDefinition data model from its src/motion/animation-definition.ts
 * (documented for users in its docs/motion-format.md).
 *
 * Compatibility rule: the mirror carries only what this plugin actually
 * sends. When the main plugin widens the contract, widen the mirror in a
 * follow-up; never guess fields.
 */

/**
 * Mirror of the AnimationDefinition JSON schema — the subset this plugin
 * uses (an `interaction`-kind squash deformation, no events). Field rules
 * enforced by the main plugin's validator:
 * - `id` must match `<namespace>:<name>` with the `user:` namespace for
 *   companions (alphanumerics, `-`, `_` in the name part);
 * - `kind: 'interaction'` must NOT declare pose-swap events (a pure
 *   deformation effect is exactly this kind; a `transition` without a
 *   pose-swap would be rejected);
 * - keyframe times are normalized 0..1; one track per property; tracks on
 *   the same layer must share one easing per interval;
 * - `value` is a number or `{ base, parameter: 'strength', amount }`
 *   evaluated as `base + strength * amount`.
 */
export interface AnimationDefinitionMirror {
  version: 1
  id: string
  name: string
  kind: 'transition' | 'ambient' | 'interaction'
  durationMs: number
  repeat: { mode: 'once' } | { mode: 'loop' } | { mode: 'alternate' } | { mode: 'random-interval'; minDelayMs: number; maxDelayMs: number }
  tracks: Array<{
    property: string
    keyframes: Array<{
      at: number
      value: number | { base: number; parameter: 'strength'; amount: number }
      easing?: string
    }>
  }>
  events?: Array<{ at: number; type: 'pose-swap' } | { at: number; type: 'particle'; effect: 'confetti' | 'star-burst' | 'sparkle' }>
  parameters?: { strength?: { default: number; min: number; max: number } }
}

/** Mirror of the `petween` host service (petween src/host/service.ts). */
export interface PetweenHostService {
  readonly version: 1
  /**
   * Validate and persist a definition into the shared animation library.
   * Rejects on schema violations or ids outside the `user:` namespace;
   * resolves once the atomic write completed.
   */
  registerAnimation(definition: AnimationDefinitionMirror): Promise<void>
  /**
   * Whether the library already holds `id` — companions register their
   * factory defaults only when missing, so a user's edits survive
   * companion reloads/upgrades.
   */
  hasAnimation(id: string): Promise<boolean>
}
