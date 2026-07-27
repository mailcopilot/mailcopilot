---
sidebar_position: 5
title: E-Mail-Regeln
---

# E-Mail-Regeln

Mit E-Mail-Regeln können Sie eingehende E-Mails automatisch sortieren und organisieren, basierend auf von Ihnen definierten Bedingungen. Die Regeln werden bei jedem Eingang neuer Nachrichten ausgewertet.

## Eine Regel erstellen

1. Öffnen Sie **Einstellungen > Regeln**.
2. Klicken Sie auf **Regel hinzufügen**.
3. Geben Sie Ihrer Regel einen Namen.
4. Wählen Sie, für welches Konto die Regel gilt (oder wählen Sie „Alle Konten").

### Bedingungen

Jede Regel hat eine oder mehrere Bedingungen. Alle Bedingungen müssen zutreffen, damit die Regel ausgelöst wird (UND-Logik). Wenn Sie eine ODER-Logik benötigen, erstellen Sie separate Regeln.

Verfügbare Bedingungsfelder:
- **Von** — Name oder Adresse des Absenders.
- **An** — Empfängeradresse.
- **CC** — CC-Adresse.
- **Betreff** — die Betreffzeile der E-Mail.
- **Hat Anhang** — ob die E-Mail Anhänge enthält.

Verfügbare Operatoren:
- **enthält** / **enthält nicht** — teilweise Übereinstimmung.
- **ist gleich** — exakte Übereinstimmung.
- **beginnt mit** / **endet mit** — Präfix- oder Suffix-Übereinstimmung.
- **stimmt mit regulärem Ausdruck überein** — erweiterte Mustersuche mit regulären Ausdrücken.

### Aktionen

Wenn eine Regel zutrifft, werden eine oder mehrere Aktionen ausgeführt:

- **Archivieren** — in den Archiv-Ordner verschieben.
- **In den Papierkorb verschieben** — in den Papierkorb verschieben.
- **In Ordner verschieben** — in einen bestimmten Ordner Ihrer Wahl verschieben.
- **Als gelesen markieren** — die E-Mail automatisch als gelesen markieren.
- **Markieren** — die E-Mail mit einem Stern versehen.
- **Als Spam markieren** — in den Spam-Ordner verschieben.

### Verarbeitung stoppen

Wenn Sie **„Keine weiteren Regeln verarbeiten"** aktivieren, werden nach dem Auslösen dieser Regel keine weiteren Regeln ausgewertet. Dies ist nützlich, wenn Sie eine allgemeine Regel haben und verhindern möchten, dass sie spezifischere Regeln überschreibt.

## Regeln testen

Bevor Sie eine Regel speichern, klicken Sie auf **„An vorhandenen E-Mails testen"**, um zu sehen, welche Ihrer bestehenden E-Mails den Bedingungen entsprechen. So können Sie überprüfen, ob die Regel wie erwartet funktioniert, bevor sie auf neue E-Mails angewendet wird.

## Auf vorhandene E-Mails anwenden

Aktivieren Sie beim Speichern einer Regel **„Auf vorhandene E-Mails im Posteingang anwenden"**, um die Regel sofort auf E-Mails anzuwenden, die sich bereits in Ihrem Posteingang befinden.

## Regelpriorität

Regeln werden in der Reihenfolge ihrer Priorität ausgewertet (niedrigere Zahl = höhere Priorität). Sie können die Priorität beim Bearbeiten einer Regel anpassen. Haben zwei Regeln die gleiche Priorität, werden sie in der Erstellungsreihenfolge ausgewertet.

## KI-Regeln

Wenn Sie einen KI-Anbieter konfiguriert haben (siehe [KI-Assistent](../ai-assistant)), können Sie auch KI-gestützte Regeln erstellen. KI-Regeln verarbeiten E-Mails, die keiner statischen Regel entsprechen.

### Wie KI-Regeln funktionieren

1. Sie schreiben einen Prompt, der beschreibt, wie E-Mails sortiert werden sollen (z. B. „Newsletter archivieren, Recruiter-E-Mails in den Ordner Jobs verschieben").
2. Sie wählen aus, welche Aktionen die KI ausführen darf.
3. Sie legen ein tägliches Budgetlimit fest, um die Kosten zu kontrollieren.
4. Die KI wertet nicht zugeordnete E-Mails stapelweise aus. Sie wendet automatisch nur umkehrbare Aktionen an (archivieren, verschieben, als gelesen markieren, mit Stern markieren); Aktionen zum Verschieben in den Papierkorb oder Markieren als Spam werden als ausstehende Vorschläge aufgezeichnet, die Sie selbst anwenden müssen.

KI-Regelaktionen werden protokolliert, damit Sie nachvollziehen können, welche Aktion für jede E-Mail angewendet oder vorgeschlagen wurde.

### Neue KI-Regeln sind zunächst deaktiviert

Eine neu erstellte KI-Regel ist **standardmäßig deaktiviert**. Aktivieren Sie **„Aktiviert"** für die Regel, nachdem Sie deren Prompt und erlaubte Aktionen überprüft haben, um sie auf eingehende E-Mails anzuwenden. So wird verhindert, dass eine Regel auf Ihren Posteingang einwirkt, bevor Sie bestätigt haben, dass sie sich wie erwartet verhält.

### Limit für aktivierte Regeln pro Konto

Sie können höchstens **20 aktivierte KI-Regeln pro Konto** haben (globale Regeln, die für jedes Konto gelten, zählen zum Limit jedes einzelnen Kontos). Wenn Sie versuchen, eine Regel über dieses Limit hinaus zu aktivieren, zeigt die App eine Meldung an und die Regel bleibt deaktiviert — deaktivieren Sie zuerst eine andere Regel. Diese Begrenzung sorgt dafür, dass die Hintergrundverarbeitung schnell und vorhersehbar bleibt: Alle aktivierten Regeln eines Kontos werden gemeinsam in einem Durchgang ausgewertet.

### Destruktive Aktionen erfordern eine Überprüfung

Umkehrbare Aktionen -- Archivieren, in Ordner verschieben, als gelesen markieren, mit Stern markieren -- werden automatisch angewendet, wenn eine KI-Regel zutrifft. **In den Papierkorb verschieben** und **Als Spam markieren** werden niemals automatisch angewendet: Stattdessen zeichnet die KI die vorgeschlagene Aktion als ausstehenden Eintrag im Aktionsprotokoll der Regel auf. Um eine vorgeschlagene Papierkorb- oder Spam-Aktion auszuführen, müssen Sie den Eintrag öffnen und sie ausdrücklich anwenden -- es wird nichts gelöscht oder als Spam markiert, bevor Sie das tun. So wird verhindert, dass die KI E-Mails ohne Ihre Bestätigung dauerhaft aus Ihrem Posteingang entfernt.

### Regeln sehen nur ihr eigenes Konto

Eine KI-Regel, die einem bestimmten Konto zugeordnet ist, wertet ausschließlich die E-Mails dieses Kontos aus und wirkt nur auf diese. Sie sieht oder beeinflusst niemals Nachrichten in Ihren anderen Konten.
