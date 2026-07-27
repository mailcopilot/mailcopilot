// Centralized logging via electron-log.
// In dev mode, logs are written to file (~/.config/mailcopilot/logs/main.log) and console.
// In production, file logging is disabled unless debugLogging is enabled in settings.
//
// Usage:
//   import { initLogger, createLogger } from './logger'
//   initLogger({ fileLogging: true })    // once at startup
//   const log = createLogger('IMAP')     // scoped logger
//   log.info('Connecting...')

import log from 'electron-log/main'

interface LoggerOptions {
  /** Enable file logging. Default is false (console only). */
  fileLogging?: boolean
}

/** Initialize logging. Call once at the start of main.ts. */
export function initLogger(options: LoggerOptions = {}) {
  log.initialize() // sets up IPC for renderer (electron-log/renderer)

  const fileLogging = options.fileLogging ?? false

  // File: info+ if enabled, otherwise disabled
  log.transports.file.level = fileLogging ? 'info' : false
  log.transports.file.maxSize = 10 * 1024 * 1024 // 10 MB, then rotation → main.old.log
  // Local time ({y}-{m}-{d} {h}:{i}:{s}) instead of UTC ({iso}) — easier for debugging
  log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {scope} {text}'

  // Console: debug in dev, warn in production
  log.transports.console.level = fileLogging ? 'debug' : 'warn'
  log.transports.console.format = '{h}:{i}:{s}.{ms} [{level}] {scope} {text}'

  // Diagnostics: show log file path
  if (fileLogging) {
    const logPath = log.transports.file.getFile()?.path
    log.info(`File logging enabled: ${logPath}`)
  }
}

/** Create a scoped logger for a module. */
export function createLogger(scope: string) {
  return log.scope(scope)
}

export default log
