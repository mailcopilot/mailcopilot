---
sidebar_position: 1
title: Allgemeine Einstellungen
---

# Allgemeine Einstellungen

## Theme

Waehlen Sie zwischen **Hell** und **Dunkel**. Die Oberflaeche wird sofort beim Umschalten aktualisiert. Im Dunkelmodus oeffnen sich Fenster von Anfang an mit dunklem Hintergrund — kein weisses Aufblitzen.

## Sprache

6 Sprachen: English, Deutsch, Francais, Espanol, Italiano, Russisch. Sofortiger Wechsel.

## Nachrichtenaufbewahrung

Legt fest, wie lange vollständige Nachrichtenkopien (HTML-Inhalt, eingebettete Bilder und Anhänge) auf der Festplatte aufbewahrt werden. Öffnen Sie **Einstellungen > Allgemein** und wählen Sie aus der Dropdown-Liste **Vollständige Nachrichtenkopie speichern für** einen Zeitraum. Ältere Nachrichten bleiben über ihre Kopfzeilen und ihren Klartext durchsuchbar — nur die erweiterte `.eml`-Datei wird nach Ablauf der Frist gelöscht.

| Option | Dauer |
|--------|-------|
| 30 Tage | ~1 Monat |
| 90 Tage | ~3 Monate |
| 180 Tage | ~6 Monate |
| 1 Jahr | 365 Tage (Standard) |
| Unbegrenzt | Keine automatische Bereinigung |

Wenn Sie den Aufbewahrungszeitraum verkürzen, zeigt MailCopilot eine Vorschau, wie viele zwischengespeicherte Nachrichten entfernt werden, bevor die Änderung angewendet wird. Nachrichten auf dem Server werden nie verändert -- nur die lokale Kopie ist betroffen.

## Standard-E-Mail-Anwendung

Der Schalter legt fest, ob MailCopilot beim Betriebssystem als Handler fuer `mailto:`-Links registriert ist. Wenn aktiviert, oeffnet ein Klick auf einen „E-Mail senden“-Link in Ihrem Browser, Terminal oder einer anderen Desktop-Anwendung das Verfassen-Fenster von MailCopilot mit bereits ausgefuelltem Empfaenger und weiteren Parametern (`to`, `cc`, `bcc`, `subject`, `body`).

Die Registrierung erfolgt nur auf Ihren ausdruecklichen Wunsch -- MailCopilot beansprucht das Protokoll nicht, solange Sie diesen Schalter nicht aktivieren. Unter Linux laeuft die Registrierung ueber die `MimeType`-Deklaration der Desktop-Datei, unter macOS ueber `open-url`, unter Windows ueber den Protokoll-Eintrag unter `HKCR\mailto`. Sie koennen die Registrierung jederzeit rueckgaengig machen, indem Sie den Schalter ausschalten oder in den Systemeinstellungen den Standard-E-Mail-Handler aendern.

Wird MailCopilot ein zweites Mal gestartet -- etwa durch Klick auf einen `mailto:`-Link, waehrend die App bereits laeuft -- wird das bestehende Fenster in den Vordergrund gebracht, statt ein doppeltes Fenster zu oeffnen. Dadurch laeuft jederzeit nur eine Instanz.

## Rechtschreibprüfung

Die Rechtschreibprüfung ist **standardmäßig deaktiviert**. Das Einschalten lädt eine Wörterbuchdatei von einem externen Server herunter (dem Server von Google), und MailCopilot fragt vorher um Erlaubnis -- bei jeder neu hinzugefügten Sprache. Das ist Absicht: MailCopilot schaltet niemals eine Sprache ein, die Sie nicht genehmigt haben. Den Download selbst führt die in die Anwendung eingebaute Browser-Engine (Chromium) aus, die den Server von Google kontaktiert -- MailCopilot kann eine bereits gestartete Anfrage nicht abbrechen. Beginnt trotzdem ein Download für eine nicht genehmigte Sprache, bemerkt MailCopilot das und schaltet die Rechtschreibprüfung wieder aus, statt sie unbemerkt aktiviert zu lassen.

Aktivieren Sie **„Rechtschreibung beim Tippen prüfen“**, um die Prüfung einzuschalten. Falsch geschriebene Wörter werden dann überall unterstrichen, wo Sie Text eingeben können -- beim Verfassen, in Einstellungsfeldern und so weiter.

### Wörterbücher auswählen

Sobald die Rechtschreibprüfung aktiviert ist, fügen Sie über **„Wörterbücher“** eine oder mehrere Sprachen hinzu. Die Liste der verfügbaren Sprachen stammt von der Rechtschreibprüfungs-Engine selbst, nicht von einer festen, in MailCopilot eingebauten Liste -- was Sie sehen, hängt davon ab, was diese Build der Anwendung tatsächlich anbieten kann. Sie können mehrere Sprachen auf einmal hinzufügen; alle werden gleichzeitig geprüft. Jede hinzugefügte Sprache kann über ihre Schaltfläche **„Entfernen“** wieder entfernt werden. Ist „Rechtschreibung beim Tippen prüfen“ aktiviert, aber kein Wörterbuch gewählt, bleibt die Rechtschreibprüfung in der Praxis aus -- ein Wörterbuch ist erforderlich.

Die Anzahl gleichzeitig aktiver Wörterbücher ist begrenzt; die aktuelle Grenze wird neben der Auswahl angezeigt.

### Downloaderlaubnis

Wenn Sie zum ersten Mal eine Sprache hinzufügen, die noch nicht genehmigt wurde, zeigt MailCopilot einen Dialog, der fragt, ob das Wörterbuch dieser Sprache heruntergeladen werden soll, und nennt den externen Server, von dem die Datei stammt. Nichts von dem, was Sie eingeben, wird jemals irgendwohin gesendet -- die Prüfung findet immer auf Ihrem Computer statt; heruntergeladen wird nur die Wörterbuchdatei selbst.

- Die Wahl von **„Herunterladen“** genehmigt die Sprache: MailCopilot merkt sich die Genehmigung und lässt den Download zu. Die Genehmigung bleibt für diese Sprache dauerhaft gültig -- muss das Wörterbuch später erneut heruntergeladen werden (zum Beispiel nach dem erneuten Aktivieren einer bereits genehmigten Sprache), geschieht das, ohne dass Sie erneut gefragt werden.
- Die Wahl von **„Abbrechen“** (oder das Schließen des Dialogs) bedeutet Ablehnung: Diese Sprache wird **nicht** aktiviert, aber die Entscheidung wird nicht als dauerhafte Ablehnung gespeichert -- Sie können dieselbe Sprache später erneut hinzufügen und werden dann einfach erneut gefragt. Alle anderen Änderungen aus demselben Speichervorgang werden trotzdem übernommen: Das Ablehnen eines Wörterbuch-Downloads blockiert nie den Rest Ihrer Änderungen.

### macOS

Unter macOS gehört die Rechtschreibprüfung dem Betriebssystem, nicht MailCopilot. Unter macOS gibt es weder eine Wörterbuchauswahl noch einen Downloaderlaubnis-Dialog, weil macOS nichts herunterlädt und jede Sprachliste ignoriert, die MailCopilot ihm sonst schicken würde -- die Einstellungen erklären dies und zeigen nur den Ein/Aus-Schalter. Um zu ändern, welche Sprachen macOS prüft, öffnen Sie Systemeinstellungen → Tastatur → Texteingabe.

### Ein falsch geschriebenes Wort korrigieren

Klicken Sie mit der rechten Maustaste auf ein als falsch geschrieben unterstrichenes Wort, um eine kurze Liste vorgeschlagener Ersetzungen sowie einen Eintrag **„Zum Wörterbuch hinzufügen“** zu sehen. Ein Klick auf einen Vorschlag ersetzt das Wort; **„Zum Wörterbuch hinzufügen“** fügt das Wort Ihrem persönlichen Wörterbuch hinzu, sodass es nicht mehr markiert wird. Es gibt derzeit keine Möglichkeit, Wörter, die Sie zum persönlichen Wörterbuch hinzugefügt haben, in MailCopilot einzusehen oder zu entfernen.

## Symbol im Infobereich und Hintergrundbetrieb

MailCopilot kann ein Symbol in Ihrem System-Infobereich (Tray) anzeigen. **„Symbol im Infobereich anzeigen“** ist standardmäßig aktiviert; das Menü bietet **„MailCopilot öffnen“**, **„Neue Nachricht“**, **„Nachrichten abrufen“** und **„Beenden“**, und solange das Symbol vorhanden ist, zeigt das Überfahren mit der Maus die Anzahl ungelesener Nachrichten in der Kurzinfo -- bis 999, danach **„999+“**.

### Beim Schließen in den Infobereich minimieren

Aktivieren Sie **„Beim Schließen in den Infobereich minimieren“** (standardmäßig deaktiviert), damit MailCopilot beim Schließen des Hauptfensters weiterläuft, statt beendet zu werden -- die Post wird weiterhin im Hintergrund synchronisiert, und Benachrichtigungen über neue Post treffen weiterhin ein. Um das Fenster zurückzuholen, klicken Sie auf das Symbol im Infobereich (oder auf dessen Menüpunkt **„MailCopilot öffnen“**); verwenden Sie **„Beenden“** im Menü des Symbols, um die Anwendung tatsächlich zu beenden.

Die Wahl von **„Beenden“** entfernt das Symbol im Infobereich nicht sofort. Bevor MailCopilot tatsächlich beendet wird, erstellt es einen Checkpoint seiner lokalen Datenbank -- daher die kurze Verzögerung, normalerweise deutlich weniger als eine Sekunde. Während dieses Vorgangs zeigt die Kurzinfo des Symbols **„Wird beendet…“**, und sein Menü zeigt anstelle der üblichen Optionen einen einzigen inaktiven Eintrag **„Wird beendet…“** -- so erkennen Sie, dass die Anwendung noch beendet wird, statt anzunehmen, „Beenden“ habe nur das Symbol entfernt. War beim Beenden gerade eine Nachricht noch im Versand, geht sie dabei nicht verloren: MailCopilot versendet über eine lokale Warteschlange, sodass ein unvollendeter Versand einfach in der Warteschlange bleibt und beim nächsten Start von MailCopilot ausgeführt wird.

Diese Einstellung hängt davon ab, ob das Symbol erfolgreich erstellt werden konnte, nicht davon, ob es irgendwo angezeigt wird: Unter Linux erstellt MailCopilot das Symbol auch dann, wenn kein Host für den Infobereich es annimmt, sodass **„Beim Schließen in den Infobereich minimieren“** funktioniert, sobald das Symbolobjekt existiert -- unabhängig davon, ob Ihre Arbeitsumgebung es tatsächlich anzeigt. Keine Wirkung hat die Einstellung nur, wenn MailCopilot das Symbol überhaupt nicht erstellen konnte (ein leeres oder nicht lesbares Symbolbild, oder eine Plattform, die die Erstellung verweigert).

MailCopilot prüft vor dem Verbergen des Fensters nicht, ob Ihre Arbeitsumgebung das Symbol wirklich anzeigt -- das entscheidet die Arbeitsumgebung, nicht MailCopilot; ein Hinweis unter der Einstellung weist für Linux darauf hin. Wird das Symbol nie angezeigt, gibt es nichts zum Anklicken, aber das Verbergen bleibt in jedem Fall umkehrbar: Ein erneuter Start von MailCopilot holt das verborgene Fenster wieder in den Vordergrund, egal ob das Symbol funktioniert, falsch dargestellt wird oder nie erschienen ist.

Sind Benachrichtigungen aktiviert, zeigt MailCopilot beim ersten Mal, dass ein Fenster in einer Sitzung beim Schließen in den Infobereich verborgen wird, eine kurze einmalige Benachrichtigung, dass es weiterhin im Hintergrund läuft und dass ein Klick auf das Symbol das Fenster zurückholt.

Wenn Sie MailCopilot einmal in der Erwartung schließen, dass es im Infobereich verbleibt, und es danach nicht mehr finden, lesen Sie [Ich habe das Fenster geschlossen und finde MailCopilot jetzt nicht mehr](../faq#ich-habe-das-fenster-geschlossen-und-finde-mailcopilot-jetzt-nicht-mehr) in den FAQ.

### Symbol für ungelesene Nachrichten

Solange ungelesene Nachrichten vorhanden sind, zeigt MailCopilot ein Abzeichen (Badge) auf dem Anwendungssymbol -- ein numerisches Abzeichen im Dock (macOS) oder im Unity-Starter (Linux) sowie einen Punkt auf der Taskleisten-Schaltfläche (Windows); die Anzahl selbst (bis 999, danach **„999+“**) ist über die Kurzinfo des Symbols im Infobereich verfügbar, solange dieses Symbol vorhanden ist. Das Abzeichen berücksichtigt dieselben Ordner, die Sie in den [Ordnereinstellungen](folders-settings#ungelesen-badges) von der Zählung ungelesener Nachrichten ausgeschlossen haben.

### Beim Anmelden starten

Aktivieren Sie **„Beim Anmelden starten“** (standardmäßig deaktiviert), damit MailCopilot automatisch startet, wenn Sie sich an Ihrem Computer anmelden. Unter Windows und macOS registriert dies MailCopilot als Autostart-Eintrag beim Betriebssystem; unter Linux wird ein Autostart-Eintrag (eine `.desktop`-Datei) erstellt, damit Ihre Desktop-Umgebung MailCopilot bei der Anmeldung startet.

Der Schalter hält fest, was Sie gewünscht haben; ein Hinweis darunter erscheint, sobald das tatsächliche Ergebnis davon abweicht. Kann diese Plattform oder Version den Autostart überhaupt nicht einrichten, teilt MailCopilot mit, dass die Einstellung hier wirkungslos bleibt. Ist das Aktivieren fehlgeschlagen, erklärt ein Hinweis, dass der Autostart nicht eingerichtet werden konnte und beim nächsten Speichern erneut versucht wird. Ist das Deaktivieren fehlgeschlagen, teilt MailCopilot mit, dass die App weiterhin beim Anmelden startet und das Entfernen beim nächsten Speichern automatisch erneut versucht wird -- so denken Sie nie, der Autostart sei ausgeschaltet, obwohl er es nicht ist.

## TLS-Zertifikatvertrauen

MailCopilot prüft jedes TLS-Zertifikat, das Ihre Mailserver vorweisen, sowohl gegen das integrierte Mozilla-Zertifikatspaket als auch gegen den Zertifikatspeicher Ihres Betriebssystems. Dass auch dem Systemspeicher vertraut wird, bedeutet, dass Sicherheitssoftware, die TLS-Verkehr untersucht (zum Beispiel Kaspersky und ähnliche Antivirenprogramme), sowie Unternehmens-Proxys die Mail-Synchronisierung unter Windows, macOS oder Linux nicht mehr unterbrechen -- MailCopilot erkennt die von diesen Tools vorgelegten Zertifikate als gültig an, statt die Verbindung abzulehnen. Die Zertifikatsprüfung wird dadurch nicht abgeschwächt: Ein Zertifikat muss weiterhin von einer dieser beiden Quellen als vertrauenswürdig eingestuft oder explizit gepinnt sein, um akzeptiert zu werden. Kann der Zertifikatspeicher Ihres Betriebssystems nicht gelesen werden, weicht MailCopilot auf das integrierte Mozilla-Paket allein aus, statt die Prüfung zu überspringen.

### Wiederherstellung nach Zertifikatswechsel

Falls ein Server jemals ein Zertifikat vorweist, dem nicht vertraut werden kann -- zum Beispiel weil es nicht mehr mit einem zuvor akzeptierten Zertifikat übereinstimmt oder sich ein selbstsigniertes Zertifikat nach einer Rotation geändert hat -- zeigt MailCopilot den Dialog **„Der Server hat ein anderes Zertifikat vorgelegt“** direkt im Hauptfenster an, nicht nur während der Kontoeinrichtung. Der Dialog listet Server, Aussteller und den SHA-256-Fingerabdruck des neuen Zertifikats auf.

Die Bestätigung erfolgt in bis zu zwei Schritten, damit das, was Sie bestätigen, immer mit dem übereinstimmt, was tatsächlich angezeigt wird:

- Wenn der Fingerabdruck noch nicht gelesen wurde, zeigt die Hauptschaltfläche **„Zertifikat abrufen“** an. Klicken Sie darauf, um das Zertifikat vom Server abzurufen; dessen Details ersetzen dann den Platzhalter im Dialog.
- Sobald ein Fingerabdruck angezeigt wird, lautet die Schaltfläche **„Vertrauen und fortfahren“**. Klicken Sie darauf, um genau das angezeigte Zertifikat zu akzeptieren.
- Ändert sich das Zertifikat des Servers erneut zwischen dem Öffnen des Dialogs und der Bestätigung, weist MailCopilot die veraltete Bestätigung zurück und liest das Zertifikat erneut, um die neuen Details zu zeigen -- aber das Vertrauensangebot dieses Dialogs war an das zuerst gezeigte Zertifikat gebunden, und das erneute Lesen erneuert es nicht: eine wiederholte Bestätigung schlägt daher genauso fehl. Klicken Sie auf **„Abbrechen“**, um diesen Dialog zu schließen, und lassen Sie MailCopilot die Verbindung erneut versuchen; es erscheint ein neuer Dialog mit dem aktuellen Zertifikat, den Sie dann bestätigen. In der Zwischenzeit wird nichts vertraut.

Wählen Sie jederzeit **„Abbrechen“**, um den vorherigen Zustand beizubehalten. Derselbe Server zeigt diesen Dialog nicht öfter als einmal pro Minute erneut an. Das Vertrauensangebot des Dialogs bleibt ebenfalls nicht unbegrenzt offen -- wenn er sehr lange unbeantwortet stehen blieb, kann eine Bestätigung abgelehnt werden; auch hier abbrechen und auf einen neuen Dialog warten.

### Erneutes Bestätigen eines gepinnten selbstsignierten Servers nach einem Update

Zertifikat-Pinning wird jetzt strikt durchgesetzt für Zertifikate, die die normale Kettenprüfung nicht bestehen: bisher verglich Pinning Fingerabdrücke nur bei Zertifikaten, deren Kette bereits normal verifiziert wurde, während selbstsignierte Zertifikate und Zertifikate privater Zertifizierungsstellen -- genau der Fall, für den Pinning existiert -- die Fingerabdruckprüfung vollständig umgingen. Diese Lücke ist nun geschlossen. Wenn Sie einen selbstsignierten Server oder einen Server mit privater Zertifizierungsstelle vor dieser Änderung gepinnt haben, enthält der gespeicherte Pin möglicherweise nur einen Fingerabdruck ohne das für die tatsächliche Verifizierung nötige Zertifikat -- ein solcher Server hört nach dem Update auf, sich zu verbinden, und MailCopilot zeigt den oben beschriebenen Dialog zur Zertifikatswiederherstellung an.

Um dies zu beheben, bestätigen Sie das Zertifikat erneut über genau diesen Dialog: Zeigt die Schaltfläche **„Zertifikat abrufen“**, klicken Sie zuerst darauf, um das Zertifikat abzurufen, und dann auf **„Vertrauen und fortfahren“**; wird bereits **„Vertrauen und fortfahren“** angezeigt, klicken Sie nur darauf. Dadurch wird der Pin zusammen mit dem Zertifikat selbst gespeichert, und die Synchronisierung wird automatisch fortgesetzt. Dies müssen Sie nur einmal pro betroffenem Server tun. Das manuelle Hinzufügen oder Bearbeiten eines Pins in den **Einstellungen** behebt dies nicht von selbst -- bei einem Zertifikat, das sonst nicht vertrauenswürdig ist (selbstsigniert oder von einer privaten Zertifizierungsstelle, die noch nicht im Zertifikatspeicher Ihres Betriebssystems vorhanden ist), kann nur der Wiederherstellungsdialog Vertrauen gewähren; siehe [Wann Zertifikat-Pinning verwenden](#wann-zertifikat-pinning-verwenden) weiter unten für den Grund.

### Hinweis auf Untersuchung

Nach der ersten erfolgreichen Synchronisierung eines Kontos in einer Sitzung prüft MailCopilot einmalig, ob dessen Mailserver-Verbindung von einem Antivirenprogramm oder Proxy untersucht wird (das Zertifikat wird nur über den Systemspeicher als vertrauenswürdig eingestuft), und zeigt gegebenenfalls einen Hinweis wie „Die Verbindung zu `{{host}}` wird geprüft.“ an, mit Nennung des Ausstellers, sofern bekannt. Diese Prüfung läuft höchstens einmal pro Server für die gesamte Lebensdauer Ihres Profils -- unabhängig davon, ob eine Untersuchung gefunden wurde. Wird eine Untersuchung auf einem Server also erst *nach* dieser bereits ergebnislos gelaufenen einmaligen Prüfung eingerichtet, bemerkt MailCopilot das nicht. Der Hinweis kann geschlossen werden.

Zertifikatsfehler werden in einem langen Intervall (6 Stunden) erneut versucht, statt im kurzen Intervall für gewöhnliche Netzwerkfehler, da sie Ihre Entscheidung erfordern und sich nicht von selbst auflösen.

## TLS-Zertifikat-Pinning

TLS-Zertifikat-Pinning fügt eine zusätzliche Sicherheitsebene für Ihre E-Mail-Verbindungen hinzu. Es stellt sicher, dass sich Ihr Client nur mit Servern verbindet, die ein bestimmtes Zertifikat vorweisen, und schützt so vor Man-in-the-Middle-Angriffen.

### Verwaltung der gepinnten Zertifikate

1. Öffnen Sie die **Einstellungen** und gehen Sie zum Abschnitt **Konten**.
2. Klicken Sie auf **Bearbeiten** bei einem Konto, um dessen Einstellungen zu öffnen.
3. Scrollen Sie nach unten zum Abschnitt **TLS-Zertifikat-Pinning**.

Der Abschnitt zeigt eine Tabelle der gepinnten Zertifikate mit Host, Port, Fingerabdruck und dem Datum der Hinzufügung.

### Einen Pin hinzufügen

1. Klicken Sie auf **Pin hinzufügen**.
2. Geben Sie den **Host** (z.B. `imap.gmail.com`) und den **Port** (z.B. `993`) ein.
3. Klicken Sie auf **Abrufen und anheften**. MailCopilot verbindet sich mit dem Server, ruft dessen Zertifikat ab und zeigt Ihnen den Fingerabdruck.
4. Bestätigen Sie, um den Pin zu speichern.

Ein auf diese Weise hinzugefügter Pin *schränkt* nur ein, welches Zertifikat für einen bereits über das übliche Mozilla-Paket oder Ihren Betriebssystem-Zertifikatspeicher vertrauenswürdigen Server akzeptiert wird -- er macht ein sonst nicht vertrauenswürdiges selbstsigniertes Zertifikat oder ein Zertifikat einer privaten Zertifizierungsstelle nicht von selbst vertrauenswürdig. Bei einem selbstsignierten Mailserver (oder einem mit privater Zertifizierungsstelle, die noch nicht im Zertifikatspeicher Ihres Betriebssystems vorhanden ist) reicht das Hinzufügen eines Pins hier nicht aus, um sich zu verbinden; Sie müssen ihn über den in [TLS-Zertifikatvertrauen](#tls-zertifikatvertrauen) beschriebenen Wiederherstellungsdialog bestätigen -- nur dort gewährt MailCopilot einem solchen Zertifikat Vertrauen.

### Einen Pin entfernen

Klicken Sie auf die Schaltfläche zum Löschen neben einem Pin in der Tabelle, um ihn zu entfernen. Dadurch wird nur der gespeicherte Pin entfernt -- danach akzeptiert MailCopilot jedes gültige Zertifikat von diesem Server.

Das Hinzufügen eines Pins verbindet MailCopilot automatisch erneut mit dem Mailserver, damit die Änderung sofort wirksam wird. Das Entfernen eines Pins löst keine automatische Neuverbindung aus -- die Änderung wirkt sich erst bei der nächsten Verbindung von MailCopilot zu diesem Server aus.

### STARTTLS-Server (Ports 143 und 587)

Server, die über STARTTLS erreicht werden (typischerweise IMAP-Port 143 oder SMTP-Port 587, wo die Verbindung im Klartext beginnt und dann auf TLS umschaltet), geben ihr Zertifikat an dem Punkt, an dem MailCopilot es für das Pinning erfasst, nicht heraus. Für solche Server wird nur der Fingerabdruck gespeichert, nicht das Zertifikat selbst -- ein selbstsignierter STARTTLS-Server oder ein Server mit privater Zertifizierungsstelle kann auf diese Weise also nicht nutzbar gemacht werden; verwenden Sie implizites TLS (typischerweise Port 993 für IMAP, 465 für SMTP), falls Ihr Server dies unterstützt.

### Wann Zertifikat-Pinning verwenden

Zertifikat-Pinning ist besonders nützlich für Unternehmensumgebungen oder Situationen, in denen Sie sicherstellen müssen, dass Ihre E-Mail-Verbindungen zu den erwarteten Servern gehen. Für die meisten privaten Nutzer ist die Standard-TLS-Verifizierung ausreichend.
