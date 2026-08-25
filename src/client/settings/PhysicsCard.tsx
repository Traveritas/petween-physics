/**
 * client/settings/PhysicsCard.tsx — the settings.section card that edits the
 * throw-physics configuration at runtime.
 *
 * Mount point choice (evidence in src/client/index.ts's slot registration
 * comment): `settings.section` (order 135, right after the main plugin's
 * card at 130). The alternative `settings.plugin.item` slot inside the
 * Plugins tab is keyed on a settings namespace the HOST must serve through
 * the settings-scope system (dsh-client-ui-settings-plugins
 * lib/types/client/slot-contract.d.ts; its tab controller dispatches only
 * keys present in `ctx.settingsScope.describe()`) — a persistence model this
 * plugin deliberately does not use (own config.json + HTTP route).
 *
 * Save discipline: edits land in a local draft; a change schedules ONE
 * debounced PUT (300ms) once the user stops tweaking, sending the whole
 * config (the host merges + validates server-side). The header line mirrors
 * the hub's saving/error state; "恢复默认" PUTs DEFAULT_CONFIG.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { getMotionPetAnimations, type AnimationOption } from '../api'
import {
  CONFIG_NUMERIC_FIELDS,
  DEFAULT_CONFIG,
  POSE_KEYS,
  type ThrowPhysicsPluginConfig,
} from '../config'
import { PhysicsConfigHub, physicsConfigHub } from '../config-hub'
import { NumberField, SelectRow, Slider, Toggle } from './controls'
import styles from './settings.module.css'

/** Auto-save debounce (ms): one PUT per burst of edits, never per keystroke. */
const SAVE_DEBOUNCE_MS = 300

/**
 * A few main-plugin builtin interaction-friendly ids, hardcoded so the
 * dropdown works even without the main plugin's /animations answer. Source:
 * dsh-motion-pet src/core/transition-presets.ts (verified against 1.x).
 */
const BUILTIN_ANIMATIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'builtin:click-pop', label: '内置 · 点击弹跳 (click-pop)' },
  { value: 'builtin:click-wiggle', label: '内置 · 点击摇摆 (click-wiggle)' },
  { value: 'builtin:click-bounce', label: '内置 · 点击颤动 (click-bounce)' },
  { value: 'builtin:click-spin', label: '内置 · 点击旋转 (click-spin)' },
  { value: 'builtin:comic-pop', label: '内置 · 漫画弹出 (comic-pop)' },
  { value: 'builtin:jelly', label: '内置 · 果冻 (jelly)' },
  { value: 'builtin:celebrate', label: '内置 · 庆祝 (celebrate)' },
]

const DEFAULT_ANIMATION_OPTION = { value: DEFAULT_CONFIG.bounceAnimation.id, label: '本插件默认 · Physics Bounce Pop' }

const POSE_OPTIONS = POSE_KEYS.map((key) => ({
  value: key,
  label: { idle: '待机 idle', thinking: '思考 thinking', working: '工作 working', waiting: '等待 waiting', success: '成功 success', error: '出错 error' }[key],
}))

export interface PhysicsCardProps {
  /** Test seam; production shares the hub with the throw controller. */
  hub?: PhysicsConfigHub
  /** Test seam for the main-plugin animation library read. */
  fetchAnimations?: () => Promise<{ customs: AnimationOption[]; warnings: string[] }>
}

export function PhysicsCard(props: PhysicsCardProps): JSX.Element {
  const hub = props.hub ?? physicsConfigHub
  const fetchAnimations = props.fetchAnimations ?? getMotionPetAnimations
  // Stable identities for useSyncExternalStore (prototype methods passed bare
  // would lose `this`; a fresh arrow per render would re-subscribe every render).
  const subscribe = useCallback((listener: () => void) => hub.subscribe(listener), [hub])
  const getSnapshot = useCallback(() => hub.getSnapshot(), [hub])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  // The UI draft: adopted from the hub once the first GET lands (or from the
  // silent DEFAULT fallback on load failure), then owned by the controls.
  const [draft, setDraft] = useState<ThrowPhysicsPluginConfig | null>(null)
  const [customs, setCustoms] = useState<AnimationOption[]>([])
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Draft version last PUT; mirrors "已保存" vs "待保存". */
  const [pending, setPending] = useState(false)

  useEffect(() => {
    void hub.load()
  }, [hub])

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    },
    [],
  )

  // Adopt the loaded config exactly once (a mid-session external change does
  // not clobber the user's open draft; the next card mount picks it up).
  useEffect(() => {
    if (draft === null && (snapshot.loaded || snapshot.loadError !== null)) {
      setDraft(structuredClone(snapshot.config))
    }
  }, [draft, snapshot.loaded, snapshot.loadError, snapshot.config])

  // Impact-animation dropdown data source: the main plugin's custom library
  // (GET /api/motion-pet/animations) + hardcoded builtins + the plugin
  // default. A failed read just leaves the static lists.
  useEffect(() => {
    let alive = true
    void fetchAnimations().then(
      ({ customs: list }) => {
        if (alive) setCustoms(list)
      },
      () => {
        /* main plugin absent/old: builtin + default lists carry the dropdown */
      },
    )
    return () => {
      alive = false
    }
  }, [fetchAnimations])

  if (draft === null) {
    return <div className={styles.status}>正在加载 Motion Pet Physics 配置…</div>
  }

  const scheduleSave = (next: ThrowPhysicsPluginConfig): void => {
    setDraft(next)
    setPending(true)
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void hub.update(next).then(() => {
        setPending(false)
      })
    }, SAVE_DEBOUNCE_MS)
  }

  const patchPhysics = (field: keyof ThrowPhysicsPluginConfig['physics'], value: number): void => {
    scheduleSave({ ...draft, physics: { ...draft.physics, [field]: value } })
  }
  const patchBounce = (
    field: keyof ThrowPhysicsPluginConfig['bounceAnimation'],
    value: ThrowPhysicsPluginConfig['bounceAnimation'][typeof field],
  ): void => {
    scheduleSave({ ...draft, bounceAnimation: { ...draft.bounceAnimation, [field]: value } })
  }
  const patchFlash = (
    field: keyof ThrowPhysicsPluginConfig['flashPose'],
    value: ThrowPhysicsPluginConfig['flashPose'][typeof field],
  ): void => {
    scheduleSave({ ...draft, flashPose: { ...draft.flashPose, [field]: value } })
  }
  const patchTop = (field: 'sampleWindowMs' | 'effectDebounceMs' | 'applyFalseTolerance', value: number): void => {
    scheduleSave({ ...draft, [field]: value })
  }

  const resetDefaults = (): void => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    setPending(false)
    setDraft(structuredClone(DEFAULT_CONFIG))
    void hub.reset()
  }

  // Animation options: default + custom library + builtins, plus the current
  // value when nothing lists it (e.g. a hand-typed id kept from old config).
  const animationOptions = [DEFAULT_ANIMATION_OPTION]
  for (const custom of customs) {
    if (custom.id === DEFAULT_ANIMATION_OPTION.value) continue
    animationOptions.push({ value: custom.id, label: `自定义 · ${custom.name} (${custom.id})` })
  }
  animationOptions.push(...BUILTIN_ANIMATIONS)
  if (!animationOptions.some((option) => option.value === draft.bounceAnimation.id)) {
    animationOptions.push({ value: draft.bounceAnimation.id, label: `当前值 · ${draft.bounceAnimation.id}` })
  }

  const physics = draft.physics
  const bounce = draft.bounceAnimation
  const flash = draft.flashPose
  const ranges = CONFIG_NUMERIC_FIELDS

  const saveStateText = snapshot.saving
    ? '保存中…'
    : snapshot.saveError !== null
      ? `保存失败:${snapshot.saveError}`
      : pending
        ? '待保存…'
        : '已保存'

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>Motion Pet Physics</span>
        <span
          className={
            snapshot.saveError !== null ? `${styles.cardSummary} ${styles.errorText}` : styles.cardSummary
          }
        >
          {saveStateText}
        </span>
      </div>
      {snapshot.loadError !== null ? (
        <p className={styles.errorLine}>
          配置加载失败({snapshot.loadError}),当前显示默认值。
          <button type="button" className={styles.inlineButton} onClick={() => void hub.load()}>
            重试
          </button>
        </p>
      ) : null}

      <div className={styles.groupTitle}>物理</div>
      <NumberField
        label="重力加速度"
        min={ranges['physics.gravity'].min}
        max={ranges['physics.gravity'].max}
        step={100}
        unit="px/s²"
        value={physics.gravity}
        onChange={(value) => patchPhysics('gravity', value)}
      />
      <Slider
        label="弹性系数"
        min={ranges['physics.restitution'].min}
        max={ranges['physics.restitution'].max}
        step={0.05}
        value={physics.restitution}
        onChange={(value) => patchPhysics('restitution', value)}
      />
      <Slider
        label="水平阻尼"
        min={ranges['physics.friction'].min}
        max={ranges['physics.friction'].max}
        step={0.05}
        value={physics.friction}
        onChange={(value) => patchPhysics('friction', value)}
      />
      <Slider
        label="甩出倍率"
        min={ranges['physics.throwMultiplier'].min}
        max={ranges['physics.throwMultiplier'].max}
        step={0.1}
        value={physics.throwMultiplier}
        onChange={(value) => patchPhysics('throwMultiplier', value)}
      />
      <NumberField
        label="最低起掷速度"
        min={ranges['physics.minThrowSpeed'].min}
        max={ranges['physics.minThrowSpeed'].max}
        step={50}
        unit="px/s"
        value={physics.minThrowSpeed}
        onChange={(value) => patchPhysics('minThrowSpeed', value)}
      />
      <NumberField
        label="落定速度"
        min={ranges['physics.settleSpeed'].min}
        max={ranges['physics.settleSpeed'].max}
        step={10}
        unit="px/s"
        value={physics.settleSpeed}
        onChange={(value) => patchPhysics('settleSpeed', value)}
      />
      <NumberField
        label="速度上限"
        min={ranges['physics.maxSpeed'].min}
        max={ranges['physics.maxSpeed'].max}
        step={100}
        unit="px/s"
        value={physics.maxSpeed}
        onChange={(value) => patchPhysics('maxSpeed', value)}
      />
      <NumberField
        label="飞行兜底时长"
        min={ranges['physics.maxFlightMs'].min}
        max={ranges['physics.maxFlightMs'].max}
        step={500}
        unit="ms"
        value={physics.maxFlightMs}
        onChange={(value) => patchPhysics('maxFlightMs', value)}
      />

      <div className={styles.groupTitle}>碰壁动画</div>
      <Toggle
        label="碰壁时播放动画"
        checked={bounce.enabled}
        onChange={(checked) => patchBounce('enabled', checked)}
      />
      <SelectRow
        label="动画"
        value={bounce.id}
        options={animationOptions}
        disabled={!bounce.enabled}
        onChange={(value) => patchBounce('id', value)}
      />
      <Toggle
        label="打断在播动画"
        checked={bounce.interrupt}
        onChange={(checked) => patchBounce('interrupt', checked)}
      />

      <div className={styles.groupTitle}>碰壁切图</div>
      <Toggle
        label="碰壁时切换图片"
        checked={flash.enabled}
        onChange={(checked) => patchFlash('enabled', checked)}
      />
      <SelectRow
        label="Pose"
        value={flash.poseKey}
        options={POSE_OPTIONS}
        disabled={!flash.enabled}
        onChange={(value) => patchFlash('poseKey', value)}
      />
      <NumberField
        label="保持时长"
        min={ranges['flashPose.holdMs'].min}
        max={ranges['flashPose.holdMs'].max}
        step={50}
        unit="ms"
        value={flash.holdMs}
        disabled={!flash.enabled}
        onChange={(value) => patchFlash('holdMs', value)}
      />

      <details className={styles.advanced}>
        <summary>高级</summary>
        <NumberField
          label="测速窗口"
          min={ranges.sampleWindowMs.min}
          max={ranges.sampleWindowMs.max}
          step={10}
          unit="ms"
          value={draft.sampleWindowMs}
          onChange={(value) => patchTop('sampleWindowMs', value)}
        />
        <NumberField
          label="去抖窗口"
          min={ranges.effectDebounceMs.min}
          max={ranges.effectDebounceMs.max}
          step={10}
          unit="ms"
          value={draft.effectDebounceMs}
          onChange={(value) => patchTop('effectDebounceMs', value)}
        />
        <NumberField
          label="apply 容忍"
          min={ranges.applyFalseTolerance.min}
          max={ranges.applyFalseTolerance.max}
          step={1}
          unit="次"
          value={draft.applyFalseTolerance}
          onChange={(value) => patchTop('applyFalseTolerance', value)}
        />
      </details>

      <div className={styles.cardFooter}>
        <span className={styles.hint}>配置落盘于 ~/.dsh/motion-pet-physics/config.json,也可手改。</span>
        <button type="button" className={styles.button} disabled={snapshot.saving} onClick={resetDefaults}>
          恢复默认
        </button>
      </div>
    </div>
  )
}
