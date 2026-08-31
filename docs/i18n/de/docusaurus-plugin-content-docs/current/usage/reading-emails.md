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

### Ungelesen-Status einer Thread-Zeile

Eine Thread-Zeile in der Nachrichtenliste wird als ungelesen (fett) angezeigt, sobald **irgendeine** in der Liste aktuell angezeigte Nachricht innerhalb des Threads ungelesen ist — nicht nur die neueste. So bleibt eine ungelesene Nachricht mitten in einer Konversation nie unsichtbar in der Liste, selbst wenn die neueste Nachricht desselben Threads bereits gelesen wurde.

Ein Klick auf einen ungelesenen Thread öffnet die **älteste ungelesene Nachricht** des Threads als aktive, erweiterte Karte. Sind bereits alle Nachrichten des Threads gelesen, öffnet ein Klick stattdessen die führende Nachricht des Threads — bei der standardmäßigen Sortierung nach Datum ist das die neueste Nachricht.

Das Öffnen einer Nachricht auf diese Weise markiert nicht den Rest des Threads als gelesen. Alle Nachrichten eines Threads als gelesen zu markieren, bleibt eine separate, ausdrückliche Aktion -- siehe **Thread als gelesen markieren** unter [Thread-Aktionen](#thread-aktionen) weiter unten.

### Thread-Ansicht — Kartenstapel

Threads mit zwei oder mehr Nachrichten werden als vertikaler Kartenstapel dargestellt. Standardmäßig sind die Karten **von neu nach alt** geordnet. Die aktive ausgeklappte Karte ist die Nachricht, die Sie geöffnet haben — die älteste ungelesene Nachricht, falls der Thread ungelesene Nachrichten enthält, andernfalls die führende Nachricht des Threads; die übrigen bleiben eingeklappt.

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
- **Thread löschen** -- wird pro Ordner entschieden: Jede Nachricht, die noch in den Papierkorb verschoben werden kann, wird sofort dorthin verschoben. Jede Nachricht, die bereits im Papierkorb liegt oder zu einem Konto ohne Papierkorb-Ordner gehört, wird stattdessen vor dem endgültigen Löschen durch einen Bestätigungsdialog abgedeckt. Ein Thread, der sich in einem einzigen Ordner befindet, nimmt also genau einen dieser beiden Wege — wie bisher; ein Thread, dessen Nachrichten sich über mehrere Ordner erstrecken (zum Beispiel eine Antwort, die bereits im Papierkorb liegt, während der Rest der Konversation es nicht ist), kann beide Wege gleichzeitig nehmen -- die verschiebbaren Nachrichten werden verschoben, und der Bestätigungsdialog deckt nur ab, was übrig bleibt.
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

Wenn das taegliche KI-Budget erreicht wurde, kein KI-Anbieter konfiguriert ist oder der Anbieter einen voruebergehenden Fehler zurueckgibt, zeigt der Streifen anstelle einer Zusammenfassung eine erklaerende Meldung. Eine Schaltflaeche **Erneut versuchen** erscheint, wenn der Fehlschlag ein voruebergehender Anbieterfehler war.

### Sofortantwort

Wenn die Sofortantwort fuer das Konto aktiviert ist, erscheint auf der aktiv geoeffneten Nachrichtenkarte eine Schaltflaeche **Sofortantwort**. Klicken Sie darauf, damit die KI zwei oder drei kurze Antwortoptionen auf Basis des Nachrichteninhalts entwirft.

Klicken Sie auf eine Option, um sie in einem **neuen Verfassen-Fenster** zu oeffnen, das mit diesem Text vorausgefuellt ist -- es wird nichts automatisch gesendet, Sie pruefen und senden die Nachricht weiterhin selbst.

Die Sofortantwort ist **standardmaessig deaktiviert** und muss **pro Konto** unter **Einstellungen > KI > Sofortantwort** aktiviert werden. Siehe [KI-Assistent](../ai-assistant#sofortantwort) fuer die Aktivierung und was dabei an Ihren KI-Anbieter gesendet wird.

## Nachrichtenübersetzung

MailCopilot kann die Nachricht, die Sie gerade lesen, in eine Sprache Ihrer Wahl übersetzen.

Die Nachrichtenübersetzung ist **standardmäßig deaktiviert** und muss **pro Konto** unter **Einstellungen > KI > KI-Übersetzung** aktiviert werden (aktivieren Sie „Übersetzen empfangener Nachrichten und eigener Entwürfe durch die KI erlauben"). Dieselbe Einstellung aktiviert auch die [Entwurfsübersetzung](../ai-assistant#entwurfsübersetzung) im Schreibfenster. Siehe [KI-Assistent](../ai-assistant#nachrichtenübersetzung) für die Aktivierung und was dabei an Ihren KI-Anbieter gesendet wird.

### Verwendung

Klicken Sie auf **Übersetzen** über dem Nachrichtentext und wählen Sie dann eine Zielsprache aus der Liste **Übersetzen nach**. MailCopilot ruft Ihren konfigurierten KI-Anbieter erst in diesem Moment auf -- es gibt keine automatische Übersetzung beim Öffnen einer Nachricht, sodass das Öffnen einer fremdsprachigen E-Mail für sich genommen nie Ihr KI-Budget verbraucht.

Sobald eine Übersetzung angezeigt wird, können Sie mit dem Umschalter **Original anzeigen** / **Übersetzung anzeigen** über dem Text jederzeit hin- und herwechseln. Die gespeicherte Nachricht selbst wird nie verändert -- die Übersetzung ist immer nur eine Ansicht darüber.

**HTML-Nachrichten werden anhand ihrer Textfassung übersetzt.** Die Übersetzung wird immer als reiner Text angezeigt, auch bei einer HTML-Nachricht -- Formatierung, Layout und eingebettete Bilder sind nicht Teil der Übersetzung. Eine Bildunterschrift über dem übersetzten Text weist ausdrücklich darauf hin: „Übersetzt wurde die Textfassung der Nachricht — Formatierung und Bilder sind daher nicht Teil der Übersetzung."

### Erkannte Ausgangssprache

Vor dem Übersetzen versucht MailCopilot, die Originalsprache der Nachricht auf Ihrem Gerät zu erkennen, und nennt sie, wenn das gelingt, in einer Bildunterschrift über der Übersetzung (zum Beispiel: „Maschinelle Übersetzung aus dem Englischen ins Deutsche. Das Original ist einen Klick entfernt."). Die Erkennung erfolgt lokal und dient nur als Beschriftung -- sie entscheidet nie, ob die Nachricht übersetzt werden kann.

Die Beschriftung lässt sich in beiden Fällen korrigieren, nicht nur wenn die Erkennung fehlschlägt. Kann die Sprache nicht mit ausreichender Sicherheit erkannt werden, übersetzt MailCopilot trotzdem und zeigt einfach keine Bildunterschrift an, sondern bietet eine Auswahl **Sprache dieser Nachricht** (Platzhalter: **Sprache auswählen**) an, damit Sie sie selbst benennen können. Wird eine Beschriftung angezeigt, nennt aber die falsche Sprache -- die lokale Erkennung kann eng verwandte Sprachen mit hoher Sicherheit verwechseln --, öffnet ein Link **Nicht die richtige Sprache?** daneben dieselbe Auswahl. In beiden Fällen ist die Sprachangabe optional und aktualisiert nur die Beschriftung der bereits angezeigten, zwischengespeicherten Übersetzung, ohne den Anbieter erneut aufzurufen.

### Übersetzungs-Cache

Die Übersetzung einer Nachricht in eine bestimmte Sprache wird lokal auf Ihrem Gerät zwischengespeichert, verknüpft mit dem Inhalt der Nachricht selbst, der Zielsprache und der Version des Übersetzungsvertrags (Anbieter, Modell und Prompt-Form), unter der sie entstanden ist -- das erneute Öffnen derselben Nachricht und die erneute Wahl derselben Sprache verwendet die zwischengespeicherte Übersetzung, statt den Anbieter erneut aufzurufen, und eine spätere Änderung daran, wie MailCopilot Übersetzungen erzeugt, wird unter einem neuen Schlüssel abgelegt, statt das Ergebnis eines älteren Vertrags als aktuell auszugeben. Der Cache hat weiterhin keine eigene Ablaufzeit -- an ihrer Stelle lässt das Limit unten Einträge veralten. Jedes Konto behält seine 500 neuesten Übersetzungen; wird dieses Limit erreicht, werden die ältesten Übersetzungen dieses Kontos entfernt, um Platz für neue zu schaffen. Das Entfernen eines Kontos löscht auch dessen zwischengespeicherte Übersetzungen.

### Wenn eine Übersetzung nicht verfügbar ist

MailCopilot nennt den genauen Grund, warum eine Übersetzung nicht erstellt werden konnte, statt einen allgemeinen Fehler anzuzeigen:

- Die Übersetzung ist für dieses Konto ausgeschaltet.
- Es ist noch kein KI-Anbieter eingerichtet.
- Der KI-Anbieter hat keine Übersetzung geliefert.
- Der Text der Nachricht ist noch nicht heruntergeladen.
- Die Nachricht ist zu lang, um sie in einem Durchgang zu übersetzen, und es gibt keine Möglichkeit, nur einen Teil davon zu übersetzen -- die gesamte Nachricht zählt für die Grenze, einschließlich einer eventuell darin zitierten früheren Korrespondenz.
- Das KI-Budget für diesen Zeitraum ist aufgebraucht.

## Anhaenge

Wenn die aktive Nachricht Anhänge enthält, erscheinen diese über dem Nachrichtentext. Fuer jeden Anhang werden angezeigt:

- Ein **Dateityp-Symbol**, das aus dem MIME-Typ gewaehlt wird, mit Rueckfall auf die Dateiendung, wenn der MIME-Typ fehlt, generisch (`application/octet-stream`) oder unbekannt ist: PDF, Bild, Archiv, Dokument, Tabellenkalkulation, Praesentation, Klartext, eingebettete `.eml`-Nachricht oder ein generisches Datei-Symbol, wenn nichts Spezifischeres greift.
- Der **Dateiname**.
- Die **Dateigroesse**.

Layout-Bilder, die der Nachrichtentext bereits eingebettet darstellt -- etwa ein Logo in einer HTML-Signatur -- werden nie aus der Liste entfernt. MailCopilot kann von ausserhalb des Browsers nicht zuverlaessig feststellen, ob ein bestimmter Teil tatsaechlich sichtbar auf dem Bildschirm gelandet ist -- das entscheiden Layout, CSS und die Auswahl in einem responsiven Bild --, deshalb wird nicht geraten: Echte Anhaenge (die Dateien, die der Absender tatsaechlich beigefuegt hat) werden zuerst aufgelistet, eingebettete Bilder aus dem Nachrichtentext werden ans Ende der Liste verschoben, hinter denselben Ausklapp-Umschalter, der weiter unten beschrieben ist.

Ein Ausklapp-Umschalter erscheint immer dann, wenn mehr angezeigt werden muesste, als eingeklappt Platz hat -- bei mehr als vier echten Anhaengen, oder wenn es zurueckgestellte eingebettete Bilder gibt, auch wenn es vier oder weniger echte Anhaenge sind. Klicken Sie auf **Mehr anzeigen (N)**, wobei N nur die gerade nicht sichtbaren Elemente zaehlt, um alles einzublenden, und auf **Weniger anzeigen**, um die Liste wieder einzuklappen.

Klicken Sie in der Anhangzeile auf die Download-Schaltflaeche, um die Datei auf Ihrem Computer zu speichern. Die Download-Schaltflaeche hat ein explizites barrierefreies Label, sodass Bildschirmleser die Aktion zusammen mit dem Dateinamen ansagen.

## Links

MailCopilot prueft Links auf Sicherheit: nicht uebereinstimmende Links, HTTP-Links und IDN-Domains.

### Rechtsklick auf einen Link

Rechtsklick auf einen Link im Nachrichtentext oeffnet ein kleines Kontextmenue mit:

- **Link im Browser öffnen** -- oeffnet den Link genauso wie ein Klick, einschliesslich der oben beschriebenen Sicherheitspruefungen (Warnungen bei abweichender Domain und bei HTTP, IDN/Punycode-Kennzeichnung). Dieser Eintrag erscheint nur im Hauptfenster und im eigenstaendigen Nachrichtenfenster (siehe [In Fenster öffnen](#in-fenster-öffnen)) -- in den Fenstern Einstellungen, Neue Nachricht oder Konto wird er nicht angeboten, da dort keine E-Mail-Links angezeigt werden.
- **Linkadresse kopieren** -- kopiert das tatsaechliche Linkziel in die Zwischenablage, nicht den sichtbaren Text, und niemals die interne Routing-Form, die MailCopilot zur Darstellung des Links verwendet. Bei einer Webadresse (`http:`/`https:`) mit einem internationalisierten Domainnamen wird die Adresse in ihrer Punycode-Form (ASCII) kopiert -- der Form, die Ihr Browser tatsaechlich verwendet -- statt in Unicode, damit eine kopierte Adresse keine aehnlich aussehende Domain hinter lesbaren Zeichen verbergen kann. Bei einer `mailto:`-Adresse wird eine internationalisierte Domain stattdessen prozentkodiert, da Mail-Clients sie nicht als Punycode-Host aufloesen. In einem Link eingebettete Zugangsdaten (`https://user:pass@host/…`) werden unveraendert kopiert, nicht entfernt -- wenn Sie einen solchen Link anderswo einfuegen, werden die Zugangsdaten mitkopiert.

Keiner der beiden Eintraege erscheint bei Links, die nicht mit `http:`, `https:` oder `mailto:` beginnen (zum Beispiel ein in eine Nachricht eingebetteter `javascript:`- oder `data:`-Link), oder bei einer Linkadresse mit mehr als 8192 Zeichen.

## Aktionen

Antworten (**r**), Allen antworten (**a**), Weiterleiten (**f**), Markieren (**s**), Loeschen (**#**), Archivieren (**e**), Spam (**!**), Gelesen/Ungelesen (**Shift+I**/**Shift+U**), Verschieben (**v**) -- Ziehen einer Nachricht auf einen Ordner in der Seitenleiste funktioniert genauso: Jede Nachricht wird aus ihrem eigenen Quellordner heraus verschoben, sodass das Ziehen aus einem Ergebnis der Suche **Alle Ordner** oder aus einer Konversation, deren Nachrichten sich in unterschiedlichen Ordnern befinden, jede Nachricht dorthin bewegt, wo sie sich tatsächlich befindet. Schlummern -- Nachricht voruebergehend ausblenden und spaeter wieder anzeigen (siehe unten).
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

## Sehr große Nachrichten

MailCopilot schützt sich vor pathologisch großen E-Mails, aber welcher Schutz genau greift, hängt davon ab, wie die Nachricht geöffnet wird.

**Das harte 100-MB-Limit schützt jedes vollständige Lesen einer Nachricht.** Immer wenn MailCopilot den rohen Inhalt einer Nachricht vollständig lesen muss -- egal ob Sie eine bereits auf Ihrem Gerät gespeicherte Kopie öffnen oder MailCopilot eine Nachricht vollständig herunterlädt, um sie offline verfügbar zu machen -- wird eine Nachricht über 100 MB (Rohgröße, wie auf dem Server gespeichert) gar nicht erst geparst. Das betrifft den Nachrichtentext, die Anhänge und jede eingebettete Kalendereinladung. Beim Öffnen einer solchen Nachricht erscheint eine Platzhalterkarte, die aus den verfügbaren Kopfzeilen-Angaben aufgebaut ist -- Absender, Betreff und Datum, soweit bekannt -- zusammen mit dem Hinweis, dass die Nachricht über dem 100-MB-Limit liegt, ohne genaue Größe; wurde der Download selbst mittendrin abgelehnt, stammen diese Angaben aus Ihrer bereits synchronisierten Nachrichtenliste statt aus der Nachricht selbst und können unvollständig sein. Es gibt bewusst keine Option „Trotzdem öffnen": Das ist ein Schutz vor Speicherüberlauf-Abstürzen und vor pathologischer oder bösartiger Post, keine Größe, der Sie im normalen Gebrauch begegnen sollten. Die meisten E-Mail-Anbieter für Privatkunden weisen Nachrichten ab etwa 20-50 MB bereits ab, bevor sie überhaupt in Ihrem Posteingang ankommen, sodass Sie dieses Limit äußerst selten erreichen sollten -- unmöglich ist es aber nicht: Manche geschäftlichen E-Mail-Systeme (zum Beispiel Microsoft 365 mit angehobenem Organisationslimit) lassen größere Nachrichten durch. Die Nachricht selbst bleibt auf dem Server unverändert -- Sie können sie in einem anderen E-Mail-Programm öffnen.

**Das „Nur Anfang angezeigt"-Limit von 1 MB gilt immer dann, wenn MailCopilot eine Nachricht über den vollständigen Lesepfad liest, der für den Offline-Zugriff verwendet wird.** Das schließt Nachrichten ein, die aus einer bereits auf Ihrem Gerät gespeicherten Kopie geöffnet werden, sowie das allererste Öffnen einer Nachricht in einem Ordner mit aktiviertem Offline-Zugriff, wenn MailCopilot die Nachricht vollständig herunterlädt, um sie anzuzeigen -- selbst wenn Ihre Cache-Größenbegrenzung anschließend verhindert, dass diese Kopie auf der Festplatte gespeichert wird. Das ist der normale Fall für Ihren Posteingang, der standardmäßig aktuelle Nachrichten offline verfügbar hält, sowie für jeden anderen Ordner, für den Sie den Offline-Zugriff aktiviert haben (**Einstellungen > Ordner**, siehe [Offline-Modus](../settings/folders-settings#offline-mode)). Ist bei diesen der decodierte Text größer als 1 MB, wird nur der Anfang angezeigt: Ein Banner unterhalb des Texts lautet „Es wird nur der Anfang dieser Nachricht angezeigt." Daneben erscheint die Schaltfläche **Vollständige Nachricht anzeigen**. Anhänge werden auch in der gekürzten Ansicht vollständig aufgelistet. Klicken Sie auf die Schaltfläche, um die Nachricht mit einer höheren, aber weiterhin endlichen Grenze (8 MB) neu zu lesen -- MailCopilot tut dies nur, wenn Sie ausdrücklich danach fragen. Reicht selbst die angehobene Grenze nicht aus, um die ganze Nachricht anzuzeigen, bleibt das Banner bestehen, aber die Schaltfläche wird durch einen Hinweis ersetzt, dass dies alles ist, was MailCopilot anzeigen kann.

**Nachrichten, die direkt vom Server geöffnet werden, sind von der obigen 1-MB-/8-MB-Grenze nicht betroffen.** Ordner, bei denen der Offline-Zugriff deaktiviert ist -- standardmäßig alle Ordner außer dem Posteingang -- rufen den Text einer Nachricht bei jedem Öffnen direkt vom Server ab, ohne die gesamte Nachricht vorher herunterzuladen und zu speichern. Dieser Abruf hat eigene, separate Größengrenzen für jeden abgerufenen Teil, die weit unter dem harten 100-MB-Limit liegen. Das Öffnen einer sehr großen Nachricht auf diese Weise zeigt weder die Platzhalterkarte noch das „Nur Anfang angezeigt"-Banner -- MailCopilot zeigt dann einfach möglicherweise weniger vom Inhalt einer sehr großen Nachricht, ohne dies anzuzeigen.

## Wenn eine Nachricht nicht geladen werden kann

Falls MailCopilot den Nachrichteninhalt nicht abrufen kann, wird anstelle eines leeren Bildschirms ein Platzhalter angezeigt. Dafuer gibt es drei unterschiedliche Gruende, und MailCopilot unterscheidet zwischen ihnen, statt in allen Faellen dieselbe Meldung anzuzeigen. Die Regel dahinter: Der Platzhalter nennt nur das, was MailCopilot tatsaechlich weiss, und keine Ursache, die er lediglich vermutet:

**Sie haben um Offline-Betrieb gebeten.** „Offline arbeiten" ist aktiviert, der Server wurde also gar nicht erst kontaktiert, und der Nachrichteninhalt wurde nie heruntergeladen -- nur seine Kopfzeilen liegen im lokalen Cache:

> „Der Nachrichteninhalt ist offline nicht verfügbar. Nur die Kopfzeilen sind zwischengespeichert."

**Die Anfrage hat die vorgesehene Zeit ueberschritten.** MailCopilot gibt dem Abruf des Nachrichteninhalts 10 Sekunden, bevor es aufgibt. Dieses Zeitbudget ist eine Stoppuhr, keine Diagnose: Es laeuft ab, ohne erfahren zu haben, warum der Abruf langsam war. Meist belegt Hintergrundarbeit -- die Synchronisierung anderer Ordner, die Indizierung von Nachrichteninhalten fuer die Suche -- im Moment des Oeffnens die Verbindung zum Mailserver, doch ein langsamer Server, eine schlechte Verbindung oder eine ungewoehnlich grosse Nachricht fuehren zu genau demselben Ergebnis. Die Nachricht existiert mit an Sicherheit grenzender Wahrscheinlichkeit auf dem Server -- MailCopilot hat es nur nicht rechtzeitig geschafft, sie abzurufen:

> „Die Nachricht wurde nicht innerhalb der vorgesehenen Zeit geladen. Das kann vorkommen, wenn Hintergrundarbeit die Verbindung belegt, wenn der Server langsam antwortet oder wenn die Nachricht sehr groß ist. Sie können es erneut versuchen."

**Das Laden ist fehlgeschlagen.** MailCopilot hat versucht, den Nachrichteninhalt zu laden, und ihn am Ende nicht erhalten. Das reicht von einer abgerissenen Netzwerkverbindung ueber ein Passwort, das der Server nicht mehr akzeptiert, bis zu einem unerwarteten Zertifikat oder einem Postfach, das es nicht mehr gibt -- und es umfasst ebenso das, was *nach* dem Eintreffen der Nachricht passiert, etwa ein voller Datentraeger beim Speichern in den lokalen Cache. MailCopilot raet bewusst nicht, welcher dieser Faelle vorliegt, denn der Platzhalter laege oefter falsch als richtig; aus demselben Grund gibt er nicht dem Mailserver die Schuld, der im Fall des vollen Datentraegers nichts falsch gemacht hat. Wo die Ursache *bekannt* ist, benennt sie diejenige Stelle der Oberflaeche, die sich ihrer sicher sein kann: der Hinweis **Erneut anmelden** ueber der Nachrichtenliste, wenn Ihre Anmeldedaten nicht mehr funktionieren, oder der Dialog zur Verbindungssicherheit, wenn dem Zertifikat des Servers nicht vertraut werden konnte.

> „MailCopilot konnte den Inhalt dieser Nachricht nicht laden — es werden nur ihre Kopfzeilen angezeigt. Sie können es erneut versuchen."

In allen drei Faellen erscheint unterhalb des Platzhalters eine Schaltflaeche **Erneut versuchen** -- im Hauptfenster ebenso wie in einem separaten Nachrichtenfenster. Klicken Sie darauf, um den Abruf des Inhalts erneut zu versuchen: Bei einem Zeitlimit-Fehler reicht meist ein zweiter Versuch, sobald die Hintergrundarbeit abgeschlossen ist. Ist der Offline-Betrieb aktiv oder sind Ihre Anmeldedaten abgelaufen, fuehrt ein erneuter Versuch weiterhin zum selben Platzhalter, bis Sie den Offline-Betrieb beenden oder sich neu anmelden.

## Besprechungsanfragen

Wenn eine Nachricht eine Kalendereinladung enthält (ein `.ics`-Anhang nach dem iTIP-Protokoll), zeigt MailCopilot eine eingebettete Karte **Besprechungsanfrage** oberhalb des Nachrichtentexts an. Eine externe Kalender-App oder ein Cloud-Dienst ist nicht erforderlich.

Die Karte enthält:

- **Veranstaltungstitel** — die Kurzbezeichnung des Termins.
- **Wann** — Startdatum und Uhrzeit. In den meisten Fällen wird die Zeit in die Zeitzone Ihres Geräts umgerechnet und dort angezeigt, unabhängig davon, in welcher Zeitzone der Organisator die Einladung gesendet hat; weicht die Zeitzone der Einladung von Ihrer eigenen ab, erscheint darunter ein Hinweis mit der ursprünglichen Zeitzone des Organisators, damit auf einen Blick erkennbar ist, dass eine Umrechnung stattgefunden hat. In zwei Fällen ist keine Umrechnung möglich, und in beiden wird die ursprüngliche Uhrzeit des Organisators unverändert angezeigt: wenn die Einladung eine Zeitzone angibt, die MailCopilot nicht auflösen kann (manche Outlook/Exchange-Einladungen verwenden statt eines Standardnamens einen Windows-Zeitzonennamen) — hier erscheint der Hinweis trotzdem und benennt die betreffende Zeitzone; und wenn die Einladung überhaupt keine Zeitzonenangabe und keinen expliziten UTC-Versatz enthält — hier gibt es nichts, was der Hinweis benennen könnte, sodass keiner erscheint und die angezeigte Uhrzeit schlicht die eigenen Zahlen des Organisators ohne jede Angabe der zugehörigen Zeitzone sind.
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

In Ordneransichten eines Kontos zeigt Archivieren, Als-Spam-markieren oder Verschieben in den Papierkorb eine Rückgängig-Leiste mit Countdown. Klicken Sie auf **Rückgängig**, bevor der Timer abläuft. Ausschlaggebend dafür ist, welche Nachrichten die Aktion tatsächlich verschiebt, nicht aus welchen Ordnern Ihre ursprüngliche Auswahl stammte: Nachrichten, die bereits im Zielordner liegen, oder Nachrichten eines Kontos ohne Ordner für diese Rolle, werden ausgeklammert und separat behandelt statt verschoben. Die Rückgängig-Leiste deckt immer nur einen einzigen Quellordner ab, sie erscheint daher nur, wenn alle tatsächlich verschobenen Nachrichten aus dem gerade geöffneten Ordner stammen. Ein Löschvorgang kann gemischt sein: Nachrichten, die in den Papierkorb wandern, erhalten eine Rückgängig-Leiste, wenn sie diese Bedingung erfüllen, während Nachrichten, die bereits im Papierkorb liegen, oder Nachrichten eines Kontos ohne Papierkorb-Ordner, endgültig gelöscht werden -- MailCopilot fragt vorher um Bestätigung und wartet auf Ihre Antwort, statt sofort zu handeln. Kontoübergreifende Aktionen und jede Aktion, deren verschobene Nachrichten sich weiterhin über mehr als einen Quellordner erstrecken -- zum Beispiel eine Sammelaktion auf einer Auswahl aus einer Suche **Alle Ordner** -- zeigen keine Rückgängig-Leiste: Dieser Teil der Aktion wird trotzdem sofort ausgeführt, Ordner für Ordner, er lässt sich nur nicht mehr in einem Schritt rückgängig machen.
