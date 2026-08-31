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
- **Anbieterauswahl.** Die KI-Thread-Zusammenfassung nutzt Ihren konfigurierten **API-Key-Anbieter** (Anthropic, OpenAI-kompatibel oder Google Gemini). Sie ist so konzipiert, dass sie ein lokales, geraeteseitiges Modell bevorzugt, sobald Unterstuetzung dafuer verfuegbar ist, damit Thread-Inhalte Ihren Rechner nicht verlassen muessten -- diese Unterstuetzung ist noch nicht verfuegbar, daher wird heute stets Ihr konfigurierter Remote-API-Key-Anbieter verwendet.
- **Telemetrie enthaelt keine Nachrichteninhalte.** Das pseudonyme Nutzungsereignis, das bei jeder Erzeugung erfasst wird, enthaelt nur die Anbieterkennung, ob das Modell lokal lief, Ein-/Ausgabe-Tokenzahlen, Latenz und eine gebuendelte Fehlerklasse -- niemals den Betreff, den Textkoerper oder die Adressen der Teilnehmer des Threads.

## Schnellaktionen beim Verfassen

[Schnellaktionen beim Verfassen](../ai-assistant#schnellaktionen-beim-verfassen) schreiben den von Ihnen selbst geschriebenen Text im Verfassen-Fenster um (Verbessern / Kürzen / Förmlich / Grammatik korrigieren). Sie folgen denselben Schutzmaßnahmen wie der Rest des KI-Assistenten:

- **Nur Ihr eigener Text verlässt das Gerät -- bei Entwürfen, die MailCopilot selbst verfasst hat.** MailCopilot trennt Ihren eigenen Text von der zitierten Nachricht, der Weiterleitungs-Kopfzeile und der Signatur, bevor überhaupt etwas gesendet wird, sodass nur Ihr eigener Text den KI-Anbieter erreicht und nur Ihr eigener Text jemals ersetzt wird. Diese Trennung ist verlässlich für Antworten, Weiterleitungen und Signaturen, die MailCopilot selbst erzeugt hat, sowie für die verbreiteten Konventionen anderer Clients -- Zitate mit `>`-Präfix (einschließlich eines verschachtelten `>>`-Zitats oder eines mit führenden Leerzeichen eingerückten Zitats), ein Weiterleitungsbanner aus Bindestrichen, ein `--`- oder `-- `-Signaturtrenner. **Ein in einem anderen E-Mail-Programm verfasster Entwurf kann in einem Stil zitieren, den MailCopilot nicht erkennt** -- ein `|`-Präfix, reine Einrückung ohne `>`, ein blanker Kopfzeilenblock `From:` / `Sent:` / `To:` / `Subject:`, aus einem HTML-Zitat umgewandelter Klartext, ein Unterstrich-Trenner im Outlook-Stil, oder „Begin forwarded message:" ohne Bindestrich-Banner. Bei einem solchen Entwurf wird keine Grenze gefunden, der gesamte Textkörper gilt als Ihr eigener Text, und das Zitat wird mitgesendet. Ihre Durchsicht steht weiterhin vor jeder Änderung: Die Umformulierung wird immer zuerst als Vorher/Nachher-Vergleich gezeigt. Siehe [Schnellaktionen beim Verfassen](../ai-assistant#schnellaktionen-beim-verfassen) dafür, wie diese Trennung erkannt wird.
- **Keine stille Ersetzung.** Eine Umformulierung wird nur als Vorher/Nachher-Vergleich angezeigt. Ihr Entwurfstext wird erst geändert, nachdem Sie explizit **Ersetzen** oder **An Cursor einfügen** angeklickt haben -- ein Klick auf **Abbrechen** oder das Schließen des Vergleichs lässt Ihren Entwurf unverändert, und es wird nichts weiter gesendet.
- **Keine stille Kürzung.** Ist Ihr eigener Text länger als 8000 Zeichen, lehnt MailCopilot die Umformulierung ab, statt nur einen Teil davon zu senden und zu ersetzen.
- **Schutz vor gleichzeitigen Änderungen.** Wenn Sie weitertippen, während eine Umformulierung erzeugt wird, wird **Ersetzen** deaktiviert, sobald die Umformulierung zurückkommt, damit sie nicht den Text überschreiben kann, den Sie inzwischen getippt haben; **An Cursor einfügen** bleibt verfügbar.
- **Umhüllter Inhalt.** Ihr eigener Text wird mit `wrapUntrusted()`-Grenzmarkierungen umhüllt, bevor er den KI-Anbieter erreicht -- derselbe Schutz, der unter [Schutz vor Prompt-Injection](#schutz-vor-prompt-injection) beschrieben wird; dies schützt auch vor Text, den Sie aus einer nicht vertrauenswürdigen Quelle eingefügt haben.
- **Auditierte Erzeugungen.** Jede Umformulierung schreibt einen Eintrag im [KI-Auditprotokoll](#das-auditprotokoll) mit dem Ziel `quick_action`; das konkret verwendete Preset (Verbessern / Kuerzen / Foermlich / Grammatik korrigieren) wird im Telemetrie-Span erfasst, nicht im Audit-Eintrag.
- **Anbieterauswahl.** Schnellaktionen nutzen Ihren konfigurierten **API-Key-Anbieter** (Anthropic, OpenAI-kompatibel oder Google Gemini). Es gibt keine eigene Ein/Aus-Einstellung: Schnellaktionen sind verfuegbar, sobald ein geeigneter Anbieter konfiguriert ist und der Entwurf Text zum Umschreiben enthaelt.
- **Budgetbewusst.** Wenn das taegliche KI-Budget erreicht wurde, wird die Umformulierung sauber abgelehnt -- siehe [Schnellaktionen beim Verfassen](../ai-assistant#schnellaktionen-beim-verfassen) fuer das, was Sie in diesem Fall sehen.
- **Telemetrie enthaelt keine Nachrichteninhalte.** Das pseudonyme Nutzungsereignis, das bei jeder Umformulierung erfasst wird, enthaelt nur das verwendete Preset, die Anbieterkennung, ob das Modell lokal lief, Tokenzahlen, Latenz und eine gebuendelte Fehlerklasse -- niemals den Entwurfstext selbst.

## Sofortantwort

Die [Sofortantwort](../ai-assistant#sofortantwort) ist eine separate, optionale Funktion, die zwei oder drei kurze Antwortoptionen fuer die geoeffnete Nachricht entwirft. Sie folgt denselben Schutzmassnahmen wie der Rest des KI-Assistenten, plus einer zusaetzlichen Massnahme, die spezifisch dafuer ist, wie sie den Nachrichtentext beschafft:

- **Standardmaessig deaktiviert, pro Konto.** Es wird nichts zum Entwerfen gesendet, solange Sie **Einstellungen > KI > Sofortantwort** nicht fuer dieses spezifische Konto aktivieren. Bei Deaktivierung wird die Schaltflaeche fuer Sofortantworten nicht angezeigt, und es wird keine Anfrage gesendet.
- **Nur Text aus dem Cache.** Die Sofortantwort loest den Text der Ausgangs-E-Mail aus dem lokalen Cache von MailCopilot anhand von Konto, Ordner und Nachrichten-UID auf -- sie vertraut niemals Textkoerper-Daten, die vom Fenster selbst geliefert werden koennten. Dies schliesst eine Klasse von Cache-Poisoning-Angriffen aus, bei denen eine manipulierte Ansicht sonst beeinflussen koennte, was an den KI-Anbieter gesendet wird.
- **Umhuellter Inhalt.** Der Text der Ausgangs-E-Mail wird mit `wrapUntrusted()`-Grenzmarkierungen umhuellt, bevor er den KI-Anbieter erreicht -- derselbe Schutz, der unter [Schutz vor Prompt-Injection](#schutz-vor-prompt-injection) beschrieben wird.
- **Niemals automatisches Senden.** Die Auswahl einer entworfenen Option fuellt lediglich ein **neues** Verfassen-Fenster vor. Es wird nichts gesendet, bis Sie den Entwurf explizit pruefen und selbst auf Senden klicken.
- **Auditierte Erzeugungen.** Jedes Mal, wenn Entwuerfe tatsaechlich erzeugt werden, wird ein Eintrag im [KI-Auditprotokoll](#das-auditprotokoll) mit dem Ziel der Sofortantwort-Aktion geschrieben.
- **Anbieterauswahl.** Die Sofortantwort nutzt Ihren konfigurierten **API-Key-Anbieter** (Anthropic, OpenAI-kompatibel oder Google Gemini).
- **Budgetbewusst.** Wenn das taegliche KI-Budget erreicht wurde, wird das Entwerfen sauber abgelehnt -- siehe [Sofortantwort](../ai-assistant#sofortantwort) fuer das, was Sie in diesem Fall sehen.
- **Telemetrie enthaelt keine Nachrichteninhalte.** Das pseudonyme Nutzungsereignis, das bei jeder Erzeugung erfasst wird, enthaelt nur die Anbieterkennung, ob das Modell lokal lief, Tokenzahlen, Latenz und eine gebuendelte Fehlerklasse -- niemals den Betreff, den Textkoerper der E-Mail, Absender- oder Empfaengeradressen, oder den Text der entworfenen Antwort.

## Nachrichtenübersetzung

Die [Nachrichtenübersetzung](../ai-assistant#nachrichtenübersetzung) ist eine separate, optionale Funktion, die die Nachricht, die Sie gerade lesen, in eine Sprache Ihrer Wahl übersetzt. Sie folgt denselben Schutzmaßnahmen wie der Rest des KI-Assistenten:

- **Standardmäßig deaktiviert, pro Konto.** Es wird nichts zur Übersetzung gesendet, solange Sie **Einstellungen > KI > KI-Übersetzung** nicht für dieses spezifische Konto aktivieren. Bei Deaktivierung wird die Schaltfläche Übersetzen nicht angezeigt, und es wird keine Anfrage gesendet.
- **Nur auf Anfrage.** Ein Anbieter wird nur aufgerufen, wenn Sie auf **Übersetzen** klicken -- es gibt keine automatische Übersetzung beim Öffnen einer Nachricht.
- **Projektion auf reinen Text.** Der Anbieter sieht und liefert immer nur reinen Text: Die Übersetzung wird aus der Textfassung der Nachricht erzeugt, nie aus dem HTML-Markup, auch bei einer HTML-Nachricht.
- **Nur Text aus dem Cache.** Der Nachrichtentext stammt aus dem lokalen Cache von MailCopilot anhand von Konto, Ordner und Nachrichten-UID -- nie aus dem, was gerade im Fenster angezeigt wird.
- **Umhüllter Inhalt.** Der Nachrichtentext wird mit `wrapUntrusted()`-Grenzmarkierungen umhüllt, bevor er den KI-Anbieter erreicht -- derselbe Schutz, der unter [Schutz vor Prompt-Injection](#schutz-vor-prompt-injection) beschrieben wird.
- **Zwischengespeichert, nicht erneut gesendet.** Eine bereits erstellte Übersetzung für eine Nachricht, eine Zielsprache und eine Version des Übersetzungsvertrags (Anbieter, Modell und Prompt-Form) wird bei späteren Öffnungen aus einem lokalen Cache bedient -- es erreicht keine Anfrage den Anbieter ein zweites Mal für dieselbe Nachricht, Sprache und denselben Vertrag. Cache-Einträge haben keine eigene Ablaufzeit: Eine spätere Änderung daran, wie MailCopilot Übersetzungen erzeugt, wird unter einem neuen Schlüssel abgelegt, statt das Ergebnis eines älteren Vertrags als aktuell auszugeben. Sie sind auf 500 pro Konto begrenzt und werden zusammen mit dem Konto gelöscht.
- **Auditierte Erzeugungen.** Jedes Mal, wenn eine Übersetzung tatsächlich erzeugt wird (und nicht aus dem Cache bedient wird), wird ein Eintrag im [KI-Auditprotokoll](#das-auditprotokoll) geschrieben. Ein Cache-Treffer schreibt keinen Eintrag.
- **Anbieterauswahl.** Die Nachrichtenübersetzung nutzt Ihren konfigurierten **API-Key-Anbieter** (Anthropic, OpenAI-kompatibel oder Google Gemini).
- **Budgetbewusst.** Wenn das tägliche KI-Budget erreicht wurde, wird die Übersetzung sauber abgelehnt -- siehe [Nachrichtenübersetzung](../ai-assistant#nachrichtenübersetzung) für das, was Sie in diesem Fall sehen.
- **Telemetrie enthält keine Nachrichteninhalte.** Das pseudonyme Nutzungsereignis, das bei jedem Aufruf des Anbieters erfasst wird, enthält nur die Anbieterkennung, ob das Modell lokal lief, Tokenzahlen, Latenz, eine gebündelte Fehlerklasse, ob eine Ausgangssprache beschriftet werden konnte (niemals welche), den Code der gewählten Zielsprache sowie, ob das Ergebnis aus dem Cache stammte -- niemals den Nachrichtentext, die Übersetzung, den Betreff, die Adressen, den Ordnernamen oder die erkannte Ausgangssprache selbst.

## Entwurfsübersetzung

Die [Entwurfsübersetzung](../ai-assistant#entwurfsübersetzung) ist das Gegenstück der Nachrichtenübersetzung auf der Schreibseite: Sie übersetzt den von Ihnen selbst geschriebenen Text in eine von Ihnen gewählte Sprache, direkt im Schreibfenster. Sie teilt sich die Opt-in-Einstellung mit der Nachrichtenübersetzung und folgt denselben Schutzmaßnahmen, plus den schreibspezifischen, die die Schnellaktionen beim Verfassen bereits nutzen:

- **Standardmäßig deaktiviert, pro Konto -- keine eigene Einstellung.** Die Entwurfsübersetzung wird über denselben Schalter **Einstellungen > KI > KI-Übersetzung** wie die Nachrichtenübersetzung gesteuert; es gibt nichts Zusätzliches zu aktivieren.
- **Nur auf Anfrage.** Ein Anbieter wird nur aufgerufen, wenn Sie auf **Übersetzen** klicken. Das Öffnen des Schreibfensters, das Erscheinen einer vorgeschlagenen Zielsprache in der Liste oder das Ändern des Listenwerts ruft niemals von selbst einen Anbieter auf.
- **Nur Ihr eigener Text verlässt das Gerät, wenn eine Grenze gefunden wird.** Die Entwurfsübersetzung verwendet dieselbe Grenze für den eigenen Text wie die Schnellaktionen beim Verfassen: Die zitierte Nachricht, die Weiterleitungs-Kopfzeile und die Signatur sind sowohl vom Gesendeten als auch von allem, was jemals ersetzt wird, ausgeschlossen -- bei Antworten, Weiterleitungen und Signaturen, die MailCopilot selbst erstellt hat, sowie bei den verbreiteten Konventionen anderer Programme. Bei einem Entwurf, der in einem Stil zitiert, den MailCopilot nicht erkennt, wird keine Grenze gefunden, und der gesamte Text -- einschließlich des Zitats -- wird an den KI-Anbieter gesendet und kann ersetzt werden. Siehe [Schnellaktionen beim Verfassen](#schnellaktionen-beim-verfassen) oben dafür, wie diese Grenze erkannt wird, und für die vollständige Liste der nicht erkannten Zitierstile.
- **Keine stille Ersetzung.** Die Übersetzung wird nur als Vorher/Nachher-Vergleich im selben Prüfpanel gezeigt, das die Schnellaktionen beim Verfassen verwenden. Ihr Entwurfstext ändert sich erst, nachdem Sie explizit **Ersetzen** oder **An Cursor einfügen** angeklickt haben.
- **Kein Cache.** Anders als bei der Nachrichtenübersetzung wird ein übersetzter Entwurf nicht gespeichert: Ein Entwurf ändert sich erwartungsgemäß laufend zwischen Anfragen, sodass ein dauerhafter Cache größtenteils unversendeten Text festhalten würde, ohne je wiederverwendet zu werden.
- **Umhüllter Inhalt.** Ihr eigener Text wird mit `wrapUntrusted()`-Grenzmarkierungen umhüllt, bevor er den KI-Anbieter erreicht -- derselbe Schutz, der unter [Schutz vor Prompt-Injection](#schutz-vor-prompt-injection) beschrieben wird.
- **Auditierte Erzeugungen.** Jede Übersetzung schreibt einen Eintrag im [KI-Auditprotokoll](#das-auditprotokoll).
- **Anbieterauswahl.** Die Entwurfsübersetzung nutzt Ihren konfigurierten **API-Key-Anbieter** (Anthropic, OpenAI-kompatibel oder Google Gemini).
- **Budgetbewusst.** Wenn das tägliche KI-Budget erreicht wurde, wird die Übersetzung sauber abgelehnt -- siehe [Entwurfsübersetzung](../ai-assistant#entwurfsübersetzung) für das, was Sie in diesem Fall sehen.
- **Die vorgeschlagene Sprache ist nur ein Vorschlag.** Wenn Sie antworten, kann MailCopilot die Zielsprachenauswahl mit der Sprache der Nachricht vorbefüllen, auf die Sie antworten, lokal auf Ihrem Gerät erkannt. Sie startet niemals von selbst eine Übersetzung, und sie wird nie gemeldet: Kein Telemetriefeld erfasst, welche Sprache vorgeschlagen wurde oder ob die von Ihnen gewählte Sprache aus diesem Vorschlag stammt.
- **Die Telemetrie enthält keinen Nachrichteninhalt.** Das pseudonyme Nutzungsereignis, das für jede Übersetzung erfasst wird, trägt nur die Anbieterkennung, ob das Modell lokal lief, Token-Zahlen, Latenz, eine gruppierte Fehlerklasse und den von Ihnen gewählten Zielsprachcode -- niemals den Entwurfstext, die Übersetzung, die Empfänger, den Betreff oder die vorgeschlagene Sprache.

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
| **Anbieter** | Ein Zuordnungslabel fuer den Eintrag, meist Ihr konfigurierter KI-Anbieter (z.B. Anthropic, OpenAI, Google). Es kann auch einen externen Client benennen, der ueber den [MCP Server Export](../ai-assistant#mcp-server-export) verbunden ist (`mcp-export`), und aeltere Eintraege koennen eine Anbieter-Kennung bewahren, die diese Version von MailCopilot nicht mehr als Verbindungsmethode anbietet. |
| **Modell** | Die spezifische Modellversion, die die Anfrage bearbeitet hat. |
| **Ziel** | Eine kurze Beschreibung dessen, was vom Assistenten verlangt wurde. |
| **Werkzeug** | Das aufgerufene MCP-Tool, falls vorhanden (z.B. `send_email`, `mail_action`, `move_email`). |
| **Tokens Ein / Aus** | Anzahl der Eingabe- und Ausgabe-Tokens fuer diese Aktion. Werte werden aufgezeichnet, wenn der Anbieter sie ueber das SDK bereitstellt; andernfalls zeigen die Spalten **n/v**. |
| **Kosten (USD)** | Geschaetzte Kosten basierend auf den veroeffentlichten Preisen des Anbieters oder **n/v**, wenn fuer diesen Eintrag kein Kostenwert pro Anfrage benannt ist -- entweder weil der Anbieter keinen gemeldet hat, oder weil der Eintrag selbst nie Kosten pro Aufruf traegt (zum Beispiel ein abgefangener Internet-Tool-Aufruf oder eine Aktion ueber eine exportierte MCP-Sitzung). **n/v** bedeutet hier nicht, dass die Anfrage die Ausgabenlimits umgangen hat: KI-Thread-Zusammenfassung, Schnellaktionen beim Verfassen und Sofortantwort zaehlen alle gegen das Taegliche / Monatliche Budget, unabhaengig davon, was diese Spalte zeigt. Die Kosten sind das primaere Signal fuer die Ausgabenverfolgung. |
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

## Schutz vor Prompt-Injection

Jeder Block mit E-Mail-Inhalt, der an die KI uebergeben wird, wird mit `wrapUntrusted()`-Grenzmarkierungen umhuellt. Diese Markierungen weisen die KI an, den eingeschlossenen Inhalt als nicht vertrauenswuerdige Benutzerdaten -- und nicht als Anweisungen -- zu behandeln, sodass eine bossartige E-Mail das Verhalten des Assistenten nicht kapern kann. Die Spalte **Umhuellt** im Auditprotokoll zeigt Ihnen genau, wie oft dieser Schutz in jeder Anfrage angewendet wurde. Der Zaehler ist praezise: Wenn dieselbe E-Mail innerhalb einer einzelnen Anfrage mehrmals abgerufen wird (z. B. wenn die KI sie bei einer mehrstufigen Aufgabe erneut besucht), wird jeder Abruf separat gezaehlt -- so spiegelt die Summe die tatsaechliche Anzahl der E-Mail-Lesevorgaenge genau wider.

## Siehe auch

- [KI-Assistent](../ai-assistant) -- vollstaendige Anleitung zur Nutzung des KI-Assistenten.
- [Telemetrie](./telemetry) -- pseudonyme Diagnosedaten, die MailCopilot erfasst (getrennt vom KI-Auditprotokoll).
