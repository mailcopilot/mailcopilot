/**
 * §2.99/§2.228 — the strings the MAIN process renders: tray menu, tray
 * tooltip, new-mail notifications and the one-shot hint shown when a close
 * hides the window into the tray.
 *
 * i18next does not run in the main process, so this follows the mechanism
 * main.ts already uses for main-side localized text (`WINDOW_TITLES`): a table
 * keyed by the same six language codes the product ships, with English as the
 * fallback for anything unknown. A locale-walk test fails when a shipped
 * language is missing a key, which is the property that keeps the table honest.
 *
 * ADDING A LANGUAGE: add one block below and add the code to `TRAY_LANGUAGES`
 * in src/i18n/index.ts's shipped set — the test reads both.
 */

export type TrayLanguage = 'en' | 'ru' | 'fr' | 'de' | 'es' | 'it'

export type TrayLabelKey =
  | 'open'
  | 'compose'
  | 'checkMail'
  | 'quit'
  /** Tooltip fragment; `{{count}}` is substituted by `formatTrayTooltip`. */
  | 'unreadCount'
  /** Notification title when a message has no subject. */
  | 'newMail'
  /** Notification title for an aggregated pass; `{{count}}` is substituted. */
  | 'newMailCount'
  /** §2.228 — one-shot hint shown the first time a close hides to the tray. */
  | 'backgroundHintTitle'
  | 'backgroundHintBody'
  /**
   * Tooltip + inert menu line while the quit drain runs. The icon survives the
   * whole drain now (see services/tray.ts `disarmTray`), so it has to say what
   * it is doing — a stale unread count would read as "nothing is happening".
   */
  | 'quitting'

export const TRAY_LABELS: Record<TrayLanguage, Record<TrayLabelKey, string>> = {
  en: {
    open: 'Open MailCopilot',
    compose: 'New Message',
    checkMail: 'Check Mail',
    quit: 'Quit',
    unreadCount: '{{count}} unread',
    newMail: 'New mail',
    newMailCount: '{{count}} new messages',
    backgroundHintTitle: 'MailCopilot is still running',
    backgroundHintBody: 'The window was closed to the tray. Click the tray icon to open it again.',
    quitting: 'Quitting…',
  },
  ru: {
    open: 'Открыть MailCopilot',
    compose: 'Новое письмо',
    checkMail: 'Проверить почту',
    quit: 'Выход',
    unreadCount: 'непрочитанных: {{count}}',
    newMail: 'Новое письмо',
    newMailCount: 'Новых писем: {{count}}',
    backgroundHintTitle: 'MailCopilot продолжает работать',
    backgroundHintBody: 'Окно свёрнуто в трей. Нажмите значок в трее, чтобы открыть его снова.',
    quitting: 'Завершение работы…',
  },
  fr: {
    open: 'Ouvrir MailCopilot',
    compose: 'Nouveau message',
    checkMail: 'Relever le courrier',
    quit: 'Quitter',
    unreadCount: '{{count}} non lus',
    newMail: 'Nouveau courrier',
    newMailCount: '{{count}} nouveaux messages',
    backgroundHintTitle: 'MailCopilot continue de fonctionner',
    backgroundHintBody: 'La fenêtre a été fermée dans la zone de notification. Cliquez sur l’icône pour la rouvrir.',
    quitting: 'Fermeture…',
  },
  de: {
    open: 'MailCopilot öffnen',
    compose: 'Neue Nachricht',
    checkMail: 'Nachrichten abrufen',
    quit: 'Beenden',
    unreadCount: '{{count}} ungelesen',
    newMail: 'Neue Nachricht',
    newMailCount: '{{count}} neue Nachrichten',
    backgroundHintTitle: 'MailCopilot läuft weiter',
    backgroundHintBody: 'Das Fenster wurde in den Infobereich geschlossen. Klicken Sie auf das Symbol, um es wieder zu öffnen.',
    quitting: 'Wird beendet…',
  },
  es: {
    open: 'Abrir MailCopilot',
    compose: 'Nuevo mensaje',
    checkMail: 'Comprobar correo',
    quit: 'Salir',
    unreadCount: '{{count}} sin leer',
    newMail: 'Correo nuevo',
    newMailCount: '{{count}} mensajes nuevos',
    backgroundHintTitle: 'MailCopilot sigue funcionando',
    backgroundHintBody: 'La ventana se cerró al área de notificación. Haz clic en el icono para volver a abrirla.',
    quitting: 'Cerrando…',
  },
  it: {
    open: 'Apri MailCopilot',
    compose: 'Nuovo messaggio',
    checkMail: 'Controlla la posta',
    quit: 'Esci',
    unreadCount: '{{count}} non letti',
    newMail: 'Nuovo messaggio',
    newMailCount: '{{count}} nuovi messaggi',
    backgroundHintTitle: 'MailCopilot è ancora in esecuzione',
    backgroundHintBody: 'La finestra è stata chiusa nell’area di notifica. Fai clic sull’icona per riaprirla.',
    quitting: 'Chiusura in corso…',
  },
}

/** Labels for `lang`, falling back to English for an unknown or absent code. */
export function trayLabels(lang: string | undefined): Record<TrayLabelKey, string> {
  return TRAY_LABELS[(lang ?? 'en') as TrayLanguage] ?? TRAY_LABELS.en
}

/**
 * Upper bounds on the mail-derived parts of a notification. The OS truncates
 * anyway; doing it here bounds what a crafted subject can do to the shell that
 * renders it (a megabyte-long single-line subject is a hostile input, not a
 * display problem) and keeps the payload small.
 */
export const NOTIFICATION_SUBJECT_MAX = 120
export const NOTIFICATION_SENDER_MAX = 80

/** Single-line, whitespace-collapsed, hard-truncated with an ellipsis. */
export function truncateForNotification(text: string | null | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

export type NewMailNotificationInput = {
  lang: string | undefined
  /** How many new messages this sync pass found for the account. */
  count: number
  /** Newest message's subject — user content, only ever shown on this machine. */
  subject?: string | null
  /** Newest message's display sender — same rule as `subject`. */
  from?: string | null
}

/**
 * Title/body for one notification.
 *
 * Aggregated by design: a pass that lands twelve messages produces ONE toast
 * naming the newest, not twelve. Batching is the notifier's decision (see
 * mailNotifier.ts); this function only renders the outcome.
 */
export function buildNewMailNotification(input: NewMailNotificationInput): { title: string; body: string } {
  const labels = trayLabels(input.lang)
  const subject = truncateForNotification(input.subject, NOTIFICATION_SUBJECT_MAX)
  const from = truncateForNotification(input.from, NOTIFICATION_SENDER_MAX)
  if (input.count > 1) {
    return {
      title: labels.newMailCount.replace('{{count}}', String(input.count)),
      body: subject || from,
    }
  }
  return {
    title: subject || labels.newMail,
    body: from,
  }
}
