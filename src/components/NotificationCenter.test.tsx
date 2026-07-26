// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NotificationCenter from './NotificationCenter'
import type { AppNotification } from './NotificationCenter'

afterEach(cleanup)

const labels = {
  title: 'Notifications',
  markAllRead: 'Mark all read',
  empty: 'No notifications',
  followUpDue: 'Follow-up reminder',
  sendFailed: 'Send failed',
  dismiss: 'Dismiss',
}

const mockNotifications: AppNotification[] = [
  { id: 1, type: 'followup_due', title: 'Re: Project update', body: 'john@example.com', refId: '42', read: false, createdAt: '2026-04-06T10:00:00Z' },
  { id: 2, type: 'send_failed', title: 'Hello', body: 'SMTP timeout', refId: 'q-1', read: true, createdAt: '2026-04-05T08:00:00Z' },
]

function setupMockApi(notifications: AppNotification[] = mockNotifications, unread = 1) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'notifications:list') return notifications
    if (channel === 'notifications:unreadCount') return unread
    if (channel === 'notifications:markAllRead') return { ok: true }
    if (channel === 'notifications:markRead') return { ok: true }
    if (channel === 'notifications:delete') return { ok: true }
    return null
  })
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const on = vi.fn((ch: string, fn: (...args: unknown[]) => void) => {
    if (!listeners.has(ch)) listeners.set(ch, new Set())
    listeners.get(ch)!.add(fn)
  })
  const off = vi.fn((ch: string, fn: (...args: unknown[]) => void) => {
    listeners.get(ch)?.delete(fn)
  })
  Object.defineProperty(window, 'api', {
    value: { invoke, on, off },
    writable: true,
    configurable: true,
  })
  return { invoke, on, off, listeners }
}

describe('NotificationCenter', () => {
  it('renders bell button', async () => {
    setupMockApi()
    render(<NotificationCenter labels={labels} />)
    expect(screen.getByTestId('notification-bell')).toBeTruthy()
  })

  it('shows badge with unread count', async () => {
    setupMockApi(mockNotifications, 3)
    render(<NotificationCenter labels={labels} />)
    await waitFor(() => {
      expect(screen.getByTestId('notification-badge').textContent).toBe('3')
    })
  })

  it('does not show badge when no unread', async () => {
    setupMockApi([], 0)
    render(<NotificationCenter labels={labels} />)
    await waitFor(() => {
      expect(screen.queryByTestId('notification-badge')).toBeNull()
    })
  })

  it('opens panel on bell click', async () => {
    setupMockApi()
    render(<NotificationCenter labels={labels} />)
    await waitFor(() => expect(screen.getByTestId('notification-bell')).toBeTruthy())
    fireEvent.click(screen.getByTestId('notification-bell'))
    expect(screen.getByTestId('notification-panel')).toBeTruthy()
  })

  it('shows notification items in panel', async () => {
    setupMockApi()
    render(<NotificationCenter labels={labels} />)
    await waitFor(() => expect(screen.getByTestId('notification-bell')).toBeTruthy())
    fireEvent.click(screen.getByTestId('notification-bell'))
    expect(screen.getByText('Re: Project update')).toBeTruthy()
    expect(screen.getByText('Hello')).toBeTruthy()
  })

  it('shows empty message when no notifications', async () => {
    setupMockApi([], 0)
    render(<NotificationCenter labels={labels} />)
    await waitFor(() => expect(screen.getByTestId('notification-bell')).toBeTruthy())
    fireEvent.click(screen.getByTestId('notification-bell'))
    expect(screen.getByText('No notifications')).toBeTruthy()
  })

  it('calls markAllRead on button click', async () => {
    const { invoke } = setupMockApi()
    render(<NotificationCenter labels={labels} />)
    await waitFor(() => expect(screen.getByTestId('notification-badge')).toBeTruthy())
    fireEvent.click(screen.getByTestId('notification-bell'))
    fireEvent.click(screen.getByText('Mark all read'))
    expect(invoke).toHaveBeenCalledWith('notifications:markAllRead')
  })

  it('calls onFollowUpClick when clicking a followup notification', async () => {
    const onFollowUpClick = vi.fn()
    const { invoke } = setupMockApi()
    render(<NotificationCenter labels={labels} onFollowUpClick={onFollowUpClick} />)
    await waitFor(() => expect(screen.getByTestId('notification-bell')).toBeTruthy())
    fireEvent.click(screen.getByTestId('notification-bell'))
    fireEvent.click(screen.getByText('Re: Project update'))
    expect(onFollowUpClick).toHaveBeenCalledWith('42')
    expect(invoke).toHaveBeenCalledWith('notifications:markRead', 1)
  })

  it('closes panel on Escape', async () => {
    setupMockApi()
    render(<NotificationCenter labels={labels} />)
    await waitFor(() => expect(screen.getByTestId('notification-bell')).toBeTruthy())
    fireEvent.click(screen.getByTestId('notification-bell'))
    expect(screen.getByTestId('notification-panel')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('notification-panel')).toBeNull()
  })

  it('caps badge at 99+', async () => {
    setupMockApi([], 150)
    render(<NotificationCenter labels={labels} />)
    await waitFor(() => {
      expect(screen.getByTestId('notification-badge').textContent).toBe('99+')
    })
  })
})
