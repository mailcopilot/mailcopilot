import { useState } from 'react'
import { Clock3, Sun, CalendarDays } from 'lucide-react'
import {
  nextHalfHour,
  tomorrowMorning,
  mondayMorning,
  toDateTimeLocalValue,
  parseDateTimeLocalValue,
  defaultCustomScheduleValue,
} from '../utils/schedule'

type Props = {
  anchorRect: DOMRect
  onSnooze: (wakeAt: Date) => void
  onClose: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

export default function SnoozeDropdown({ anchorRect, onSnooze, onClose, t }: Props) {
  const [showCustom, setShowCustom] = useState(false)
  const [customValue, setCustomValue] = useState(() => defaultCustomScheduleValue())

  const presets: Array<{ label: string; icon: typeof Clock3; date: () => Date }> = [
    { label: t('snooze.laterToday'), icon: Clock3, date: nextHalfHour },
    { label: t('snooze.tomorrowMorning'), icon: Sun, date: tomorrowMorning },
    { label: t('snooze.nextWeek'), icon: CalendarDays, date: mondayMorning },
  ]

  const top = anchorRect.bottom + 4
  const left = Math.min(anchorRect.left, window.innerWidth - 240)

  return (
    <div className="snooze-dropdown-overlay" onClick={onClose}>
      <div
        className="snooze-dropdown"
        style={{ top, left }}
        onClick={e => e.stopPropagation()}
      >
        {presets.map(p => (
          <button
            key={p.label}
            className="snooze-preset"
            onClick={() => { onSnooze(p.date()); onClose() }}
          >
            <p.icon size={14} />
            <span>{p.label}</span>
          </button>
        ))}

        <div className="ctx-sep" />

        {!showCustom && (
          <button className="snooze-preset" onClick={() => setShowCustom(true)}>
            <CalendarDays size={14} />
            <span>{t('snooze.custom')}</span>
          </button>
        )}

        {showCustom && (
          <div className="snooze-custom">
            <input
              type="datetime-local"
              value={customValue}
              min={toDateTimeLocalValue(new Date())}
              onChange={e => setCustomValue(e.target.value)}
            />
            <button
              className="btn-primary snooze-apply"
              onClick={() => {
                const d = parseDateTimeLocalValue(customValue)
                if (d && d.getTime() > Date.now()) { onSnooze(d); onClose() }
              }}
            >
              {t('snooze.apply')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
