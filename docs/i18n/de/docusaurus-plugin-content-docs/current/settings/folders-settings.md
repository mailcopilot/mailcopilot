---
sidebar_position: 4
title: Ordner-Einstellungen
---

# Ordner-Einstellungen

Öffnen Sie **Einstellungen > Ordner**, um zu konfigurieren, wie MailCopilot mit Ihren E-Mail-Ordnern umgeht.

## Rollenzuordnung der Ordner

MailCopilot muss wissen, welcher Serverordner welcher speziellen Rolle entspricht (Archiv, Papierkorb, Gesendet, Entwürfe, Spam). Die Erkennung erfolgt automatisch anhand der Standard-IMAP-Attribute, Sie können die Zuordnung aber auch manuell anpassen.

Für jede Rolle können Sie:
- **Auto** beibehalten, um den automatisch erkannten Ordner zu verwenden.
- Einen bestimmten Ordner aus der Dropdown-Liste auswählen.
- Auf **Erstellen** klicken, um den Standardordner auf dem Server anzulegen, falls er nicht vorhanden ist.

## Synchronisierungsrichtlinie für Ordner

Unter der Rollenzuordnung finden Sie eine detaillierte Konfiguration für jeden Ordner Ihres Kontos:

### Sichtbarkeit

- **In der Seitenleiste anzeigen** -- legt fest, ob der Ordner in der Seitenleiste erscheint. Deaktivieren Sie diese Option, um selten genutzte Ordner auszublenden.

### Ungelesen-Badges

- **In Ungelesen-Badges einbeziehen** -- legt fest, ob die Anzahl ungelesener Nachrichten dieses Ordners im Gesamt-Badge der Anwendung berücksichtigt wird.

### Suchindexierung

- **In Suche einbeziehen** -- legt fest, ob Nachrichteninhalte dieses Ordners für die Volltextsuche indexiert werden. Wenn deaktiviert, ist der Ordner weiterhin in der Nachrichtenliste sichtbar und seine Kopfzeilen sind durchsuchbar, aber `body:`-Abfragen liefern keine Ergebnisse aus diesem Ordner.

Junk-, Spam- und Papierkorb-Ordner haben die Suchindexierung standardmäßig deaktiviert, um Suchergebnisse sauber zu halten und den Speicherplatz zu reduzieren. Bei Bedarf können Sie die Indexierung für jeden Ordner aktivieren.

### Synchronisierungsmodus für Kopfzeilen

Steuert, wie Nachrichtenkopfzeilen für den Ordner synchronisiert werden:

- **Alle Nachrichten** -- alle Kopfzeilen synchronisieren (empfohlen für den Posteingang).
- **Beim Öffnen** -- Kopfzeilen erst synchronisieren, wenn Sie den Ordner aufrufen.
- **Nach Zeitraum** -- Kopfzeilen nur für die letzten N Tage synchronisieren.

Um die Synchronisierung eines Ordners vollständig zu deaktivieren, blenden Sie ihn über **Aus der Seitenleiste ausblenden** im Ordner-Kontextmenü aus. Ausgeblendete Ordner werden vollständig von der Kopfzeilen-Synchronisierung, dem Offline-Speicher und den Badges ausgeschlossen.

### Offline-Modus {#offline-mode}

Steuert, ob Nachrichteninhalte zum Offline-Lesen heruntergeladen werden:

- **Deaktiviert** -- keine Nachrichteninhalte herunterladen.
- **Nach Zeitraum** -- Nachrichteninhalte der letzten N Tage herunterladen.
- **Alle Nachrichten** -- alle Nachrichteninhalte herunterladen.

## Kontoauswahl

Wenn Sie mehrere Konten haben, verwenden Sie die Kontoauswahl oben, um zwischen den Konten zu wechseln und die Ordner für jedes Konto einzeln zu konfigurieren.
