import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Runtime counter for emails processed today (archive, delete, spam, move, snooze).
 * Resets at midnight and on app restart. Non-persistent by design.
 */
export function useInboxZeroCounter() {
  const [count, setCount] = useState(0)
  const dateRef = useRef(todayString())

  const increment = useCallback((n = 1) => {
    if (n <= 0) return
    const today = todayString()
    if (today !== dateRef.current) {
      dateRef.current = today
      setCount(n)
      return
    }
    setCount(prev => prev + n)
  }, [])

  const decrement = useCallback((n = 1) => {
    if (n <= 0) return
    setCount(prev => Math.max(0, prev - n))
  }, [])

  // Midnight reset via interval check (every 60s)
  useEffect(() => {
    const interval = window.setInterval(() => {
      const today = todayString()
      if (today !== dateRef.current) {
        dateRef.current = today
        setCount(0)
      }
    }, 60_000)
    return () => window.clearInterval(interval)
  }, [])

  return { count, increment, decrement }
}

function todayString(): string {
  return new Date().toDateString()
}
