import { describe, it, expect, vi } from 'vitest'

vi.mock('keytar', () => ({ default: {} }))
vi.mock('electron-store', () => ({
  default: class MockStore {
    get() { return undefined }
    set() {}
    delete() {}
  },
}))
vi.mock('../db', () => ({ deleteAccountData: vi.fn() }))

import { settingsSchema } from './config'

describe('gravatarInMail default', () => {
  it('is off when the stored record has no value (privacy by default)', () => {
    const parsed = settingsSchema.parse({ theme: 'light' })
    expect(parsed.gravatarInMail).toBe(false)
  })

  it('leaves an explicitly stored value as it is (no migration)', () => {
    expect(settingsSchema.parse({ theme: 'light', gravatarInMail: true }).gravatarInMail).toBe(true)
    expect(settingsSchema.parse({ theme: 'light', gravatarInMail: false }).gravatarInMail).toBe(false)
  })
})
