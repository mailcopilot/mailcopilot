---
sidebar_position: 6
title: Über
---

# Über

Die Registerkarte **Über** in den Einstellungen zeigt Informationen über Ihre MailCopilot-Installation und bietet Steuerelemente für die Diagnose und Updates.

## Version

Zeigt die aktuelle Version von MailCopilot an, die auf Ihrem Computer installiert ist.

## Links

- **Webseite** — öffnet die MailCopilot-Webseite in Ihrem Browser.
- **Dokumentation** — öffnet diese Dokumentationsseite.

## Systeminformationen

Das Panel **Systeminformationen** zeigt technische Details über Ihre Installation:

- **App-Version** — die aktuelle MailCopilot-Version und der Veröffentlichungskanal (stable, nightly oder dev).
- **Electron** — die Version der von MailCopilot verwendeten Electron-Laufzeitumgebung.
- **Chromium** — die Version der in Electron integrierten Chromium-Engine.
- **Node.js** — die innerhalb der Anwendung verwendete Node.js-Version.
- **Plattform** — das Betriebssystem und die Architektur.
- **Installationspfad** — der Pfad zur gerade laufenden ausführbaren Datei (`process.execPath`). Unter Windows und macOS ist dies der tatsächliche Installationsort von MailCopilot. Bei einer AppImage zeigt `execPath` auf einen temporären Ort `/tmp/.mount_*`, der erstellt wird, solange die App läuft, nicht auf den Ort der `.AppImage`-Datei selbst — die Markierung **schreibgeschützt** spiegelt die Schreibbarkeit des tatsächlichen Ordners der AppImage-Datei wider, nicht die des hier angezeigten Pfads. Diese Markierung erscheint nie bei `.deb`/`.rpm`/pacman-Installationen — diese schreiben Updates mit Administratorrechten, statt sich auf Ordnerberechtigungen zu verlassen.

Diese Informationen sind nützlich, wenn Sie Fehler melden oder die Kompatibilität prüfen.

## Updates

Der Abschnitt **Updates** ermöglicht Ihnen, zu steuern, wie MailCopilot sich selbst aktualisiert.

### Updates automatisch im Hintergrund herunterladen

Wenn diese Option aktiviert ist, lädt MailCopilot neue Versionen automatisch herunter, sobald sie verfügbar sind. Sobald ein Download abgeschlossen ist, werden Sie aufgefordert, die Anwendung neu zu starten, um das Update anzuwenden. Es sind keine weiteren Aktionen erforderlich, bis Sie bereit zum Neustart sind.

Wenn diese Option deaktiviert ist, benachrichtigt MailCopilot Sie über verfügbare Updates und zeigt eine Schaltfläche **Herunterladen** an. Sie entscheiden genau, wann der Download beginnt.

Diese Einstellung ist **standardmäßig deaktiviert** (muss explizit aktiviert werden). Aktivieren Sie sie, damit MailCopilot Updates ohne manuelle Eingabe herunterlädt.

### Nach Updates suchen

Klicken Sie auf die Schaltfläche **Nach Updates suchen**, um jederzeit manuell eine Updateprüfung auszulösen. Die Schaltfläche und der Statusbereich spiegeln den aktuellen Stand des Update-Prozesses wider:

- **inaktiv** — die Schaltfläche **Nach Updates suchen** ist sichtbar und einsatzbereit.
- **Wird geprüft…** — eine Updateprüfung wird durchgeführt; die Schaltfläche ist deaktiviert, bis die Prüfung abgeschlossen ist.
- **Sie haben die neueste Version** — kein Update verfügbar.
- **verfügbar** — eine neue Version wurde gefunden: neben der Versionsnummer oben erscheint ein Hinweis **(neueste verfügbare Version X.Y.Z)**, und — sofern die Installation selbst aktualisiert werden kann — erscheint hier eine Schaltfläche **X.Y.Z herunterladen**.
- **Wird heruntergeladen… N %** — die Update-Datei wird heruntergeladen; ein Fortschrittsindikator zeigt den Prozentsatz an.
- **Neu starten, um zu installieren** — der Download ist abgeschlossen; klicken Sie, um MailCopilot sofort neu zu starten und das Update anzuwenden.
- **Netzwerkfehler — versuchen Sie es erneut, sobald Sie online sind** — die Prüfung oder der Download ist aufgrund eines Netzwerkproblems fehlgeschlagen.
- **Berechtigung verweigert — Administrator erforderlich** — der Update-Mechanismus oder das Betriebssystem hat den Zugriff verweigert. Bei Installationen, die Administratorrechte nutzen (`.deb`/`.rpm`/pacman), bedeutet das meist, dass der Rechteerhöhungsschritt oder der Paketinstallationsschritt fehlgeschlagen ist — nicht, dass ein Ordner nicht beschreibbar ist.
- **Update fehlgeschlagen — Details in den Protokollen** — ein unerwarteter Fehler ist aufgetreten; weitere Informationen finden Sie in der Debug-Protokollierung.
- **Updates sind in dieser Version deaktiviert** — MailCopilot läuft im Entwicklungsmodus oder ist nicht gepackt; automatische Updates sind nicht verfügbar.

### Wenn Selbstaktualisierung nicht verfügbar ist

MailCopilot kann sich normalerweise auf jeder unterstützten Plattform selbst aktualisieren: Eine AppImage-Installation ersetzt die `.AppImage`-Datei selbst, und eine `.deb`/`.rpm`/pacman-Installation lässt den Update-Mechanismus den Schreibvorgang versuchen, indem sie Administratorrechte anfordert (`pkexec`/`sudo`) — genau wie es `apt`/`dnf`/`pacman` tun würden. Das tatsächliche Ergebnis bei diesen paketbasierten Linux-Installationen entscheiden die Rechteerhöhungsabfrage und der Paketmanager, nicht MailCopilot — ein Fehlschlag dabei zeigt einen Dialog **Update installation failed** („Update-Installation fehlgeschlagen“) mit einem Link zur Download-Seite, nicht stillschweigend.

MailCopilot entscheidet nur in zwei Fällen im Voraus, dass Selbstaktualisierung nicht verfügbar ist:

- **Die Version ist nicht gepackt** — eine Entwicklungs- oder CI-Version. In diesem Fall gibt es überhaupt keinen Update-Mechanismus: Die Schaltfläche **Nach Updates suchen** und der Statusbereich erscheinen nicht, stattdessen zeigt ein Hinweis **„Updates sind in dieser Version deaktiviert“**.
- **Die Version ist gepackt, aber MailCopilot hat einen konkreten Grund zu erwarten, dass der Schreibvorgang fehlschlagen würde** — das ist der Fall, wenn:
  - die Linux-Version weder eine AppImage noch ein unterstütztes Systempaket ist — zum Beispiel eine entpackte AppImage oder ein rohes `linux-unpacked`-Verzeichnis, oder
  - das Verzeichnis, in das MailCopilot schreiben müsste, für Ihr Benutzerkonto nicht beschreibbar ist. Bei einer AppImage ist das der Ordner, in dem die `.AppImage`-Datei liegt; unter Windows und macOS ist es der Ordner, in dem die installierte ausführbare Datei liegt. Diese Prüfung gilt nicht für `.deb`/`.rpm`/pacman-Installationen, da der Update-Mechanismus dort stattdessen Rechte erhöht.

Im zweiten Fall funktioniert die Update-Prüfung weiterhin normal — betroffen ist nur das Schreiben des Updates an Ort und Stelle:

- Die Schaltfläche **Nach Updates suchen** bleibt verfügbar und funktioniert — Sie können jederzeit prüfen, ob eine neue Version existiert.
- Das Kontrollkästchen **Updates automatisch im Hintergrund herunterladen** bleibt verfügbar und speichert Ihre Einstellung weiterhin, aber es wird nichts automatisch heruntergeladen, solange Selbstaktualisierung nicht möglich ist.
- Neben dem Kontrollkästchen erscheint ein Hinweis, der den Grund erklärt — zum Beispiel: „Diese Version kann sich nicht selbst ersetzen (sie läuft weder als AppImage noch als Systempaket). Laden Sie die neue Version manuell von der Website herunter.“ oder „Der Ordner mit der App ist nicht beschreibbar, daher kann das Update nicht an Ort und Stelle installiert werden. Laden Sie die neue Version manuell herunter oder verschieben Sie die App in einen eigenen Ordner.“ Wenn MailCopilot den konkreten Grund nicht bestimmen kann, erscheint stattdessen ein neutraler Hinweis: „Diese Installation kann sich nicht automatisch aktualisieren. Laden Sie die neue Version manuell von der Website herunter.“
- Die Steuerelemente **Herunterladen** und **Neu starten, um zu installieren** erscheinen nicht, da MailCopilot keine Möglichkeit hat, das Update selbst zu schreiben.

Diese Prüfung läuft einmal, beim Start von MailCopilot. Wenn Sie die AppImage-Datei an einen beschreibbaren Ort verschieben oder die Berechtigungen des Installationsordners ändern, beenden Sie MailCopilot und starten Sie es neu, damit die Änderung wirksam wird — eine bereits laufende Instanz behält ihr ursprüngliches Ergebnis bei.

Aktualisieren Sie die Anwendung über Ihren Paketmanager, mit Administratorrechten oder indem Sie die neue Version manuell von der Website herunterladen.

## Diagnose- und Nutzungsdaten

Wenn aktiviert, sendet MailCopilot Absturzberichte, Leistungsmessungen, Nutzungsereignisse (welche Funktionen verwendet werden, welcher KI-Anbieter und welches Modell, die geschätzten Kosten einer Anfrage) sowie eine zufällige Installationskennung, die Ihre Sitzungen verbindet. Nachrichteninhalte und Ihr Suchtext sind darin nie enthalten; Adressen, Betreffzeilen und Ordnernamen sind vollständig ausgeschlossen, wo die Diagnose eine geschlossene Feldliste verwendet (wie bei der Sent-Kopie-Diagnose), und werden andernorts durch eine formbasierte Bereinigung nach bestem Bemühen abgefangen -- ein Sicherheitsnetz, keine Garantie. Das Feedback-Formular unten ist die einzige Stelle, an der absichtlich eine Adresse gesendet wird, damit Sie eine Antwort erhalten können; überall sonst wird eine Adresse nur bereinigt, nicht garantiert ausgeschlossen -- und weil die Installationskennung enthalten ist, sind diese Daten nicht vollständig anonym. Die vollständige Liste dessen, was gesendet wird und was nie gesendet wird, finden Sie unter [Telemetrie](../privacy/telemetry).

Diese Einstellung spiegelt die Antwort wider, die Sie beim ersten Start von MailCopilot auf dem Zustimmungsbildschirm gegeben haben, und ist **standardmäßig deaktiviert** — es wird nichts gesendet, bis Sie aktiv zugestimmt haben. Sie können Ihre Entscheidung jederzeit ändern, indem Sie das Kontrollkästchen aktivieren oder deaktivieren.

Wenn MailCopilot keine Antwort auf die anfängliche Zustimmungsfrage vorliegen hat — zum Beispiel unmittelbar nachdem sich die Liste der erhobenen Daten geändert hat und eine erneute Nachfrage fällig wird —, wird das Kontrollkästchen hier deaktiviert und nicht angehakt angezeigt, mit einem Hinweis, dass die Diagnose ausgeschaltet bleibt, bis Sie beim nächsten Start auf dem Zustimmungsbildschirm antworten.

## Debug-Protokollierung

Wenn aktiviert, schreibt MailCopilot detaillierte Protokolle in eine Datei zur Fehlerbehebung. Diese Protokolle werden lokal auf Ihrem Computer gespeichert und nie automatisch gesendet.

Die Debug-Protokollierung ist standardmäßig deaktiviert. Aktivieren Sie sie nur bei der Untersuchung eines Problems — sie kann die Leistung geringfügig beeinträchtigen.

MailCopilot entscheidet nur einmal, beim Start, ob diese Datei geschrieben wird -- anhand des Werts dieser Einstellung zu diesem Zeitpunkt; das Aktivieren wirkt sich erst nach einem Neustart von MailCopilot aus. In einer installierten Kopie der Anwendung existiert überhaupt keine Protokolldatei, bis Sie diese Option aktiviert und mindestens einmal neu gestartet haben -- gehen Sie also einem Problem nach, aktivieren Sie diese Einstellung, starten Sie neu und versuchen Sie erst danach, das Problem zu reproduzieren. Die Datei erfasst ausschließlich, was im Hauptprozess von MailCopilot geschieht; Diagnoseausgaben, die innerhalb eines bestimmten Fensters entstehen -- das, was Sie in der Entwicklerkonsole dieses Fensters sehen würden -- werden hier nicht geschrieben.

## Einen Fehler melden

Klicken Sie auf die Schaltfläche **Einen Fehler melden**, um Feedback direkt an die MailCopilot-Entwickler zu senden. Beschreiben Sie das aufgetretene Problem — das hilft uns, Fehler schneller zu identifizieren und zu beheben.

Ihr Feedback wird sicher über dasselbe oben beschriebene Diagnose-Meldesystem gesendet. Wenn Fehlerberichte deaktiviert sind, sehen Sie einen Link zur MailCopilot-Website, wo Sie den Support kontaktieren können.

Wenn die Anwendung auf einen unerwarteten Fehler stößt, erscheint auf dem Fehlerbildschirm ebenfalls ein Feedback-Formular, in dem Sie beschreiben können, was Sie vor dem Fehler getan haben.
