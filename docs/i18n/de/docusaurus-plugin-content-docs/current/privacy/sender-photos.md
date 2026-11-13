---
sidebar_position: 3
title: Absenderfotos (Gravatar)
---

# Absenderfotos (Gravatar)

Die Option **Absenderfotos anzeigen (Gravatar)** ist auf neuen Installationen aus. Solange sie aus ist, sendet MailCopilot keine Anfrage an gravatar.com.

Eine von einer Version vor 1.27.2 aktualisierte Installation behält die gespeicherte Einstellung. Ältere Versionen schalteten die Option standardmäßig ein und schrieben diesen Wert in die Einstellungen, deshalb ist sie bei den meisten bestehenden Installationen an. Wenn Sie das nicht möchten, schalten Sie sie wie unten beschrieben aus.

## Was bei aktivierter Option gesendet wird

Für jede in der Nachrichtenliste angezeigte Absenderadresse fragt die App bei `www.gravatar.com` ein Foto an. Die Anfrage geht direkt von Ihrem Computer an Gravatar. Kein Server von MailCopilot ist beteiligt, und sie läuft nicht über den Proxy für externe Bilder in Nachrichten.

Gravatar erhält:

- den SHA-256-Hash der Absenderadresse (ohne Leerzeichen, in Kleinbuchstaben). Wer eine Adresse kennt, kann ihren Hash berechnen und der Anfrage zuordnen;
- Ihre IP-Adresse und den Zeitpunkt der Anfrage;
- die üblichen Header einer Browseranfrage, darunter einen User-Agent mit Name und Version der Anwendung.

Die Anfrage enthält keinen Referer-Header. Nachrichtentext und Betreff erhält Gravatar nicht. Adressen Ihrer eigenen Konten und Identitäten werden in der Nachrichtenliste übersprungen, ihre Hashes werden von dort nicht gesendet.

Die App merkt sich im Arbeitsspeicher, welche Absender kein Foto haben. Von Gravatar gelieferte Fotos werden außerdem im HTTP-Cache von Chromium im Datenordner der Anwendung auf Ihrer Festplatte gespeichert, wie jedes Bild, das die Anwendung lädt. Das Ausschalten der Option leert diesen Cache nicht.

## Wo Sie die Option ändern

Einstellungen > Produktivität > **Absenderfotos anzeigen (Gravatar)**.

## Avatar des eigenen Kontos

Der Avatar-Modus **Gravatar** für ein Konto (Einstellungen > Konten) ist eine eigene Wahl. Wenn Sie ihn auswählen, wird dieselbe Art von Anfrage für die Adresse dieses Kontos gesendet. Andere Modi senden keine Anfrage.
