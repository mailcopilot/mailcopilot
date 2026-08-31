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
- **Absender — Adresse** — wird nur mit der E-Mail-Adresse des Absenders verglichen. Filtert eine Regel, die verschiebt, archiviert, löscht oder als Spam markiert, überhaupt nach dem Absender, ist dies das einzige Absenderfeld, das MailCopilot dafür zulässt — siehe unten.
- **Absender — Anzeigename** — wird nur mit dem Anzeigenamen des Absenders verglichen, dem Freitext-Namen, der neben der Adresse erscheint (z. B. „Max Mustermann" in `Max Mustermann <max@example.com>`). Bekannte Einschränkung: Ist der gespeicherte Anzeigename eines Absenders textlich identisch mit dessen eigener Adresse, behandelt MailCopilot diesen Absender so, als hätte er gar keinen Anzeigenamen, und diese Bedingung trifft dann nicht zu — vergleichen Sie für diesen Absender stattdessen mit **Absender — Adresse**. MailCopilot lässt dieses Feld keine Regel steuern, die E-Mails verschiebt, archiviert, löscht oder als Spam markiert — siehe unten.
- **Absender — Name oder Adresse (veraltet)** — das ursprüngliche kombinierte Feld: Es trifft zu, wenn *entweder* der Anzeigename *oder* die Adresse übereinstimmt (**Enthält nicht** bildet die Ausnahme — siehe unten). Sein Vergleichsverhalten hat sich geändert, als das obige Feld in **Absender — Adresse** und **Absender — Anzeigename** aufgeteilt wurde: Früher wurde nur ein einzelner Wert verglichen — der Anzeigename, wobei nur dann auf die Adresse zurückgegriffen wurde, wenn der Absender keinen Anzeigenamen gesetzt hatte —, sodass eine Regel auf diesem Feld bei einem Absender mit Signatur nie über die Adresse zutraf. Jetzt werden immer beide Werte zusammen verglichen, sodass eine bereits auf dieses Feld konfigurierte Regel plötzlich auf Nachrichten zutreffen kann, auf die sie vorher nicht zutraf (und bei **Enthält nicht** umgekehrt aufhören kann, Nachrichten auszuschließen, die sie vorher ausschloss). Wenn Sie bestehende Regeln auf diesem Feld haben, prüfen Sie, worauf sie jetzt zutreffen — besonders solche, die Post verschieben, löschen oder als Spam markieren. Es wird für neue Bedingungen nicht mehr angeboten — siehe „Veraltetes Feld" unten. **Enthält nicht** bei diesem Feld bildet die Ausnahme: Da diese Bedingung bedeutet „darf mit keinem von beidem übereinstimmen", muss der Text sowohl im Anzeigenamen als auch in der Adresse fehlen. Eine Regel „enthält nicht example.com" trifft also nicht auf eine Nachricht zu, deren Anzeigename diesen Text enthält — selbst wenn die Adresse ihn nicht enthält.
- **Empfänger** — Empfängeradresse.
- **Cc** — wird beim Hinzufügen einer neuen Bedingung nicht mehr angeboten. MailCopilot speichert das Cc-Feld für zwischengespeicherte E-Mails nicht, sodass eine Bedingung darauf in Wirklichkeit nie geprüft werden konnte, und je nach Operator verhielt sie sich unberechenbar statt einfach nur „funktioniert nicht": Eine bestimmte Adresse im Cc traf nie zu, aber ein ausschließender Operator wie **enthält nicht** oder ein regulärer Ausdruck, der auf eine leere Zeichenfolge passt, traf stattdessen auf **jede** Nachricht zu — eine Regel, die für eine Handvoll Nachrichten gedacht war, konnte so ein ganzes Postfach leeren. Wenn eine vor dieser Änderung konfigurierte Regel noch eine Cc-Bedingung enthält, erscheint sie weiterhin im Regeleditor mit einem Hinweis, dass die Bedingung nie erfüllt werden kann — die Regel trifft dadurch auf nichts mehr zu und läuft nicht mehr. Die Regel selbst bleibt aber unverändert in Ihrer Liste stehen, bis Sie sie zum Bearbeiten öffnen — und die Regelliste selbst markiert sie mit dem Badge **„Wird nicht angewendet"**, sodass Sie das nicht erst durch Öffnen der Regel bemerken müssen (siehe „Als nicht angewendet markierte Regeln" unten). Sie im Editor zu öffnen und zu speichern wird verweigert, ebenso wie **„Auf vorhandene E-Mails im Posteingang anwenden"** dafür zu aktivieren, solange Sie die Cc-Bedingung nicht entfernt oder durch ein unterstütztes Feld ersetzt haben. Sie sind dabei aber nicht ausgesperrt: Das Kontrollkästchen neben der Regel in der Liste schaltet sie weiterhin ein und aus, und sie aus der Liste zu löschen funktioniert ebenfalls immer.
- **Betreff** — die Betreffzeile der E-Mail.
- **Hat Anhang** — ob die E-Mail Anhänge enthält.

Verfügbare Operatoren:
- **enthält** / **enthält nicht** — teilweise Übereinstimmung.
- **ist gleich** — exakte Übereinstimmung.
- **beginnt mit** / **endet mit** — Präfix- oder Suffix-Übereinstimmung.
- **entspricht Regex** — erweiterte Mustersuche mit regulären Ausdrücken.

### Der Anzeigename kann gefälscht werden

Ein Absender kontrolliert seinen eigenen Anzeigenamen vollständig — es ist Freitext, den er selbst festlegt, und kein Wert, den der Mailserver überprüft. Das bedeutet, ein Absender kann seinen Anzeigenamen so setzen, dass er genau wie eine Adresse aussieht, zum Beispiel `user@example.com` — unabhängig davon, welche Adresse der `From:`-Header der Nachricht tatsächlich nennt. Eine Regel wie „Absender — Anzeigename ist gleich user@example.com" trifft allein aufgrund dieses Anzeigenamens zu, unabhängig von der Adresse — und genauso trifft dieselbe Bedingung auf **Absender — Name oder Adresse (veraltet)** zu, da auch dieses Feld den Anzeigenamen prüft.

Adresse und Anzeigename werden getrennt gespeichert und verglichen, sodass Text, den ein Absender in den Anzeigenamen schreibt, nie als Adresse gelesen wird — das macht die Adresse aber nicht für sich genommen vertrauenswürdig: Der Absender verfasst den gesamten `From:`-Header, Adresse eingeschlossen, sie ist also genauso fälschbar (siehe unten). Was diese Trennung bringt, ist enger gefasst: Filtert eine Regel, die verschiebt, archiviert, löscht oder als Spam markiert, nach dem Absender, und dieser Filter steht auf **Absender — Anzeigename** oder dem veralteten Feld, verweigert MailCopilot sie — eine Regel, die eines dieser Felder mit **In Papierkorb verschieben**, **Als Spam markieren**, **Archivieren** oder **In Ordner verschieben** kombiniert, kann nicht gespeichert werden. Es geht dabei ausschließlich darum, welches Feld eine Bedingung auf den *Absender* verwendet; eine Regel, die eine dieser Aktionen ausführt, ohne überhaupt nach dem Absender zu filtern — etwa nach Betreff, Empfänger oder Anhang —, ist davon nicht betroffen. Hat eine bestehende Regel diese Kombination bereits — aus der Zeit vor dieser Einschränkung —, wird sie im Editor zu öffnen und zu speichern verweigert, ebenso wie das Ausführen von **„Auf vorhandene E-Mails im Posteingang anwenden"** dafür; die Meldung nennt das Feld und die Aktion, die den Ausschlag gaben, und verweist stattdessen auf **Absender — Adresse**. Bis Sie das korrigieren, hört auch diese Regel auf, auf neue E-Mails zuzutreffen — aber nicht heimlich: Die Regelliste markiert sie mit dem Badge **„Wird nicht angewendet"**, sodass Sie das nicht erst durch Öffnen der Regel bemerken müssen (siehe „Als nicht angewendet markierte Regeln" unten). **Sie sind dabei aber nicht ausgesperrt: Das Kontrollkästchen neben der Regel in der Liste schaltet sie weiterhin ein und aus — unabhängig von der Verweigerung — und ist der schnellste Weg, eine Regel zu stoppen, die sich sonst nicht speichern lässt.** Auch das Löschen der Regel aus der Liste funktioniert immer. Von der Einschränkung selbst nicht betroffen sind **Als gelesen markieren** und **Stern hinzufügen**: Keine der beiden Aktionen kann E-Mails zerstören oder verbergen, ein gefälschter Absender, der eine davon auslöst, kostet Sie also nichts Unwiderrufliches — beide Felder dürfen sie weiterhin steuern.

Es lohnt sich, genau zu sagen, was **Absender — Adresse** beweist und was nicht — dorthin verweist diese Einschränkung schließlich: Es ist keine Garantie, dass die Nachricht tatsächlich von dieser Adresse stammt. Der Wert wird direkt aus dem `From:`-Header der Nachricht gelesen, und MailCopilot prüft diesen Header nicht kryptografisch — ein Abgleich mit DKIM- oder DMARC-Signaturen ist eine eigene, noch nicht umgesetzte Aufgabe —, sodass eine Nachricht dort weiterhin jede beliebige Adresse behaupten kann, genauso frei wie jeden beliebigen Anzeigenamen. Was der Abgleich auf dieses Feld tatsächlich bringt, ist enger gefasst, aber real: Weil Adresse und Anzeigename getrennte Felder sind, wird ein Anzeigename, den ein Absender wie eine Adresse aussehen ließ, nie als Adresse verglichen — ein gefälschter Anzeigename kann also eine Bedingung auf **Absender — Anzeigename** erfüllen, aber nicht für sich genommen eine Bedingung auf **Absender — Adresse**. Verstehen Sie eine Übereinstimmung bei **Absender — Adresse** als „diese Adresse wurde in der Nachricht angegeben", nicht als geprüfte Identität.

### Veraltetes Feld

**Absender — Name oder Adresse (veraltet)** ist das ursprüngliche, ungeteilte „Absender"-Feld, das für Regeln erhalten bleibt, die vor der oben beschriebenen Aufteilung darauf konfiguriert wurden. Sie können eine Regel, die es verwendet, weiterhin öffnen und bearbeiten, aber sein Vergleichsverhalten hat sich seitdem geändert — siehe den Hinweis unter „Bedingungen" oben —, weshalb es sich lohnt zu prüfen, worauf eine bestehende Regel auf diesem Feld jetzt zutrifft, besonders solche, die Post verschieben, löschen, archivieren oder als Spam markieren (warum diese Kombination verweigert wird — siehe „Der Anzeigename kann gefälscht werden" oben).

Wichtig ist eine Einbahnstraße im Regeleditor: Das veraltete Feld erscheint im Dropdown der Bedingungsfelder nur, solange eine Bedingung noch darauf eingestellt ist. Sobald Sie diese Bedingung auf ein anderes Feld umstellen (auch wenn Sie umstellen und wieder zurückwechseln), verschwindet die veraltete Option aus dem Dropdown, und es gibt keine Möglichkeit mehr, sie über die Oberfläche erneut auszuwählen — Sie müssten die Bedingung stattdessen auf **Absender — Adresse** oder **Absender — Anzeigename** neu anlegen. Entscheiden Sie sich vor dem Umschalten, nicht danach.

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

## Als nicht angewendet markierte Regeln

Wenn die Bedingungen oder Aktionen einer Regel nicht glaubhaft rechtfertigen, was die Regel tut, verweigert MailCopilot deren Ausführung — und markiert das in der Regelliste, statt sie stillschweigend untätig zu lassen. Das Badge erscheint anstelle der üblichen Zusammenfassung „N Bedingungen, M Aktionen" für diese Regel, unabhängig davon, ob sie aktiviert oder deaktiviert ist, sodass Sie eine Regel nicht öffnen müssen, um herauszufinden, dass sie tatsächlich nicht läuft.

- **„Nicht anwendbar"** — die Regel selbst lässt sich nicht lesen: Einigen ihrer Bedingungen oder Aktionen fehlen Teile, die MailCopilot für die Ausführung braucht, meist weil das, was sie erstellt hat (zum Beispiel ein KI-Assistent, der gebeten wurde, eine Regel einzurichten), sie nicht korrekt zu Ende geschrieben hat. Das Öffnen der Regel zeigt dieselbe Meldung, und ihre Bedingungs- und Aktionslisten sind im Editor leer — es gibt nichts zu reparieren, nur neu aufzubauen.
- **„Wird nicht angewendet"** — die Regel lässt sich lesen, aber MailCopilot kann nicht rechtfertigen, sie wie geschrieben auszuführen. Das betrifft die zwei oben beschriebenen Situationen: eine Bedingung, die auf ein Feld zutrifft, das MailCopilot für zwischengespeicherte E-Mails nicht speichert (etwa **Cc**) und deshalb nie wirklich geprüft werden kann; oder eine destruktive Aktion — **In Papierkorb verschieben**, **Als Spam markieren**, **Archivieren** oder **In Ordner verschieben** — die vom Anzeigenamen des Absenders abhängt (**Absender — Anzeigename** oder dem veralteten Feld **Absender — Name oder Adresse**), den der Absender beliebig setzen kann, sodass er die Aktion nicht rechtfertigen kann (siehe „Der Anzeigename kann gefälscht werden" oben).

Trifft auf eine Regel beides zu, hat **„Nicht anwendbar"** Vorrang — die Badges erscheinen nie gleichzeitig, angezeigt wird nur die Kennzeichnung der unlesbaren Regel.

Wenn Sie den Mauszeiger über eines der beiden Badges bewegen, zeigt ein Tooltip den Grund der Verweigerung in einer Zeile; wenn Sie das Badge per Tastatur ansteuern, erscheint dieser Tooltip nicht. Bei **„Wird nicht angewendet"** gehört der Grund außerdem zu dem, was ein Screenreader für das Badge vorliest, und das Badge selbst ist eine Schaltfläche: Ein Klick darauf öffnet die Regel im Editor, damit Sie die Bedingung oder Aktion korrigieren können, die die Verweigerung auslöst. **„Nicht anwendbar"** ist nur eine Beschriftung, keine Schaltfläche: Im Editor gibt es nichts, worauf hingewiesen werden könnte — öffnen Sie eine solche Regel über die Bearbeiten-Schaltfläche (Stift) in ihrer Zeile. Eine Regel in einem dieser beiden Zustände bleibt unverändert in Ihrer Liste, bis Sie sie korrigieren — das Kontrollkästchen daneben schaltet sie weiterhin ein und aus, und sie aus der Liste zu löschen funktioniert weiterhin immer, aber die Regel selbst tut nichts, solange sie so markiert ist.

## Regeln testen

Bevor Sie eine Regel speichern, klicken Sie auf **„An vorhandenen E-Mails testen"**, um vorab zu sehen, welche Ihrer aktuellen Posteingangs-E-Mails den Bedingungen entsprechen würden. Der Test prüft bis zu 500 Posteingangs-E-Mails, die bereits auf dieses Gerät heruntergeladen wurden, und zeigt bis zu 20 Treffer an — das ist eine schnelle Stichprobe, keine vollständige Durchsuchung Ihres gesamten Postfachs. Bei einer Regel für ein einzelnes Konto sind das Ihre neuesten E-Mails; bei einer Regel für alle Konten stammen die geprüften 500 aus all Ihren Konten zusammen, sind aber nicht zwangsläufig insgesamt die neuesten. Ältere E-Mails und noch nicht heruntergeladene E-Mails werden nicht einbezogen.

## Auf vorhandene E-Mails anwenden

Aktivieren Sie beim Speichern einer Regel **„Auf vorhandene E-Mails im Posteingang anwenden"**, um sie sofort auf E-Mails anzuwenden, die Sie bereits haben. Dies erfasst bis zu 1.000 Posteingangs-E-Mails, die bereits auf dieses Gerät heruntergeladen wurden — bei einer Regel für ein einzelnes Konto Ihre neuesten solchen E-Mails; bei einer Regel für alle Konten bis zu 1.000 aus all Ihren Konten zusammen, nicht zwangsläufig insgesamt die neuesten. Es reicht nicht weiter in Ihren E-Mail-Verlauf auf dem Server zurück und umfasst nur den Posteingang, keine anderen Ordner. Schlägt eine einzelne Aktion fehl, wird nur diese Aktion übersprungen — die übrigen Aktionen derselben Regel werden für diese E-Mail trotzdem ausgeführt, und der Rest des Durchlaufs wird ebenfalls abgeschlossen. Eine Regel mit einer Bedingung, die MailCopilot nicht prüfen kann, oder bei der der Anzeigename (oder das veraltete Feld) eine verschiebende oder destruktive Aktion steuert, wird auch hier verweigert — siehe „Bedingungen" oben.

## Nur neue E-Mails

Regeln greifen bei neuer E-Mail, sobald sie auf Ihrem Gerät ankommt — unabhängig davon, auf welchem Weg das geschieht: per Push-Benachrichtigung, regelmäßige Synchronisierung oder eine Seite mit E-Mails, die neuer sind als die, die Sie schon gesehen haben. Früher konnte es eine Rolle spielen, auf welchem dieser Wege eine Nachricht ankam, und eine Regel konnte sie dadurch übersehen; diese Lücke gibt es jetzt nicht mehr. Beim Zurückscrollen zu älteren Seiten werden diese älteren E-Mails den Regeln allerdings nicht zugeführt — das ist beabsichtigt, dasselbe „kein Verlaufs-Scan"-Verhalten wie weiter unten beschrieben, keine übrig gebliebene Lücke.

Diese Garantie für neue E-Mails ist allerdings nicht für jede Situation absolut: Schlägt die Aktion für dieselbe E-Mail drei Versuche in Folge fehl (zum Beispiel wegen einer unterbrochenen Verbindung), wird sie endgültig aufgegeben — MailCopilot überspringt sie und macht in diesem Ordner weiter, sodass ein späterer Neustart sie nicht zurückbringt. Was ein Neustart tatsächlich zurücksetzt, ist ein Zähler, der die drei noch nicht erreicht hat: Startet die App neu, bevor eine E-Mail dreimal in Folge fehlgeschlagen ist, beginnt die Zählung wieder bei null — eine Aktion, die aus einem dauerhaften Grund immer wieder fehlschlägt, kann die Verarbeitung eines Ordners dadurch unbegrenzt aufhalten, ohne dieses Dreifach-Limit je tatsächlich zu erreichen.

Regeln durchsuchen den Verlauf eines Ordners zudem nie von sich aus. Jeder Ordner, den MailCopilot beim Start bereits kennt, erhält sofort einen Startpunkt, noch bevor synchronisiert wird — ein leerer Ordner erhält den Startpunkt null, sodass seine allererste E-Mail ganz normal ausgewertet wird; ein Ordner mit bereits zwischengespeicherten E-Mails erhält einen Startpunkt hinter diesen E-Mails, sodass die vorhandene Post nicht nachträglich erfasst wird, alles danach Eintreffende aber schon. Ein Ordner, der erst nach diesem Startzeitpunkt entsteht — neu angelegt oder neu abonniert —, wird anders behandelt: Darin wird nichts ausgewertet, bis MailCopilot ihn einmal synchronisiert hat, und nur E-Mails, die nach dieser ersten Synchronisierung eintreffen, zählen. Derselbe Neustart erfolgt, wenn der Server die Nummerierung der Nachrichten in einem Ordner zurücksetzt (selten, kann aber nach bestimmten serverseitigen Migrationen vorkommen). Verwenden Sie **„Auf vorhandene E-Mails im Posteingang anwenden"** (siehe oben), wenn eine Regel auch bereits vorhandene E-Mails auswerten soll.

## Regelpriorität

Regeln werden in der Reihenfolge ihrer Priorität ausgewertet (niedrigere Zahl = höhere Priorität). Die Priorität wird beim Erstellen einer Regel automatisch vergeben — im Regeleditor gibt es derzeit keine Möglichkeit, sie anzupassen. Haben zwei Regeln dieselbe Priorität, ist nicht definiert, welche zuerst ausgewertet wird.

## KI-Regeln

Wenn Sie einen KI-Anbieter konfiguriert haben (siehe [KI-Assistent](../ai-assistant)), können Sie auch KI-gestützte Regeln erstellen. KI-Regeln verarbeiten E-Mails, die keiner statischen Regel entsprechen.

Das ist etwas anderes, als den Assistenten im Chat zu bitten, eine Regel für Sie zu erstellen oder zu ändern. In diesem Fall erstellt oder ändert der Assistent eine **statische** Regel — die oben beschriebene Art, mit eigenen Bedingungen und Aktionen —, und alle oben beschriebenen Einschränkungen gelten dafür vollständig: Er kann keine Bedingung auf das Cc erstellen, da MailCopilot es nicht speichert; er kann eine Regel, die E-Mails verschiebt, in den Papierkorb legt, archiviert oder als Spam markiert, nicht auf den Anzeigenamen des Absenders stützen, sondern nur auf **Absender — Adresse**; und liefert er eine Regel, die MailCopilot aus einem anderen Grund nicht anwenden kann, wird die Regel nicht gespeichert — bitten Sie ihn, es erneut zu versuchen, oder bauen Sie die Regel selbst im Editor. Eine **KI-Regel**, um die es im Rest dieses Abschnitts geht, ist dagegen etwas ganz anderes: Statt Bedingungen hat sie einen Prompt, der in Ihren eigenen Worten beschreibt, was Sie wollen, plus eine Liste von Aktionen, die Sie der KI erlauben.

### Wie KI-Regeln funktionieren

1. Sie schreiben einen Prompt, der beschreibt, wie E-Mails sortiert werden sollen (z. B. „Newsletter archivieren, Recruiter-E-Mails in den Ordner Jobs verschieben").
2. Sie wählen aus, welche Aktionen die KI ausführen darf.
3. Sie legen ein tägliches Budgetlimit fest, um die Kosten zu kontrollieren.
4. Die KI wertet nicht zugeordnete E-Mails stapelweise aus. Sie wendet automatisch umkehrbare Aktionen an (archivieren, verschieben, als gelesen markieren, mit Stern markieren); bei **In Papierkorb verschieben** oder **Als Spam markieren** rührt sie die E-Mail gar nicht an — stattdessen zeichnet sie die vorgeschlagene Aktion als Protokolleintrag auf.

KI-Regelaktionen werden protokolliert, damit Sie nachvollziehen können, welche Aktion für jede E-Mail angewendet oder vorgeschlagen wurde.

Eine KI-Regel hat keine Bedingungen, die eingeschränkt werden müssten — die oben beschriebenen Regeln für Cc und Absenderadresse gelten für sie deshalb gar nicht, es gibt nichts, das einer Bedingung ähnelt, worauf sie zutreffen könnten. Ihre Absicherung funktioniert anders: Sie legen selbst fest, welche Aktionen sie überhaupt ausführen darf (siehe unten); davon werden alle automatisch angewendet außer **In Papierkorb verschieben** und **Als Spam markieren** — was bei diesen beiden stattdessen passiert, steht unter „Destruktive Aktionen erfordern eine Überprüfung" weiter unten.

### Neue KI-Regeln sind zunächst deaktiviert

Eine neu erstellte KI-Regel ist **standardmäßig deaktiviert**. Aktivieren Sie **„Aktiviert"** für die Regel, nachdem Sie deren Prompt und erlaubte Aktionen überprüft haben, um sie auf eingehende E-Mails anzuwenden. So wird verhindert, dass eine Regel auf Ihren Posteingang einwirkt, bevor Sie bestätigt haben, dass sie sich wie erwartet verhält.

### Limit für aktivierte Regeln pro Konto

Sie können höchstens **20 aktivierte KI-Regeln pro Konto** haben (globale Regeln, die für jedes Konto gelten, zählen zum Limit jedes einzelnen Kontos). Wenn Sie versuchen, eine Regel über dieses Limit hinaus zu aktivieren, zeigt die App eine Meldung an und die Regel bleibt deaktiviert — deaktivieren Sie zuerst eine andere Regel. Diese Begrenzung sorgt dafür, dass die Hintergrundverarbeitung schnell und vorhersehbar bleibt: Alle aktivierten Regeln eines Kontos werden gemeinsam in einem Durchgang ausgewertet.

### Destruktive Aktionen erfordern eine Überprüfung

Umkehrbare Aktionen -- Archivieren, in Ordner verschieben, als gelesen markieren, mit Stern markieren -- werden automatisch angewendet, wenn eine KI-Regel zutrifft. **In Papierkorb verschieben** und **Als Spam markieren** werden niemals automatisch angewendet: Die E-Mail wird nicht angerührt, und die KI zeichnet die vorgeschlagene Aktion stattdessen als Eintrag im Aktionsprotokoll der Regel auf, sodass nichts allein aufgrund einer KI-Regel gelöscht oder als Spam markiert wird. Es gibt keine Schaltfläche, um einen protokollierten Vorschlag auszuführen — wenn Sie ihm zustimmen, erledigen Sie das selbst auf dem üblichen Weg (über die Nachrichtenliste oder deren Kontextmenü).

### Regeln sehen nur ihr eigenes Konto

Eine KI-Regel, die einem bestimmten Konto zugeordnet ist, wertet ausschließlich die E-Mails dieses Kontos aus und wirkt nur auf diese. Sie sieht oder beeinflusst niemals Nachrichten in Ihren anderen Konten.
