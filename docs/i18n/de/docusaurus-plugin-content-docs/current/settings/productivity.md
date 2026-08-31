---
sidebar_position: 2
title: Produktivitaet
---

# Produktivitaets-Einstellungen

Desktop-Benachrichtigungen, IMAP IDLE, Sync-Intervall (1–30 Min), Entwuerfe-Synchronisierung, externe Bilder immer laden, Absenderfotos (Gravatar), Sortierreihenfolge, Konversationsgruppierung, Tastaturkuerzel-Preset (Gmail/Outlook), Versandverzoegerung und Offline-Modus.

## Desktop-Benachrichtigungen

Aktivieren oder deaktivieren Sie Desktop-Benachrichtigungen für neu eingehende Post. Wenn aktiviert, benachrichtigt Sie MailCopilot über neue Post, die in einem Ordner eintrifft, der zum [Symbol für ungelesene Nachrichten](general#symbol-für-ungelesene-nachrichten) zählt -- standardmäßig Ihr Posteingang, plus jeder Ordner, den Sie ausdrücklich in das Abzeichen einbezogen haben -- und nur, wenn dieser Ordner auf vollständige oder periodische Kopfzeilen-Synchronisierung eingestellt ist. Darüber hinaus überspringt MailCopilot standardmäßig einen festen Satz von Ordnern -- Papierkorb, Spam, Archiv und Entwürfe -- selbst wenn Sie einen davon ausdrücklich in das Abzeichen einbezogen haben; dies schränkt Benachrichtigungen weiter ein und erweitert sie niemals über die Abzeichen-Regel hinaus. Ordner, die vom Abzeichen ausgeschlossen sind, oder die nur auf Abruf synchronisiert werden, erzeugen niemals eine Benachrichtigung, selbst wenn dort neue Post eintrifft.

Solange das MailCopilot-Fenster im Vordergrund ist, wird für neue Post keine Benachrichtigung angezeigt: Das Abzeichen und die Nachrichtenliste werden wie gewohnt aktualisiert, aber das Eintreffen wird nicht durch eine Benachrichtigung unterbrochen, da Sie die App bereits betrachten. Treffen mehrere Nachrichten innerhalb eines kurzen Zeitfensters ein, während die App im Hintergrund läuft, zeigt MailCopilot eine einzige Benachrichtigung pro Konto (zum Beispiel „5 neue Nachrichten“) statt einer je Nachricht -- treffen bei zwei Konten gleichzeitig neue Nachrichten ein, erhalten Sie trotzdem zwei getrennte Benachrichtigungen; ein Klick auf eine Benachrichtigung öffnet die betreffende Nachricht. Bei unsignierten macOS-Builds lässt das Betriebssystem Benachrichtigungen unter Umständen überhaupt nicht zu.

## Offline-Modus

Laden Sie Nachrichten herunter, um sie ohne Internetverbindung zu lesen. Der Offline-Modus wird **pro Ordner** im Tab [Ordner](folders-settings#offline-mode) konfiguriert — Sie koennen ihn fuer Posteingang, Gesendet oder jeden anderen Ordner einzeln aktivieren.

Der Tab Produktivitaet enthaelt nur das globale Groessenlimit:

- **Maximale Nachrichtengroesse** — Nachrichten ueberspringen, die groesser als diese Groesse sind (0 = kein Limit, in KB).
- **Jetzt synchronisieren** — eine Offline-Synchronisierung fuer alle aktivierten Ordner manuell ausloesen.

Wenn Sie eine Nachricht offline oeffnen, zeigt MailCopilot die zwischengespeicherten Kopfzeilen (Betreff, Absender, Datum) und einen Hinweis an, dass der Nachrichtentext nicht verfuegbar ist. Sobald Sie wieder verbunden sind, wird die vollstaendige Nachricht normal geladen.

## Sortierreihenfolge

Waehlen Sie die Sortierreihenfolge der Nachrichtenliste:

- **Nach Datum** (Standard) -- neueste Nachrichten zuerst.
- **Nach Absender** -- alphabetisch nach Absendername.
- **Nach Betreff** -- alphabetisch nach Betreffzeile.

## Automatisches Weiterschalten

Waehlen Sie, was nach dem Archivieren, Loeschen oder Zurueckstellen einer Nachricht passiert:

- **Aeltere E-Mail oeffnen** (Standard) -- oeffnet automatisch die naechste aeltere Nachricht.
- **Neuere E-Mail oeffnen** -- oeffnet die naechste neuere Nachricht.
- **Zurueck zur Liste** -- schliesst die Nachrichtendetails und kehrt zur Liste zurueck.
- **Bleiben (nichts tun)** -- behaelt die aktuelle Ansicht ohne aktive Nachricht.

Besonders nuetzlich in Kombination mit [Senden und archivieren](../usage/composing-emails#send--archive) fuer einen Inbox-Zero-Workflow.

## Absenderfotos (Gravatar)

Wenn aktiviert (Standard), zeigt MailCopilot Profilfotos neben den Absendernamen in der Nachrichtenliste an. Fotos werden von [Gravatar](https://gravatar.com) geladen. Hat ein Absender kein Gravatar-Profil, wird stattdessen ein farbiger Kreis mit Initialen angezeigt.

Deaktivieren Sie diese Option, wenn Sie nur Initialen-Avatare bevorzugen oder Netzwerkanfragen beim Durchsuchen Ihres Posteingangs vermeiden moechten.

## Dunkelmodus für E-Mail-Inhalte

Im dunklen Thema können HTML-E-Mail-Inhalte schwer lesbar sein, da viele E-Mails für einen weißen Hintergrund gestaltet sind. Aktivieren Sie diese Option (standardmäßig aktiviert), um die Farben des E-Mail-Inhalts im Dunkelmodus automatisch zu invertieren und so ein angenehmes Lesen zu ermöglichen.

Bilder, Videos und andere Medien behalten ihre Originalfarben bei — nur Text und Hintergrund werden invertiert.
