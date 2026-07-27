---
title: Telemetry
sidebar_position: 2
---

# Telemetrie

MailCopilot erhebt eine geringe Menge anonymer Diagnose- und Nutzungsdaten, wenn Sie unter Einstellungen -> Ueber den Schalter **Anonyme Diagnose- und Nutzungsdaten senden** aktivieren. Diese Seite dokumentiert genau, was erhoben wird und -- ebenso wichtig -- was niemals erhoben wird.

## Was wir niemals erheben

MailCopilot uebertraegt unter keinen Umstaenden:

- Den Inhalt Ihrer Nachrichten (Betreff, Body, Anhaenge, Entwuerfe)
- Ihre E-Mail-Adressen oder die Ihrer Kontakte
- Ordnernamen oder -pfade auf Ihrem IMAP-Server
- Dateinamen von Anhaengen
- Den Text Ihrer Suchanfragen
- Den Inhalt von KI-Chats oder des KI-Speichers
- Server-Hostnamen, Ports oder Zugangsdaten

## Wie Daten weitergeleitet werden

Saemtliche Telemetrie geht an [Sentry](https://sentry.io), unsere Plattform fuer Fehler- und Performance-Monitoring. Wenn Sie den Schalter in den Einstellungen ausschalten, wird die Pipeline vollstaendig umgangen -- es wird nichts gesendet. Wenn Sie das Debug-Logging aktivieren, erscheinen dieselben Ereignisse zusaetzlich in Ihrer lokalen `main.log`, sodass Sie genau pruefen koennen, was uebertragen werden wuerde.

### Anonyme Installations-Kennung

Beim ersten Start erzeugt MailCopilot eine zufaellige UUID und speichert sie in der lokalen Konfigurationsdatei. Diese UUID verlaesst Ihr Geraet niemals. Uebertragen wird stattdessen ein SHA-256-Hash davon -- auf 16 Hex-Zeichen gekuerzt -- den wir `install_id_hash` nennen. Er wird jedem Telemetrie-Ereignis als Sentry user id beigefuegt, damit wir Fragen wie „Wie viele eindeutige Installationen laufen auf Version X?" oder „Betrifft Crash Y eine Person oder hundert?" beantworten koennen. Der Hash ist:

- **Anonym** -- nicht abgeleitet von oder korreliert mit einer Konto-E-Mail, einem Geraete-Fingerabdruck, einer IP-Adresse oder einem Hardware-Identifikator.
- **Stabil ueber Releases hinweg** -- dieselbe Installation behaelt nach einem Auto-Update den gleichen Hash, sodass Retention-Metriken Versionsspruenge ueberleben.
- **Nicht umkehrbar** -- es gibt auf unserer Seite keine Zuordnung vom Hash zurueck zur UUID oder zu Ihrem Geraet.
- **Wird beim Deaktivieren der Telemetrie verworfen** -- das Umlegen des Schalters in Einstellungen entfernt die Kennung sofort aus dem Sentry-Client und stoppt jede weitere Uebertragung.

Wir verwenden diese Kennung wie ein Webanalyse-Werkzeug eine anonyme Besucher-ID: sie erlaubt uns, *eindeutige* Installationen zu zaehlen statt *Gesamtereignisse*. Genau dieser Unterschied ist der Grund, warum Telemetrie ueberhaupt nuetzlich ist -- ohne ihn saehe eine sehr aktive Installation aus wie hundert ruhige.

## Ereignisse

### App-Lebenszyklus

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | nein | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Einmal beim App-Start. Traegt `install_id_hash` fuer DAU/MAU. |
| `app.session_ended` | histogram | nein | `reason`, `install_id_hash` | Einmal beim regulaeren Beenden. value_ms = Sitzungsdauer. |
| `app.updated` | event | nein | `from_version`, `to_version` | Einmal nach der Installation einer neuen Version durch Auto-Update. |
| `app.startup_ms` | histogram | nein | `accounts_count` | Zeit von `app.whenReady` bis zum ersten sichtbaren `BrowserWindow`. |

### Nutzungszusammenfassung

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | nein | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | Bitmap am Sitzungsende: welche Funktionen wurden mindestens einmal benutzt? |

### Onboarding

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | nein | `first_run` | Anwender oeffnete den Konto-Hinzufuegen-Assistenten. |
| `onboarding.method_selected` | event | nein | `method` | Wahl zwischen OAuth und manueller IMAP/SMTP-Einrichtung. |
| `onboarding.autoconfig_result` | event | nein | `success`, `provider` | Autoconfig-Probe abgeschlossen -- wurden IMAP/SMTP-Einstellungen gefunden? |
| `onboarding.connection_test_result` | event | nein | `kind`, `success`, `failure_kind` | IMAP- oder SMTP-Konnektivitaetstest abgeschlossen. |
| `onboarding.google_oauth_result` | event | nein | `success`, `failure_kind` | Google-OAuth2-Flow abgeschlossen. |
| `onboarding.account_saved` | event | nein | `provider`, `auth_type` | Konto-Zugangsdaten in keytar/electron-store geschrieben. |
| `onboarding.first_headers_sync_completed` | histogram | nein | `provider`, `folder_count_bucket` | Zeit von `account_saved` bis zur ersten abgeschlossenen Header-Synchronisation (value_ms). |
| `onboarding.first_message_opened` | event | nein | `time_since_sync_bucket` | Anwender oeffnete nach Anmeldung seine erste Nachricht. |

### Verfassen

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `compose.opened` | event | nein | `source`, `has_draft` | Verfassen-Fenster geoeffnet; verfolgt den Einstiegspunkt. |

### Sendewarteschlange

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `send_queue.enqueued` | event | nein | `scheduled`, `send_and_archive`, `has_attachments`, `body_size_bucket` | Ausgehende Nachricht zu `send_queue` hinzugefuegt (sofort oder geplant). |
| `send_queue.sent` | histogram | nein | `scheduled` | Zeit von der Einreihung bis zur erfolgreichen Zustellung -- SMTP fuer die meisten Konten, Microsoft Graph fuer Outlook (value_ms). |
| `send_queue.failed` | event | nein | `failure_kind` | Sendeversuch endgueltig fehlgeschlagen (Warteschlange hat aufgegeben). Deckt sowohl SMTP- als auch Microsoft-Graph-Pfade ab. |
| `send_queue.retried` | event | nein | `attempt_number` | Voruebergehender Sendefehler -- Nachricht neu eingeplant. Deckt sowohl SMTP- als auch Microsoft-Graph-Pfade ab. |

### Falsch-Adressaten-Warnungen

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `misdirection.prompted` | event | nein | `kind` | Verfassen-Fenster zeigte den Warndialog. |
| `misdirection.outcome` | event | nein | `outcome`, `kind` | Anwender hat auf die Warnung reagiert. |

### Vorlagen

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `template.applied` | event | nein | `var_count` | Anwender hat eine Vorlage in das Verfassen-Fenster eingefuegt. |

### Follow-up-Erinnerungen

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `followup.created` | event | nein | `duration_days_bucket` | Einer ausgehenden Nachricht wurde eine Follow-up-Erinnerung beigefuegt. |

### Suche

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | nein | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | End-to-End-Latenz der FTS-Suche (Main-Seite, vor dem Merge mit Server-Treffern). Wird in PR 2 durch `search.completed` ersetzt. |
| `search.error` | event | nein | `scope`, `kind` | Suchhandler hat eine Exception geworfen -- entweder Anwender-Abbruch oder echter Fehler. |

### Body-Indexer

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | nein | `indexed`, `folders_scanned` | Ein vollstaendiger Indexer-Tick ueber alle Ordner. |
| `body_indexer.coverage_pct` | gauge | nein | `total_messages`, `indexed_messages` | Anteil der zwischengespeicherten Nachrichten mit indiziertem `body_text`. |
| `body_indexer.backlog` | gauge | nein | -- | Absolute Anzahl zwischengespeicherter Nachrichten ohne `body_text`. |
| `body_indexer.folder_error` | event | nein | `folder_role`, `error_streak`, `backoff_ms` | Body-Indexer ist auf einer Fehlerfolge in einem Ordner haengen geblieben und ging in Backoff. |

### Volltextindex-Wartung

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `fts.optimize.duration_ms` | histogram | nein | `segments_before`, `segments_after`, `reduction` | FTS5-Optimize-Lauf: Dauer und Segmentanzahl vor/nach. |
| `fts.optimize.failed` | event | nein | `reason` | FTS5-Optimize hat einen Fehler geworfen. |

### Header-Synchronisation

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | nein | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Vollstaendiger `syncFolderHeaders`-Lauf -- Aufteilung in Upsert vs. Sonstiges fuer Profiling. |
| `sync.headers.coalesced` | event | nein | `folder_role` | Doppelter `syncFolderHeaders`-Versuch wurde an einen laufenden Lauf angedockt. |

### Instrumentierung des E-Mail-Oeffnens

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | nein | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Ende-zu-Ende-Latenz des Nachrichteoeffnens, gemessen auf Renderer-Seite (vom Klick bis zum Rendern des Inhalts). Der Tag `cache_hit_level` gibt an, aus welcher Cache-Ebene der Inhalt stammt: `memory`, `db`, `eml`, `imap` oder `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | nein | `cache_hit_level` | Wall-Zeit des IPC-Handlers `net:messageDetails` im Hauptprozess. Isoliert die serverseitige Latenz vom Rauschen des Renderer-zu-Main-Round-Trips. Ein Messwert pro terminalem Pfad (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | nein | `requester`, `wait_ms_bucket` | Wartezeit beim Abrufen einer Verbindung aus dem per-Account IMAP-Pool. Wird nur emittiert, wenn die Wartezeit 500 ms ueberschreitet, damit Dashboards den Long-Tail erfassen ohne Rauschen durch schnelle Akquisitionen. |

### OAuth-Token-Refresh fuer IMAP

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | nein | `provider` | OAuth-Token-Refresh wurde durch einen IMAP-Auth-Fehler ausgeloest (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | nein | `provider` | Refresh erfolgreich -- der IMAP-Retry verwendet das frische Token. |
| `imap.auth_refresh_failure` | event | nein | `provider`, `reason` | Refresh fehlgeschlagen -- der urspruengliche Auth-Fehler wird an den Aufrufer weitergereicht. |
| `imap.auth_refresh_suppressed` | event | nein | `reason` | Der Per-Account-Cooldown hat einen Refresh-Versuch unterdrueckt, um `/token`-Anfragesturmen vorzubeugen, wenn ein Refresh-Token widerrufen wurde. |
| `imap.idle_auth_refreshed` | event | nein | `provider` | Die IDLE-Schleife hat sich von einem Auth-Fehler mitten im Zyklus durch einen In-Loop-Refresh erholt -- Push-Zustellung lief ohne den 60-Minuten-Auth-Backoff weiter. |
| `imap.auth_refresh_exhausted` | event | nein | `provider`, `consecutive` | Die IDLE-Schleife loeste die Storm-Brake aus -- N Refreshes hintereinander beim Anbieter erfolgreich, aber IMAP wies die frischen Tokens weiter ab; deshalb fallen wir auf den ueblichen Auth-Backoff zurueck. |

### Cache-Aufbewahrung

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | nein | `count_bucket`, `freed_bytes_bucket` | Die Aufbewahrungsbereinigung hat `.eml`-Dateien geloescht, die aelter als der konfigurierte Zeitraum sind. Anzahl und Groessen werden nur als Bereiche uebermittelt -- keine exakten Pfade oder Zahlen. |
| `cache.folder_index_disabled` | event | nein | `count`, `role` | Ein Ordner wurde von der Volltextsuche ausgeschlossen -- automatisch fuer Junk/Spam/Papierkorb bei der ersten Registrierung oder manuell ueber das Ordner-Kontextmenue. `role`: `spam`, `trash` oder `manual`. |

### Cache-Sicherheit und Datenverlust-Signale

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | nein | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | Ordnerweites `DELETE FROM messages` wurde abgesetzt. Jede Aufrufstelle liefert einen Grund mit, sodass eine Regression, die einen gesunden Cache loescht, von einem regulaeren UIDVALIDITY-Bump unterscheidbar ist. |
| `imap.stale_wipe_guard_tripped` | event | nein | `folder_role`, `provider` | Die Mass-Delete-Schutzschicht hat das Loeschen des lokalen Ordnercaches verweigert, weil `mailbox.exists` nicht-numerisch zurueckkam. Ein Spike deutet auf ein Anbieter- oder Verbindungsproblem, nicht auf Datenverlust. |
| `db.shutdown_wal_checkpoint_ms` | histogram | nein | `busy`, `reclaimed_kb_bucket`, `ok` | Wallclock-Dauer des `PRAGMA wal_checkpoint(TRUNCATE)` vor dem Beenden, damit committed-but-not-checkpointed-Schreibungen Sitzungswechsel ueberleben. |

### MCP-stdio-Gate (Renderer-zu-RCE-Schutz)

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `mcp.stdio.connect_attempted` | event | nein | `approved_source` | Der stdio-MCP-Transport wird gleich gestartet -- emittiert einmal pro erfolgreichem Connect, nachdem Approval- und Allowlist-Gates passiert wurden. |
| `mcp.stdio.connect_blocked` | event | nein | `reason` | stdio-Connect oder -Speicherung wurde vom Gate abgelehnt (`not_approved`, `unapproved_command`, `forbidden_field`, `forbidden_env_key`, `env_disabled`). |
| `mcp.stdio.approval_granted` | event | nein | `source`, `scope` | Der Anwender hat die stdio-MCP-Freigabe erteilt (globale Aktivierung oder pro Verbindung); `source` unterscheidet env vs native-confirm, `scope` global vs pro Verbindung. |
| `mcp.stdio.env_sanitized_on_load` | event | nein | `count_bucket` | Die Settings-Migration hat verbotene Loader-Hook-Env-Keys aus persistierten MCP-Verbindungen beim Laden entfernt. Maximal einmal pro Start. |

### KI-Aktions-Audit (Preview -> Apply Bestaetigungsbarriere)

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ai.action.preview_created` | event | nein | `kind` | Ein `*_preview`-MCP-Tool hat eine ausstehende mutierende Aktion registriert, die auf den Apply-Klick wartet. |
| `ai.action.applied` | event | nein | `kind` | Ein `*_apply`-MCP-Tool hat eine zuvor bestaetigte mutierende Aktion erfolgreich ausgefuehrt. |
| `ai.action.rejected` | event | nein | `kind`, `reason` | Ein `*_apply`-Aufruf wurde am Validierungs-Gate abgelehnt (Preview fehlt/abgelaufen, Token fehlt/passt nicht, kind mismatch, Callback fehlt oder Rate-Limit). |
| `ai.action.expired` | event | nein | `kind` | Eine ausstehende mutierende Aktion ist abgelaufen, ohne dass der Anwender Apply geklickt hat (TTL). |
| `ai.action.apply_duration_ms` | histogram | nein | `kind` | Wallclock-Dauer eines erfolgreichen Apply -- wie lange die zugrunde liegende Mutation gedauert hat (DB / IMAP / SMTP). |

### KI-Egress-Gate (Ausgehende Tool-Aufrufe)

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | nein | `tool_name`, `account_id` | Ein ausgehender Tool-Aufruf (z. B. `WebSearch`, `WebFetch`, generisches externes MCP-Tool) wurde abgelehnt, waehrend Nutzer-E-Mail-Daten im Geltungsbereich waren -- entweder aus dem SDK-Toolset gefiltert oder am Runtime-Gate gestoppt. |
| `ai.egress.allowed_once` | event | nein | `tool_name`, `account_id` | Der Anwender hat eine einmalige Egress-Zustimmung erteilt und die KI hat sie genutzt. Hilft, „Anwender uebersteuern routinemaessig" von „das Gate haelt, Versuche sind ueberwiegend Injektion-getrieben" zu trennen. |

### IPC-Performance

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | ja (10-s-Fenster) | `channel`, `duration_bucket` | IPC-Handler hat den Schwellwert fuer „langsam" ueberschritten. |

### UI-Reaktionsfaehigkeit

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | ja (10-s-Fenster) | `duration_bucket`, `inflight_count`, `top_inflight` | Renderer-Event-Loop war laenger blockiert als der Freeze-Schwellwert. |
| `ui.freeze.main_ms` | histogram | ja (10-s-Fenster) | `duration_bucket`, `inflight_count`, `top_inflight` | Main-Prozess-Event-Loop war blockiert (ueber `perf_hooks`-Delay). |

## Kontakt

Fragen oder Bedenken zu dem, was wir erheben? Oeffnen Sie ein Issue auf [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) oder kontaktieren Sie das Team direkt ueber das Feedback-Formular unter Einstellungen -> Ueber.
