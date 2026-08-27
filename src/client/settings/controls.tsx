/**
 * client/settings/controls.tsx — small form controls for the settings card
 * (Slider / NumberField / Toggle / SelectRow), same interaction model as the
 * main plugin's controls (independently written — companion packages share
 * no code). Input bounds are bound to CONFIG_NUMERIC_FIELDS so the card can
 * never send a value the host validation rejects.
 */
import { useState, type JSX } from 'react'
import styles from './settings.module.css'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Decimal places implied by a slider step (0.05 → 2, 1 → 0). */
function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0
  const text = String(step)
  if (text.includes('e')) return 2 // exotic step notation: a safe default
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

/**
 * Snap a raw slider position onto the min-anchored step grid, clamped to the
 * range. The round-trip through toFixed(stepDecimals) kills float tails
 * (0.1 + 0.2 = 0.30000000000000004) before they reach the config.
 */
function quantizeToStep(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return clamp(value, min, max)
  const snapped = min + Math.round((value - min) / step) * step
  return clamp(Number(snapped.toFixed(stepDecimals(step))), min, max)
}

export function Slider(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  unit?: string
  disabled?: boolean
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <label className={props.disabled === true ? `${styles.row} ${styles.disabled}` : styles.row}>
      <span className={styles.label}>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange(quantizeToStep(Number(event.target.value), props.min, props.max, props.step))
        }
      />
      <span className={styles.value}>
        {props.value.toFixed(stepDecimals(props.step))}
        {props.unit ?? ''}
      </span>
    </label>
  )
}

export function NumberField(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  unit?: string
  disabled?: boolean
  onChange: (value: number) => void
}): JSX.Element {
  const { value, min, max, onChange } = props
  // UX: raw text is held locally while the user types — no clamping and no
  // commit per keystroke. Blur or Enter clamps and commits; an empty or
  // non-finite field reverts to the last committed value on commit.
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const trimmed = draft.trim()
    const parsed = trimmed === '' ? Number.NaN : Number(trimmed)
    const next = Number.isFinite(parsed) ? clamp(parsed, min, max) : value
    setDraft(null)
    if (next !== value) onChange(next)
  }
  return (
    <label className={props.disabled === true ? `${styles.row} ${styles.disabled}` : styles.row}>
      <span className={styles.label}>{props.label}</span>
      <input
        type="number"
        className={styles.number}
        min={props.min}
        max={props.max}
        step={props.step}
        value={draft ?? String(value)}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
      />
      <span className={styles.unit}>{props.unit ?? ''}</span>
    </label>
  )
}

export function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <label className={`${styles.row} ${styles.toggle}`}>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
  )
}

export function SelectRow<T extends string>(props: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  disabled?: boolean
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <label className={props.disabled === true ? `${styles.row} ${styles.disabled}` : styles.row}>
      <span className={styles.label}>{props.label}</span>
      <select
        className={styles.select}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value as T)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
