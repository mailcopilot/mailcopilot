---
sidebar_position: 1
title: AI Data & Audit Log
---

# KI-Daten und Auditprotokoll

Diese Seite erklaert, welche Daten der KI-Assistent verarbeitet, wie MailCopilot diese Verarbeitung in einem lokalen Auditprotokoll aufzeichnet und welche Kontrollmoeglichkeiten Sie ueber diese Daten haben.

## Was der KI-Assistent an Anbieter sendet

Wenn Sie den KI-Assistenten verwenden, uebertraegt MailCopilot folgende Daten an Ihren gewaehlten KI-Anbieter:

- Den Inhalt der E-Mail oder des Gespraechsfadens, den Sie gerade anzeigen (Betreff, Text, Absender, Empfaenger).
- Anhaenge, die Sie den Assistenten explizit bitten zu lesen.
- Ihre KI-Gedaechtnisnotizen (wenn die Gedaechtnisfunktion konfiguriert ist).
- Den Text Ihrer Chat-Nachricht an den Assistenten.

**Was niemals gesendet wird:**

- E-Mails oder Ordner, die Sie in der aktuellen Sitzung nicht geoeffnet oder erwaehnt haben.
- Ihre IMAP/SMTP-Zugangsdaten oder Serverkonfiguration.
- Passwoerter Ihrer E-Mail-Konten.
- Daten aus Konten, die Sie in der aktuellen KI-Anfrage nicht explizit genutzt haben.

Der KI-Assistent ist vollstaendig optional. Wenn Sie keinen Anbieter konfigurieren, werden keine E-Mail-Daten an einen externen Dienst uebertragen.

## KI-Thread-Zusammenfassung

Die [KI-Thread-Zusammenfassung](../ai-assistant#ki-thread-zusammenfassung) ist eine separate, optionale Funktion, die eine kurze Zusammenfassung eines geoeffneten Threads erzeugt. Sie folgt denselben Schutzmassnahmen wie der Rest des KI-Assistenten:

- **Standardmaessig deaktiviert, pro Konto.** Es wird nichts zur Zusammenfassung gesendet, solange Sie **Einstellungen > KI > KI-Thread-Zusammenfassung** nicht fuer dieses spezifische Konto aktivieren.
- **Umhuellter Inhalt.** Jede in die Zusammenfassungsanfrage einbezogene Nachricht wird mit `wrapUntrusted()`-Grenzmarkierungen umhuellt, bevor sie den KI-Anbieter erreicht -- derselbe Schutz, der weiter unten unter [Schutz vor Prompt-Injection](#schutz-vor-prompt-injection) beschrieben wird.
- **Auditierte Erzeugungen.** Jedes Mal, wenn eine Zusammenfassung tatsaechlich erzeugt wird (nicht aus dem Cache bedient), wird ein Eintrag im [KI-Auditprotokoll](#das-auditprotokoll) mit dem Ziel der Zusammenfassungsaktion geschrieben. Das erneute Oeffnen eines bereits zusammengefassten Threads liest das zwischengespeicherte Ergebnis und erzeugt weder einen neuen Audit-Eintrag noch kontaktiert es erneut den KI-Anbieter.
- **Kontogebundener Cache.** Eine erzeugte Zusammenfassung wird pro Konto zwischengespeichert und nachgeschlagen: Der Cache-Schluessel kombiniert Ihr Konto mit der Identitaet des Threads, sodass eine zwischengespeicherte Zusammenfassung eines Kontos niemals fuer ein anderes Konto wiederverwendet oder offengelegt wird.
- **Budgetbewusst.** Wenn das taegliche KI-Budget erreicht wurde, wird die Zusammenfassung sauber abgelehnt statt erzeugt -- siehe [KI-Thread-Zusammenfassung](../ai-assistant#ki-thread-zusammenfassung) fuer das, was Sie in diesem Fall sehen.
- **Anbieterauswahl.** Die KI-Thread-Zusammenfassung nutzt Ihren konfigurierten **API-Key-Anbieter** (Anthropic, OpenAI-kompatibel oder Google Gemini) -- **ein Claude-Abonnement wird fuer die KI-Thread-Zusammenfassung nicht unterstuetzt** und fuehrt zur selben Ablehnung „kein KI-Anbieter" wie das voellige Fehlen eines konfigurierten Anbieters. Sie ist so konzipiert, dass sie ein lokales, geraeteseitiges Modell bevorzugt, sobald Unterstuetzung dafuer verfuegbar ist, damit Thread-Inhalte Ihren Rechner nicht verlassen muessten -- diese Unterstuetzung ist noch nicht verfuegbar, daher wird heute stets Ihr konfigurierter Remote-API-Key-Anbieter verwendet.
- **Telemetrie enthaelt keine Nachrichteninhalte.** Das anonyme Nutzungsereignis, das bei jeder Erzeugung erfasst wird, enthaelt nur die Anbieterkennung, ob das Modell lokal lief, Ein-/Ausgabe-Tokenzahlen, Latenz und eine gebuendelte Fehlerklasse -- niemals den Betreff, den Textkoerper oder die Adressen der Teilnehmer des Threads.

## Schnellaktionen beim Verfassen

[Schnellaktionen beim Verfassen](../ai-assistant#schnellaktionen-beim-verfassen) schreiben Ihren aktuellen Entwurfstext im Verfassen-Fenster um (Verbessern / Kuerzen / Foermlich / Grammatik korrigieren). Sie folgen denselben Schutzmassnahmen wie der Rest des KI-Assistenten:

- **Keine stille Ersetzung.** Eine Umformulierung wird nur als Vorher/Nachher-Vergleich angezeigt. Ihr Entwurfstext wird erst geaendert, nachdem Sie explizit **Ersetzen** oder **An Cursor einfuegen** angeklickt haben -- ein Klick auf **Abbrechen** oder das Schliessen des Vergleichs laesst Ihren Entwurf unveraendert, und es wird nichts weiter gesendet.
- **Umhuellter Inhalt.** Ihr Entwurfstext wird mit `wrapUntrusted()`-Grenzmarkierungen umhuellt, bevor er den KI-Anbieter erreicht -- derselbe Schutz, der unter [Schutz vor Prompt-Injection](#schutz-vor-prompt-injection) beschrieben wird; dies schuetzt auch vor Text, den Sie aus einer nicht vertrauenswuerdigen Quelle eingefuegt haben.
- **Auditierte Erzeugungen.** Jede Umformulierung schreibt einen Eintrag im [KI-Auditprotokoll](#das-auditprotokoll) mit dem Ziel `quick_action`; das konkret verwendete Preset (Verbessern / Kuerzen / Foermlich / Grammatik korrigieren) wird im Telemetrie-Span erfasst, nicht im Audit-Eintrag.
- **Anbieterauswahl.** Schnellaktionen nutzen Ihren konfigurierten **API-Key-Anbieter** (Anthropic, OpenAI-kompatibel oder Google Gemini) -- **ein Claude-Abonnement wird nicht unterstuetzt** und fuehrt zur selben Ablehnung „kein KI-Anbieter" wie das voellige Fehlen eines konfigurierten Anbieters. Es gibt keine eigene Ein/Aus-Einstellung: Schnellaktionen sind verfuegbar, sobald ein geeigneter Anbieter konfiguriert ist und der Entwurf Text zum Umschreiben enthaelt.
- **Budgetbewusst.** Wenn das taegliche KI-Budget erreicht wurde, wird die Umformulierung sauber abgelehnt -- siehe [Schnellaktionen beim Verfassen](../ai-assistant#schnellaktionen-beim-verfassen) fuer das, was Sie in diesem Fall sehen.
- **Telemetrie enthaelt keine Nachrichteninhalte.** Das anonyme Nutzungsereignis, das bei jeder Umformulierung erfasst wird, enthaelt nur das verwendete Preset, die Anbieterkennung, ob das Modell lokal lief, Tokenzahlen, Latenz und eine gebuendelte Fehlerklasse -- niemals den Entwurfstext selbst.

## Sofortantwort

Die [Sofortantwort](../ai-assistant#sofortantwort) ist eine separate, optionale Funktion, die zwei oder drei kurze Antwortoptionen fuer die geoeffnete Nachricht entwirft. Sie folgt denselben Schutzmassnahmen wie der Rest des KI-Assistenten, plus einer zusaetzlichen Massnahme, die spezifisch dafuer ist, wie sie den Nachrichtentext beschafft:

- **Standardmaessig deaktiviert, pro Konto.** Es wird nichts zum Entwerfen gesendet, solange Sie **Einstellungen > KI > Sofortantwort** nicht fuer dieses spezifische Konto aktivieren. Bei Deaktivierung wird die Schaltflaeche fuer Sofortantworten nicht angezeigt, und es wird keine Anfrage gesendet.
- **Nur Text aus dem Cache.** Die Sofortantwort loest den Text der Ausgangs-E-Mail aus dem lokalen Cache von MailCopilot anhand von Konto, Ordner und Nachrichten-UID auf -- sie vertraut niemals Textkoerper-Daten, die vom Fenster selbst geliefert werden koennten. Dies schliesst eine Klasse von Cache-Poisoning-Angriffen aus, bei denen eine manipulierte Ansicht sonst beeinflussen koennte, was an den KI-Anbieter gesendet wird.
- **Umhuellter Inhalt.** Der Text der Ausgangs-E-Mail wird mit `wrapUntrusted()`-Grenzmarkierungen umhuellt, bevor er den KI-Anbieter erreicht -- derselbe Schutz, der unter [Schutz vor Prompt-Injection](#schutz-vor-prompt-injection) beschrieben wird.
- **Niemals automatisches Senden.** Die Auswahl einer entworfenen Option fuellt lediglich ein **neues** Verfassen-Fenster vor. Es wird nichts gesendet, bis Sie den Entwurf explizit pruefen und selbst auf Senden klicken.
- **Auditierte Erzeugungen.** Jedes Mal, wenn Entwuerfe tatsaechlich erzeugt werden, wird ein Eintrag im [KI-Auditprotokoll](#das-auditprotokoll) mit dem Ziel der Sofortantwort-Aktion geschrieben.
- **Anbieterauswahl.** Die Sofortantwort nutzt Ihren konfigurierten **API-Key-Anbieter** (Anthropic, OpenAI-kompatibel oder Google Gemini) -- **ein Claude-Abonnement wird nicht unterstuetzt** und fuehrt zur selben Ablehnung „kein KI-Anbieter" wie das voellige Fehlen eines konfigurierten Anbieters.
- **Budgetbewusst.** Wenn das taegliche KI-Budget erreicht wurde, wird das Entwerfen sauber abgelehnt -- siehe [Sofortantwort](../ai-assistant#sofortantwort) fuer das, was Sie in diesem Fall sehen.
- **Telemetrie enthaelt keine Nachrichteninhalte.** Das anonyme Nutzungsereignis, das bei jeder Erzeugung erfasst wird, enthaelt nur die Anbieterkennung, ob das Modell lokal lief, Tokenzahlen, Latenz und eine gebuendelte Fehlerklasse -- niemals den Betreff, den Textkoerper der E-Mail, Absender- oder Empfaengeradressen, oder den Text der entworfenen Antwort.

## KI-Egress-Richtlinie

MailCopilot interceptiert jeden ausgehenden Internet-Tool-Aufruf, den die KI ausfuehren moechte -- Websuche, Web-Abruf und externe MCP-Tool-Aufrufe -- und unterbricht die KI, um Ihre Genehmigung vor der Ausfuehrung einzuholen. Dies verhindert, dass eine bossartige E-Mail Ihre Daten durch einen Prompt-Injection-Angriff still und leise exfiltriert.

### Funktionsweise

Wenn die KI ein Internet-Tool nutzen moechte (z. B. eine Websuche durchfuehren), unterbricht MailCopilot die Antwort und zeigt ein integriertes Bestaetigungsdialogfeld im KI-Panel mit der Meldung **«KI möchte auf das Internet zugreifen»** an. Das Dialogfeld zeigt:

- Den Aktionstyp -- «Websuche:», «URL abrufen:» oder «Externer Tool-Aufruf»
- Die angeforderte Suchanfrage, URL oder den Namen des externen Tools (sofern verfuegbar)
- Die Schaltflaechen **Erlauben** und **Ablehnen**

Klicken Sie auf **Erlauben**, um der KI das Fortfahren zu erlauben, oder auf **Ablehnen**, um abzulehnen. Ihre Entscheidung gilt fuer den gesamten aktuellen Antwort-Durchlauf -- wenn die KI in einer Antwort mehrere Internet-Tool-Aufrufe macht, werden Sie nur einmal gefragt. Ein Klick auf **Erlauben** gewaehrt Zugriff fuer alle verbleibenden Aufrufe dieses Durchlaufs.

Wenn Sie nicht innerhalb von 30 Sekunden antworten, lehnt MailCopilot den Tool-Aufruf automatisch ab.

### Schild-Symbol

Im KI-Panel-Header wird ein Schild-Symbol angezeigt, wenn die Egress-Interception aktiv ist. Beim Hovern erscheint: «KI-Webzugriff wird abgefangen – jeder ausgehende Aufruf erfordert Ihre Genehmigung». Dieses Symbol bestaetigt, dass der Interceptor laeuft und kein Internet-Aufruf Ihre Genehmigung umgehen kann.

### Richtlinieneinstellungen

Sie koennen die Egress-Richtlinie unter **Einstellungen → AI** anpassen (unter der Steuerung **KI-Webzugriff**). Diese Einstellung steuert, wann die KI Internet-Tools verwenden kann. Bei **Standardmäßig ablehnen** oder **Bei jeder Antwort fragen** wird MailCopilot beim ersten Internet-Tool-Aufruf in jedem Antwort-Durchlauf um Bestaetigung gebeten. Bei **Immer erlauben** wird die Abfrage uebersprungen -- Internet-Tools werden ohne Bestaetigung ausgefuehrt:

- **Standardmäßig ablehnen (empfohlen)** -- alle Internet-Tool-Aufrufe abfangen; Sie genehmigen oder lehnen jeden Durchlauf ueber das Bestaetigungsdialogfeld ab.
- **Bei jeder Antwort fragen** -- gleiches Verhalten wie Standardabweisung: explizite Pro-Durchlauf-Einwilligung ueber das Bestaetigungsdialogfeld.
- **Immer erlauben** -- die KI kann Web-Tools frei aufrufen. Warnung: Die KI kann E-Mail-Inhalte an externe Dienste senden.

### Auditprotokoll

Jeder abgefangene Internet-Tool-Aufruf erstellt einen Eintrag im Auditprotokoll; abgelehnte Aufrufe erhoehen die Spalte **Blockiert**, waehrend genehmigte Aufrufe mit **Blockiert** = 0 aufgezeichnet werden. Jeder Eintrag wird auch im Telemetrieereignis `ai.egress.intercepted` mit Tags gezaehlt, die den Tool-Namen, das Ergebnis (genehmigt oder abgelehnt) und ob die Einwilligung fuer diesen Durchlauf bereits erteilt worden war, angeben. Fuer Anfrage- und URL-Details speichert das Auditprotokoll nur einen SHA-256-Hash, der auf die ersten 16 Hexadezimalzeichen gekuerzt ist; rohe Anfragen und URLs werden niemals auf den Datentraeger geschrieben.

## Das Auditprotokoll

MailCopilot fuehrt ein lokales Auditprotokoll jeder KI-Aktion. Das Protokoll wird in Ihrer lokalen Datenbank auf Ihrem Geraet gespeichert und wird niemals an MailCopilot oder Dritte uebertragen.

### Was jeder Eintrag aufzeichnet

| Feld | Beschreibung |
|------|--------------|
| **Zeitstempel** | Genaues Datum und Uhrzeit der Aktion. |
| **Anbieter** | Der verwendete KI-Anbieter (z.B. Anthropic, OpenAI, Google). |
| **Modell** | Die spezifische Modellversion, die die Anfrage bearbeitet hat. |
| **Ziel** | Eine kurze Beschreibung dessen, was vom Assistenten verlangt wurde. |
| **Werkzeug** | Das aufgerufene MCP-Tool, falls vorhanden (z.B. `send_email`, `mail_action`, `move_email`). |
| **Tokens Ein / Aus** | Anzahl der Eingabe- und Ausgabe-Tokens fuer diese Aktion. Werte werden aufgezeichnet, wenn der Anbieter sie ueber das SDK bereitstellt; andernfalls zeigen die Spalten **n/v**. |
| **Kosten (USD)** | Geschaetzte Kosten basierend auf den veroeffentlichten Preisen des Anbieters oder **n/v** fuer abonnementbasierte Anbieter. Die Kosten sind das primaere Signal fuer die Ausgabenverfolgung. |
| **Umhuellt** | Anzahl der Aufrufe des `wrapUntrusted()`-Grenzmarkers. Jeder Aufruf bedeutet, dass ein Block mit E-Mail-Inhalt vor der Uebergabe an die KI isoliert wurde, um Prompt-Injection zu verhindern. |
| **Blockiert** | Anzahl der von der Sicherheitsrichtlinie blockierten ausgehenden Egress-Versuche waehrend dieser Aktion. |
| **Ergebnis** | Ergebnis der Aktion: **OK** (erfolgreich abgeschlossen), **Fehler** (fehlgeschlagen) oder **Abgebrochen** (durch Sie oder das System abgebrochen). |

### Unveraenderlichkeit und Aufbewahrung

Neue Eintraege werden immer angehaengt. Alle Spalten ausser `deleted_at` sind nach dem Einfuegen unveraenderlich -- bestehende Datensaetze werden nach dem Schreiben nicht mehr geaendert. Die App kann vergangene Eintraege also nicht veraendern (nur Soft-Loeschen oder durch die Rotationsgrenze entfernen lassen). Das Soft-Loeschen eines Eintrags (siehe unten) setzt den `deleted_at`-Zeitstempel und blendet den Eintrag aus der Ansicht aus, aber alle anderen Spalten bleiben unveraendert.

Das Protokoll ist auf **10.000 Eintraege** begrenzt. Wenn ein neuer Eintrag hinzugefuegt wird und die Gesamtzahl diesen Grenzwert ueberschreitet, werden die aeltesten Zeilen automatisch entfernt. Eintraege, die aelter als die juengsten 10.000 sind, werden dauerhaft aus der lokalen Datenbank geloescht. Wenn Sie eine dauerhafte Aufzeichnung benoetigen, exportieren Sie das Protokoll regelmaessig ueber die Schaltflaechen **Als JSON exportieren** oder **Als CSV exportieren**, bevor Eintraege herausrotiert werden.

### Auf das Auditprotokoll zugreifen

Oeffnen Sie **Einstellungen → KI** und klappen Sie den Abschnitt **Datenschutz und Audit** auf. Das Protokoll ist seitenweise aufgeteilt und nach neuesten Eintraegen zuerst sortiert.

### Exportieren

Klicken Sie auf **Als JSON exportieren** oder **Als CSV exportieren**, um das aktuell sichtbare Auditprotokoll herunterzuladen (aktive Zeilen innerhalb der 10.000-Zeilen-Rotationsgrenze; soft-geloeschte und rotationsbedingt entfernte Eintraege sind ausgeschlossen). Der Export umfasst alle oben aufgefuehrten Felder fuer jeden enthaltenen Eintrag. Der CSV-Export verwendet das RFC-4180-Format mit CRLF-Zeilentrennzeichen und korrektem Escaping (Felder mit Kommas, Anfuehrungszeichen oder eingebetteten Zeilenumbruechen werden korrekt maskiert). Die CSV-Datei ist mit Excel, Numbers und LibreOffice kompatibel. Sie koennen ihn verwenden fuer:

- Ueberpruefung der KI-Aktivitaet zu einem beliebigen Zeitpunkt.
- Bearbeitung von Auskunftsersuchen zu personenbezogenen Daten gemaess DSGVO oder aehnlichen Vorschriften.
- Aufbewahrung einer Offline-Kopie fuer eigene Unterlagen.

### Eintraege loeschen

**Soft-Delete pro Zeile** -- klicken Sie auf das Loeschsymbol eines Protokolleintrags, um ihn aus der Ansicht auszublenden. Der `deleted_at`-Zeitstempel des Eintrags wird gesetzt und er verschwindet aus der Liste und den Aggregaten, aber die zugrunde liegenden Daten bleiben zur Wahrung der Auditintegritaet erhalten.

**Alle loeschen** -- markiert alle Audit-Eintraege als soft-geloescht (setzt `deleted_at` fuer jeden Datensatz). Vor der Ausfuehrung zeigt MailCopilot einen nativen Systemdialog mit dem Titel "Clear AI audit log" und den Schaltflaechen **Cancel** und **Delete All**. Die Eintraege sind in der Liste, den Aggregaten und den Exporten ausgeblendet. Beachten Sie, dass die automatische Begrenzung auf 10.000 Zeilen (siehe oben) die aeltesten Zeilen mit der Zeit physisch loescht; soft-geloeschte Eintraege werden in dieser Begrenzung mitgezaehlt und werden schliesslich durch die Rotation endgueltig geloescht.

## Token- und Kostenaggregate

Der obere Bereich des Panels "Datenschutz und Audit" zeigt Token- und Kostensummen pro Anbieter. Waehlen Sie einen Zeitraum -- **Heute**, **Letzte 7 Tage** oder **Letzte 30 Tage** -- um die Aggregate zu filtern. Dies sind gleitende Fenster, keine Kalenderwochen oder -monate. Diese Summen werden aus dem lokalen Auditprotokoll berechnet und niemals an einen Server gesendet.

Fuer abonnementbasierte Anbieter werden Kosten als **n/v** angezeigt, da eine anfragenbasierte Preisgestaltung nicht gilt.

## Schutz vor Prompt-Injection

Jeder Block mit E-Mail-Inhalt, der an die KI uebergeben wird, wird mit `wrapUntrusted()`-Grenzmarkierungen umhuellt. Diese Markierungen weisen die KI an, den eingeschlossenen Inhalt als nicht vertrauenswuerdige Benutzerdaten -- und nicht als Anweisungen -- zu behandeln, sodass eine bossartige E-Mail das Verhalten des Assistenten nicht kapern kann. Die Spalte **Umhuellt** im Auditprotokoll zeigt Ihnen genau, wie oft dieser Schutz in jeder Anfrage angewendet wurde. Der Zaehler ist praezise: Wenn dieselbe E-Mail innerhalb einer einzelnen Anfrage mehrmals abgerufen wird (z. B. wenn die KI sie bei einer mehrstufigen Aufgabe erneut besucht), wird jeder Abruf separat gezaehlt -- so spiegelt die Summe die tatsaechliche Anzahl der E-Mail-Lesevorgaenge genau wider.

## Siehe auch

- [KI-Assistent](../ai-assistant) -- vollstaendige Anleitung zur Nutzung des KI-Assistenten.
- [Telemetrie](./telemetry) -- anonyme Diagnosedaten, die MailCopilot erfasst (getrennt vom KI-Auditprotokoll).
