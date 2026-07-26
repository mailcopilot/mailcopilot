---
sidebar_position: 5
title: Vorlagen
---

# Vorlagen

Im Reiter Vorlagen in den Einstellungen koennen Sie wiederverwendbare Nachrichtenvorlagen erstellen, bearbeiten und loeschen.

## Vorlage erstellen

1. Gehen Sie zu **Einstellungen > Vorlagen**.
2. Klicken Sie auf **Vorlage hinzufuegen**.
3. Fuellen Sie die Felder aus:
   - **Name** -- ein kurzer Name zur Identifizierung der Vorlage (z. B. "Schnelle Nachfrage").
   - **Betreff** -- die Betreffzeile der E-Mail, z. B. `Re: {subject}` (optional).
   - **Text** -- der Nachrichtentext, z. B. `Hallo {name}, danke fuer Ihre Nachricht…`
   - **Kuerzel** -- ein optionales Stichwort, um die Vorlage schnell zu finden.
4. Klicken Sie auf **Speichern**.

## Vorlage bearbeiten

Klicken Sie auf das **Stift-Symbol** neben einer Vorlage, um sie zu bearbeiten. Klicken Sie nach den Aenderungen auf **Speichern**, um die Vorlage zu aktualisieren.

## Vorlage loeschen

Klicken Sie auf das **Papierkorb-Symbol** neben einer Vorlage, um sie zu loeschen. Geloeschte Vorlagen koennen nicht wiederhergestellt werden.

## Vorlagen-Variablen

Sie koennen Variablen im Betreff und Text Ihrer Vorlage verwenden. Diese Variablen werden automatisch ersetzt, wenn Sie die Vorlage im Verfassen-Fenster anwenden:

| Variable | Ersetzt durch |
|----------|---------------|
| `{name}` | Den Namen des Empfaengers |
| `{email}` | Die E-Mail-Adresse des Empfaengers |
| `{date}` | Das heutige Datum |

### Beispiel

**Vorlagentext:**
```
Liebe/r {name},

vielen Dank fuer Ihre E-Mail. Ich werde sie pruefen und mich in Kuerze bei Ihnen melden.

Mit freundlichen Gruessen
```

Wenn die Vorlage auf eine Nachricht an "Alice Schmidt" angewendet wird, wird die Variable `{name}` durch "Alice Schmidt" ersetzt.

## Vorlagen verwenden

Um eine Vorlage beim Verfassen einer Nachricht zu verwenden, siehe [E-Mails verfassen > Vorlagen verwenden](../usage/composing-emails#vorlagen-verwenden).
