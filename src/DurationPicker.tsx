import { useState } from 'react'

export function validateDurationInput(raw: string): number | string {
  const trimmed = raw.trim()
  if (trimmed === '') return 'Please enter a duration'
  const n = Number(trimmed)
  if (!isFinite(n) || isNaN(n)) return 'Please enter a valid number'
  if (!Number.isInteger(n)) return 'Duration must be a whole number of minutes'
  if (n < 1) return 'Minimum duration is 1 minute'
  if (n > 240) return 'Maximum duration is 240 minutes'
  return n
}

const PRESETS: { label: string; ms: number }[] = [
  { label: '15 min', ms: 900_000 },
  { label: '30 min', ms: 1_800_000 },
  { label: '45 min', ms: 2_700_000 },
]

interface DurationPickerProps {
  value: number
  onChange: (ms: number) => void
}

export function DurationPicker({ value, onChange }: DurationPickerProps) {
  const [customInput, setCustomInput] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)
  const isUnlimited = value === 0
  const isCustom = !isUnlimited && !PRESETS.some(p => p.ms === value)

  function handleCustomConfirm() {
    const result = validateDurationInput(customInput)
    if (typeof result === 'string') {
      setCustomError(result)
      return
    }
    setCustomError(null)
    onChange(result * 60_000)
  }

  function handleCustomKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleCustomConfirm()
  }

  return (
    <div className="duration-picker">
      <div className="duration-presets">
        {PRESETS.map(p => (
          <button
            key={p.ms}
            type="button"
            className={`duration-btn${value === p.ms ? ' selected' : ''}`}
            onClick={() => { onChange(p.ms); setCustomError(null) }}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className={`duration-btn${isUnlimited ? ' selected' : ''}`}
          onClick={() => { onChange(0); setCustomError(null) }}
        >
          ∞
        </button>
      </div>

      <div className="duration-custom">
        <input
          type="number"
          className={`duration-custom-input${isCustom ? ' selected' : ''}`}
          placeholder="Custom"
          min={1}
          max={240}
          value={customInput}
          onChange={e => { setCustomInput(e.target.value); setCustomError(null) }}
          onKeyDown={handleCustomKeyDown}
          aria-label="Custom duration in minutes"
        />
        <span className="duration-custom-unit">min</span>
        <button
          type="button"
          className="duration-custom-confirm"
          onClick={handleCustomConfirm}
        >
          Set
        </button>
        {customError && <span className="duration-custom-error">{customError}</span>}
      </div>

      <p className="duration-selected-label">
        {isUnlimited
          ? 'Unlimited — session runs until you stop it'
          : isCustom
            ? `${value / 60_000} min selected`
            : `${value / 60_000} min selected`}
      </p>
    </div>
  )
}
