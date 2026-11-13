// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import MailAvatar from './MailAvatar'
import { clearGravatarCache } from '../utils/gravatar'

afterEach(() => {
  cleanup()
  clearGravatarCache()
})

const NO_OWN: ReadonlySet<string> = new Set()

describe('MailAvatar', () => {
  it('displays initials when Gravatar is disabled', () => {
    const { container } = render(
      <MailAvatar ownAddresses={NO_OWN} from="John Doe" fromAddr="john@test.com" gravatarEnabled={false} />
    )
    const avatar = container.querySelector('.mail-avatar')
    expect(avatar).toBeTruthy()
    expect(avatar!.textContent).toBe('JD')
    expect(avatar!.querySelector('img')).toBeNull()
  })

  it('adds mail-avatar-clickable class when fromAddr is present', () => {
    const { container } = render(
      <MailAvatar ownAddresses={NO_OWN} from="Jane" fromAddr="jane@test.com" gravatarEnabled={false} />
    )
    expect(container.querySelector('.mail-avatar-clickable')).toBeTruthy()
  })

  it('does not add clickable class without fromAddr', () => {
    const { container } = render(
      <MailAvatar ownAddresses={NO_OWN} from="Jane" gravatarEnabled={false} />
    )
    expect(container.querySelector('.mail-avatar-clickable')).toBeNull()
  })

  it('passes title prop', () => {
    const { container } = render(
      <MailAvatar ownAddresses={NO_OWN} from="Bob" gravatarEnabled={false} title="Bob Smith" />
    )
    expect(container.querySelector('.mail-avatar')!.getAttribute('title')).toBe('Bob Smith')
  })

  it('calls onClick on click', () => {
    const onClick = vi.fn()
    const { container } = render(
      <MailAvatar ownAddresses={NO_OWN} from="Click" fromAddr="click@test.com" gravatarEnabled={false} onClick={onClick} />
    )
    fireEvent.click(container.querySelector('.mail-avatar')!)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('shows img when Gravatar is enabled and URL is cached', async () => {
    const { container } = render(
      <MailAvatar ownAddresses={NO_OWN} from="Gravatar User" fromAddr="gravatar@test.com" gravatarEnabled={true} />
    )
    // Wait for async precompute — after this img should appear
    await vi.waitFor(() => {
      const img = container.querySelector('.mail-avatar img')
      expect(img).toBeTruthy()
    })
    const img = container.querySelector('.mail-avatar img') as HTMLImageElement
    expect(img.src).toContain('gravatar.com/avatar/')
    expect(img.src).toContain('d=404')
  })

  it('falls back to initials on img load error', async () => {
    const { container } = render(
      <MailAvatar ownAddresses={NO_OWN} from="Fail User" fromAddr="fail@test.com" gravatarEnabled={true} />
    )
    await vi.waitFor(() => {
      expect(container.querySelector('.mail-avatar img')).toBeTruthy()
    })
    // Simulate load error
    fireEvent.error(container.querySelector('.mail-avatar img')!)
    // After error, img should disappear and initials should show
    await vi.waitFor(() => {
      expect(container.querySelector('.mail-avatar img')).toBeNull()
      expect(container.querySelector('.mail-avatar')!.textContent).toBe('FU')
    })
  })

  it('does not load Gravatar without fromAddr', () => {
    const { container } = render(
      <MailAvatar ownAddresses={NO_OWN} from="No Email" gravatarEnabled={true} />
    )
    expect(container.querySelector('.mail-avatar img')).toBeNull()
    expect(container.querySelector('.mail-avatar')!.textContent).toBe('NE')
  })

  it('sets no-referrer on the photo request', async () => {
    const { container } = render(
      <MailAvatar ownAddresses={NO_OWN} from="Ref User" fromAddr="ref@test.com" gravatarEnabled={true} />
    )
    await vi.waitFor(() => {
      expect(container.querySelector('.mail-avatar img')).toBeTruthy()
    })
    expect(container.querySelector('.mail-avatar img')!.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('makes no Gravatar request for the user\'s own addresses', async () => {
    const own = new Set(['me@test.com'])
    const { container } = render(
      <MailAvatar from="Me" fromAddr=" Me@Test.com " gravatarEnabled={true} ownAddresses={own} />
    )
    // Give the async hash a chance to resolve; no image may appear.
    await new Promise(r => setTimeout(r, 50))
    expect(container.querySelector('.mail-avatar img')).toBeNull()
    expect(container.querySelector('.mail-avatar')!.textContent).toBe('ME')
  })

  it('still requests a photo for other addresses when own addresses are given', async () => {
    const own = new Set(['me@test.com'])
    const { container } = render(
      <MailAvatar from="Other" fromAddr="other@test.com" gravatarEnabled={true} ownAddresses={own} />
    )
    await vi.waitFor(() => {
      expect(container.querySelector('.mail-avatar img')).toBeTruthy()
    })
  })
})
