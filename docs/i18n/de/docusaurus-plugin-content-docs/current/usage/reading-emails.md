---
sidebar_position: 2
title: E-Mails lesen
---

# E-Mails lesen

## Nachricht anzeigen

Klicken Sie auf eine Nachricht, um sie im Lesebereich zu oeffnen. Tastatur: **j**/**k** (naechste/vorherige), **o** oder **Enter** (oeffnen), **u** (zurueck).

## Empfänger-Kopfzeilen

Im Lesebereich werden die Felder **To**, **Cc** und (bei gesendeten Nachrichten) **Bcc** oberhalb des Nachrichtentexts angezeigt. Enthält ein Feld mehr als drei Adressen, klappt MailCopilot den Überlauf ein: Die ersten drei Namen werden inline angezeigt, gefolgt von einer Schaltfläche **+N mehr**, wobei N die Anzahl der ausgeblendeten Adressen ist.

Klicken Sie auf **+N mehr**, um die vollständige Empfängerliste in mehreren Zeilen einzublenden. Klicken Sie erneut auf die Schaltfläche, um zur Zusammenfassung zurückzukehren. Alternativ können Sie **Esc** drücken, während die Liste ausgeklappt ist, um sie einzuklappen.

Fahren Sie mit der Maus über einen Empfängernamen, um einen Tooltip mit der vollständigen Zeichenfolge `Name <email@host>` anzuzeigen. Tastaturbenutzer können mit Tab zu jedem Empfänger-Chip und zur Schaltfläche **+N mehr** navigieren; **Enter** oder **Leertaste** auf der Schaltfläche wechselt den ausgeklappten Zustand.

**Bcc-Datenschutz:** Die Bcc-Zeile wird nur für Nachrichten angezeigt, die Sie selbst gesendet haben. Bei empfangenen Nachrichten wird sie nie angezeigt, sodass die Bcc-Empfänger eingehender Nachrichten vertraulich bleiben.

## Externe Bilder

Standardmaessig blockiert. Klicken Sie auf **Bilder anzeigen** oder aktivieren Sie die Option in den Einstellungen.

## Zitierter Text

Wenn Sie eine Antwort oder eine weitergeleitete Nachricht erhalten, klappt MailCopilot den zitierten Verlauf automatisch zusammen, sodass Sie nur den neuen Inhalt sehen. Der zitierte Teil ist hinter einem **Zitierten Text anzeigen**-Steuerelement am Ende des Nachrichtentextes verborgen.

Klicken Sie auf **Zitierten Text anzeigen**, um den vollständigen Verlauf direkt in der Nachricht einzublenden. Das Einklappen von Zitaten gilt **nur für HTML-Nachrichten**: `<blockquote>`-Blöcke auf oberster und verschachtelter Ebene werden jeweils unabhängig voneinander mithilfe eines nativen `<details>`/`<summary>`-Elements eingeklappt — kein JavaScript ist erforderlich. MailCopilot erkennt außerdem Outlook-typische Attributionsmuster (`-----Original Message-----`, `On … wrote:`), wenn sie unmittelbar vor einem `<blockquote>`-Block stehen, und klappt diese Attributionszeilen zusammen mit dem zugehörigen zitierten Block ein.

Reine Textnachrichten stellen den zitierten Verlauf unverändert dar, ohne Einklapp-Funktion. Dies ist eine bekannte Einschränkung, die in einer zukünftigen Version behoben werden soll.

Enthält eine Nachricht keinen zitierten Text, wird das Steuerelement nicht angezeigt.

## Konversations-Threads

Wenn die Konversationsgruppierung aktiviert ist (Standard), werden zusammengehörige Nachrichten in Threads gruppiert. In der Nachrichtenliste erscheint neben dem Betreff eines Threads mit mehr als einer Nachricht ein `+N`-Abzeichen — das ist die Anzahl der zusätzlichen Nachrichten im Thread; der Tooltip zeigt die Gesamtzahl. Klicken Sie auf den Thread in der Nachrichtenliste, um ihn im Lesebereich zu öffnen.

### Thread-Ansicht — Kartenstapel

Threads mit zwei oder mehr Nachrichten werden als vertikaler Kartenstapel dargestellt. Standardmäßig sind die Karten **von neu nach alt** geordnet. Die neueste Nachricht — die zuletzt empfangene — ist die aktive ausgeklappte Karte; ältere Nachrichten sind darunter eingeklappt.

- **Eingeklappte Karten** zeigen Avatar, Absendername, smart-formatiertes Datum und einen kurzen Textausschnitt. Enthält die Nachricht keinen vorschaubaren Text, zeigt die Karte **„(keine Vorschau)"**.
- Klicken Sie auf eine beliebige eingeklappte Karte, um sie auszuklappen. Klicken Sie erneut auf eine ausgeklappte Karte, um sie einzuklappen. Pro Thread kann nur eine Karte gleichzeitig ausgeklappt sein: Das Öffnen einer anderen Nachricht schließt die zuvor geöffnete.

Threads mit einer einzelnen Nachricht sowie Konten mit deaktivierter Gruppierung verwenden weiterhin die einfache Einzelnachrichtenansicht — der Kartenstapel erscheint nur bei zwei oder mehr Nachrichten.

Deaktivierbar unter **Einstellungen > Produktivität > Nachrichten in Konversationen gruppieren**.

### Konversationsreihenfolge

Standardmäßig erscheint die neueste Nachricht oben im Kartenstapel, damit Sie die letzte Antwort sofort sehen — genau wie neue Nachrichten in Ihrem Posteingang erscheinen. Sie können die Reihenfolge unter **Einstellungen > Produktivität > Konversationsreihenfolge** ändern:

- **Neueste zuerst** (Standard) — die neueste Nachricht befindet sich oben; ältere Nachrichten sind darunter.
- **Älteste zuerst** — Nachrichten sind chronologisch von oben nach unten geordnet, die neueste Nachricht befindet sich am Ende des Stapels.

Die Einstellung gilt für alle Threads im Lesebereich und wird sofort beim Ändern wirksam.

### Thread-Aktionen

Beim Anzeigen eines Threads mit zwei oder mehr Nachrichten wechselt die einheitliche Symbolleiste am oberen Rand des Nachrichtenbetrachters in den Thread-Modus. Es handelt sich um dieselbe Symbolleiste wie bei Einzelnachrichten — ihre Schaltflächen passen sich der Thread-Semantik an:

- **Antworten** -- eine Antwort an den Absender der neuesten Nachricht im Thread verfassen.
- **Allen antworten** -- auf alle Empfänger der neuesten Nachricht antworten, ohne die primäre Adresse Ihres Kontos.
- **Weiterleiten** -- die neueste Nachricht des Threads an jemand anderen weiterleiten.
- **Thread archivieren** -- verschiebt den gesamten Thread in den Archiv-Ordner. Deaktiviert, wenn kein Archiv-Ordner konfiguriert ist.
- **Thread löschen** -- verschiebt den gesamten Thread in den Papierkorb, wenn das Konto über einen Papierkorb-Ordner verfügt. Befindet sich der Thread bereits im Papierkorb oder hat das Konto keinen Papierkorb-Ordner, fragt MailCopilot vor dem endgültigen Löschen nach einer Bestätigung.
- **Thread als gelesen markieren** -- markiert alle Nachrichten im Thread als gelesen. Diese Schaltfläche erscheint nur, wenn mindestens eine Nachricht im Thread ungelesen ist; sie wird ausgeblendet, wenn der gesamte Thread bereits gelesen ist.
- **Schlummern** -- blendet **den gesamten Thread** vorübergehend aus und holt alle Nachrichten zu einer gewählten Zeit zurück. Der Schlummer-Dialog wird an der neuesten Nachricht verankert, geschlummert werden jedoch alle Nachrichten des Threads zusammen. Dieselben Optionen wie beim Schlummern einzelner Nachrichten. Im Entwürfe-Ordner ausgeblendet.
- **Spam** -- im Thread-Modus öffnet sich ein Bestätigungsdialog mit der Frage, ob alle Nachrichten im Thread als Spam markiert werden sollen. Eine Spam-Markierung lässt sich schwerer rückgängig machen als eine Archivierung; der zusätzliche Bestätigungsdialog ist beabsichtigt.
- **Markieren, Anheften, Drucken, In Fenster öffnen, In Konto öffnen** -- diese Schaltflächen beziehen sich auf die aktuell aktive (aufgeklappte) Nachricht im Thread, nicht auf den gesamten Thread.

Antworten, Allen antworten und Weiterleiten beziehen sich auf die neueste Nachricht im Thread. Thread archivieren, Thread löschen, Thread als gelesen markieren und Schlummern gelten für alle Nachrichten im Thread auf einmal.

### KI-Thread-Zusammenfassung

Wenn Sie einen Thread mit **drei oder mehr Nachrichten** oeffnen und die KI-Thread-Zusammenfassung fuer das Konto aktiviert ist, erscheint ueber dem Kartenstapel eine einzeilige, von der KI erzeugte Zusammenfassung. Klicken Sie darauf, um fuenf Stichpunkte mit den wichtigsten Punkten des Gespraechs aufzuklappen. Klicken Sie erneut auf die Zusammenfassungszeile, um die Stichpunkte einzuklappen.

Die KI-Thread-Zusammenfassung ist **standardmaessig deaktiviert** und muss **pro Konto** unter **Einstellungen > KI > KI-Thread-Zusammenfassung** aktiviert werden. Siehe [KI-Assistent](../ai-assistant#ki-thread-zusammenfassung) fuer die Aktivierung und was dabei an Ihren KI-Anbieter gesendet wird.

Kuerzere Threads (weniger als drei Nachrichten) zeigen den Zusammenfassungsstreifen nie -- der Stapel ist klein genug, um ihn direkt zu lesen. Nur der von Ihnen aktiv geoeffnete Thread wird zusammengefasst; MailCopilot fasst niemals Threads im Hintergrund oder ueber Ihr gesamtes Postfach hinweg zusammen.

Sobald ein Thread zusammengefasst wurde, zeigt das erneute Oeffnen die zwischengespeicherte Zusammenfassung sofort an -- MailCopilot erzeugt sie nicht neu, solange sich die Nachrichten des Threads nicht aendern.

Wenn das taegliche KI-Budget erreicht wurde, kein KI-Anbieter konfiguriert ist (dazu zaehlt auch ein konfiguriertes **Claude-Abonnement**, das fuer die KI-Thread-Zusammenfassung nicht unterstuetzt wird) oder der Anbieter einen voruebergehenden Fehler zurueckgibt, zeigt der Streifen anstelle einer Zusammenfassung eine erklaerende Meldung. Eine Schaltflaeche **Erneut versuchen** erscheint, wenn der Fehlschlag ein voruebergehender Anbieterfehler war.

### Sofortantwort

Wenn die Sofortantwort fuer das Konto aktiviert ist, erscheint auf der aktiv geoeffneten Nachrichtenkarte eine Schaltflaeche **Sofortantwort**. Klicken Sie darauf, damit die KI zwei oder drei kurze Antwortoptionen auf Basis des Nachrichteninhalts entwirft.

Klicken Sie auf eine Option, um sie in einem **neuen Verfassen-Fenster** zu oeffnen, das mit diesem Text vorausgefuellt ist -- es wird nichts automatisch gesendet, Sie pruefen und senden die Nachricht weiterhin selbst.

Die Sofortantwort ist **standardmaessig deaktiviert** und muss **pro Konto** unter **Einstellungen > KI > Sofortantwort** aktiviert werden. Siehe [KI-Assistent](../ai-assistant#sofortantwort) fuer die Aktivierung und was dabei an Ihren KI-Anbieter gesendet wird.

## Anhaenge

Wenn die aktive Nachricht Anhänge enthält, erscheinen diese über dem Nachrichtentext. Fuer jeden Anhang werden angezeigt:

- Ein **Dateityp-Symbol**, das aus dem MIME-Typ gewaehlt wird, mit Rueckfall auf die Dateiendung, wenn der MIME-Typ fehlt, generisch (`application/octet-stream`) oder unbekannt ist: PDF, Bild, Archiv, Dokument, Tabellenkalkulation, Praesentation, Klartext, eingebettete `.eml`-Nachricht oder ein generisches Datei-Symbol, wenn nichts Spezifischeres greift.
- Der **Dateiname**.
- Die **Dateigroesse**.
- Ein **„Vorschau verfügbar"-Badge** bei Anhaengen, die MailCopilot als vorschaubar erkennt. Aktuell sind das PNG-, JPEG-, GIF-, WebP-Bilder und PDF-Dokumente -- das Badge erscheint nur bei diesen Typen und zeigt an, dass Vorschau-Unterstuetzung geplant ist; die primaere Aktion in der Zeile ist heute weiterhin die Download-Schaltflaeche.

Klicken Sie in der Anhangzeile auf die Download-Schaltflaeche, um die Datei auf Ihrem Computer zu speichern. Die Download-Schaltflaeche hat ein explizites barrierefreies Label, sodass Bildschirmleser die Aktion zusammen mit dem Dateinamen ansagen.

## Links

MailCopilot prueft Links auf Sicherheit: nicht uebereinstimmende Links, HTTP-Links und IDN-Domains.

## Aktionen

Antworten (**r**), Allen antworten (**a**), Weiterleiten (**f**), Markieren (**s**), Loeschen (**#**), Archivieren (**e**), Spam (**!**), Gelesen/Ungelesen (**Shift+I**/**Shift+U**), Verschieben (**v**), Schlummern -- Nachricht voruebergehend ausblenden und spaeter wieder anzeigen (siehe unten).
- **Anheften / Lösen** -- eine Nachricht oben in der Nachrichtenliste anheften. Angeheftete Nachrichten erscheinen immer zuerst, unabhängig von der Sortierung (Tastenkürzel: **p**).
- **In Fenster öffnen** -- die Nachricht in einem separaten eigenständigen Fenster öffnen, um sie neben anderen Inhalten zu lesen.
- **Drucken** -- die aktuelle E-Mail drucken (Tastenkürzel: **Ctrl+P**).

## In Fenster öffnen

Die Aktion **In Fenster öffnen** öffnet die aktuelle Nachricht in einem dedizierten eigenständigen Fenster. Dies ist nützlich, wenn Sie eine Nachricht lesen oder bearbeiten möchten, während das Hauptfenster frei bleibt, um andere Ordner zu durchsuchen.

Das eigenständige Fenster ist ein vollständig funktionsfähiger Arbeitsbereich. Es enthält oben eine vollständige Aktionsleiste mit allen erforderlichen Schaltflächen:

- **Antworten** -- eine Antwort an den Absender verfassen.
- **Allen antworten** -- allen Empfängern antworten.
- **Weiterleiten** -- die Nachricht an einen anderen Empfänger weiterleiten.
- **Archivieren** -- die Nachricht in den Archiv-Ordner verschieben. Die Schaltfläche ist deaktiviert, wenn für das Konto kein Archiv-Ordner konfiguriert ist.
- **Löschen** -- die Nachricht in den Papierkorb verschieben, wenn das Konto über einen Papierkorb-Ordner verfügt. Hat das Konto keinen Papierkorb-Ordner oder befindet sich die Nachricht bereits im Papierkorb, fragt MailCopilot vor dem endgültigen Löschen nach einer Bestätigung.
- **Markieren / Markierung aufheben** -- den Markierungsstatus der Nachricht umschalten.
- **Als gelesen / ungelesen markieren** -- den Lesestatus umschalten.
- **Drucken** -- den Nachrichteninhalt drucken.

Wenn Sie auf **Archivieren** klicken oder auf **Löschen** für eine Nachricht, die in den Papierkorb verschoben werden kann, zeigt das eigenständige Fenster für 3 Sekunden einen eingebetteten Widerrufshinweis, bevor MailCopilot die Verschiebung durchführt und das Fenster schließt. Klicken Sie auf **Rückgängig**, um den Vorgang abzubrechen — die Nachricht bleibt an ihrem Platz und das Fenster bleibt geöffnet. Solange der Widerrufshinweis sichtbar ist, sind die Schaltflächen **Archivieren** und **Löschen** deaktiviert; **Antworten**, **Allen antworten**, **Weiterleiten**, **Markieren / Markierung aufheben**, **Als gelesen / ungelesen markieren** und **Drucken** bleiben verfügbar.

Hat das Konto keinen Papierkorb-Ordner oder befindet sich die Nachricht bereits im Papierkorb, fragt **Löschen** vor der endgültigen Löschung nach einer Bestätigung — es erscheint kein Widerrufshinweis, und die Aktion ist nicht rückgängig zu machen.

Das eigenständige Fenster verwendet dieselben grundlegenden Schutzmaßnahmen wie der Haupt-Lesebereich: bereinigtes HTML in einem isolierten iframe ohne Skripte, gesperrte externe Bilder und Phishing-Warnungen für Links.

## Nachrichten schlummern lassen

Mit der Schlummern-Funktion koennen Sie eine Nachricht voruebergehend ausblenden und zu einem gewaehlten Zeitpunkt wieder erscheinen lassen.

### So funktioniert's

Klicken Sie mit der rechten Maustaste auf eine Nachricht in der Liste und waehlen Sie **Schlummern** im Kontextmenue.

### Schlummern-Optionen

Waehlen Sie einen voreingestellten Zeitpunkt oder legen Sie Datum und Uhrzeit individuell fest:

- **Spaeter heute** -- zur naechsten halben Stunde.
- **Morgen frueh (09:00)**.
- **Naechste Woche (Montag 09:00)**.
- **Benutzerdefiniert** -- beliebiges Datum und Uhrzeit in der Zukunft.

### Der Schlummern-Ordner

Schlummernde Nachrichten erscheinen im Ordner **Schlummern** in der Seitenleiste. Wenn der Zeitpunkt erreicht ist, wird die Nachricht wieder in ihrem urspruenglichen Ordner sichtbar und Sie erhalten eine Benachrichtigung.

Klicken Sie auf eine schlummernde Nachricht, um sie zu oeffnen und zu lesen, ohne das Schlummern abzubrechen. Um eine Nachricht vorzeitig aufzuwecken, klicken Sie auf die Schaltflaeche **Abbrechen** neben der Nachricht.

## Später lesen

Mit „Später lesen" können Sie E-Mails als Lesezeichen speichern — ideal für lange Newsletter, Referenzmaterial oder alles, wozu Sie später zurückkehren möchten.

### So fügen Sie „Später lesen" hinzu

- Klicken Sie mit der rechten Maustaste auf eine Nachricht und wählen Sie **Später lesen** aus dem Kontextmenü.
- Oder bitten Sie den KI-Assistenten, eine E-Mail zum späteren Lesen zu markieren.

### Der Ordner „Später lesen"

Markierte Nachrichten erscheinen im Ordner **Später lesen** in der Seitenleiste (Buchsymbol). Im Gegensatz zu zurückgestellten Nachrichten bleiben „Später lesen"-E-Mails in ihrem Originalordner sichtbar — der Ordner ist eine zusätzliche Ansicht, kein Filter.

Klicken Sie auf eine Nachricht im Ordner „Später lesen", um sie zu öffnen und zu lesen. Um eine Nachricht aus der Liste zu entfernen, klicken Sie auf die Schaltflaeche **Aus Liste entfernen** neben der Nachricht.

Den Ordner „Spaeter lesen" koennen Sie ueber die Seitenleiste oeffnen.

## Wenn eine Nachricht nicht geladen werden kann

Falls MailCopilot den Nachrichteninhalt nicht abrufen kann -- zum Beispiel weil die Verbindung zum IMAP-Server nach 10 Sekunden abgelaufen ist -- wird anstelle eines leeren Bildschirms ein Platzhalter angezeigt:

> „Nachrichteninhalt ist offline nicht verfuegbar. Nur Kopfzeilen sind zwischengespeichert."

Unterhalb der Nachricht erscheint eine Schaltflaeche **Wiederholen**. Klicken Sie darauf, um den Abruf des Inhalts erneut zu versuchen. Wenn die Verbindung wiederhergestellt wurde, wird die Nachricht normal geladen.

## Besprechungsanfragen

Wenn eine Nachricht eine Kalendereinladung enthält (ein `.ics`-Anhang nach dem iTIP-Protokoll), zeigt MailCopilot eine eingebettete Karte **Besprechungsanfrage** oberhalb des Nachrichtentexts an. Eine externe Kalender-App oder ein Cloud-Dienst ist nicht erforderlich.

Die Karte enthält:

- **Veranstaltungstitel** — die Kurzbezeichnung des Termins.
- **Wann** — Startdatum und Uhrzeit.
- **Organisator** — der in der Kalendereinladung aufgeführte Organisator (kann sich vom E-Mail-Absender unterscheiden, wenn die Einladung in Vertretung gesendet wurde).
- **Ort** — Besprechungsraum oder Konferenzlink, falls angegeben.

Unterhalb der Termindetails stehen drei Antwortschaltflächen bereit: **Annehmen**, **Vielleicht** und **Ablehnen**. Ein Klick auf eine dieser Schaltflächen sendet eine standardkonforme iTIP-Antwort-E-Mail an den Organisator über SMTP mit Ihren Kontoanmeldedaten. Die Karte wird anschließend aktualisiert und bestätigt Ihre Wahl (zum Beispiel „Sie haben die Einladung angenommen"). Kann die Antwort nicht gesendet werden, wird stattdessen eine Fehlermeldung angezeigt.

Die Schaltflächen Annehmen / Vielleicht / Ablehnen erscheinen nur bei aktiven Besprechungsanfragen (`METHOD:REQUEST`), bei denen der Organisator nicht Sie selbst sind. Absagen, Kalender-Feed-Veröffentlichungen, Antworten und selbst organisierte Veranstaltungen zeigen keine RSVP-Schaltflächen — stattdessen sehen Sie einen „Abgesagt"- oder „Nicht zu beantworten"-Hinweis.

### Einschränkungen in dieser Version

- **Keine Systemkalender-Integration.** MailCopilot fügt den Termin nicht zu Ihrem Betriebssystemkalender (macOS Kalender, GNOME Kalender usw.) hinzu. Dies ist für eine zukünftige Version geplant.
- **Wiederkehrende Termine.** Regelmäßige Besprechungen werden als einzelnes Ereignis angezeigt; das Wiederholungsmuster wird nicht dargestellt.
- **Gegenangebote.** Sie können keine andere Uhrzeit vorschlagen — nur Annehmen, Vielleicht oder Ablehnen stehen zur Verfügung.
- **Abgesagte Termine.** Hat der Organisator einen Termin abgesagt, zeigt die Karte „Diese Veranstaltung wurde abgesagt" und die Antwortschaltflächen werden ausgeblendet.

## Rueckgaengig

In Ordneransichten eines Kontos zeigt Archivieren, Als-Spam-markieren oder Verschieben in den Papierkorb eine Rueckgaengig-Leiste mit Countdown. Klicken Sie auf **Rueckgaengig**, bevor der Timer ablauft. Endgueltige Loeschvorgaenge und einige Aktionen im vereinheitlichten Posteingang oder kontouebergreifend zeigen keine Rueckgaengig-Leiste.
