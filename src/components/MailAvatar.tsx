import { useEffect, useState, useCallback } from 'react'
import { getInitials, getAvatarColor } from '../utils/mail'
import { getGravatarUrl, precomputeGravatarHash, markGravatarNotFound } from '../utils/gravatar'

interface MailAvatarProps {
  from: string
  fromAddr?: string
  gravatarEnabled: boolean
  title?: string
  onClick?: (e: React.MouseEvent) => void
}

/** Gravatar size (×2 for retina). */
const GRAVATAR_SIZE = 72

/** Sender avatar in the mail list — initials or Gravatar photo. */
export default function MailAvatar({ from, fromAddr, gravatarEnabled, title, onClick }: MailAvatarProps) {
  const email = fromAddr || ''
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
