// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import MailAvatar from './MailAvatar'
import { clearGravatarCache } from '../utils/gravatar'

afterEach(() => {
  cleanup()
  clearGravatarCache()
})

describe('MailAvatar', () => {
  it('displays initials when Gravatar is disabled', () => {
    const { container } = render(
      <MailAvatar from="John Doe" fromAddr="john@test.com" gravatarEnabled={false} />
    )
    const avatar = container.querySelector('.mail-avatar')
    expect(avatar).toBeTruthy()
    expect(avatar!.textContent).toBe('JD')
    expect(avatar!.querySelector('img')).toBeNull()
  })

  it('adds mail-avatar-clickable class when fromAddr is present', () => {
    const { container } = render(
      <MailAvatar from="Jane" fromAddr="jane@test.com" gravatarEnabled={false} />
    )
    expect(container.querySelector('.mail-avatar-clickable')).toBeTruthy()
  })

  it('does not add clickable class without fromAddr', () => {
    const { container } = render(
      <MailAvatar from="Jane" gravatarEnabled={false} />
    )
    expect(container.querySelector('.mail-avatar-clickable')).toBeNull()
  })

  it('passes title prop', () => {
    const { container } = render(
      <MailAvatar from="Bob" gravatarEnabled={false} title="Bob Smith" />
    )
    expect(container.querySelector('.mail-avatar')!.getAttribute('title')).toBe('Bob Smith')
  })

  it('calls onClick on click', () => {
    const onClick = vi.fn()
    const { container } = render(
      <MailAvatar from="Click" fromAddr="click@test.com" gravatarEnabled={false} onClick={onClick} />
    )
    fireEvent.click(container.querySelector('.mail-avatar')!)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('shows img when Gravatar is enabled and URL is cached', async () => {
    const { container } = render(
      <MailAvatar from="Gravatar User" fromAddr="gravatar@test.com" gravatarEnabled={true} />
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
      <MailAvatar from="Fail User" fromAddr="fail@test.com" gravatarEnabled={true} />
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
      <MailAvatar from="No Email" gravatarEnabled={true} />
    )
    expect(container.querySelector('.mail-avatar img')).toBeNull()
    expect(container.querySelector('.mail-avatar')!.textContent).toBe('NE')
  })
})
