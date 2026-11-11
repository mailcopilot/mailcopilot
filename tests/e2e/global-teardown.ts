/**
 * Playwright global teardown: kills apps this run launched but never closed.
 *
 * A worker torn down on a timeout or crash skips `closeApp`, and the app it had
 * spawned outlives it (see runMarker.ts for the incident and the matching
 * rules). By the time this runs every worker has stopped, so anything still
 * carrying this run's marker is a leftover. Only this run's exact marker is
 * matched. The teardown never fails the run: a reaping problem is logged, not
 * thrown — but a scan that could not look at the process table at all is
 * reported as a warning, never as "found 0".
 */
import { E2E_RUN_ID_ENV, reapRunMarkedProcesses } from './runMarker'

export default async function globalTeardown(): Promise<void> {
  try {
    const result = await reapRunMarkedProcesses(process.env[E2E_RUN_ID_ENV])
    switch (result.status) {
      case 'skipped':
        console.log(`[e2e-teardown] orphan reaping skipped: ${result.reason}`)
        return
      case 'scan-failed':
        console.warn(
          `[e2e-teardown] WARNING: could not list processes (${result.error}); `
            + 'apps this run left behind, if any, were NOT reaped',
        )
        return
      case 'done':
        console.log(
          `[e2e-teardown] reaped leftover app processes: found ${result.found}, killed ${result.killed}`
            + ` (unreadable entries ${result.unreadable}, pid reused before signal ${result.identityChanged})`,
        )
        if (result.xvfbScanFailed) {
          console.warn('[e2e-teardown] WARNING: could not look up the Xvfb server of a stuck xvfb-run; it may leak')
        }
        return
    }
  } catch (err) {
    console.warn('[e2e-teardown] orphan reaping failed:', err)
  }
}
