---
sidebar_position: 5
---

# Suche

MailCopilot bietet leistungsstarke Suchfunktionen, um jede E-Mail in allen Konten und Ordnern zu finden.

## Einfache Suche

Geben Sie Text in die Suchleiste oben in der E-Mail-Liste ein. Ergebnisse erscheinen sofort während der Eingabe.

## Suchbereich

Bei der Suche können Sie den Bereich über die Schaltflächen unter der Suchleiste auswählen:

- **Aktueller Ordner** — nur im aktuellen Ordner suchen.
- **Alle Ordner** — in allen Ordnern des aktuellen Kontos suchen.
- **Alle Konten** — in allen verbundenen Konten und Ordnern suchen.

## Suchoperatoren

Verwenden Sie Operatoren für präzise Suchen:

| Operator | Beschreibung | Beispiel |
|----------|-------------|---------|
| `from:` | Nach Absender | `from:alice@example.com` |
| `to:` | Nach Empfänger | `to:bob@example.com` |
| `subject:` | Nach Betreff | `subject:meeting` |
| `body:` | Nach Nachrichtentext | `body:rechnung` |
| `filename:` | Nach Anhangname | `filename:bericht.pdf` |
| `is:unread` | Ungelesene | `is:unread` |
| `is:starred` | Markierte | `is:starred` |
| `has:attachment` | Mit Anhängen | `has:attachment` |
| `before:` | Vor einem Datum | `before:2026-01-01` |
| `after:` | Nach einem Datum | `after:2025-12-01` |

Kombinieren Sie Operatoren mit freiem Text: `from:alice subject:bericht is:unread`.

Verwenden Sie `-` zum Ausschließen: `-from:spam@example.com`.

## Suchvollständigkeit

MailCopilot durchsucht Ihren lokalen E-Mail-Cache. Die Vollständigkeitsanzeige unter der Suchleiste zeigt:

- **Header-Abdeckung** — wie viele Ordner synchronisiert sind (z.B. „Header: 5/8 Ordner synchronisiert").
- **Volltextindexierung** — Prozentsatz der Nachrichten mit indexiertem Text für `body:`-Suchen.

Standardordner (Posteingang, Gesendet, Archiv, Entwürfe) werden standardmäßig vollständig indexiert. Junk-, Spam- und Papierkorb-Ordner sind standardmäßig von der Volltextindexierung ausgeschlossen, um Suchergebnisse sauber zu halten und Speicherplatz zu reduzieren. Sie können die Indexierungseinstellung für jeden Ordner über das Kontextmenü (Rechtsklick in der Seitenleiste) oder unter **Einstellungen > Ordner** ändern.

Eine Nachricht, die normal geöffnet wurde -- einschließlich einer Nachricht, deren Text durch das [weiche 1-MB-Limit](../usage/reading-emails#sehr-große-nachrichten) abgeschnitten wurde -- ist sofort mit `body:` durchsuchbar, wie jede andere Nachricht: Die ersten rund 200.000 Zeichen ihres Texts werden indexiert. Eine Nachricht über dem harten 100-MB-Limit (siehe denselben Abschnitt) ist anders: Da ihr Text beim Öffnen nie decodiert wurde, findet die `body:`-Suche sie erst, nachdem der Hintergrund-Textindexer sie vom Server abgerufen und indexiert hat -- das kann länger dauern als bei einer gewöhnlichen Nachricht.

## Serverunterstützte Suche

Bei der Suche in einem bestimmten Ordner kann MailCopilot auch den IMAP-Server abfragen. Serverergebnisse werden mit einem „+N vom Server"-Badge gekennzeichnet.

## Relevanzranking

Suchergebnisse werden nach Relevanz sortiert. Treffer im Betreff werden höher eingestuft als Treffer im Nachrichtentext.
