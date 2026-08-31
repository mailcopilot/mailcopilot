// @vitest-environment jsdom
/**
 * Component tests for src/components/Settings/SettingsSaveRefusalNotice.tsx —
 * BACKLOG §2.167.
 *
 * What each test protects:
 *   - a field main refused is NAMED, in words, not left as "something failed";
 *   - export tool names this window removed from its state in answer to that
 *     refusal are listed verbatim, because the person's configuration was
 *     edited without them asking;
 *   - what the save ACCEPTED is reported as saved — scoped that way on purpose,
 *     because the same reply can also carry a rejected AI destination;
 *   - a field or code this build has never heard of is still reported.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { SettingsSaveRefusalNotice as Notice } from '../../hooks/useSettingsSaveRefusal'
import en from '../../i18n/locales/en.json'

/** The shipped English wording, so the closing-line test pins the real string. */
const OTHER_SAVED_EN: string = en.settings.mcpExport.otherSettingsSaved

const i18nMap: Record<string, string> = {
  'settings.mcpExport.refusedTitle': 'The MCP export tool list was not saved',
  'settings.mcpExport.refusedUnknownTool': 'It contains a tool name this version of the app does not export.',
  'settings.mcpExport.refusedOther': 'It was not accepted.',
  'settings.mcpExport.repairedTitle': 'Outdated tool names were removed from the list',
  'settings.mcpExport.repairedTools': 'Removed from the MCP export tool list: {{tools}}.',
  'settings.mcpExport.repairedExplain': 'Press Save again to store the corrected list.',
  'settings.mcpExport.otherSettingsSaved': OTHER_SAVED_EN,
  'settings.saveRefusal.unknownField': 'This setting was not saved: {{field}}.',
}
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  const value = i18nMap[key] ?? key
  if (!opts) return value
  return value.replace(/\{\{(\w+)\}\}/g, (_, k) => (opts[k] !== undefined ? String(opts[k]) : `{{${k}}}`))
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: stableT }) }))

const { default: SettingsSaveRefusalNotice } = await import('./SettingsSaveRefusalNotice')

function notice(patch: Partial<Notice> = {}): Notice {
  return { refusedFields: [], repairedExportTools: [], ...patch }
}

const WHITELIST_REFUSAL = {
  field: 'mcpExportWhitelist',
  code: 'unknown_export_tool',
  values: ['update_memory'],
}

afterEach(cleanup)

describe('§2.167 SettingsSaveRefusalNotice', () => {
  it('renders nothing when there is nothing to report', () => {
    const { container } = render(<SettingsSaveRefusalNotice notice={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the refused field and says why', () => {
    render(<SettingsSaveRefusalNotice notice={notice({ refusedFields: [WHITELIST_REFUSAL] })} />)
    const banner = screen.getByTestId('settings-save-refusal-notice')
    expect(banner).toHaveTextContent('The MCP export tool list was not saved')
    expect(banner).toHaveTextContent('does not export')
  })

  // Every state this banner can be in means the same thing now: a setting the
  // person edited is not in effect, and pressing Save again is what fixes it.
  it('presents itself as an error the person has to act on', () => {
    render(<SettingsSaveRefusalNotice notice={notice({ refusedFields: [WHITELIST_REFUSAL] })} />)
    const banner = screen.getByTestId('settings-save-refusal-notice')
    expect(banner).toHaveAttribute('role', 'alert')
    expect(banner).toHaveClass('error-banner')
  })

  it('lists the tool names it removed, verbatim', () => {
    render(<SettingsSaveRefusalNotice notice={notice({
      refusedFields: [WHITELIST_REFUSAL],
      repairedExportTools: ['update_memory', 'call_external_tool'],
    })} />)
    expect(screen.getByTestId('settings-save-refusal-repaired'))
      .toHaveTextContent('update_memory, call_external_tool')
  })

  // The repaired list is on screen and unsaved — the notice has to say what
  // closes the loop, or the person reads "not saved" with nothing to do.
  it('tells the person to save again after a repair', () => {
    render(<SettingsSaveRefusalNotice notice={notice({
      refusedFields: [WHITELIST_REFUSAL],
      repairedExportTools: ['update_memory'],
    })} />)
    expect(screen.getByTestId('settings-save-refusal-repaired'))
      .toHaveTextContent('Press Save again to store the corrected list.')
  })

  // A refusal this window could not repair says nothing about removals: no
  // entry left the person's list, and claiming otherwise would be a lie.
  it('says nothing about removals when there were none', () => {
    render(<SettingsSaveRefusalNotice notice={notice({
      refusedFields: [{ field: 'mcpExportWhitelist', code: 'unknown_export_tool', values: [] }],
    })} />)
    expect(screen.queryByTestId('settings-save-refusal-repaired')).toBeNull()
    expect(screen.getByTestId('settings-save-refusal-field-mcpExportWhitelist')).toBeInTheDocument()
  })

  it('states that what the save accepted landed', () => {
    render(<SettingsSaveRefusalNotice notice={notice({ refusedFields: [WHITELIST_REFUSAL] })} />)
    expect(screen.getByTestId('settings-save-refusal-other-saved'))
      .toHaveTextContent(OTHER_SAVED_EN)
  })

  // ...and says it about the ACCEPTED changes only. The same `settings:save`
  // can also reject the AI destination (§2.119), whose notice is rendered right
  // beside this one — "all your other changes were saved" would then be false
  // on screen, next to the banner proving it false. The claim is scoped in
  // words, so the guard is on the words: no universal quantifier here.
  it('does not claim every other change on the screen was saved', () => {
    expect(OTHER_SAVED_EN).not.toMatch(/\b(all|every|everything)\b/i)
    expect(OTHER_SAVED_EN.toLowerCase()).toContain('accepted')
  })

  it('shows both halves of one save together', () => {
    render(<SettingsSaveRefusalNotice notice={notice({
      refusedFields: [WHITELIST_REFUSAL],
      repairedExportTools: ['update_memory'],
    })} />)
    expect(screen.getByTestId('settings-save-refusal-field-mcpExportWhitelist')).toBeInTheDocument()
    expect(screen.getByTestId('settings-save-refusal-repaired')).toBeInTheDocument()
  })

  // FAIL-VISIBLE. A future main that refuses another field must not produce a
  // blank banner: the wire name is worse than a sentence, and better than
  // nothing the person can search for.
  it('reports a field this build does not know, by its wire name', () => {
    render(<SettingsSaveRefusalNotice notice={notice({
      refusedFields: [{ field: 'somethingNew', code: 'unknown_export_tool', values: [] }],
    })} />)
    expect(screen.getByTestId('settings-save-refusal-field-somethingNew'))
      .toHaveTextContent('This setting was not saved: somethingNew.')
  })

  it('falls back to a neutral explanation for a code it does not know', () => {
    render(<SettingsSaveRefusalNotice notice={notice({
      refusedFields: [{ field: 'mcpExportWhitelist', code: '', values: [] }],
    })} />)
    expect(screen.getByTestId('settings-save-refusal-field-mcpExportWhitelist'))
      .toHaveTextContent('It was not accepted.')
  })
})
