---
sidebar_position: 5
title: E-Mail-Regeln
---

# E-Mail-Regeln

Mit E-Mail-Regeln können Sie eingehende E-Mails automatisch sortieren und organisieren, basierend auf von Ihnen definierten Bedingungen. Die Regeln laufen immer dann, wenn MailCopilot E-Mails vom Server abruft — nicht zwingend in dem Moment, in dem eine Nachricht dort eintrifft.

## Eine Regel erstellen

1. Öffnen Sie **Einstellungen > Regeln**.
2. Klicken Sie auf **Regel hinzufügen**.
3. Geben Sie Ihrer Regel einen Namen.
4. Wählen Sie, für welches Konto die Regel gilt (oder wählen Sie „Alle Konten").

### Bedingungen

Jede Regel hat eine oder mehrere Bedingungen. Alle Bedingungen müssen zutreffen, damit die Regel ausgelöst wird (UND-Logik). Wenn Sie eine ODER-Logik benötigen, erstellen Sie separate Regeln.

Verfügbare Bedingungsfelder:
- **Absender** — wird mit dem Anzeigenamen des Absenders verglichen, sofern die Nachricht einen hat, und nur bei dessen Fehlen mit der Adresse. Eine Regel, die auf eine Adresse abzielt, kann aufhören zu greifen, sobald dieser Absender einen Anzeigenamen verwendet — testen Sie die Regel nach dem Einrichten und achten Sie darauf, ob sie plötzlich nicht mehr auslöst.
- **Empfänger** — Empfängeradresse.
- **Cc** — im Regeleditor vorhanden, aber MailCopilot speichert das Cc-Feld für zwischengespeicherte E-Mails nicht, sodass jede Nachricht für eine Regel wie eine mit leerem Cc-Feld aussieht. Dadurch verhält sich die Bedingung unberechenbar statt einfach nur „funktioniert nicht": Eine bestimmte Adresse im Cc trifft nie zu, aber ein ausschließender Operator wie **enthält nicht** oder ein regulärer Ausdruck, der auf eine leere Zeichenfolge passt, trifft stattdessen auf **jede** Nachricht zu. Verwenden Sie eine Cc-Bedingung nicht in einer Regel, die E-Mails in den Papierkorb verschiebt, als Spam markiert oder in einen anderen Ordner verschiebt — mit dem falschen Operator kann sie sich auf Ihr gesamtes Postfach auswirken.
- **Betreff** — die Betreffzeile der E-Mail.
- **Hat Anhang** — ob die E-Mail Anhänge enthält.

Verfügbare Operatoren:
- **enthält** / **enthält nicht** — teilweise Übereinstimmung.
- **ist gleich** — exakte Übereinstimmung.
- **beginnt mit** / **endet mit** — Präfix- oder Suffix-Übereinstimmung.
- **entspricht Regex** — erweiterte Mustersuche mit regulären Ausdrücken.

### Aktionen

Wenn eine Regel zutrifft, werden eine oder mehrere Aktionen ausgeführt:

- **Archivieren** — in den Archiv-Ordner verschieben.
- **In Papierkorb verschieben** — in den Papierkorb verschieben.
- **In Ordner verschieben** — in einen bestimmten Ordner Ihrer Wahl verschieben.
- **Als gelesen markieren** — die E-Mail automatisch als gelesen markieren.
- **Stern hinzufügen** — die E-Mail mit einem Stern versehen.
- **Als Spam markieren** — in den Spam-Ordner verschieben.

### Verarbeitung stoppen

Wenn Sie **„Weitere Regeln nicht mehr verarbeiten"** aktivieren, werden nach dem Auslösen dieser Regel keine weiteren Regeln ausgewertet. Dies ist nützlich, wenn Sie eine allgemeine Regel haben und verhindern möchten, dass sie spezifischere Regeln überschreibt.

## Regeln testen

Bevor Sie eine Regel speichern, klicken Sie auf **„An vorhandenen E-Mails testen"**, um vorab zu sehen, welche Ihrer aktuellen Posteingangs-E-Mails den Bedingungen entsprechen würden. Der Test prüft bis zu 500 Posteingangs-E-Mails, die bereits auf dieses Gerät heruntergeladen wurden, und zeigt bis zu 20 Treffer an — das ist eine schnelle Stichprobe, keine vollständige Durchsuchung Ihres gesamten Postfachs. Bei einer Regel für ein einzelnes Konto sind das Ihre neuesten E-Mails; bei einer Regel für alle Konten stammen die geprüften 500 aus all Ihren Konten zusammen, sind aber nicht zwangsläufig insgesamt die neuesten. Ältere E-Mails und noch nicht heruntergeladene E-Mails werden nicht einbezogen.

## Auf vorhandene E-Mails anwenden

Aktivieren Sie beim Speichern einer Regel **„Auf vorhandene E-Mails im Posteingang anwenden"**, um sie sofort auf E-Mails anzuwenden, die Sie bereits haben. Dies erfasst bis zu 1.000 Posteingangs-E-Mails, die bereits auf dieses Gerät heruntergeladen wurden — bei einer Regel für ein einzelnes Konto Ihre neuesten solchen E-Mails; bei einer Regel für alle Konten bis zu 1.000 aus all Ihren Konten zusammen, nicht zwangsläufig insgesamt die neuesten. Es reicht nicht weiter in Ihren E-Mail-Verlauf auf dem Server zurück und umfasst nur den Posteingang, keine anderen Ordner. Schlägt eine einzelne Aktion fehl, wird nur diese Aktion übersprungen — die übrigen Aktionen derselben Regel werden für diese E-Mail trotzdem ausgeführt, und der Rest des Durchlaufs wird ebenfalls abgeschlossen.

## Nur neue E-Mails

Regeln greifen bei neuer E-Mail, sobald sie auf Ihrem Gerät ankommt — unabhängig davon, auf welchem Weg das geschieht: per Push-Benachrichtigung, regelmäßige Synchronisierung oder eine Seite mit E-Mails, die neuer sind als die, die Sie schon gesehen haben. Früher konnte es eine Rolle spielen, auf welchem dieser Wege eine Nachricht ankam, und eine Regel konnte sie dadurch übersehen; diese Lücke gibt es jetzt nicht mehr. Beim Zurückscrollen zu älteren Seiten werden diese älteren E-Mails den Regeln allerdings nicht zugeführt — das ist beabsichtigt, dasselbe „kein Verlaufs-Scan"-Verhalten wie weiter unten beschrieben, keine übrig gebliebene Lücke.

Diese Garantie für neue E-Mails ist allerdings nicht für jede Situation absolut: Schlägt die Aktion für dieselbe E-Mail drei Versuche in Folge fehl (zum Beispiel wegen einer unterbrochenen Verbindung), wird sie endgültig aufgegeben — MailCopilot überspringt sie und macht in diesem Ordner weiter, sodass ein späterer Neustart sie nicht zurückbringt. Was ein Neustart tatsächlich zurücksetzt, ist ein Zähler, der die drei noch nicht erreicht hat: Startet die App neu, bevor eine E-Mail dreimal in Folge fehlgeschlagen ist, beginnt die Zählung wieder bei null — eine Aktion, die aus einem dauerhaften Grund immer wieder fehlschlägt, kann die Verarbeitung eines Ordners dadurch unbegrenzt aufhalten, ohne dieses Dreifach-Limit je tatsächlich zu erreichen.

Regeln durchsuchen den Verlauf eines Ordners zudem nie von sich aus. Jeder Ordner, den MailCopilot beim Start bereits kennt, erhält sofort einen Startpunkt, noch bevor synchronisiert wird — ein leerer Ordner erhält den Startpunkt null, sodass seine allererste E-Mail ganz normal ausgewertet wird; ein Ordner mit bereits zwischengespeicherten E-Mails erhält einen Startpunkt hinter diesen E-Mails, sodass die vorhandene Post nicht nachträglich erfasst wird, alles danach Eintreffende aber schon. Ein Ordner, der erst nach diesem Startzeitpunkt entsteht — neu angelegt oder neu abonniert —, wird anders behandelt: Darin wird nichts ausgewertet, bis MailCopilot ihn einmal synchronisiert hat, und nur E-Mails, die nach dieser ersten Synchronisierung eintreffen, zählen. Derselbe Neustart erfolgt, wenn der Server die Nummerierung der Nachrichten in einem Ordner zurücksetzt (selten, kann aber nach bestimmten serverseitigen Migrationen vorkommen). Verwenden Sie **„Auf vorhandene E-Mails im Posteingang anwenden"** (siehe oben), wenn eine Regel auch bereits vorhandene E-Mails auswerten soll.

## Regelpriorität

Regeln werden in der Reihenfolge ihrer Priorität ausgewertet (niedrigere Zahl = höhere Priorität). Die Priorität wird beim Erstellen einer Regel automatisch vergeben — im Regeleditor gibt es derzeit keine Möglichkeit, sie anzupassen. Haben zwei Regeln dieselbe Priorität, ist nicht definiert, welche zuerst ausgewertet wird.

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

Umkehrbare Aktionen -- Archivieren, in Ordner verschieben, als gelesen markieren, mit Stern markieren -- werden automatisch angewendet, wenn eine KI-Regel zutrifft. **In Papierkorb verschieben** und **Als Spam markieren** werden niemals automatisch angewendet: Stattdessen zeichnet die KI die vorgeschlagene Aktion als ausstehenden Eintrag im Aktionsprotokoll der Regel auf. Um eine vorgeschlagene Papierkorb- oder Spam-Aktion auszuführen, müssen Sie den Eintrag öffnen und sie ausdrücklich anwenden -- es wird nichts gelöscht oder als Spam markiert, bevor Sie das tun. So wird verhindert, dass die KI E-Mails ohne Ihre Bestätigung dauerhaft aus Ihrem Posteingang entfernt.

### Regeln sehen nur ihr eigenes Konto

Eine KI-Regel, die einem bestimmten Konto zugeordnet ist, wertet ausschließlich die E-Mails dieses Kontos aus und wirkt nur auf diese. Sie sieht oder beeinflusst niemals Nachrichten in Ihren anderen Konten.
