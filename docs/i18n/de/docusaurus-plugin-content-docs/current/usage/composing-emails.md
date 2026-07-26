---
sidebar_position: 3
title: E-Mails verfassen
---

# E-Mails verfassen

## Neue Nachricht

Klicken Sie auf **Verfassen** oder druecken Sie **c**. Das Fenster oeffnet sich separat.

## Felder

- **Von** -- bei mehreren Konten waehlen Sie ueber das Dropdown oben das Konto, von dem gesendet werden soll. Hat das gewaehlte Konto mehr als eine **Identitaet** (alternative „From"-Adresse, etwa einen Alias im selben Gmail- oder Outlook-Konto), erscheint direkt unterhalb des Konto-Dropdowns ein Identitaetsauswahl-Dropdown, mit dem Sie auswaehlen koennen, von welcher Identitaet aus gesendet wird. Siehe [Identitaeten](../settings/identities) zum Verhalten von Identitaeten und Signaturen pro Identitaet.
- **An** -- Empfaengeradresse. Mehrere mit **Enter**, **Tab** oder **Komma**.
- **Cc / Bcc** -- Klicken Sie auf **Cc/Bcc**.
- **Betreff** und **Nachrichtentext**.

## Kontakt-Autovervollstaendigung

Vorschlaege basierend auf frueherer Korrespondenz.

## Anhaenge

**Anhaengen** klicken oder Dateien per Drag & Drop. Maximale Groesse: 25 MB pro Datei.

## Antworten und Weiterleiten

- **Antworten** (**r**), **Allen antworten** (**a**), **Weiterleiten** (**f**).

## Entwuerfe

Automatische Speicherung lokal und im IMAP-Entwuerfe-Ordner.

## Senden

Klicken Sie auf die Schaltfläche **Senden**, um Ihre Nachricht zu versenden. Das Fenster schließt sich sofort, während die Nachricht im Hintergrund gesendet wird. Bei einem Fehler (z.B. Verbindungsproblem) erhalten Sie eine Desktop-Benachrichtigung.

Wenn die Nachricht erfolgreich zugestellt wurde, aber MailCopilot keine Kopie im Ordner „Gesendet“ speichern konnte (z.B. wenn der IMAP-Server vorübergehend nicht verfügbar ist), erscheint eine Benachrichtigung: **Nachricht zugestellt, aber die Kopie konnte nicht im Ordner „Gesendet“ gespeichert werden**. Klicken Sie auf **Schließen**, um sie zu verwerfen. Die Nachricht wurde an den Empfänger zugestellt — nur die serverseitige Kopie im Ordner „Gesendet“ wurde nicht gespeichert.

## Senden und Archivieren {#send--archive}

Beim Antworten auf eine E-Mail enthält das Dropdown-Menü der **Senden**-Schaltfläche die Option **Senden und Archivieren**. Klicken Sie auf den kleinen Pfeil **▾** neben der Senden-Schaltfläche und wählen Sie **Senden und Archivieren**. Dies sendet Ihre Antwort und archiviert die ursprüngliche E-Mail automatisch in einem Schritt.

Dies ist besonders nützlich für einen Inbox-Zero-Workflow — antworten Sie und räumen Sie die E-Mail aus Ihrem Posteingang, ohne zusätzliche Klicks.

## Zeitgesteuerte Sendung

Sie können eine Nachricht für einen späteren Zeitpunkt planen:

1. Klicken Sie auf den kleinen Pfeil **▾** neben der Senden-Schaltfläche, um das Dropdown-Menü zu öffnen.
2. Wählen Sie einen vorgegebenen Zeitpunkt:
   - **Später heute** — die nächste halbe Stunde.
   - **Morgen früh (09:00)**.
   - **Montag früh (09:00)**.
   - **Datum und Uhrzeit wählen** — wählen Sie ein eigenes Datum und eine Uhrzeit.
3. Die Nachricht wird in die Warteschlange gestellt und automatisch zum geplanten Zeitpunkt gesendet.

Geplante Nachrichten erscheinen im **Postausgang**, wo Sie sie bearbeiten, umplanen, sofort senden oder stornieren können.

## Versandverzoegerung

Aktivieren Sie eine Verzoegerung (5, 10 oder 30 Sekunden) unter **Einstellungen > Produktivitaet**.

## Vorlagen verwenden

Mit Vorlagen koennen Sie vorgefertigte Nachrichten schnell in das Verfassen-Fenster einfuegen und so Zeit bei haeufig versendeten Nachrichten sparen.

### Vorlage anwenden

1. Oeffnen Sie das Verfassen-Fenster.
2. Klicken Sie auf die Schaltflaeche **Vorlagen** (Raster-Symbol) in der Symbolleiste.
3. Waehlen Sie eine Vorlage aus der Dropdown-Liste.
4. Betreff und Text der Vorlage werden in das Verfassen-Fenster eingefuegt.

### Vorlagen-Variablen

Vorlagen koennen Variablen enthalten, die beim Anwenden automatisch ersetzt werden:

- `{name}` -- der Name des Empfaengers (falls verfuegbar).
- `{email}` -- die E-Mail-Adresse des Empfaengers.
- `{date}` -- das heutige Datum.

Zum Beispiel wird in einem Vorlagentext wie "Liebe/r `{name}`, ..." die Variable `{name}` durch den tatsaechlichen Namen des Empfaengers ersetzt.

Vorlagen erstellen und verwalten Sie unter **Einstellungen > Vorlagen**. Weitere Details finden Sie auf der Seite [Vorlagen-Einstellungen](../settings/templates).

## Schnellaktionen beim Verfassen

Ueber dem Nachrichtentext wird eine kleine KI-Symbolleiste mit vier Schaltflaechen angezeigt: **Verbessern**, **Kuerzen**, **Foermlich** und **Grammatik korrigieren**. Klicken Sie auf eine davon, damit die KI Ihren aktuellen Entwurfstext umschreibt.

MailCopilot zeigt ein Panel „KI-Umformulierung pruefen" mit einem Vergleich Ihres Originaltexts (**Vorher**) und der Umformulierung der KI (**Nachher**). Waehlen Sie **Ersetzen**, um den gesamten Entwurf durch die Umformulierung zu ersetzen, **An Cursor einfuegen**, um sie an der aktuellen Cursorposition einzufuegen, oder **Abbrechen**, um die Umformulierung zu verwerfen und den Entwurf unveraendert zu lassen. Der Nachrichtentext wird nur geaendert, wenn Sie **Ersetzen** oder **An Cursor einfuegen** waehlen -- **Abbrechen** laesst den Entwurf unveraendert.

Schnellaktionen erfordern einen konfigurierten KI-Anbieter (siehe [KI-Assistent](../ai-assistant)) und Text im Nachrichtentext zum Umschreiben. Das vollstaendige Verhalten und die Datenschutzdetails finden Sie unter [Schnellaktionen beim Verfassen](../ai-assistant#schnellaktionen-beim-verfassen).

## Warnung bei falschen Empfängern

MailCopilot hilft Ihnen, versehentliches Senden von E-Mails an falsche Empfänger zu vermeiden. Vor dem Senden wird die Empfängerliste geprüft und in zwei Situationen eine Warnung angezeigt:

- **Externe Domain** -- wenn die Mehrheit der Empfänger eine gemeinsame Domain haben (z.B. @firma.com) und Sie jemanden von einer anderen, nicht vertrauenswürdigen Domain hinzugefügt haben, erscheint ein Bestätigungsdialog.
- **Neue Empfänger in einer Antwort** -- beim Antworten wird eine Warnung angezeigt, wenn Sie Empfänger hinzugefügt haben, die nicht Teil der ursprünglichen Konversation waren.

Sie können vertrauenswürdige Domains (die keine Warnungen auslösen sollen) unter **Einstellungen > Produktivität > Vertrauenswürdige Domains** hinzufügen.

## Signatur

Hat die aktive Identitaet (die Standardidentitaet, sofern Sie keine andere ausgewaehlt haben) eine Signatur unter **Einstellungen > Signaturen** oder **Einstellungen > Identities** konfiguriert, wird sie automatisch an neue Nachrichten angehaengt. Bei Antworten und Weiterleitungen wird die Signatur nicht hinzugefuegt.

## Follow-up-Erinnerungen

Follow-up-Erinnerungen helfen Ihnen, E-Mails zu verfolgen, die eine Antwort erfordern. Wenn Sie eine wichtige Nachricht senden und keine Antwort erhalten, erinnert MailCopilot Sie daran.

### Eine Erinnerung einrichten

1. Aktivieren Sie im Verfassen-Fenster das Kontrollkästchen **"Erinnern, wenn keine Antwort"** am unteren Rand.
2. Wählen Sie einen Erinnerungszeitraum: **2 Tage**, **3 Tage** oder **7 Tage**.
3. Senden Sie die Nachricht wie gewohnt.

Wenn innerhalb des gewählten Zeitraums keine Antwort eingeht, erhalten Sie eine Desktop-Benachrichtigung, die Sie an das Follow-up erinnert.

### Der Follow-up-Ordner

Ausstehende Follow-ups erscheinen im Ordner **Follow-ups** in der Seitenleiste (Uhr-Symbol mit Häkchen). Das Ordner-Badge zeigt die Anzahl der aktiven Erinnerungen.

Jedes Follow-up zeigt:
- Die Adresse des Empfängers.
- Den Betreff der ursprünglichen Nachricht.
- Wie lange die Erinnerung bereits fällig ist.

### Eine Erinnerung verwerfen

Wenn Sie eine Erinnerung nicht mehr benötigen (zum Beispiel, weil die Person außerhalb der E-Mail geantwortet hat), klicken Sie auf die Schaltfläche **Verwerfen** neben dem Follow-up, um es zu entfernen.
