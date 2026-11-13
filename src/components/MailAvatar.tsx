import { useEffect, useState, useCallback } from 'react'
import { getInitials, getAvatarColor } from '../utils/mail'
import { getGravatarUrl, precomputeGravatarHash, markGravatarNotFound } from '../utils/gravatar'

interface MailAvatarProps {
  from: string
  fromAddr?: string
  gravatarEnabled: boolean
  /** Normalized addresses of the user's own accounts; no Gravatar request is made for them. */
  ownAddresses: ReadonlySet<string>
  title?: string
  onClick?: (e: React.MouseEvent) => void
}

/** Gravatar size (×2 for retina). */
const GRAVATAR_SIZE = 72

/** Sender avatar in the mail list — initials or Gravatar photo. */
export default function MailAvatar({ from, fromAddr, gravatarEnabled: gravatarSetting, ownAddresses, title, onClick }: MailAvatarProps) {
  const email = fromAddr || ''
  const gravatarEnabled = gravatarSetting && !ownAddresses.has(email.trim().toLowerCase())
  const [, setTick] = useState(0)

  const onReady = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    if (gravatarEnabled && email) {
      precomputeGravatarHash(email, GRAVATAR_SIZE, onReady)
    }
  }, [gravatarEnabled, email, onReady])

  const gravatarUrl = gravatarEnabled && email ? getGravatarUrl(email) : null

  return (
    <div
      className={`mail-avatar${fromAddr ? ' mail-avatar-clickable' : ''}`}
      style={{ background: gravatarUrl ? 'transparent' : getAvatarColor(fromAddr || from) }}
      title={title}
      onClick={onClick}
    >
      {gravatarUrl ? (
        <img
          src={gravatarUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => {
            markGravatarNotFound(email)
            setTick(t => t + 1)
          }}
        />
      ) : (
        getInitials(from)
      )}
    </div>
  )
}
