---
sidebar_position: 3
title: Signaturen
---

# Signaturen

## Signatur einrichten

Konfigurieren Sie Ihre Signatur unter **Einstellungen > Signatur**. Die Registerkarte „Signaturen" bearbeitet die Signatur der **Standardidentität** des aktuell gewählten Kontos. Bei mehreren Konten wählen Sie das Konto im Dropdown oben; hat das Konto zusätzliche Identitäten (alternative „From"-Adressen), besitzt jede ihre eigene Signatur — diese werden unter **Einstellungen > Identities** bearbeitet.

## Signatur verfassen

Geben Sie Ihren Signaturtext in das Textfeld ein. Ein gängiges Format:

```
--
Max Mustermann
Software-Entwickler
Beispiel GmbH
max.mustermann@example.com
```

Der Trenner `--` ist der Standard-Trenner für E-Mail-Signaturen, der von den meisten Mail-Clients erkannt wird.

## So funktionieren Signaturen

- Ihre Signatur wird **automatisch** an neue Nachrichten angehängt, wenn Sie das Verfassen-Fenster öffnen.
- An Antworten und Weiterleitungen werden Signaturen **nicht** angehängt, um Duplikate zu vermeiden.
- Wenn Sie einen Entwurf bearbeiten, der bereits eine Signatur enthält, bleibt die vorhandene Signatur erhalten.
- Die Standardidentität jedes Kontos kann ihre eigene Signatur haben; zusätzliche Identitäten haben ebenfalls jeweils eine eigene Signatur, die unter **Einstellungen > Identities** bearbeitet wird.

## Signatur entfernen

Um eine Signatur zu entfernen, leeren Sie das Textfeld unter **Einstellungen > Signatur** und speichern.

## Signaturen und Identitäten

Signaturen leben jetzt pro Identität, nicht pro Konto. Die Registerkarte **Signaturen** auf dieser Seite bearbeitet die Signatur der Standardidentität des Kontos. Hat das Konto zusätzliche Identitäten (andere „From"-Adressen im selben Konto, z. B. einen privaten Alias oder einen Team-Alias), besitzt jede ihre eigene Signatur — bearbeiten Sie diese unter **Einstellungen > Identities**. Siehe [Identitäten](./identities) zum Verhalten von Identitäten und dazu, wie das Verfassen-Fenster bei Antworten oder neuen Nachrichten eine auswählt.
