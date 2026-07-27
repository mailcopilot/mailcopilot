import { describe, it, expect } from 'vitest'
import { parseShellArgs } from './parseShellArgs'

describe('parseShellArgs', () => {
  it('splits simple whitespace-separated args', () => {
    expect(parseShellArgs('--verbose --port 8080')).toEqual(['--verbose', '--port', '8080'])
  })

  it('handles double-quoted strings', () => {
    expect(parseShellArgs('--path "/Users/me/My Folder" --verbose')).toEqual([
      '--path', '/Users/me/My Folder', '--verbose',
    ])
  })

  it('handles single-quoted strings', () => {
    expect(parseShellArgs("--name 'hello world'")).toEqual(['--name', 'hello world'])
  })

  it('handles mixed quotes', () => {
    expect(parseShellArgs(`--a "double" --b 'single'`)).toEqual(['--a', 'double', '--b', 'single'])
  })

  it('handles empty input', () => {
    expect(parseShellArgs('')).toEqual([])
  })

  it('handles whitespace-only input', () => {
    expect(parseShellArgs('   ')).toEqual([])
  })

  it('handles tabs and multiple spaces', () => {
    expect(parseShellArgs('a\t\tb   c')).toEqual(['a', 'b', 'c'])
  })

  it('handles unclosed quote gracefully', () => {
    expect(parseShellArgs('--path "/some/dir')).toEqual(['--path', '/some/dir'])
  })

  it('handles adjacent quoted and unquoted text', () => {
    expect(parseShellArgs('pre"mid"post')).toEqual(['premidpost'])
  })
})
