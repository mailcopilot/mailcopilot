/**
 * Playwright global setup: mints the id that tags every app launched by this run.
 *
 * Runs once in the runner process before any worker starts, and workers inherit
 * the runner's environment — so all workers of one run share the same id, and
 * `global-teardown.ts` can reap exactly this run's leftovers. A fresh id is
 * minted every time, even if one is already set, so a value exported in the
 * developer's shell can never make two runs share a marker. See runMarker.ts.
 */
import { randomUUID } from 'node:crypto'
import { E2E_RUN_ID_ENV } from './runMarker'

export default function globalSetup(): void {
  process.env[E2E_RUN_ID_ENV] = randomUUID()
}
