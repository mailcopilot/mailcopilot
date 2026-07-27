---
sidebar_position: 2
title: Produktivitaet
---

# Produktivitaets-Einstellungen

Desktop-Benachrichtigungen, IMAP IDLE, Sync-Intervall (1–30 Min), Entwuerfe-Synchronisierung, externe Bilder immer laden, Absenderfotos (Gravatar), Sortierreihenfolge, Konversationsgruppierung, Tastaturkuerzel-Preset (Gmail/Outlook), Versandverzoegerung und Offline-Modus.

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
