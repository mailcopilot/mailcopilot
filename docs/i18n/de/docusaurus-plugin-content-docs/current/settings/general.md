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

Der Schalter legt fest, ob MailCopilot beim Betriebssystem als Handler fuer `mailto:`-Links registriert ist. Wenn aktiviert, oeffnet ein Klick auf einen „E-Mail senden"-Link in Ihrem Browser, Terminal oder einer anderen Desktop-Anwendung das Verfassen-Fenster von MailCopilot mit bereits ausgefuelltem Empfaenger und weiteren Parametern (`to`, `cc`, `bcc`, `subject`, `body`).

Die Registrierung erfolgt nur auf Ihren ausdruecklichen Wunsch -- MailCopilot beansprucht das Protokoll nicht, solange Sie diesen Schalter nicht aktivieren. Unter Linux laeuft die Registrierung ueber die `MimeType`-Deklaration der Desktop-Datei, unter macOS ueber `open-url`, unter Windows ueber den Protokoll-Eintrag unter `HKCR\mailto`. Sie koennen die Registrierung jederzeit rueckgaengig machen, indem Sie den Schalter ausschalten oder in den Systemeinstellungen den Standard-E-Mail-Handler aendern.

Wird MailCopilot ein zweites Mal gestartet -- etwa durch Klick auf einen `mailto:`-Link, waehrend die App bereits laeuft -- wird das bestehende Fenster in den Vordergrund gebracht, statt ein doppeltes Fenster zu oeffnen. Dadurch laeuft jederzeit nur eine Instanz.

## TLS-Zertifikatvertrauen

MailCopilot prüft jedes TLS-Zertifikat, das Ihre Mailserver vorweisen, sowohl gegen das integrierte Mozilla-Zertifikatspaket als auch gegen den Zertifikatspeicher Ihres Betriebssystems. Dass auch dem Systemspeicher vertraut wird, bedeutet, dass Sicherheitssoftware, die TLS-Verkehr untersucht (zum Beispiel Kaspersky und ähnliche Antivirenprogramme), sowie Unternehmens-Proxys die Mail-Synchronisierung unter Windows, macOS oder Linux nicht mehr unterbrechen -- MailCopilot erkennt die von diesen Tools vorgelegten Zertifikate als gültig an, statt die Verbindung abzulehnen. Die Zertifikatsprüfung wird dadurch nicht abgeschwächt: Ein Zertifikat muss weiterhin von einer dieser beiden Quellen als vertrauenswürdig eingestuft oder explizit gepinnt sein, um akzeptiert zu werden. Kann der Zertifikatspeicher Ihres Betriebssystems nicht gelesen werden, weicht MailCopilot auf das integrierte Mozilla-Paket allein aus, statt die Prüfung zu überspringen.

### Wiederherstellung nach Zertifikatswechsel

Falls ein Server jemals ein Zertifikat vorweist, dem nicht vertraut werden kann -- zum Beispiel weil es nicht mehr mit einem zuvor akzeptierten Zertifikat übereinstimmt oder sich ein selbstsigniertes Zertifikat nach einer Rotation geändert hat -- zeigt MailCopilot den Dialog **„Der Server hat ein anderes Zertifikat vorgelegt“** direkt im Hauptfenster an, nicht nur während der Kontoeinrichtung. Der Dialog listet Server, Aussteller und den SHA-256-Fingerabdruck des neuen Zertifikats auf.

Die Bestätigung erfolgt in bis zu zwei Schritten, damit das, was Sie bestätigen, immer mit dem übereinstimmt, was tatsächlich angezeigt wird:

- Wenn der Fingerabdruck noch nicht gelesen wurde, zeigt die Hauptschaltfläche **„Zertifikat lesen“** an. Klicken Sie darauf, um das Zertifikat vom Server abzurufen; dessen Details ersetzen dann den Platzhalter im Dialog.
- Sobald ein Fingerabdruck angezeigt wird, lautet die Schaltfläche **„Vertrauen und fortfahren“**. Klicken Sie darauf, um genau das angezeigte Zertifikat zu akzeptieren.
- Ändert sich das Zertifikat des Servers erneut zwischen dem Öffnen des Dialogs und der Bestätigung, weist MailCopilot die veraltete Bestätigung zurück und liest das Zertifikat erneut, um die neuen Details zu zeigen -- aber das Vertrauensangebot dieses Dialogs war an das zuerst gezeigte Zertifikat gebunden, und das erneute Lesen erneuert es nicht: eine wiederholte Bestätigung schlägt daher genauso fehl. Klicken Sie auf **„Abbrechen“**, um diesen Dialog zu schließen, und lassen Sie MailCopilot die Verbindung erneut versuchen; es erscheint ein neuer Dialog mit dem aktuellen Zertifikat, den Sie dann bestätigen. In der Zwischenzeit wird nichts vertraut.

Wählen Sie jederzeit **„Abbrechen“**, um den vorherigen Zustand beizubehalten. Derselbe Server zeigt diesen Dialog nicht öfter als einmal pro Minute erneut an. Das Vertrauensangebot des Dialogs bleibt ebenfalls nicht unbegrenzt offen -- wenn er sehr lange unbeantwortet stehen blieb, kann eine Bestätigung abgelehnt werden; auch hier abbrechen und auf einen neuen Dialog warten.

### Erneutes Bestätigen eines gepinnten selbstsignierten Servers nach einem Update

Zertifikat-Pinning wird jetzt strikt durchgesetzt für Zertifikate, die die normale Kettenprüfung nicht bestehen: bisher verglich Pinning Fingerabdrücke nur bei Zertifikaten, deren Kette bereits normal verifiziert wurde, während selbstsignierte Zertifikate und Zertifikate privater Zertifizierungsstellen -- genau der Fall, für den Pinning existiert -- die Fingerabdruckprüfung vollständig umgingen. Diese Lücke ist nun geschlossen. Wenn Sie einen selbstsignierten Server oder einen Server mit privater Zertifizierungsstelle vor dieser Änderung gepinnt haben, enthält der gespeicherte Pin möglicherweise nur einen Fingerabdruck ohne das für die tatsächliche Verifizierung nötige Zertifikat -- ein solcher Server hört nach dem Update auf, sich zu verbinden, und MailCopilot zeigt den oben beschriebenen Dialog zur Zertifikatswiederherstellung an.

Um dies zu beheben, bestätigen Sie das Zertifikat erneut über genau diesen Dialog: Zeigt die Schaltfläche **„Zertifikat lesen“**, klicken Sie zuerst darauf, um das Zertifikat abzurufen, und dann auf **„Vertrauen und fortfahren“**; wird bereits **„Vertrauen und fortfahren“** angezeigt, klicken Sie nur darauf. Dadurch wird der Pin zusammen mit dem Zertifikat selbst gespeichert, und die Synchronisierung wird automatisch fortgesetzt. Dies müssen Sie nur einmal pro betroffenem Server tun. Das manuelle Hinzufügen oder Bearbeiten eines Pins in den **Einstellungen** behebt dies nicht von selbst -- bei einem Zertifikat, das sonst nicht vertrauenswürdig ist (selbstsigniert oder von einer privaten Zertifizierungsstelle, die noch nicht im Zertifikatspeicher Ihres Betriebssystems vorhanden ist), kann nur der Wiederherstellungsdialog Vertrauen gewähren; siehe [Wann Zertifikat-Pinning verwenden](#wann-zertifikat-pinning-verwenden) weiter unten für den Grund.

### Hinweis auf Untersuchung

Nach der ersten erfolgreichen Synchronisierung eines Kontos in einer Sitzung prüft MailCopilot einmalig, ob dessen Mailserver-Verbindung von einem Antivirenprogramm oder Proxy untersucht wird (das Zertifikat wird nur über den Systemspeicher als vertrauenswürdig eingestuft), und zeigt gegebenenfalls einen Hinweis wie „Die Verbindung zu `{host}` wird überprüft.“ an, mit Nennung des Ausstellers, sofern bekannt. Diese Prüfung läuft höchstens einmal pro Server für die gesamte Lebensdauer Ihres Profils -- unabhängig davon, ob eine Untersuchung gefunden wurde. Wird eine Untersuchung auf einem Server also erst *nach* dieser bereits ergebnislos gelaufenen einmaligen Prüfung eingerichtet, bemerkt MailCopilot das nicht. Der Hinweis kann geschlossen werden.

Zertifikatsfehler werden in einem langen Intervall (6 Stunden) erneut versucht, statt im kurzen Intervall für gewöhnliche Netzwerkfehler, da sie Ihre Entscheidung erfordern und sich nicht von selbst auflösen.

## TLS-Zertifikat-Pinning

TLS-Zertifikat-Pinning fügt eine zusätzliche Sicherheitsebene für Ihre E-Mail-Verbindungen hinzu. Es stellt sicher, dass sich Ihr Client nur mit Servern verbindet, die ein bestimmtes Zertifikat vorweisen, und schützt so vor Man-in-the-Middle-Angriffen.

### Verwaltung der gepinnten Zertifikate

1. Öffnen Sie die **Einstellungen** und gehen Sie zum Abschnitt **Konten**.
2. Klicken Sie auf **Bearbeiten** bei einem Konto, um dessen Einstellungen zu öffnen.
3. Scrollen Sie nach unten zum Abschnitt **TLS-Zertifikat-Pinning**.

Der Abschnitt zeigt eine Tabelle der gepinnten Zertifikate mit Host, Port, Fingerabdruck und dem Datum der Hinzufügung.

### Einen Pin hinzufügen

1. Klicken Sie auf **Add pin** (Pin hinzufügen).
2. Geben Sie den **Host** (z.B. `imap.gmail.com`) und den **Port** (z.B. `993`) ein.
3. Klicken Sie auf **Abrufen und pinnen**. MailCopilot verbindet sich mit dem Server, ruft dessen Zertifikat ab und zeigt Ihnen den Fingerabdruck.
4. Bestätigen Sie, um den Pin zu speichern.

Ein auf diese Weise hinzugefügter Pin *schränkt* nur ein, welches Zertifikat für einen bereits über das übliche Mozilla-Paket oder Ihren Betriebssystem-Zertifikatspeicher vertrauenswürdigen Server akzeptiert wird -- er macht ein sonst nicht vertrauenswürdiges selbstsigniertes Zertifikat oder ein Zertifikat einer privaten Zertifizierungsstelle nicht von selbst vertrauenswürdig. Bei einem selbstsignierten Mailserver (oder einem mit privater Zertifizierungsstelle, die noch nicht im Zertifikatspeicher Ihres Betriebssystems vorhanden ist) reicht das Hinzufügen eines Pins hier nicht aus, um sich zu verbinden; Sie müssen ihn über den in [TLS-Zertifikatvertrauen](#tls-zertifikatvertrauen) beschriebenen Wiederherstellungsdialog bestätigen -- nur dort gewährt MailCopilot einem solchen Zertifikat Vertrauen.

### Einen Pin entfernen

Klicken Sie auf die Schaltfläche zum Löschen neben einem Pin in der Tabelle, um ihn zu entfernen. Dadurch wird nur der gespeicherte Pin entfernt -- danach akzeptiert MailCopilot jedes gültige Zertifikat von diesem Server.

Das Hinzufügen eines Pins verbindet MailCopilot automatisch erneut mit dem Mailserver, damit die Änderung sofort wirksam wird. Das Entfernen eines Pins löst keine automatische Neuverbindung aus -- die Änderung wirkt sich erst bei der nächsten Verbindung von MailCopilot zu diesem Server aus.

### STARTTLS-Server (Ports 143 und 587)

Server, die über STARTTLS erreicht werden (typischerweise IMAP-Port 143 oder SMTP-Port 587, wo die Verbindung im Klartext beginnt und dann auf TLS umschaltet), geben ihr Zertifikat an dem Punkt, an dem MailCopilot es für das Pinning erfasst, nicht heraus. Für solche Server wird nur der Fingerabdruck gespeichert, nicht das Zertifikat selbst -- ein selbstsignierter STARTTLS-Server oder ein Server mit privater Zertifizierungsstelle kann auf diese Weise also nicht nutzbar gemacht werden; verwenden Sie implizites TLS (typischerweise Port 993 für IMAP, 465 für SMTP), falls Ihr Server dies unterstützt.

### Wann Zertifikat-Pinning verwenden

Zertifikat-Pinning ist besonders nützlich für Unternehmensumgebungen oder Situationen, in denen Sie sicherstellen müssen, dass Ihre E-Mail-Verbindungen zu den erwarteten Servern gehen. Für die meisten privaten Nutzer ist die Standard-TLS-Verifizierung ausreichend.
