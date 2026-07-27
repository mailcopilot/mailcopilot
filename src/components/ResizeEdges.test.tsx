// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import ResizeEdges from './ResizeEdges'

const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockOff = vi.fn()

Object.defineProperty(window, 'api', {
  value: {
    invoke: mockInvoke,
    on: mockOn,
    off: mockOff,
  },
  writable: true,
  configurable: true,
})

describe('ResizeEdges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'win:getPlatform') return Promise.resolve('linux')
      if (channel === 'win:isMaximized') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    cleanup()
  })

  async function getHandles() {
    const view = render(<ResizeEdges />)
    await waitFor(() => {
      expect(view.container.querySelectorAll('div')).toHaveLength(5)
    })
    return view.container.querySelectorAll('div')
  }

  it('starts resize on edge mousedown', async () => {
    const handles = await getHandles()
    fireEvent.mouseDown(handles[0])
    expect(mockInvoke).toHaveBeenCalledWith('win:startResize', expect.any(String))
  })

  it('stops resize on window blur after dragging starts', async () => {
    const handles = await getHandles()
    fireEvent.mouseDown(handles[0])
    fireEvent.blur(window)
    expect(mockInvoke).toHaveBeenCalledWith('win:stopResize')
  })

  it('stops resize on document mouseup after dragging starts', async () => {
    const handles = await getHandles()
    fireEvent.mouseDown(handles[0])
    fireEvent.mouseUp(document)
    expect(mockInvoke).toHaveBeenCalledWith('win:stopResize')
  })
})
