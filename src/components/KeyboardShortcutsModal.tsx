import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

type Props = { onClose: () => void }

const GROUPS = [
  {
    titleKey: 'shortcuts.navigation',
    items: [
      { keys: ['j / k'], labelKey: 'shortcuts.nextPrev' },
      { keys: ['o / Enter'], labelKey: 'shortcuts.open' },
      { keys: ['u'], labelKey: 'shortcuts.backToList' },
      { keys: ['/'], labelKey: 'shortcuts.focusSearch' },
      { keys: ['g', 'i'], labelKey: 'shortcuts.goInbox' },
      { keys: ['g', 's'], labelKey: 'shortcuts.goSent' },
      { keys: ['g', 'd'], labelKey: 'shortcuts.goDrafts' },
      { keys: ['g', '*'], labelKey: 'shortcuts.goStarred' },
    ],
  },
  {
    titleKey: 'shortcuts.actions',
    items: [
      { keys: ['c'], labelKey: 'shortcuts.compose' },
      { keys: ['r'], labelKey: 'shortcuts.reply' },
      { keys: ['a'], labelKey: 'shortcuts.replyAll' },
      { keys: ['f'], labelKey: 'shortcuts.forward' },
      { keys: ['s'], labelKey: 'shortcuts.star' },
      { keys: ['e'], labelKey: 'shortcuts.archive' },
      { keys: ['Shift+I'], labelKey: 'shortcuts.markRead' },
      { keys: ['Shift+U'], labelKey: 'shortcuts.markUnread' },
      { keys: ['!'], labelKey: 'shortcuts.spam' },
      { keys: ['x'], labelKey: 'shortcuts.selectToggle' },
      { keys: ['v'], labelKey: 'shortcuts.move' },
      { keys: ['z'], labelKey: 'shortcuts.undo' },
      { keys: ['# / Delete'], labelKey: 'shortcuts.delete' },
      { keys: ['Escape'], labelKey: 'shortcuts.clearSelection' },
    ],
  },
  {
    titleKey: 'shortcuts.general',
    items: [
      { keys: ['Ctrl+K'], labelKey: 'shortcuts.commandPalette' },
      { keys: ['?'], labelKey: 'shortcuts.showHelp' },
    ],
  },
  {
    titleKey: 'shortcuts.contextMenuTitle',
    items: [
      { keys: ['Right-click'], labelKey: 'shortcuts.contextMenuHint' },
    ],
  },
] as const

export default function KeyboardShortcutsModal({ onClose }: Props) {
  const { t } = useTranslation()

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [onClose])

  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div
        className="shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="shortcuts-header">
          <h2 id="shortcuts-title">{t('shortcuts.title')}</h2>
          <button className="shortcuts-close" aria-label={t('common.close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="shortcuts-body">
          {GROUPS.map(group => (
            <div key={group.titleKey} className="shortcuts-group">
              <h3>{t(group.titleKey)}</h3>
              <div className="shortcuts-list">
                {group.items.map(item => (
                  <div key={item.labelKey} className="shortcut-row">
                    <span className="shortcut-keys">
                      {item.keys.map((k, i) => (
                        <span key={`${item.labelKey}:${k}`}>
                          {i > 0 && <span className="shortcut-then"> → </span>}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </span>
                    <span className="shortcut-label">{t(item.labelKey)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
