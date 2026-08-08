---
sidebar_position: 1
title: Oberflaeche
---

# Oberflaeche im Ueberblick

MailCopilot hat ein klares Drei-Spalten-Layout.

## Seitenleiste

Links: Kontoauswahl, Ordnerliste mit Ungelesen-Badges, Schreiben-, Sync- und Einstellungen-Buttons, vereinheitlichter Posteingang.

- **Offline arbeiten** — schaltet den Offline-Modus ein und aus. Im Offline-Modus stoppt MailCopilot alle Netzwerkaktivitäten und arbeitet ausschließlich mit zwischengespeicherten Daten. Sie können zuvor synchronisierte E-Mails lesen, als gelesen oder markiert kennzeichnen und Ordner durchsuchen. Offline vorgenommene Änderungen werden synchronisiert, sobald Sie wieder online sind. Das Schaltflächensymbol wechselt zwischen WLAN (online) und durchgestrichenem WLAN (offline).

**Inbox Zero** -- wenn Sie E-Mails bearbeiten (archivieren, löschen, zurückstellen, als Spam markieren oder in einen Ordner verschieben) und Ihr Posteingang leer wird, erscheint im Nachrichtenlistenbereich eine „Inbox Zero!"-Glückwunschnachricht zusammen mit der Anzahl der heute bearbeiteten E-Mails. Der Zähler wird automatisch um Mitternacht und beim Neustart der App zurückgesetzt.

Die Seitenleiste kann auf ein schmales Icon-Format reduziert werden. Eingeklappte Icons zeigen Tooltips.

## Nachrichtenliste

Mittlere Spalte: Absender, Betreff, Datum, Ungelesen-/Stern-/Anhangs-Indikatoren, Thread-Anzahl.

Im Modus **Vereinheitlichter Posteingang** wird die E-Mail-Adresse des Kontos neben dem Absendernamen angezeigt, damit Sie erkennen koennen, welches Konto die Nachricht erhalten hat.

Verwenden Sie die Filter-Schaltflaechen, um Ungelesene, Nachrichten mit Anhaengen oder Markierte anzuzeigen. Klicken Sie auf eine Schaltflaeche, um den Filter zu aktivieren, und erneut, um ihn zu deaktivieren. Eine andere Schaltflaeche zu waehlen ersetzt den aktiven Filter.

Um die Sortierreihenfolge zu aendern (Datum, Absender, Betreff), gehen Sie zu **Einstellungen > Produktivitaet > Sort emails by**.

### Kontextmenue fuer Nachrichten

Klicken Sie mit der rechten Maustaste auf eine Nachricht in der Liste, um das Kontextmenue zu oeffnen. Von hier aus koennen Sie schnell:

- Die Nachricht **zurueckstellen**
- **Archivieren**
- **Loeschen**
- **Als gelesen / ungelesen markieren**
- Weitere Aktionen: **Spaeter lesen**, **Anpinnen**, **In Ordner verschieben**, **Als Spam markieren**, **Antworten**, **Allen antworten**, **Weiterleiten**

Bei mehreren ausgewaehlten Nachrichten kann das Kontextmenue alle gleichzeitig als gelesen/ungelesen markieren, verschieben, als Spam markieren, archivieren oder loeschen. Spaeter lesen und Anpinnen gelten immer nur fuer die Nachricht, auf der das Menue geoeffnet wurde. Schlummern gilt fuer den gesamten Thread, wenn die Konversationsgruppierung aktiv ist, andernfalls nur fuer die einzelne Nachricht. Antworten, Allen antworten und Weiterleiten sind im Mehrfachauswahlmodus ausgeblendet.

### Nachrichten auswaehlen und Aktionsleiste

- Klicken Sie auf eine Nachricht, um sie auszuwaehlen und zu lesen.
- Halten Sie **Shift** und klicken Sie, um einen Bereich auszuwaehlen.
- Druecken Sie **x**, um die Auswahl umzuschalten.
- Eine Aktionsleiste ist immer ueber der Nachrichtenliste sichtbar. Wenn Sie eine oder mehrere Nachrichten auswaehlen, werden die Schaltflaechen aktiv: Gelesen/Ungelesen markieren, Als Spam markieren, Archivieren, Loeschen und Verschieben. Verschieben ist im vereinheitlichten Posteingang deaktiviert. Die Leiste funktioniert in allen anderen Ansichten.

## Lesebereich

Rechte Spalte: Kopfzeilen, Nachrichtentext, Anhaenge und Aktions-Buttons (Antworten, Weiterleiten, Loeschen, Archivieren, Schlummern usw.). Im Thread-Modus wird die Symbolleiste Thread-sensitiv: Antworten/Weiterleiten richten sich an die neueste Nachricht, Archivieren und Loeschen wirken auf den gesamten Thread. Siehe [E-Mails lesen](./reading-emails#thread-aktionen) fuer Details.

## Groessenanpassung

Ziehen Sie die Spaltengrenze, um die Breite anzupassen.

## Textauswahl und Bearbeitung

Rechtsklick in ein beliebiges Textfeld -- die Suchleiste, eine Nachricht, die Sie gerade verfassen, das Eingabefeld des KI-Assistenten oder jedes andere bearbeitbare Feld -- oeffnet ein kleines Kontextmenue mit **Ausschneiden**, **Kopieren**, **Einfügen** und **Alles auswählen**. Rechtsklick auf ausgewaehlten, nicht bearbeitbaren Text (zum Beispiel eine markierte Passage im Nachrichtentext) bietet nur **Kopieren** an.

Rechtsklick auf einen Link im Nachrichtentext oeffnet ein anderes Menue mit Optionen zum Oeffnen oder Kopieren des Links; siehe [Rechtsklick auf einen Link](./reading-emails#rechtsklick-auf-einen-link).

## Statusleiste

Eine dauerhaft sichtbare Statusleiste verlaeuft am unteren Rand des Fensters, aehnlich der von VS Code. Sie zeigt Hintergrundaktivitaeten, die zuvor nur im Suchpanel sichtbar waren:

- **Synchronisations-Indikator** -- erscheint, wenn ein Ordner gerade mit dem IMAP-Server synchronisiert wird, samt Konto, Ordnername, aktueller Nachrichtenanzahl und gegebenenfalls Prozentanteil.
- **Header-Abdeckung** -- wie viele Ordner ihre initiale Header-Synchronisation abgeschlossen haben (zum Beispiel „Header: 5/8 Ordner").
- **Fortschritt der Body-Indizierung** -- der Prozentsatz der zwischengespeicherten Nachrichten, deren Inhalt fuer die Volltextsuche indiziert wurde.
- **Badge fuer entfernte Ergebnisse** -- wenn eine Suche zusaetzliche Treffer vom Server jenseits des lokalen Caches liefert, erscheint hier ein Badge „+N vom Server".

Die Statusleiste bleibt sichtbar, solange Synchronisations- oder Indizierungsarbeit laeuft, nicht nur waehrend einer Suche. Gibt es nichts zu melden, klappt sie automatisch ein. Der Inhalt aktualisiert sich im Hintergrund etwa alle 30 Sekunden. Beim Drucken wird die Leiste ausgeblendet.

## Benachrichtigungszentrale

Ein Glockensymbol im Header der Nachrichtenliste oeffnet die Benachrichtigungszentrale. Sie buendelt zwei Arten von Benachrichtigungen:

- **Follow-up-Erinnerungen** -- wenn ein Follow-up, das Sie auf eine gesendete Nachricht gesetzt haben, faellig wird (siehe [E-Mails verfassen](./composing-emails) fuer Details).
- **Sendefehler** -- wenn eine Nachricht in der Sendeschlange nach dauerhaften Zustellfehlern (SMTP oder, bei Outlook-Konten, Microsoft Graph) aufgibt.

Die Glocke zeigt ein kleines Badge mit der Zahl neuer Benachrichtigungen. Klicken Sie auf die Glocke, um das Dropdown-Panel zu oeffnen: dort koennen Sie jede Benachrichtigung lesen, sie als gelesen markieren, alle auf einmal als gelesen markieren oder einzelne Eintraege loeschen. Benachrichtigungen werden lokal im SQLite-Cache gespeichert und ueberleben App-Neustarts; Eintraege aelter als 30 Tage werden automatisch entfernt.

Sind Betriebssystem-Benachrichtigungen erlaubt, loesen dieselben Ereignisse zusaetzlich eine native Desktop-Benachrichtigung aus.

## Einzelfenster

MailCopilot erzwingt eine einzige laufende Instanz pro Benutzer. Wenn Sie die Anwendung ein zweites Mal starten -- etwa durch Klick auf einen `mailto:`-Link oder eine andere Desktop-Verknuepfung -- wird das bestehende Fenster in den Vordergrund gebracht und fokussiert, statt ein doppeltes Fenster zu oeffnen. So vermeiden Sie zwei parallele Kopien, die um dieselben IMAP-Verbindungen und denselben lokalen Cache konkurrieren.

## `mailto:`-Links und Standard-E-Mail-Client

Sie koennen MailCopilot als System-Handler fuer `mailto:`-Links registrieren, sodass ein Klick auf einen „E-Mail senden"-Link in Ihrem Browser, Terminal oder einer anderen Anwendung das Verfassen-Fenster von MailCopilot mit bereits ausgefuelltem Empfaenger und weiteren Parametern oeffnet.

Der Schalter zur Registrierung von MailCopilot als Standard-E-Mail-Anwendung befindet sich in **Einstellungen > Allgemein**. Unterstuetzte `mailto:`-Parameter sind `to`, `cc`, `bcc`, `subject` und `body`.

## Offline arbeiten

Die Schaltflaeche „Offline arbeiten" in der Seitenleiste (WLAN-Symbol, durchgestrichen im Offline-Modus) schaltet den Offline-Modus um. Im Offline-Modus:

- Saemtliche Netzwerkaktivitaet stoppt -- es werden keine IMAP- oder SMTP-Verbindungen geoeffnet.
- Sie koennen weiterhin bereits synchronisierte Nachrichten lesen, Ordner durchsuchen, Nachrichten als gelesen oder mit Stern markieren und so weiter.
- Ausgehende Nachrichten werden in den Postausgang eingereiht und automatisch gesendet, sobald Sie wieder online sind.
- Verschiebe- und Loeschoperationen erzeugen lokale Platzhalter, sodass die Nachricht den Quellordner sofort visuell verlaesst, statt bis zur Wiederverbindung sichtbar zu bleiben. Das tatsaechliche serverseitige Verschieben wird nach der Wiederherstellung der Verbindung abgespielt, und der lokale Platzhalter wird mit dem Server-Ergebnis abgeglichen.
- Das pro Ordner einstellbare Offline-Verhalten (ob Body-Inhalte fuer das Offline-Lesen heruntergeladen werden und fuer welchen Zeitraum) konfigurieren Sie in **Einstellungen > Ordner**; siehe [Ordner-Einstellungen](../settings/folders-settings).

## Helles und dunkles Theme

Wechseln Sie unter **Einstellungen > Allgemein > Theme**.
