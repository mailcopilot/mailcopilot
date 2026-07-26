---
sidebar_position: 4
title: Identities
---

# Identitäten

Ein einzelnes E-Mail-Konto kann mehrere **Identitäten** besitzen — alternative „From"-Adressen, von denen Sie senden. Das ist nützlich bei Gmail- oder Microsoft-365-Konten, bei denen es neben der Hauptadresse Aliasse gibt (ein privater Alias, ein Team-Alias, eine alte Vanity-Adresse) und Sie für jeden einen eigenen Anzeigenamen, eine eigene Signatur sowie eigene Bcc-Regeln haben möchten — ohne jeden Alias als separates IMAP-Konto einrichten zu müssen.

## Was eine Identität enthält

Jede Identität trägt:

- Einen **Anzeigenamen** — wie der Empfänger Sie im „From"-Header sieht.
- Eine **E-Mail-Adresse** — die tatsächliche Adresse, die als „From"-Adresse verwendet wird. Das zugrunde liegende Konto muss berechtigt sein, von dieser Adresse zu senden.
- Eine optionale **Signatur** — ersetzt die kontoweite Signatur, wenn diese Identität ausgewählt ist. Siehe [Signaturen](./signatures) für das Verhalten von Signaturen bei Antworten und Weiterleitungen.
- Ein optionales **Standard-Bcc** — wird automatisch ins Bcc-Feld eingefügt, sobald die Identität im Verfassen-Fenster ausgewählt ist.
- Ein **Standard-Flag** — genau eine Identität pro Konto ist die Standard­identität. Sie wird verwendet, wenn keine spezifischere Regel greift.

Jedes Konto hat immer mindestens eine Identität. Beim ersten Anmelden erstellt MailCopilot aus Kontoname, E-Mail und vorhandener Signatur eine einzelne Standardidentität.

## Identitäten verwalten

Öffnen Sie **Einstellungen > Identities** und wählen Sie oben das Konto im Dropdown aus. Die Registerkarte zeigt die Liste der Identitäten dieses Kontos mit Aktionen:

- **Hinzufügen** einer neuen Identität. Tragen Sie Anzeigename, E-Mail, Signatur und Standard-Bcc ein; markieren Sie sie bei Bedarf als Standard.
- **Bearbeiten** einer bestehenden Identität, um beliebige Felder zu ändern.
- **Als Standard festlegen** — eine Identität zur Standard­identität befördern. Es kann immer nur eine Identität gleichzeitig die Standardidentität sein.
- **Löschen** einer Identität. Die Standardidentität kann nicht gelöscht werden; befördern Sie zuerst eine andere Identität zum Standard.

## Identität beim Verfassen wählen

Das Verfassen-Fenster enthält ein Dropdown zur Identitätswahl direkt unter dem Konto-Dropdown „From". Standardmäßig wählt MailCopilot eine Identität in folgender Reihenfolge:

1. **Antworten und Weiterleitungen** — Abgleich mit den From-, To- und Cc-Adressen der Originalnachricht. Die erste Identität, deren E-Mail-Adresse irgendwo in dieser Liste auftaucht, gewinnt — damit die Antwort von derselben Adresse ausgeht, an die Sie die Nachricht ursprünglich erhalten haben. Der Abgleich ist case-insensitiv über die vollständige E-Mail-Adresse; Alias-Ketten und Plus-Adress-Varianten werden nicht erkannt und fallen auf die Standardidentität zurück.
2. **Neue Nachrichten** — die Standardidentität des Kontos wird gewählt.

Sie können die Wahl jederzeit überschreiben, indem Sie das Dropdown öffnen und eine andere Identität auswählen. Der Identitätswechsel aktualisiert den „From"-Header. Die Signatur wird nur ersetzt, wenn der Nachrichtenkörper leer ist oder ausschließlich einen Signaturblock nach dem Standard-Trenner `\n\n--\n` enthält — Text, den Sie über dem Trenner getippt haben, wird nie überschrieben. Das Bcc-Feld wird nur ersetzt, wenn es leer ist oder noch dem Standard-Bcc der vorher gewählten Identität entspricht; ein selbst getipptes Bcc übersteht damit Identitätswechsel.

## Verhältnis zu Signaturen

Signaturen leben jetzt **pro Identität**, nicht pro Konto. Die Registerkarte **Einstellungen > Signaturen** verwaltet die Signatur der Standardidentität des aktuell gewählten Kontos; Nicht-Standardidentitäten werden unter **Einstellungen > Identities** bearbeitet. Konten, die vor dem Multi-Identity-Rollout angelegt wurden, behalten ihre alte kontoweite Signatur: MailCopilot liest sie über eine synthetisierte Standardidentität, sodass nichts kaputtgeht. Die neue Identitätsliste wird beim nächsten Speichern des Kontos auf Platte geschrieben (z. B. wenn Sie ein beliebiges Kontofeld bearbeiten).

## Versand und Audit

Welche Identität beim Senden im Verfassen-Fenster aktiv ist, erscheint auch in der tatsächlich ausgehenden Nachricht:

- Der „From"-Header von SMTP / Microsoft Graph trägt die E-Mail-Adresse und den Anzeigenamen der Identität.
- Geplante Sendungen merken sich die zum Planungszeitpunkt gewählte Identität — eine Nachricht, die Sie von Ihrem Alias geplant haben, wird auch beim Auslösen des Timers von diesem Alias versendet.
