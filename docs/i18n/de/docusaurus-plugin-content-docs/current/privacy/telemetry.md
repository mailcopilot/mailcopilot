---
title: Telemetry
sidebar_position: 2
---

# Telemetrie

MailCopilot kann eine geringe Menge Diagnose- und Nutzungsdaten senden -- aber erst, nachdem Sie aktiv zugestimmt haben. Inhalte Ihrer E-Mails sind darin nie enthalten, wohl aber eine zufällige Kennung dieser Installation -- vollständig anonym sind die Daten daher nicht: was diese Kennung genau erlaubt und was nicht, steht unten unter [Installations-Kennung](#installations-kennung). Diese Seite dokumentiert genau, was erhoben wird und -- ebenso wichtig -- was niemals erhoben wird.

## Zustimmung beim ersten Start

Beim ersten Start von MailCopilot sehen Sie, bevor sich der Kontoeinrichtungs-Assistent öffnet, einen Zustimmungsbildschirm mit dem Titel **Diagnosedaten senden?**. Er listet auf, was bei Zustimmung gesendet würde und was niemals gesendet wird, und bietet zwei gleich große Schaltflächen: **Erlauben** und **Nicht erlauben**. Keine der beiden ist vorausgewählt oder hervorgehoben, und es gibt kein vorangehaktes Kontrollkästchen -- Sie müssen eine aktive Wahl treffen.

Daraus folgt Einiges:

- **Vor Ihrer Antwort wird nichts erhoben, nicht nur nichts gesendet.** Die Zähler und Puffer hinter Diagnose- und Nutzungsdaten werden erst gar nicht geöffnet, solange die Zustimmung aussteht -- MailCopilot sammelt keinen stillen Rückstand, um ihn nach Ihrer Zustimmung auf einmal zu übertragen. Was vor Ihrer Antwort geschah, ist einfach weg; sobald Sie zustimmen, beginnt die Zählung erst ab diesem Zeitpunkt neu (eine Messung der Sitzungsdauer etwa zählt ab dem Moment der Zustimmung, nicht ab dem App-Start).
- **Den Bildschirm zu schließen oder Escape zu drücken zählt als "Nicht erlauben".** Es gibt keine Möglichkeit, den Bildschirm zu verlassen und dabei zugestimmt zu haben.
- **Ihre Entscheidung wird zusammen mit der Version dieser Offenlegung gespeichert.** MailCopilot zeigt den Bildschirm nur dann erneut, wenn sich die Liste des Erhobenen tatsächlich erweitert -- eine neue Datenkategorie, ein neues Ziel oder ein breiterer Umfang als zuvor. Gewöhnliche App-Updates, Formulierungsänderungen und Fehlerbehebungen lösen niemals eine erneute Nachfrage aus.
- **Wenn Sie die Diagnose bereits deaktiviert hatten**, bevor es diesen Bildschirm gab, wird diese Ablehnung respektiert und Sie werden nicht erneut gefragt. Bei allen anderen wird die Diagnose automatisch abgeschaltet, und die Frage erscheint einmal beim nächsten Start.
- **Sie können Ihre Entscheidung jederzeit ändern**, unter **Einstellungen -> Über**. Solange Sie die anfängliche Frage nicht beantwortet haben, wird der Schalter dort ausgeschaltet und deaktiviert angezeigt, mit einem Hinweis, dass er erst wirksam wird, sobald Sie auf dem Zustimmungsbildschirm geantwortet haben.

## Was wir senden

Wenn Sie zustimmen, sendet MailCopilot:

- **Fehler und Abstürze** -- die Art des Fehlers und den Stacktrace, der zeigt, an welcher Stelle im Code er auftrat. Manche Fehlerpfade laufen bereits über eine geschlossene Menge struktureller Felder, die den rohen Text eines Drittservers vollständig ausschließt -- wenn zum Beispiel das Sichern einer Kopie einer gesendeten Nachricht in Ihrem Gesendet-Ordner fehlschlägt, trägt die Diagnose die Rolle des Ordners (`sent`, niemals seinen Namen), einen gesalzenen SHA-256-Hash der Nachrichtenkennung, gekürzt auf 12 Hex-Zeichen (niemals die Kennung selbst -- das ist eine pseudonyme Kennzeichnung, keine Anonymisierung: Wer eine mutmaßliche Nachrichtenkennung besitzt, kann eine Übereinstimmung durch Nachrechnen des Hashs bestätigen), die Länge der Serverantwort und eine geschlossene Menge an Protokollcodes (etwa `AUTHENTICATIONFAILED` oder `OVERQUOTA`). Andere Fehlerberichte, die noch nicht auf diese strukturierte Form umgestellt sind, können weiterhin rohen Drittserver-Text weiterleiten -- erfasst nur durch die unten beschriebene Adress- und Pfadbereinigung, keine strukturelle Garantie -- siehe [Wie Adressen und Pfade bereinigt werden](#wie-adressen-und-pfade-bereinigt-werden).
- **Versionen** -- die MailCopilot-Version, Ihr Betriebssystem und dessen Version.
- **Leistung** -- die Dauer von Vorgängen wie Mail-Synchronisierung, Suche, Versand und KI-Anfragen.
- **Funktionsnutzung** -- welche Funktionen Sie in einer Sitzung wie oft genutzt haben (Suche, Verfassen von E-Mails, KI, Regeln, Vorlagen, Zurückstellen und mehr), sowie, wenn Sie den KI-Assistenten nutzen, welcher Anbieter und welches Modell die Anfrage bearbeitet haben und die geschätzten Kosten dieser Anfrage. Die KI-spezifischen Felder stehen unten unter [KI-Nutzungsprotokoll](#ki-nutzungsprotokoll).
- **Aktivität im KI-Schlüsselspeicher** -- Aktionen am Speicher, in dem Ihre KI-API-Schlüssel liegen: welcher Anbieter, ob der Schlüssel gelesen, gespeichert oder gelöscht wurde, und wie es ausging, einschließlich ob dort ein Schlüssel gefunden wurde. Der Wert des Schlüssels selbst wird nie gesendet -- weder als Text, noch als Länge, noch als Hash.
- **Einrichtungskontext** -- wie viele Konten Sie verbunden haben, die Art des Maildienstes je Konto (zum Beispiel Gmail oder Outlook), wie Sie sich angemeldet haben (OAuth oder Passwort), die Sprache Ihrer Oberfläche und Ihr Design.
- **Installations-Kennung** -- eine zufällige, beim ersten Start erzeugte Kennung, unten ausführlich beschrieben. Sie verknüpft die Daten Ihrer verschiedenen Sitzungen miteinander -- genau deshalb sind die Daten nicht vollständig anonym.

## Was wir niemals erheben

MailCopilot legt keinen Codepfad darauf an, Folgendes zu senden. Bei typisierten Metriken und der Diagnose fehlgeschlagener Sent-Kopien ist das eine absolute Garantie, durchgesetzt durch eine geschlossene Menge struktureller Felder, die der Code überhaupt füllen darf. Alle anderen Diagnoseberichte verlassen sich in erster Linie darauf, dass die Aufrufstelle den Inhalt gar nicht erst dort hineinschreibt, abgesichert durch einen formbasierten Filter, der erkennbare Formen von Adressen und Dateipfaden als zweite Ebene abfängt -- kein universeller Inhaltsfilter. Was diese zweite Ebene genau erfasst und was nicht, steht unten unter [Wie Adressen und Pfade bereinigt werden](#wie-adressen-und-pfade-bereinigt-werden).

- Den Inhalt Ihrer Nachrichten (Betreff, Body, Anhänge, Entwürfe)
- Ihre E-Mail-Adressen oder die Ihrer Kontakte -- das Feedback-Formular unter Einstellungen -> Über ist die einzige Stelle, an der absichtlich eine Adresse gesendet wird, wenn Sie dort selbst eine eingeben, damit Sie eine Antwort erhalten können.
- Ihre Ordnernamen oder -pfade auf Ihrem IMAP-Server -- in den Daten erscheint nur die allgemeine Art des Ordners (etwa Posteingang, Gesendet oder Papierkorb), niemals der Name, den Sie ihm gegeben haben
- Dateinamen von Anhängen
- Was Sie in die Suche eingeben -- gezählt werden nur die Länge der Anfrage und die Anzahl der Treffer, niemals der Text selbst
- Den Inhalt von KI-Chats oder des KI-Speichers
- Server-Hostnamen, Ports oder Zugangsdaten
- Ihre IP-Adresse als von uns angehängte Daten -- jedes Ereignis weist Sentry ausdrücklich an, keine zu erfassen. Die Netzwerkverbindung selbst zeigt Ihre IP-Adresse unvermeidlich jedem, den sie unterwegs berührt; was ein empfangender Server, ein Proxy oder dessen eigene Protokolle damit tun, ist eine Konfigurationsfrage dieser Infrastruktur, nicht etwas, das die Nutzlast von MailCopilot steuert.
- Ihren Betriebssystem-Kontonamen in den Diagnoseberichten, die wir bauen -- die dokumentierten Lücken stehen unter [Wie Adressen und Pfade bereinigt werden](#wie-adressen-und-pfade-bereinigt-werden)

## Wie Daten weitergeleitet werden

Sämtliche Telemetrie geht an [Sentry](https://sentry.io), unsere Plattform für Fehler- und Performance-Monitoring, und zwar erst, nachdem Sie auf dem Zustimmungsbildschirm zugestimmt haben (oder später, indem Sie den Schalter unter Einstellungen -> Über einschalten). Solange die Diagnose ausgeschaltet ist -- sei es weil Sie abgelehnt haben, noch nicht geantwortet haben, oder den Schalter später deaktiviert haben -- wird die Pipeline vollständig umgangen und es wird nichts gesendet. Wenn Sie das Debug-Logging aktivieren, erscheinen dieselben Ereignisse zusätzlich in Ihrer lokalen `main.log`, sodass Sie genau prüfen können, was übertragen werden würde.

### Installations-Kennung

Beim ersten Start erzeugt MailCopilot eine zufällige UUID und speichert sie in der lokalen Konfigurationsdatei. Diese UUID verlässt Ihr Gerät niemals. Übertragen wird stattdessen ein SHA-256-Hash davon -- auf 16 Hex-Zeichen gekürzt -- den wir `install_id_hash` nennen. Er wird jedem Telemetrie-Ereignis als Sentry user id beigefügt, auf jedem Ereignis und jeder Transaktion, nicht nur den Sitzungs-Ereignissen, damit wir Fragen wie „Wie viele eindeutige Installationen laufen auf Version X?" oder „Betrifft Crash Y eine Person oder hundert?" beantworten können. Der Hash ist:

- **Pseudonym, nicht identifizierend, aber auch nicht unverknüpfbar** -- er ist nicht abgeleitet von einer Konto-E-Mail, einem Geräte-Fingerabdruck, einer IP-Adresse oder einem Hardware-Identifikator, und es gibt auf unserer Seite keine Zuordnung vom Hash zurück zur UUID oder zu Ihrem Gerät. Er ist aber bewusst eine stabile Kennung dieser einen Installation: Er verbindet jedes Ereignis und jede Transaktion, die diese Installation je sendet, zu einer durchgehenden Spur -- und könnte, wie jeder pseudonyme Identifikator, der an einen Dritten übergeben wird, im Prinzip mit anderen Daten abgeglichen werden, die Sentry oder uns zur Verfügung stehen. Das ist der Grund, warum der Zustimmungsbildschirm die Daten „nicht vollständig anonym" statt anonym nennt.
- **Stabil über Releases hinweg** -- dieselbe Installation behält nach einem Auto-Update den gleichen Hash, sodass Retention-Metriken Versionssprünge überleben.
- **Wird beim Deaktivieren der Telemetrie verworfen** -- das Umlegen des Schalters in Einstellungen entfernt die Kennung sofort aus dem Sentry-Client und stoppt jede weitere Übertragung.

Wir verwenden diese Kennung wie ein Webanalyse-Werkzeug eine Besucher-ID: sie erlaubt uns, *eindeutige* Installationen zu zählen statt *Gesamtereignisse*. Genau dieser Unterschied ist der Grund, warum Telemetrie überhaupt nützlich ist -- ohne ihn sähe eine sehr aktive Installation aus wie hundert ruhige.

### Wie Adressen und Pfade bereinigt werden

Zwei formbasierte Filter laufen über jedes ausgehende Ereignis und jeden strukturierten Protokolleintrag, in beiden Prozessen -- Hauptprozess und Renderer --, als letzter Schritt vor der Übertragung -- mit einer Ausnahme: der Umschlag des Feedback-Formulars, dessen Adresse Sie absichtlich selbst eingegeben haben, damit wir antworten können, ist bewusst vom Adressfilter ausgenommen. Sie sind ein Sicherheitsnetz für Inhalte, die diesen Punkt gar nicht erst hätten erreichen dürfen, nicht der primäre Mechanismus -- der primäre Mechanismus ist, dass typisierte Metrik-Tags von vornherein geschlossene Aufzählungen und strukturelle Felder sind, sodass es dort nichts Freitextliches zu bereinigen gibt.

- **E-Mail-förmiger Text** wird durch `<email>` ersetzt. Das Muster erkennt die praktische, gebräuchliche Form einer Adresse (Buchstaben, Ziffern und eine kleine Menge an Satzzeichen vor dem `@`, eine Domain mit Punkt danach) -- nicht die vollständige formale E-Mail-Grammatik. Ein bewusst ausgeschlossener Fall: `root@localhost` und ähnliche Adressen ohne Domain mit Punkt bleiben unangetastet, damit gewöhnlicher Text, der ein Paket wie `@types/node` erwähnt, nicht verstümmelt wird. Ein lokaler Teil mit ungewöhnlichen Satzzeichen kann nach dem Entfernen von `@domain.tld` ein führendes Fragment zurücklassen.
- **Pfade zum Home-Verzeichnis** (`/home/<Name>/...`, `/Users/<Name>/...`, `C:\Users\<Name>\...`) haben das Namenssegment durch `<user>` ersetzt. Der eine dokumentierte Restfall: ein Kontoname mit Leerzeichen, ganz am Ende eines Pfads, ohne abschließendes Anführungszeichen oder Trennzeichen danach, kann sein zweites Wort zurücklassen (`C:\Users\Max Mustermann` am Zeilenende behält „Mustermann"). Der Hauptprozess ersetzt zusätzlich Ihren wörtlichen Home-Verzeichnis-Pfad überall dort, wo er wortwörtlich vorkommt -- das kann der sandboxed Renderer nicht.
- Beide Filter durchlaufen eine bekannte, begrenzte Menge von Ereignisfeldern (Stacktrace-Text, Nachrichten, Anfragedaten, Breadcrumbs und Ähnliches) sowie einen tiefen- und größenbegrenzten Durchlauf freiformiger Container (höchstens 4 Ebenen tief und 500 besuchte Knoten, wobei jedes Container-Element und jeder Objektschlüssel gegen dieses Budget zählt, nicht nur die tatsächlich umgeschriebenen Zeichenketten) -- kein unbegrenztes Durchforsten des gesamten Ereignisses, sodass Inhalte jenseits dieser Grenze nicht besucht werden. Ein Feld wird bewusst nicht angefasst: der Maschinen-Hostname, den Sentrys eigenes SDK jedem Ereignis beifügt (`server_name`), weil er auf macOS und Windows häufig vom Kontonamen abgeleitet ist und keine Bereinigungsregel das zuverlässig von einem unabhängigen Hostnamen unterscheiden kann.
- Ein Leck in einer Form, die keiner der beiden Filter erkennt -- ein Ordnername, eine Betreffzeile, freier Servertext -- wird hier nicht abgefangen. Deshalb sind die Metriktabellen unten und die Sent-Kopie-Diagnose aus geschlossenen strukturellen Feldern aufgebaut, statt sich auf die Bereinigung von Freitext zu verlassen.

### KI-Nutzungsprotokoll

Jedes Mal, wenn Sie dem KI-Assistenten eine Nachricht senden, zeichnet MailCopilot nach Abschluss der Anfrage einen strukturierten Protokolleintrag auf -- zusätzlich zu dem booleschen Wert in der oben beschriebenen Nutzungszusammenfassung. Dieser Eintrag enthält: den **KI-Anbieter** (zum Beispiel den Anbieter Ihres API-Schlüssels oder „subscription"), das **Modell**, das die Anfrage bearbeitet hat, die **Gesamtzahl der Werkzeugaufrufe** und die **Namen der aufgerufenen Werkzeuge** (zum Beispiel `send_email` oder `mail_action`, niemals die ihnen übergebenen Argumente), ob die Anfrage abgebrochen wurde oder fehlschlug, sowie die **geschätzten Kosten** der Anfrage in USD, sofern der Anbieter Preise offenlegt. Nichts davon umfasst den Text Ihrer Anfrage, die Antwort der KI oder E-Mail-Inhalte -- die vollständige Aufschlüsselung dessen, was der KI-Assistent selbst an Anbieter sendet (ein eigenes, weit umfangreicheres Thema, das mit diesem strukturierten Protokolleintrag nicht zu verwechseln ist), finden Sie unter [KI-Daten und Auditprotokoll](./ai-data). Zugehörige Latenzmessungen für einzelne KI-Funktionen tragen eigene aggregierte Felder (Kontexttyp des Gesprächs, ob ein Verlauf vorhanden war, Token-Zahlen, das verwendete Umschreib-Preset, die Anzahl erzeugter Antwortentwürfe und Ähnliches) -- siehe [Performance-Spans](#performance-spans) unten.

## Ereignisse

### App-Lebenszyklus

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | nein | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Einmal beim App-Start. Trägt `install_id_hash` für DAU/MAU. |
| `app.session_ended` | histogram | nein | `reason`, `install_id_hash` | Einmal beim regulären Beenden. value_ms = Sitzungsdauer. |
| `app.updated` | event | nein | `from_version`, `to_version` | Einmal nach der Installation einer neuen Version durch Auto-Update. |
| `app.startup_ms` | histogram | nein | `accounts_count` | Zeit von `app.whenReady` bis zum ersten sichtbaren `BrowserWindow`. |
| `window.rescued` | event | nein | `windows_moved`, `pass` | Ein Rettungsdurchlauf hat mindestens ein Fenster, das außerhalb des sichtbaren Bereichs lag, nach einer Änderung der Bildschirmkonfiguration (Monitor angeschlossen, Auflösung geändert, aus dem Ruhezustand zurück) wieder in Sicht gebracht. |

### Telemetrie-Zustimmung

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `telemetry.consent_granted` | event | nein | `version` | Wird nur ausgelöst, wenn Sie auf dem Zustimmungsbildschirm auf Erlauben tippen, mit der Version der Offenlegung, die Sie gesehen haben. Eine Ablehnung löst überhaupt kein Ereignis aus -- ein „Nein" zu messen wäre selbst genau die Übertragung, die die Ablehnung verhindern soll. Das erneute Einschalten des Schalters unter Einstellungen -> Über nach dem Ausschalten löst dieses Ereignis ebenfalls nicht aus -- nur eine Antwort auf dem Zustimmungsbildschirm tut das. |

### Nutzungszusammenfassung

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | nein | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | Bitmap am Sitzungsende: welche Funktionen wurden mindestens einmal benutzt? |

### Onboarding

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | nein | `first_run` | Anwender öffnete den Konto-Hinzufügen-Assistenten. |
| `onboarding.method_selected` | event | nein | `method` | Wahl zwischen OAuth und manueller IMAP/SMTP-Einrichtung. |
| `onboarding.autoconfig_result` | event | nein | `success`, `provider` | Autoconfig-Probe abgeschlossen -- wurden IMAP/SMTP-Einstellungen gefunden? |
| `onboarding.connection_test_result` | event | nein | `kind`, `success`, `failure_kind` | IMAP- oder SMTP-Konnektivitätstest abgeschlossen. |
| `onboarding.google_oauth_result` | event | nein | `success`, `failure_kind` | Google-OAuth2-Flow abgeschlossen. |
| `onboarding.account_saved` | event | nein | `provider`, `auth_type` | Konto-Zugangsdaten in keytar/electron-store geschrieben. |
| `onboarding.first_headers_sync_completed` | histogram | nein | `provider`, `folder_count_bucket` | Zeit von `account_saved` bis zur ersten abgeschlossenen Header-Synchronisation (value_ms). |
| `onboarding.first_message_opened` | event | nein | `time_since_sync_bucket` | Anwender öffnete nach Anmeldung seine erste Nachricht. |

### Verfassen

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `compose.opened` | event | nein | `source`, `has_draft` | Verfassen-Fenster geöffnet; verfolgt den Einstiegspunkt. |

### Sendewarteschlange

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `send_queue.enqueued` | event | nein | `scheduled`, `send_and_archive`, `has_attachments`, `body_size_bucket` | Ausgehende Nachricht zu `send_queue` hinzugefügt (sofort oder geplant). |
| `send_queue.sent` | histogram | nein | `scheduled` | Zeit von der Einreihung bis zur erfolgreichen SMTP-Zustellung (value_ms). |
| `send_queue.failed` | event | nein | `failure_kind` | SMTP-Sendeversuch endgültig fehlgeschlagen (Warteschlange hat aufgegeben). |
| `send_queue.retried` | event | nein | `attempt_number` | Vorübergehender SMTP-Sendefehler -- Nachricht neu eingeplant. |
| `send_queue.append_failed` | event | nein | `reason`, `provider_id` | Die SMTP-Zustellung war erfolgreich, aber das Speichern einer Kopie der Nachricht im Gesendet-Ordner über IMAP ist fehlgeschlagen. Siehe die oben unter „Was wir senden" beschriebene Sent-Kopie-Diagnose. |

### Falsch-Adressaten-Warnungen

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `misdirection.prompted` | event | nein | `kind` | Verfassen-Fenster zeigte den Warndialog. |
| `misdirection.outcome` | event | nein | `outcome`, `kind` | Anwender hat auf die Warnung reagiert. |

### Vorlagen

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `template.applied` | event | nein | `var_count` | Anwender hat eine Vorlage in das Verfassen-Fenster eingefügt. |

### Follow-up-Erinnerungen

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `followup.created` | event | nein | `duration_days_bucket` | Einer ausgehenden Nachricht wurde eine Follow-up-Erinnerung beigefügt. |

### Suche

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | nein | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | End-to-End-Latenz der FTS-Suche (Main-Seite, vor dem Merge mit Server-Treffern). Wird in PR 2 durch `search.completed` ersetzt. |
| `search.error` | event | nein | `scope`, `kind` | Suchhandler hat eine Exception geworfen -- entweder Anwender-Abbruch oder echter Fehler. |

### Body-Indexer

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | nein | `indexed`, `folders_scanned` | Ein vollständiger Indexer-Tick über alle Ordner. |
| `body_indexer.coverage_pct` | gauge | nein | `total_messages`, `indexed_messages` | Anteil der zwischengespeicherten Nachrichten mit indiziertem `body_text`. |
| `body_indexer.backlog` | gauge | nein | -- | Absolute Anzahl zwischengespeicherter Nachrichten ohne `body_text`. |
| `body_indexer.folder_error` | event | nein | `folder_role`, `error_streak`, `backoff_ms` | Body-Indexer ist auf einer Fehlerfolge in einem Ordner hängen geblieben und ging in Backoff. |

### Volltextindex-Wartung

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `fts.optimize.duration_ms` | histogram | nein | `segments_before`, `segments_after`, `reduction` | FTS5-Optimize-Lauf: Dauer und Segmentanzahl vor/nach. |
| `fts.optimize.failed` | event | nein | `reason` | FTS5-Optimize hat einen Fehler geworfen. |

### Header-Synchronisation

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | nein | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Vollständiger `syncFolderHeaders`-Lauf -- Aufteilung in Upsert vs. Sonstiges für Profiling. |
| `sync.headers.coalesced` | event | nein | `folder_role` | Doppelter `syncFolderHeaders`-Versuch wurde an einen laufenden Lauf angedockt. |

### Instrumentierung des E-Mail-Öffnens

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | nein | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Ende-zu-Ende-Latenz des Nachrichtenöffnens, gemessen auf Renderer-Seite (vom Klick bis zum Rendern des Inhalts). Der Tag `cache_hit_level` gibt an, aus welcher Cache-Ebene der Inhalt stammt: `memory`, `db`, `eml`, `imap` oder `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | nein | `cache_hit_level` | Wall-Zeit des IPC-Handlers `net:messageDetails` im Hauptprozess. Isoliert die serverseitige Latenz vom Rauschen des Renderer-zu-Main-Round-Trips. Ein Messwert pro terminalem Pfad (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | nein | `requester`, `wait_ms_bucket` | Wartezeit beim Abrufen einer Verbindung aus dem per-Account IMAP-Pool. Wird nur emittiert, wenn die Wartezeit 500 ms überschreitet, damit Dashboards den Long-Tail erfassen ohne Rauschen durch schnelle Akquisitionen. |

### EML-Verarbeitung

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `eml.parse_dispatch` | event | nein | `path`, `size_bucket` | Ein EML-Parse-Vorgang, markiert mit dem tatsächlich genutzten Pfad: `worker` (außerhalb des Hauptthreads geparst), `worker_failed` (der Worker war verfügbar, aber genau dieser Parse-Vorgang schlug fehl), `worker_aborted` (Sie haben die Nachricht geschlossen, bevor der Worker fertig war), `inline_below_threshold` (klein genug, um planmäßig im Hauptthread geparst zu werden), oder `inline_unavailable` (im Hauptthread geparst, weil der Worker selbst in dieser Sitzung unbrauchbar ist). |
| `eml.parse_worker_unavailable` | event | nein | `reason` | Wird höchstens einmal pro Sitzung ausgelöst, in dem Moment, in dem sich herausstellt, dass das EML-Parsen außerhalb des Hauptthreads für den Rest dieser Sitzung nicht möglich ist — jeder spätere Parse-Vorgang fällt dann auf `inline_unavailable` oben zurück. `reason` ist `script_missing`, `spawn_failed`, `startup_failed` oder `not_main_thread`. |

Keines der beiden Ereignisse wird aggregiert: Jedes wird einzeln erfasst statt mit anderen aus demselben Schwall zusammengefasst zu werden, weil sonst genau die Information, die ein Maintainer braucht — welchen Pfad ein Parse-Vorgang nahm oder warum der Worker gestorben ist — in der Zählung untergehen würde. Garantiert ist ein `eml.parse_dispatch`-Ereignis pro EML-Datei, die MailCopilot tatsächlich parst — nicht ein Ereignis pro Nachricht, die Sie öffnen. Das Öffnen einer Nachricht, die bereits im Detail-Cache im Arbeitsspeicher oder auf der Festplatte liegt (die Stufen `memory` und `db` des Tags `cache_hit_level`, weiter oben unter [Instrumentierung des E-Mail-Öffnens](#instrumentierung-des-e-mail-öffnens) beschrieben), parst nie eine `.eml`-Datei, sodass für dieses Öffnen kein Ereignis entsteht; das Ereignis wird nur ausgelöst, wenn eine Nachricht aus einer lokal gespeicherten `.eml`-Datei gelesen oder frisch heruntergeladen wird und geparst werden muss. Jedes tatsächlich ausgelöste Ereignis trägt den `path` genau dieses einen Parse-Vorgangs und den `size_bucket` genau dieser einen Nachricht, dazu — wie jedes andere Ereignis, das diese App sendet — die in [Installations-Kennung](#installations-kennung) beschriebene Installations-Kennung, die es mit den übrigen Ereignissen Ihrer Sitzung verknüpft. Der Tag `size_bucket` verwendet dieselbe grobe Bandbreiten-Behandlung, die an anderer Stelle auf dieser Seite bereits auf die Nachrichtengröße angewendet wird (siehe `body_size_bucket` unter [Sendewarteschlange](#sendewarteschlange) und [Instrumentierung des E-Mail-Öffnens](#instrumentierung-des-e-mail-öffnens)): eine von fünf groben Bandbreiten — `<1KB`, `1-10KB`, `10-100KB`, `100KB-1MB`, `1MB+` — keine exakte Byte-Zahl, keine Größe mit feinerer Auflösung, und niemals Betreff, Absender, Dateiname oder Nachrichten-Kennung.

### Kalendereinladungen

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `mail.invite_rsvp` | event | nein | `method`, `hadLocation` | Wird ausgelöst, sobald eine Antwort auf eine Kalendereinladung (Zusagen / Vorläufig / Absagen) erfolgreich gesendet wurde. `hadLocation` hält nur fest, ob die ursprüngliche Einladung ein Ortsfeld hatte, nicht was darin stand. Fehlgeschlagene RSVP-Sendungen werden hier nicht gezählt. |

### OAuth-Token-Refresh für IMAP

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | nein | `provider` | OAuth-Token-Refresh wurde durch einen IMAP-Auth-Fehler ausgelöst (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | nein | `provider` | Refresh erfolgreich -- der IMAP-Retry verwendet das frische Token. |
| `imap.auth_refresh_failure` | event | nein | `provider`, `reason` | Refresh fehlgeschlagen -- der ursprüngliche Auth-Fehler wird an den Aufrufer weitergereicht. |
| `imap.auth_refresh_suppressed` | event | nein | `reason` | Der Per-Account-Cooldown hat einen Refresh-Versuch unterdrückt, um `/token`-Anfragesturmen vorzubeugen, wenn ein Refresh-Token widerrufen wurde. |
| `imap.idle_auth_refreshed` | event | nein | `provider` | Die IDLE-Schleife hat sich von einem Auth-Fehler mitten im Zyklus durch einen In-Loop-Refresh erholt -- Push-Zustellung lief ohne den 60-Minuten-Auth-Backoff weiter. |
| `imap.auth_refresh_exhausted` | event | nein | `provider`, `consecutive` | Die IDLE-Schleife löste die Storm-Brake aus -- N Refreshes hintereinander beim Anbieter erfolgreich, aber IMAP wies die frischen Tokens weiter ab; deshalb fallen wir auf den üblichen Auth-Backoff zurück. |

### Zertifikatsvertrauen-Wiederherstellung

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `imap.cert_error` | event | ja (10-s-Fenster) | `provider` | Eine IMAP-Operation ist mit einem als Zertifikatsfehler klassifizierten TLS-Fehler fehlgeschlagen (selbstsigniert, nicht vertrauenswürdige Kette, Pin-Konflikt, Hostname-Konflikt). |
| `cert.recovery_dialog_shown` | event | nein | `provider` | Der Zertifikat-Wiederherstellungsdialog wurde für einen Host angezeigt, höchstens einmal pro Storm-Guard-Fenster. |
| `cert.trust_clicked` | event | nein | `provider`, `pem` | Sie haben ein vorgelegtes Zertifikat akzeptiert, wodurch ein TLS-Pin gespeichert und eine Konto-Neusynchronisation ausgelöst wurde. `pem` hält nur fest, ob der Zertifikatskörper zusammen mit dem Pin erfasst wurde -- das entscheidet, ob einem selbstsignierten Server künftig vertraut werden kann. |
| `cert.trust_rejected` | event | nein | `provider`, `reason` | Ein Vertrauensversuch endete nicht mit einem gespeicherten Pin -- zum Beispiel haben Sie die Bestätigung abgelehnt, oder das vom Server vorgelegte Zertifikat stimmte nicht mit dem im Wiederherstellungsdialog gezeigten überein. |
| `cert.interception_notice_shown` | event | nein | `provider` | Ein einmaliger Hinweis wurde angezeigt, dass die Zertifikatskette Ihres Mailservers nur gegen den Zertifikatsspeicher Ihres Betriebssystems verifiziert, nicht gegen die mitgelieferte Liste öffentlicher Stammzertifikate -- ein Anzeichen für Antivirensoftware oder einen Unternehmens-Proxy, der die Verbindung inspiziert. |

Keiner dieser Tags trägt jemals den Hostnamen, den Zertifikats-Fingerabdruck, den Namen des Ausstellers oder den rohen Fehlertext -- nur die aufgezählte `provider`-Klassifizierung und geschlossene Grundcodes.

### Cache-Aufbewahrung

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | nein | `count_bucket`, `freed_bytes_bucket` | Die Aufbewahrungsbereinigung hat `.eml`-Dateien gelöscht, die älter als der konfigurierte Zeitraum sind. Anzahl und Größen werden nur als Bereiche übermittelt -- keine exakten Pfade oder Zahlen. |
| `cache.folder_index_disabled` | event | nein | `count`, `role` | Ein Ordner wurde von der Volltextsuche ausgeschlossen -- automatisch für Junk/Spam/Papierkorb bei der ersten Registrierung oder manuell über das Ordner-Kontextmenü. `role`: `spam`, `trash` oder `manual`. |

### Cache-Sicherheit und Datenverlust-Signale

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | nein | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | Ordnerweites `DELETE FROM messages` wurde abgesetzt. Jede Aufrufstelle liefert einen Grund mit, sodass eine Regression, die einen gesunden Cache löscht, von einem regulären UIDVALIDITY-Bump unterscheidbar ist. |
| `imap.stale_wipe_guard_tripped` | event | nein | `folder_role`, `provider` | Die Mass-Delete-Schutzschicht hat das Löschen des lokalen Ordnercaches verweigert, weil `mailbox.exists` nicht-numerisch zurückkam. Ein Spike deutet auf ein Anbieter- oder Verbindungsproblem, nicht auf Datenverlust. |
| `db.shutdown_wal_checkpoint_ms` | histogram | nein | `busy`, `reclaimed_kb_bucket`, `ok` | Wallclock-Dauer des `PRAGMA wal_checkpoint(TRUNCATE)` vor dem Beenden, damit committed-but-not-checkpointed-Schreibungen Sitzungswechsel überleben. |

### KI-Ausgabenlimits

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `db.ai_reserve_denied` | event | ja (10-s-Fenster) | `reason` | Eine KI-Budgetreservierung wurde abgelehnt, bevor überhaupt Kosten entstehen konnten -- meist weil Ihr konfiguriertes Ausgabenlimit erreicht war. |
| `ai.request_budget.stopped` | event | nein | `provider`, `steps` | Eine Chat-Anfrage wurde vorzeitig gestoppt, weil die angefallenen Kosten Ihr konfiguriertes Limit pro Anfrage erreicht haben. `steps` ist die Anzahl abgeschlossener agentischer Schritte vor dem Stopp, niemals deren Inhalt. |

### MCP-stdio-Gate (Renderer-zu-RCE-Schutz)

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `mcp.stdio.connect_attempted` | event | nein | `approved_source` | Der stdio-MCP-Transport wird gleich gestartet -- emittiert einmal pro erfolgreichem Connect, nachdem Approval- und Allowlist-Gates passiert wurden. |
| `mcp.stdio.connect_blocked` | event | nein | `reason` | stdio-Connect oder -Speicherung wurde vom Gate abgelehnt (`not_approved`, `unapproved_command`, `forbidden_field`, `forbidden_env_key`, `env_disabled`). |
| `mcp.stdio.approval_granted` | event | nein | `source`, `scope` | Der Anwender hat die stdio-MCP-Freigabe erteilt (globale Aktivierung oder pro Verbindung); `source` unterscheidet env vs native-confirm, `scope` global vs pro Verbindung. |
| `mcp.stdio.env_sanitized_on_load` | event | nein | `count_bucket` | Die Settings-Migration hat verbotene Loader-Hook-Env-Keys aus persistierten MCP-Verbindungen beim Laden entfernt. Maximal einmal pro Start. |

### KI-Aktions-Audit (Preview -> Apply Bestätigungsbarriere)

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ai.action.preview_created` | event | nein | `kind` | Ein `*_preview`-MCP-Tool hat eine ausstehende mutierende Aktion registriert, die auf den Apply-Klick wartet. |
| `ai.action.applied` | event | nein | `kind` | Ein `*_apply`-MCP-Tool hat eine zuvor bestätigte mutierende Aktion erfolgreich ausgeführt. |
| `ai.action.rejected` | event | nein | `kind`, `reason` | Ein `*_apply`-Aufruf wurde am Validierungs-Gate abgelehnt -- die Preview fehlte oder war abgelaufen, das Bestätigungstoken fehlte, passte nicht oder war abgelaufen, die Aktionsart passte nicht zur Preview, der Callback fehlte, oder das Rate-Limit war erreicht. |
| `ai.action.expired` | event | nein | `kind` | Eine ausstehende mutierende Aktion ist abgelaufen, ohne dass der Anwender Apply geklickt hat (TTL). |
| `ai.action.apply_duration_ms` | histogram | nein | `kind` | Wallclock-Dauer eines erfolgreichen Apply -- wie lange die zugrunde liegende Mutation gedauert hat (DB / IMAP / SMTP). |
| `ai.action.preview_skipped` | event | nein | `kind`, `reason` | Ein `*_preview`-MCP-Tool hat die Registrierung einer ausstehenden Aktion verweigert, weil die aufgelöste Zielmenge leer war (keine Treffer nach der Anfrageauflösung). |
| `ai.action.batch_size` | event | nein | `kind`, `accounts_count_bucket`, `emails_count_bucket`, `folders_count_bucket` | Wird erfasst, wenn eine Preview-Registrierung ein Bündel von Nachrichten umfasst. Alle drei Zahlen sind grobe Bereiche, niemals genaue Zahlen. |

### KI-Egress-Gate (Ausgehende Tool-Aufrufe)

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | nein | `tool_name`, `account_id` | Ein ausgehender Tool-Aufruf (z. B. `WebSearch`, `WebFetch`, generisches externes MCP-Tool) wurde abgelehnt, während Nutzer-E-Mail-Daten im Geltungsbereich waren -- entweder aus dem SDK-Toolset gefiltert oder am Runtime-Gate gestoppt. |
| `ai.egress.allowed_once` | event | nein | `tool_name`, `account_id` | Der Anwender hat eine einmalige Egress-Zustimmung erteilt und die KI hat sie genutzt. Hilft, „Anwender übersteuern routinemäßig" von „das Gate hält, Versuche sind überwiegend Injektion-getrieben" zu trennen. |
| `ai.egress.intercepted` | event | nein | `tool_name`, `outcome`, `was_consented_for_turn` | Ein Internet-Tool-Aufruf (Websuche, Web-Fetch, externes MCP-Tool) wurde vom Bestätigungsdialog abgefangen, der unter [KI-Egress-Richtlinie](./ai-data#ki-egress-richtlinie) beschrieben ist, mit dem Vermerk, ob er erlaubt oder abgelehnt wurde und ob eine frühere Zustimmung für dieselbe Antwortrunde bereits vorlag. Niemals die Suchanfrage, URL oder Tool-Argumente -- die werden im lokalen KI-Auditprotokoll nur gehasht. |

### Aktionen im KI-Datenschutz-Auditbereich

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ai.audit.export_requested` | event | nein | `format` | Sie haben auf Export JSON oder Export CSV im KI-Auditprotokoll-Bereich geklickt. |
| `ai.audit.entry_deleted` | event | nein | `scope` | Sie haben einen Auditprotokoll-Eintrag weich gelöscht oder alle auf einmal gelöscht. Die zugrunde liegenden Zeilen werden dabei nicht entfernt, nur ausgeblendet -- siehe [Das Auditprotokoll](./ai-data#das-auditprotokoll). |

### Hintergrund-KI-Regeln

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ai.rule.applied` | event | nein | `action` | Die Pipeline für Hintergrund-KI-Regeln hat automatisch eine reversible Aktion (Archivieren, Verschieben, Als gelesen markieren oder Markieren) auf eine Nachricht angewendet. |
| `ai.rule.destructive_preview` | event | nein | `action` | Die Pipeline für Hintergrund-KI-Regeln hat eine destruktive Aktion (Löschen oder Als Spam markieren) vorgeschlagen, sie aber als ausstehende Preview erfasst, statt sie automatisch anzuwenden. |

### Automatische Updates

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `update.check_triggered` | event | nein | `source` | Eine Update-Prüfung wurde ausgelöst, entweder durch den stündlichen Hintergrund-Timer oder durch Ihren Klick unter Einstellungen -> Über. |
| `update.check_result` | event | nein | `result`, `error_class` | Eine Update-Prüfung ist abgeschlossen: aktuell, ein Update verfügbar oder fehlgeschlagen. |
| `update.download_started` | event | nein | `source` | Ein Update-Download hat begonnen, entweder automatisch oder durch Ihren Klick. |
| `update.download_completed` | event | nein | — | Ein Update-Download ist erfolgreich abgeschlossen und für die Installation beim nächsten Neustart bereitgestellt. |
| `update.download_failed` | event | nein | `error_class` | Ein Update-Download wurde nicht abgeschlossen (Netzwerkabbruch, voller Speicher, Signaturkonflikt oder Ähnliches). |
| `update.install_outcome` | event | nein | `result`, `error_class` | Was passiert ist, nachdem Sie auf Neu starten, um zu installieren geklickt haben. |

Keines davon trägt die Versionsnummer des betroffenen Releases -- nur das gruppierte Ergebnis -- sodass sich anhand dieser Tabelle nicht ablesen lässt, wie weit eine einzelne Installation zurückliegt.

### Gate für externe Links

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `links.external_open_suppressed` | event | ja (10-s-Fenster) | `source` | Eine Anfrage, einen Link in Ihrem Standardbrowser zu öffnen, wurde vom Gate für externe Links ratenbegrenzt. `source` gibt an, welcher Teil der App die Anfrage gestellt hat (zum Beispiel ein Update-Dialog oder ein Abmelde-Link), niemals die URL selbst. |

### Ausweichmodus für den Secret Store

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `secret_store.fallback_active` | event | nein | `surface`, `platform` | Ein Lesevorgang aus dem Secret Store Ihres Betriebssystems (keytar / libsecret / Secret Service) ist fehlgeschlagen -- diese Installation läuft ohne zugänglichen Schlüsselbund. `surface` gibt an, welche Art von Zugangsdaten-Lesevorgang fehlgeschlagen ist, niemals die Zugangsdaten, das Konto oder dessen E-Mail-Adresse. |

### Speicherung von KI-API-Schlüsseln

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ai.api_key_store_op` | event | ja (10-s-Fenster) | `op`, `provider`, `outcome` | Ein gespeicherter KI-API-Schlüssel wurde aus dem Secret Store Ihres Betriebssystems gelesen, dorthin geschrieben oder daraus gelöscht. `op` ist `read`, `write` oder `delete`. `provider` ist `anthropic-api`, `openai-api` oder `gemini-api` -- ein Claude-Abonnement hat keinen gespeicherten Schlüssel und erscheint hier nie. `outcome` ist `found` oder `absent` bei einem Lesevorgang (ein Schlüssel existiert gerade oder nicht), `ok` bei einem erfolgreichen Schreiben oder Löschen, oder `store_error`, wenn der Secret Store selbst nicht erreichbar war. Der Wert des Schlüssels erscheint nie -- weder als Text, noch als Länge, noch als Hash. |

### Bestätigung des KI-Ziels

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ai.destination_confirm` | event | nein | `field`, `outcome` | Das Ergebnis der Ziel-Bestätigungssperre, die eine Änderung der KI-Endpunkt- oder Proxy-Adresse absichert (siehe [Bestätigen eines neuen KI-Ziels](../ai-assistant#bestätigen-eines-neuen-ki-ziels)). `field` ist `endpoint` oder `proxy`. `outcome` ist `accepted`, `declined` (die Änderung wurde nicht genehmigt — Sie haben auf Abbrechen geklickt oder Escape gedrückt, das Bestätigungsfenster wurde geschlossen, bevor Sie geantwortet haben, oder der Dialog selbst konnte nicht angezeigt werden), `blocked_invalid` (die neue Adresse war keine verwendbare http(s)-URL und wurde ohne angezeigten Dialog abgelehnt), oder `blocked_busy` (die Änderung traf ein, während bereits eine andere Bestätigung offen war — für die gesamte App kann jeweils nur ein Dialog aktiv sein, das kann also sogar für dasselbe Feld passieren). Ein `declined`-Zähler zählt nicht nur bewusste Ablehnungen — er erfasst auch einen Dialog, der sich gar nicht anzeigen ließ. Weder die Adresse noch der Host werden jemals übermittelt. |

### IPC-Performance

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | ja (10-s-Fenster) | `channel`, `duration_bucket` | IPC-Handler hat den Schwellwert für „langsam" überschritten. |

### UI-Reaktionsfähigkeit

| Ereignis | Typ | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | ja (10-s-Fenster) | `duration_bucket`, `inflight_count`, `top_inflight` | Renderer-Event-Loop war länger blockiert als der Freeze-Schwellwert. |
| `ui.freeze.main_ms` | histogram | ja (10-s-Fenster) | `duration_bucket`, `inflight_count`, `top_inflight` | Main-Prozess-Event-Loop war blockiert (über `perf_hooks`-Delay). |

### Kontextmenü

| Ereignis | Art | Aggregiert | Tags | Zweck |
| --- | --- | --- | --- | --- |
| `ui.context_menu_shown` | event | ja (10-s-Fenster) | `context` | Das native Kontextmenue (Rechtsklick) wurde angezeigt. `context` haelt fest, welchen Abschnitt es angeboten hat: `link` (Link), `editable` (Textfeld) oder `selection` (ausgewaehlter, nicht bearbeitbarer Text). |
| `ui.context_menu_link_action` | event | ja (10-s-Fenster) | `action` | Einer der beiden Link-Eintraege im Kontextmenue wurde aktiviert. `action` ist `open` (Link im Browser öffnen) oder `copy_address` (Linkadresse kopieren). Weder die URL des Links noch sein sichtbarer Text werden jemals mitgesendet. |

## Performance-Spans

Über die diskreten Ereignisse und Histogramme oben hinaus misst MailCopilot eine feste Menge von Vorgängen als Sentry-Performance-Spans -- der Mechanismus, den Sentry für Latenz-Tracing statt für Zähler verwendet. Jeder Attributwert unten ist ein Aggregat: eine Aufzählung, eine Zahl, eine Dauer oder ein boolescher Wert. Keiner davon trägt Nachrichteninhalt, eine Adresse, eine Suchanfrage, eine URL oder einen Prompt.

### Mail-Synchronisierung und -Zustellung

| Span | Typ | Aggregiert | Attribute | Zweck |
| --- | --- | --- | --- | --- |
| `imap.idle` | span | nein | `folder_role`, `provider`, `exit_reason`, `duration_bucket` | Ein IDLE-Zyklus: verbinden, auf eine Push-Benachrichtigung warten, aktualisieren oder beenden. |
| `imap.sync` | span | nein | `folder_role`, `provider`, `changed_since_present`, `fetched_headers_bucket`, `skipped`, `errored` | Ein Header-Synchronisationslauf für einen Ordner, über CONDSTORE oder eine vollständige Abfrage. |
| `smtp.send` | span | nein | `provider`, `size_bucket`, `has_attachments` | Ein SMTP-Sendeversuch. |

### Hintergrundverarbeitung

| Span | Typ | Aggregiert | Attribute | Zweck |
| --- | --- | --- | --- | --- |
| `body_indexer.batch` | span | nein | `folder_role`, `batch_size_bucket`, `fetched_ok_bucket`, `failed_bucket` | Ein Nachrichten-Bündel, das innerhalb eines Body-Indexer-Ticks verarbeitet wurde. |
| `offline.replay` | span | nein | `ops_count_bucket`, `failed_bucket`, `uidvalidity_mismatch` | Eine Wiederholung wartender Offline-Aktionen für ein Konto, sobald es wieder verbunden ist. |
| `search.fts` | span | nein | `query_len_bucket`, `result_count_bucket` | Ein Volltextsuche-Aufruf an den Such-Worker. |
| `net.message_details` | span | nein | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Der Hauptprozess-Handler, der den vollständigen Inhalt einer Nachricht auflöst -- von einem Treffer im Arbeitsspeicher bis zu einer frischen IMAP-Abfrage. |

### KI-Funktionslatenz

| Span | Typ | Aggregiert | Attribute | Zweck |
| --- | --- | --- | --- | --- |
| `ai.chat` | span | nein | `ai.provider`, `ai.model`, `ai.context_type`, `ai.has_history`, `ai.session_resumed`, `ai.tool_call_count`, `ai.tools_used`, `ai.aborted`, `ai.cost_usd` | Eine Chat-Anfrage an den KI-Assistenten -- vom Öffnen des Anbieter-Streams bis zum Abschluss oder Abbruch. `ai.context_type` und die Verlaufs-/Fortsetzungs-Flags beschreiben, von wo das Gespräch startete und ob es ein vorheriges fortsetzte -- niemals dessen Inhalt. |
| `ai.thread_summary.generate` | span | nein | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | Eine KI-Thread-Zusammenfassung-Generierung. Wird nur bei einem tatsächlichen Anbieteraufruf ausgelöst, niemals bei einem Cache-Treffer. |
| `ai.quick_action.rewrite` | span | nein | `preset`, `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | Eine Umschreibung über die Schnellaktionen beim Verfassen. `preset` hält fest, welches der Presets (Verbessern / Kürzer / Formell / Grammatik korrigieren) Sie gewählt haben, niemals den Text Ihres Entwurfs. |
| `ai.instant_reply.generate` | span | nein | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `draft_count` | Ein Sofortantwort-Generierungsaufruf. `draft_count` ist die Anzahl der erzeugten Antwortoptionen, niemals deren Text. |

### Lokale Datenbank

| Span | Typ | Aggregiert | Attribute | Zweck |
| --- | --- | --- | --- | --- |
| `db.upsert_messages` | span | nein | `row_count_bucket`, `folder_role` | Eine gebündelte Upsert-Transaktion für Nachrichten. |
| `db.reconcile_uids` | span | nein | `row_count_bucket`, `folder_role`, `uidvalidity_changed` | Ein Abgleichlauf, der lokal zwischengespeicherte Nachrichten entfernt, die auf dem Server nicht mehr existieren. |
| `db.search_messages` | span | nein | `query_len_bucket`, `folder_role`, `result_count_bucket` | Ein Suchaufruf über den lokalen Cache, unabhängig vom internen Suchpfad, der ihn bediente. |

## Kontakt

Fragen oder Bedenken zu dem, was wir erheben? Öffnen Sie ein Issue auf [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) oder kontaktieren Sie das Team direkt über das Feedback-Formular unter Einstellungen -> Über.
