import { useEffect, useMemo, useRef, useState } from 'react'
import { CITATION_MAX_PER_ANSWER } from '@mailcopilot/core'
import type { CitationStatus } from '../utils/aiSourceVerdict'
import { createAnswerTokenCache } from '../utils/answerCitations'

/**
 * What main says each citation ticket of the open chat's answers is (`ai:resolveCitations`): a source of THIS
 * session (found / missing) or not a source (unknown). A ticket is asked about once per session and chat; the
 * answers are re-asked after the mailbox list changes (captions and "message is gone" can change). While main has
 * not answered, a ticket is simply absent from the map (the panel shows the link as pending, never as unconfirmed).
 * A failed question leaves the tickets absent and asks again the next time the answers change.
 */
export function useCitations(
  sessionId: string | null,
  answers: readonly string[],
): { citations: ReadonlyMap<string, CitationStatus>; tokensOf: (text: string) => string[] } {
  const [citations, setCitations] = useState<ReadonlyMap<string, CitationStatus>>(new Map())
  const [epoch, setEpoch] = useState(0)
  const asked = useRef<Set<string>>(new Set())
  const sessionRef = useRef<string | null>(sessionId)
  sessionRef.current = sessionId

  // One cache of parsed answers per chat: a chat that is closed leaves nothing of itself alive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cache = useMemo(() => createAnswerTokenCache(), [sessionId])
  const tokensOf = cache.tokensOf

  // Which tickets the answers contain, as a stable key so an unrelated re-render does not re-ask.
  const tokens = useMemo(() => {
    const seen = new Set<string>()
    for (const text of answers) for (const token of tokensOf(text)) seen.add(token)
    return [...seen]
  }, [answers, tokensOf])
  const tokenKey = tokens.join(',')

  // A different chat starts from nothing: another session's tickets mean nothing here.
  useEffect(() => {
    asked.current = new Set()
    setCitations(new Map())
  }, [sessionId])

  useEffect(() => {
    const onChanged = () => { asked.current = new Set(); setEpoch(e => e + 1) }
    window.api.on('accounts:changed', onChanged as (...args: unknown[]) => void)
    return () => { window.api.off('accounts:changed', onChanged as (...args: unknown[]) => void) }
  }, [])

  useEffect(() => {
    if (!sessionId) return
    const fresh = tokens.filter(token => !asked.current.has(token))
    if (fresh.length === 0) return
    for (const token of fresh) asked.current.add(token)
    // Main refuses a request with more than CITATION_MAX_PER_ANSWER tickets, so a long chat is asked in batches.
    for (let at = 0; at < fresh.length; at += CITATION_MAX_PER_ANSWER) {
      const batch = fresh.slice(at, at + CITATION_MAX_PER_ANSWER)
      void (async () => {
        let answered = new Set<string>()
        try {
          const reply = await window.api.invoke('ai:resolveCitations', { sessionId, tokens: batch }) as CitationStatus[] | undefined
          // The answer belongs to the chat that asked; a chat opened meanwhile has its own tickets.
          if (sessionRef.current !== sessionId) return
          if (Array.isArray(reply)) {
            const items = reply.filter(item => item && typeof item.token === 'string')
            answered = new Set(items.map(item => item.token))
            setCitations(prev => {
              const next = new Map(prev)
              for (const item of items) next.set(item.token, item)
              return next
            })
          }
        } catch { /* the tickets stay unanswered, below */ }
        // Whatever main did not answer about is asked again the next time the answers change.
        for (const token of batch) if (!answered.has(token)) asked.current.delete(token)
      })()
    }
    // `tokenKey` stands for `tokens`: same content, same effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tokenKey, epoch])

  return { citations, tokensOf }
}
