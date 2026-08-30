/**
 * client/types.ts — self-contained mirror of the petween client
 * service contract (`petween/client`, service version 1).
 *
 * WHY a local mirror: this companion is an independent package and must not
 * import the main plugin's runtime code. The shapes below mirror
 * petween@1.0.0 src/client/extension-service.ts; the entry file
 * fetches the service with a runtime cast instead of global Context
 * augmentation, so the mirror can never drift into a load-time dependency.
 *
 * Semantics worth remembering (from the provider's docs):
 * - "no active session" (pet disabled/unmounted) is a NORMAL window: every
 *   API degrades through null returns or a null snapshot push;
 * - the position lease is exclusive: while held, the main plugin ignores
 *   remote overlay coordinates — hold it only during flight, release right
 *   after commit;
 * - the drag gesture belongs to the main plugin; `subscribeUserDrag` needs
 *   no lease, and the user's hand always outranks the driver.
 */

/** Pose slots the main plugin's resolver knows. */
export type PoseKey = 'idle' | 'thinking' | 'working' | 'waiting' | 'success' | 'error'

/** Live projection of the pet stage (viewport px; x/y = bounding-box top-left). */
export interface StageSnapshot {
  x: number
  y: number
  /** The configured user scale; bounding box = stageSize * scale. */
  scale: number
  /** Base stage square in px. */
  stageSize: number
  visualState: string | null
  activityMode: string | null
  started: boolean
  /**
   * v1 additive widening (petween 2026-08-27): absent on older providers —
   * consumers must treat every field below as optional.
   */
  viewport?: { width: number; height: number }
  dragging?: boolean
  reducedMotion?: boolean
  poseKey?: string | null
  /** The visible pose-image box (viewport px, tighter than the square); null before the first pose. */
  bodyRect?: { x: number; y: number; width: number; height: number } | null
}

/** Exclusive position lease handed out by requestPositionControl(). */
export interface PositionDriver {
  /** false = suspended (a user drag is in flight) or already released. */
  apply(x: number, y: number): boolean
  /** Persist the current position immediately (overlay config slice). */
  commit(): Promise<void>
  /** Hand the position back; remote overlay coordinates apply again. */
  release(): void
  /**
   * A user drag gesture started or ended: 'start' suspends the driver
   * (apply returns false), 'end' re-enables it (widened 2026-08-27 — a
   * 0-arg listener from the v1 contract still receives both phases).
   */
  onUserDrag(listener: (phase: 'start' | 'end') => void): () => void
}

/** Mirror of the `petween/client` service. */
export interface PetweenClientService {
  /** Contract version. Bump and widen, never mutate in place. */
  readonly version: 1
  getStageSnapshot(): StageSnapshot | null
  /** Subscribing pushes the current value immediately; null = no session. */
  subscribeStage(listener: (snapshot: StageSnapshot | null) => void): () => void
  /**
   * Drag gestures on the pet: 'start' once the gesture crosses the drag
   * threshold, 'end' when it ends with real travel. A click fires neither.
   */
  subscribeUserDrag(listener: (phase: 'start' | 'end') => void): () => void
  /** Null without an active session or while another driver holds the lease. */
  requestPositionControl(): PositionDriver | null
  /** Play a registered animation by id; null without a session / unknown id. */
  playAnimation(
    id: string,
    options?: { interrupt?: boolean; strength?: number },
  ): unknown | null
  /** Swap the pose for holdMs then restore the state machine's pose. */
  flashPose(poseKey: string, holdMs: number): boolean
  /**
   * Force one config/animations fetch and resolve once the session applied
   * it — closes the register→sync window (the 3s poll, unbounded while the
   * page is hidden), so "registerAnimation then playAnimation" works on
   * return. Resolves immediately without a session; a failed fetch resolves
   * with the registry unchanged. A v1 additive widening (petween
   * 2026-08-27): absent on older providers, hence optional — feature-check.
   */
  resyncAnimations?: () => Promise<void>
}

/**
 * Fetch the injected service off a cordis context without declaring global
 * module augmentation. Returns null when absent or version-incompatible.
 */
export function petweenClientServiceOf(ctx: object): PetweenClientService | null {
  const service = (ctx as { 'petween/client'?: PetweenClientService })['petween/client']
  if (service === undefined || service.version !== 1) return null
  return service
}
