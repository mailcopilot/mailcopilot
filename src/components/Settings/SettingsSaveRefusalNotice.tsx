import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import {
  isKnownRefusableField,
  isKnownRefusalCode,
  type RefusedSettingsField,
  type SettingsSaveRefusalNotice as Notice,
} from '../../hooks/useSettingsSaveRefusal'

/**
 * "One field of that save was not applied" (BACKLOG §2.167).
 *
 * Shown after a `settings:save` that main answered with a `refused` array. When
 * the refusal named the offending entries, this window has already taken them
 * out of its own `mcpExportWhitelist` state, and the notice says which ones —
 * that is an edit to the person's configuration that they did not ask for, so
 * it is reportable for the same reason the refusal is. Both are one event and
 * therefore one notice, rather than two banners that can contradict each other.
 *
 * WHY IT SITS BY THE SAVE BUTTON AND NOT INSIDE THE MCP EXPORT SECTION. The
 * section lives on the AI tab, but Save is window-wide: a person editing the
 * General tab can press Save and have their MCP export list refused without
 * ever opening the tab that would hold the notice. The same reasoning put the
 * §2.119 destination notice here. The text carries the section's own name so
 * the notice is still self-locating.
 *
 * ALWAYS AN ERROR SURFACE, unlike the earlier version of this component. Every
 * state it can be rendered in now means the same thing: a setting the person
 * edited is NOT in effect, and pressing Save again is what puts it there (the
 * corrected list is on screen, unsaved). There is no longer a quiet "we
 * repaired something and saved it anyway" case to distinguish.
 */

/** Per-field heading. Unknown fields fall back to a generic sentence. */
const FIELD_TITLE_KEYS = {
  mcpExportWhitelist: 'settings.mcpExport.refusedTitle',
} as const

/** Per-code explanation. Unknown codes fall back to "not accepted". */
const CODE_DETAIL_KEYS = {
  unknown_export_tool: 'settings.mcpExport.refusedUnknownTool',
} as const

export interface SettingsSaveRefusalNoticeProps {
  /** Nothing is rendered when null. */
  notice: Notice | null
}

function RefusedFieldLine({ refused }: { refused: RefusedSettingsField }) {
  const { t } = useTranslation()
  const title = isKnownRefusableField(refused.field)
    ? t(FIELD_TITLE_KEYS[refused.field])
    // A field this build has never heard of is still reported, by its wire
    // name: an unnamed "something was not saved" is worse than an identifier
    // the person can search for.
    : t('settings.saveRefusal.unknownField', { field: refused.field })
  const detail = isKnownRefusalCode(refused.code)
    ? t(CODE_DETAIL_KEYS[refused.code])
    : t('settings.mcpExport.refusedOther')
  return (
    <div data-testid={`settings-save-refusal-field-${refused.field}`}>
      <div><strong>{title}</strong></div>
      <div>{detail}</div>
    </div>
  )
}

export default function SettingsSaveRefusalNotice({ notice }: SettingsSaveRefusalNoticeProps) {
  const { t } = useTranslation()
  if (!notice) return null

  const refused = notice.refusedFields
  const repaired = notice.repairedExportTools

  return (
    <div
      className="error-banner"
      role="alert"
      data-testid="settings-save-refusal-notice"
      style={{ alignItems: 'flex-start', marginTop: 16 }}
    >
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>
        {refused.map(entry => <RefusedFieldLine key={entry.field} refused={entry} />)}
        {repaired.length > 0 && (
          <div data-testid="settings-save-refusal-repaired">
            <div><strong>{t('settings.mcpExport.repairedTitle')}</strong></div>
            {/* Tool names are identifiers, not prose: they are listed verbatim
                so they can be matched against the exported tool list. */}
            <div>{t('settings.mcpExport.repairedTools', { tools: repaired.join(', ') })}</div>
            <div>{t('settings.mcpExport.repairedExplain')}</div>
          </div>
        )}
        {/* Deliberately NOT "all your other changes were saved". The same
            reply can carry a rejected AI destination (§2.119), which is a
            second edit that did not land and which its own notice reports
            right next to this one — an absolute claim here would contradict
            it. This banner only knows about the field IT reports, so it
            speaks only for what the save accepted. */}
        <div data-testid="settings-save-refusal-other-saved">
          {t('settings.mcpExport.otherSettingsSaved')}
        </div>
      </div>
    </div>
  )
}
