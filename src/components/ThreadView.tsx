/**
 * ThreadView — vertical stack-of-cards thread view.
 *
 * Architecture:
 * - Receives a ThreadRow and renders each message as a card sorted by
 *   conversation order (newest-top by default; respects 'conversationOrder'
 *   setting loaded from window.api).
 * - `expandedSet` in useThreadCards is the single source of truth for expansion:
 *   a card is expanded iff its key is in expandedSet.
 * - Clicking a collapsed card calls `onCardOpen(item)`, which triggers openMail
 *   in App.tsx, changing `active` and loading details. useThreadCards then resets
 *   expandedSet to the new activeKey.
 * - Clicking an expanded+active card toggles it closed (collapses it without
 *   switching the active mail).
 * - Clicking a collapsed+active card re-expands it.
 * - Thread-level actions live in the single top viewer toolbar (App.tsx) and
 *   apply to the whole thread when activeThread.count > 1, matching Gmail /
 *   Spark / Shortwave / Apple Mail / Outlook behavior. ThreadView itself does
 *   NOT render an action bar — having two toolbars (Gmail/Outlook do not) led
 *   to confusion about which scope a button targets.
 */

import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MailSummary } from '../../packages/net/types'
import type { ThreadRow } from '../utils/threading'
import { useThreadCards } from '../hooks/useThreadCards'
import type { ConversationOrder } from '../hooks/useThreadCards'
import { useThreadSummary } from '../hooks/useThreadSummary'
import { useInstantReply } from '../hooks/useInstantReply'
import type { InstantReplyDraft } from '../utils/quickActions'
import MailAvatar from './MailAvatar'
import { ThreadSummaryStrip } from './ThreadSummaryStrip'
import { InstantReplyStrip } from './InstantReplyStrip'
import { formatSmartDate } from '../utils/mail'

interface ThreadViewProps {
  thread: ThreadRow
  /** mailKey of the currently active / selected message */
  activeKey: string | null
  /** Called when user clicks a collapsed card to open it */
  onCardOpen: (item: MailSummary) => void
  /** Body content for the currently expanded (active) card — rendered as a slot */
  renderBody: () => React.ReactNode
  gravatarEnabled: boolean
  /**
   * Conversation card order override. When provided, this value is passed
   * directly to useConversationOrder as an override, which skips the async
   * settings:get IPC call and the settings:changed subscription entirely.
   * Useful in tests and when the parent already knows the desired sort
   * direction. When omitted, the hook loads the value from settings (defaulting
   * to newest-top until the async read resolves).
   */
  order?: ConversationOrder
  /**
   * §3.3 B2 Thread AI Summary — per-account opt-in for the active thread's
   * account, resolved by the caller from
   * `settings.aiThreadSummaryEnabled["<accountId>"]`. Default false. When
   * false the summary strip is inert (no IPC, not rendered). The strip is also
   * gated on the thread having ≥3 messages inside the hook.
   */
  summaryEnabled?: boolean
  /**
   * §3.3 B4 Instant Reply — per-account opt-in for the active thread's account,
   * resolved by the caller from `settings.aiInstantReplyEnabled["<accountId>"]`.
   * Default false. When false the Instant Reply strip is inert (no IPC, not
   * rendered). The strip attaches to the actively-open card only.
   */
  instantReplyEnabled?: boolean
  /**
   * Called when the user picks an Instant Reply draft option. The parent
   * prefills a NEW Compose (via `ui:openCompose`) with the draft body; nothing
   * is sent automatically. `ref` is the message the reply is scoped to.
   */
  onInstantReplyPick?: (
    ref: { accountId: number; folder: string; uid: number },
    draft: InstantReplyDraft,
  ) => void
}

/**
 * Read the conversationOrder setting from window.api once on mount and subscribe
 * to settings:changed events for live updates.
 *
 * When `override` is provided the hook returns that value immediately and skips
 * both the initial settings:get IPC call and the settings:changed subscription.
 * This is the mechanism that lets callers short-circuit IPC in tests or when the
 * parent component already knows the desired sort direction.
 */
function useConversationOrder(override?: ConversationOrder): ConversationOrder {
  const [order, setOrder] = useState<ConversationOrder>(override ?? 'newest-top')

  useEffect(() => {
    if (override !== undefined) return

    let cancelled = false

    void (async () => {
      try {
        const s = await window.api.invoke('settings:get') as { conversationOrder?: unknown } | undefined
        if (!cancelled && s) {
          const v = s.conversationOrder
          if (v === 'oldest-top' || v === 'newest-top') {
            setOrder(v)
          }
        }
      } catch {
        // ignore — keep default
      }
    })()

    const onChanged = (...args: unknown[]) => {
      const s = args[0] as { conversationOrder?: unknown } | undefined
      if (!s) return
      const v = s.conversationOrder
      if (v === 'oldest-top' || v === 'newest-top') {
        setOrder(v)
      }
    }
    window.api?.on('settings:changed', onChanged)

    return () => {
      cancelled = true
      window.api?.off('settings:changed', onChanged)
    }
  }, [override])

  return override ?? order
}

export default function ThreadView({
  thread,
  activeKey,
  onCardOpen,
  renderBody,
  gravatarEnabled,
  order: orderProp,
  summaryEnabled = false,
  instantReplyEnabled = false,
  onInstantReplyPick,
}: ThreadViewProps) {
  const { t } = useTranslation()
  const order = useConversationOrder(orderProp)
  const { cards, expandedKeys, toggleCard } = useThreadCards(thread, activeKey, order)

  // §3.3 B2: the summary is scoped to the actively-open thread only — no
  // list-level or ambient processing. The hook holds the debounce/IPC/refusal
  // logic; ThreadView just renders whatever it produces (CLAUDE.md §5).
  const summary = useThreadSummary({
    accountId: thread.lead?.accountId ?? null,
    messages: thread.items,
    enabled: summaryEnabled,
    threadKey: thread.key,
  })

  // §3.3 B4: Instant Reply is scoped to the actively-open card. All request /
  // refusal / options logic lives in the hook; the strip only renders it.
  const instantReply = useInstantReply()

  // Reset Instant Reply state when the active card changes so options generated
  // for one message never leak onto another (dismiss is idempotent/no-op when
  // already idle). Keyed on activeKey — the active card's identity.
  const instantReplyDismiss = instantReply.dismiss
  useEffect(() => {
    instantReplyDismiss()
  }, [activeKey, instantReplyDismiss])

  return (
    <div className="thread-view" data-testid="thread-view">
      {summary.active && (
        <ThreadSummaryStrip
          status={summary.status}
          summary={summary.summary}
          refusal={summary.refusal}
          onRetry={summary.retry}
        />
      )}
      <div className="thread-cards">
        {cards.map(card => {
          const isActive = card.key === activeKey
          const isExpanded = expandedKeys.has(card.key)
          const showBody = isActive && isExpanded

          const fromLabel = (card.item.fromName || card.item.from || card.item.fromAddr || '').trim()
          const dateLabel = formatSmartDate(card.item.date, t).display

          return (
            <div
              key={card.key}
              className={[
                'thread-card',
                isActive ? 'thread-card-active' : '',
                isExpanded ? 'thread-card-expanded' : 'thread-card-collapsed',
                card.item.unread ? 'thread-card-unread' : '',
              ].filter(Boolean).join(' ')}
              data-testid="thread-card"
            >
              <button
                type="button"
                className="thread-card-header"
                aria-expanded={isExpanded}
                title={isExpanded ? t('mail.thread.collapseCard') : t('mail.thread.expandCard')}
                onClick={() => {
                  if (isExpanded && isActive) {
                    toggleCard(card.key)
                  } else if (!isExpanded && isActive) {
                    toggleCard(card.key)
                  } else if (!isExpanded && !isActive) {
                    onCardOpen(card.item)
                  }
                }}
              >
                <MailAvatar
                  from={card.item.from}
                  fromAddr={card.item.fromAddr}
                  gravatarEnabled={gravatarEnabled}
                />
                <div className="thread-card-header-meta">
                  <div className="thread-card-header-row">
                    <span className="thread-card-from">{fromLabel}</span>
                    <span className="thread-card-date">{dateLabel}</span>
                  </div>
                  {!isExpanded && (
                    <div className="thread-card-snippet">
                      {card.item.matchSnippet || card.item.subject || t('mail.thread.snippetEmpty')}
                    </div>
                  )}
                </div>
                <span className="thread-card-chevron" aria-hidden="true">
                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </span>
              </button>

              {showBody && (
                <div className="thread-card-body">
                  {instantReplyEnabled && (
                    <InstantReplyStrip
                      status={instantReply.status}
                      drafts={instantReply.drafts}
                      refusal={instantReply.refusal}
                      messageRef={{
                        accountId: card.item.accountId,
                        folder: card.item.folder,
                        uid: card.item.uid,
                        messageId: card.item.messageId ?? null,
                      }}
                      onGenerate={instantReply.generate}
                      onPick={draft => {
                        onInstantReplyPick?.(
                          {
                            accountId: card.item.accountId,
                            folder: card.item.folder,
                            uid: card.item.uid,
                          },
                          draft,
                        )
                        instantReply.dismiss()
                      }}
                    />
                  )}
                  {renderBody()}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
