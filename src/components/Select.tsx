import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { SelectOption } from './Select.helpers'

export type { SelectOption }

export type SelectProps<T extends string | number = string> = {
  value: T
  onChange: (value: T) => void
  options: ReadonlyArray<SelectOption<T>>
  testId?: string
  className?: string
  style?: CSSProperties
  disabled?: boolean
  ariaLabel?: string
  labelledBy?: string
}

/**
 * Accessible custom dropdown — drop-in replacement for native <select>.
 * Listbox renders via React Portal to document.body with fixed positioning;
 * placement flips above the trigger when there isn't enough room below.
 *
 * Coverage in Select.test.tsx is intentionally narrow (API contract only);
 * detailed keyboard/ARIA behaviour is exercised end-to-end via Playwright.
 */
export function Select<T extends string | number = string>(props: SelectProps<T>) {
  const {
    value, onChange, options, testId, className, style, disabled,
    ariaLabel, labelledBy,
  } = props

  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const uid = useId()
  const listboxId = `${uid}-listbox`

  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, options.findIndex(o => o.value === value)),
  )
  const [listboxStyle, setListboxStyle] = useState<CSSProperties>({})

  // Position the portal listbox; flip above when bottom doesn't fit.
  const recompute = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const listH = listRef.current?.getBoundingClientRect().height ?? 240
    const below = window.innerHeight - rect.bottom
    const above = rect.top
    const flipUp = below < listH + 8 && above > below
    setListboxStyle({
      position: 'fixed',
      top: flipUp ? Math.max(8, rect.top - listH - 3) : rect.bottom + 3,
      left: rect.left,
      minWidth: rect.width,
      maxHeight: Math.max(120, Math.min(240, (flipUp ? above : below) - 12)),
    })
  }, [])

  useEffect(() => {
    if (!open) return
    recompute()
    window.addEventListener('scroll', recompute, { capture: true, passive: true })
    window.addEventListener('resize', recompute, { passive: true })
    return () => {
      window.removeEventListener('scroll', recompute, { capture: true })
      window.removeEventListener('resize', recompute)
    }
  }, [open, recompute])

  // Reset active index to selected when value changes.
  useEffect(() => {
    const next = options.findIndex(o => o.value === value)
    setActiveIndex(next >= 0 ? next : 0)
  }, [value, options])

  // Keep the active option in view inside a scrollable listbox.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    const active = list.querySelector<HTMLLIElement>(`#${CSS.escape(`${uid}-opt-${activeIndex}`)}`)
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' })
    }
  }, [open, activeIndex, uid])

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const commit = useCallback(
    (idx: number) => {
      const opt = options[idx]
      if (!opt) return
      onChange(opt.value)
      setOpen(false)
      triggerRef.current?.focus()
    },
    [options, onChange],
  )

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (open) commit(activeIndex)
        else setOpen(true)
        break
      case 'ArrowDown':
        e.preventDefault()
        if (!open) setOpen(true)
        else setActiveIndex(i => Math.min(i + 1, options.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        if (!open) setOpen(true)
        else setActiveIndex(i => Math.max(i - 1, 0))
        break
      case 'Home':
        if (open) { e.preventDefault(); setActiveIndex(0) }
        break
      case 'End':
        if (open) { e.preventDefault(); setActiveIndex(options.length - 1) }
        break
      case 'Tab':
        if (open) setOpen(false)
        break
      default:
        // Single-char typeahead: jump to first option whose label starts with the key.
        if (e.key.length === 1) {
          const ch = e.key.toLowerCase()
          const start = open ? activeIndex + 1 : 0
          const wrapped = [...options.slice(start), ...options.slice(0, start)]
          const hit = wrapped.findIndex(o => String(o.label).toLowerCase().startsWith(ch))
          if (hit >= 0) {
            const real = (start + hit) % options.length
            setActiveIndex(real)
            if (!open) onChange(options[real]!.value)
          }
        }
    }
  }

  const onWrapperBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!open) return
    const next = e.relatedTarget as Node | null
    if (next && (wrapperRef.current?.contains(next) || listRef.current?.contains(next))) return
    setOpen(false)
  }

  const selectedLabel = options.find(o => o.value === value)?.label ?? String(value)
  const activeId = open ? `${uid}-opt-${activeIndex}` : undefined

  const listbox = open && createPortal(
    <ul
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      className="mc-select__listbox"
      style={listboxStyle}
    >
      {options.map((opt, idx) => {
        const isSelected = opt.value === value
        const isActive = idx === activeIndex
        return (
          <li
            key={String(opt.value)}
            id={`${uid}-opt-${idx}`}
            role="option"
            aria-selected={isSelected}
            data-value={String(opt.value)}
            className={`mc-select__option${isActive ? ' mc-select__option--active' : ''}${isSelected ? ' mc-select__option--selected' : ''}`}
            onMouseEnter={() => setActiveIndex(idx)}
            onMouseDown={e => e.preventDefault()}
            onClick={() => commit(idx)}
          >
            {opt.label}
          </li>
        )
      })}
    </ul>,
    document.body,
  )

  return (
    <div
      ref={wrapperRef}
      className={`mc-select${open ? ' mc-select--open' : ''}${disabled ? ' mc-select--disabled' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      onBlur={onWrapperBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        data-testid={testId}
        data-selected-value={String(value)}
        className="mc-select__trigger"
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={onTriggerKey}
      >
        <span className="mc-select__value">{selectedLabel}</span>
        <span className="mc-select__chevron" aria-hidden="true">
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
            <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {listbox}
    </div>
  )
}

export default Select
