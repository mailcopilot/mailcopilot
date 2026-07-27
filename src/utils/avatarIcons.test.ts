import { describe, it, expect } from 'vitest'
import { AVATAR_ICONS, getAvatarIcon } from './avatarIcons'

describe('avatarIcons', () => {
  it('AVATAR_ICONS contains 19 icons', () => {
    expect(AVATAR_ICONS.length).toBe(19)
  })

  it('all names are unique', () => {
    const unique = new Set(AVATAR_ICONS)
    expect(unique.size).toBe(AVATAR_ICONS.length)
  })

  it('getAvatarIcon returns a component for known icons', () => {
    for (const name of AVATAR_ICONS) {
      const Icon = getAvatarIcon(name)
      // lucide-react components are React.memo (object) or function
      expect(Icon).toBeDefined()
      expect(typeof Icon === 'function' || typeof Icon === 'object').toBe(true)
    }
  })

  it('getAvatarIcon returns Mail for an unknown icon', () => {
    const fallback = getAvatarIcon('unknown-icon')
    const mail = getAvatarIcon('mail')
    expect(fallback).toBe(mail)
  })
})
