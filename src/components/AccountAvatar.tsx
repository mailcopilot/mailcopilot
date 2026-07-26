import { useEffect, useState } from 'react'
import type { AccountMeta } from '../../packages/net/types'
import { getInitials, getPaletteColor, getAvatarColor } from '../utils/mail'
import { AVATAR_ICONS, getAvatarIcon } from '../utils/avatarIcons'
import { sha256hex } from '../utils/gravatar'

export type ConnectionStatus = 'ok' | 'error' | 'syncing'

type DivProps = React.HTMLAttributes<HTMLDivElement>

interface AccountAvatarProps extends DivProps {
  account: AccountMeta
  size?: number
  unread?: number
  connStatus?: ConnectionStatus
  /** Called when Gravatar is not found or failed to load. */
  onGravatarFailed?: () => void
}

/** Reusable account avatar component. */
export default function AccountAvatar({ account, size = 36, unread, connStatus, onGravatarFailed, className, style, ...rest }: AccountAvatarProps) {
  const email = account.email || account.imap.user || ''
  const displayName = (account.name || '').trim()
  const label = displayName || email || `#${account.id}`

  const bgColor = typeof account.colorIndex === 'number'
    ? getPaletteColor(account.colorIndex)
    : getAvatarColor(email || label)

  const initials = account.avatarInitials || getInitials(label)
  const fontSize = Math.round(size * 0.36)
  const iconSize = Math.round(size * 0.44)

  const isGravatar = account.avatarMode === 'gravatar' && email
  // Only treat as icon mode when a recognised icon name is set — unrecognised
  // names (empty string, legacy values) fall through to the initials branch so
  // the user never sees the Mail fallback icon instead of their own initials.
  const isIcon = account.avatarMode === 'icon'
    && account.avatarIcon
    && (AVATAR_ICONS as readonly string[]).includes(account.avatarIcon)

  // Gravatar URL (SHA-256 hash of email)
  const [gravatarUrl, setGravatarUrl] = useState<string | null>(null)
  const [gravatarFailed, setGravatarFailed] = useState(false)

  useEffect(() => {
    if (!isGravatar) { setGravatarUrl(null); setGravatarFailed(false); return }
    let cancelled = false
    sha256hex(email.trim().toLowerCase())
      .then(hash => {
        if (!cancelled) setGravatarUrl(`https://www.gravatar.com/avatar/${hash}?d=404&s=${size * 2}`)
      })
      .catch(() => {
        if (!cancelled) { setGravatarFailed(true); onGravatarFailed?.() }
      })
    return () => { cancelled = true }
  }, [isGravatar, email, size, onGravatarFailed])

  const showGravatar = isGravatar && gravatarUrl && !gravatarFailed
  const IconComponent = isIcon ? getAvatarIcon(account.avatarIcon!) : null

  // Content inside the circle
  let content: React.ReactNode
  if (showGravatar) {
    content = (
      <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', position: 'absolute', inset: 0 }}>
        <img
          src={gravatarUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => { setGravatarFailed(true); onGravatarFailed?.() }}
        />
      </div>
    )
  } else if (IconComponent) {
    content = <IconComponent size={iconSize} />
  } else {
    content = initials
  }

  return (
    <div
      {...rest}
      className={`account-avatar${className ? ` ${className}` : ''}`}
      style={{
        background: showGravatar ? 'transparent' : bgColor,
        width: size,
        height: size,
        fontSize,
        ...style,
      }}
    >
      {content}
      {typeof unread === 'number' && unread > 0 && <span className="account-badge">{unread}</span>}
      {connStatus && <span className={`connection-dot connection-dot-${connStatus}`} />}
    </div>
  )
}
