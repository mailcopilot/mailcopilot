import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-log/main
const mockScope = vi.fn()
const mockInitialize = vi.fn()
const mockLog = {
  initialize: mockInitialize,
  scope: mockScope,
  info: vi.fn(),
  transports: {
    file: {
      level: false as false | string,
      maxSize: 0,
      format: '',
      getFile: vi.fn(() => ({ path: '/tmp/test.log' })),
    },
    console: { level: false as false | string, format: '' },
  },
}

vi.mock('electron-log/main', () => ({ default: mockLog }))

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLog.transports.file.level = false
    mockLog.transports.file.maxSize = 0
    mockLog.transports.file.format = ''
    mockLog.transports.console.level = false
    mockLog.transports.console.format = ''
  })

  it('initLogger() with no arguments disables file logging', async () => {
    const { initLogger } = await import('./logger')
    initLogger()

    expect(mockInitialize).toHaveBeenCalledOnce()
    expect(mockLog.transports.file.level).toBe(false)
    expect(mockLog.transports.console.level).toBe('warn')
  })

  it('initLogger({ fileLogging: true }) enables file logging', async () => {
    const { initLogger } = await import('./logger')
    initLogger({ fileLogging: true })

    expect(mockInitialize).toHaveBeenCalledOnce()
    expect(mockLog.transports.file.level).toBe('info')
    expect(mockLog.transports.file.maxSize).toBe(10 * 1024 * 1024)
    expect(mockLog.transports.file.format).toContain('{level}')
    expect(mockLog.transports.console.level).toBe('debug')
  })

  it('createLogger() calls log.scope() with the given name', async () => {
    const fakeScopedLogger = { info: vi.fn(), error: vi.fn() }
    mockScope.mockReturnValue(fakeScopedLogger)

    const { createLogger } = await import('./logger')
    const logger = createLogger('IMAP')

    expect(mockScope).toHaveBeenCalledWith('IMAP')
    expect(logger).toBe(fakeScopedLogger)
  })
})
