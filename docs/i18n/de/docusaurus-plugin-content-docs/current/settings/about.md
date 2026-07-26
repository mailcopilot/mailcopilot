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
- **Installationspfad** — das Verzeichnis, in dem MailCopilot installiert ist. Wenn der Pfad als **schreibgeschützt** markiert ist, handelt es sich um eine systemweite Installation, und automatische Updates erfordern Administratorrechte.

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
- **Update verfügbar: vX.Y.Z** — eine neue Version wurde gefunden; eine Schaltfläche **X.Y.Z herunterladen** erscheint, sofern die Installation selbst aktualisiert werden kann.
- **Wird heruntergeladen… N %** — die Update-Datei wird heruntergeladen; ein Fortschrittsindikator zeigt den Prozentsatz an.
- **Neu starten, um zu installieren** — der Download ist abgeschlossen; klicken Sie, um MailCopilot sofort neu zu starten und das Update anzuwenden.
- **Netzwerkfehler — versuchen Sie es erneut, sobald Sie online sind** — die Prüfung oder der Download ist aufgrund eines Netzwerkproblems fehlgeschlagen.
- **Berechtigung verweigert — Administrator erforderlich** — das Installationsverzeichnis kann vom aktuellen Benutzer nicht beschrieben werden.
- **Update fehlgeschlagen — Details in den Protokollen** — ein unerwarteter Fehler ist aufgetreten; weitere Informationen finden Sie in der Debug-Protokollierung.
- **Updates sind in dieser Version deaktiviert** — MailCopilot läuft im Entwicklungsmodus oder ist nicht gepackt; automatische Updates sind nicht verfügbar.

### Schreibgeschützte Installationen

Wenn MailCopilot systemweit installiert wurde (z. B. über einen Paketmanager, der die Anwendung in ein geschütztes Verzeichnis platziert), ist der **Installationspfad** in den Systeminformationen als **schreibgeschützt** markiert. In diesem Fall gilt:

- Das Kontrollkästchen **Updates automatisch im Hintergrund herunterladen** wird angezeigt, ist jedoch **deaktiviert** (ausgegraut), mit einem Hinweis-Tooltip, dass die Installation schreibgeschützt ist.
- Die Schaltfläche **Nach Updates suchen** **bleibt funktionsfähig** — Sie können weiterhin prüfen, ob eine neue Version verfügbar ist.
- Die Steuerelemente **Herunterladen** und **Neu starten, um zu installieren** sind gesperrt: Sie werden nicht angezeigt oder funktionieren nicht bei schreibgeschützten Installationen, da MailCopilot das Update nicht in ein geschütztes Verzeichnis schreiben kann.

Aktualisieren Sie die Anwendung über Ihren Paketmanager oder mit Administratorrechten.

## Anonyme Fehlerberichte

Wenn aktiviert, sendet MailCopilot anonyme Absturzberichte, um den Entwicklern zu helfen, Fehler zu finden und zu beheben. Es werden keine persönlichen Daten, E-Mail-Inhalte oder Kontoinformationen erfasst — nur technische Fehlerdetails.

Diese Einstellung ist standardmäßig aktiviert. Sie können sie jederzeit deaktivieren, indem Sie das Kontrollkästchen deaktivieren.

## Debug-Protokollierung

Wenn aktiviert, schreibt MailCopilot detaillierte Protokolle in eine Datei zur Fehlerbehebung. Diese Protokolle werden lokal auf Ihrem Computer gespeichert und nie automatisch gesendet.

Die Debug-Protokollierung ist standardmäßig deaktiviert. Aktivieren Sie sie nur bei der Untersuchung eines Problems — sie kann die Leistung geringfügig beeinträchtigen.

## Einen Fehler melden

Klicken Sie auf die Schaltfläche **Einen Fehler melden**, um Feedback direkt an die MailCopilot-Entwickler zu senden. Beschreiben Sie das aufgetretene Problem — das hilft uns, Fehler schneller zu identifizieren und zu beheben.

Ihr Feedback wird sicher über dasselbe anonyme Fehlerberichtssystem gesendet. Wenn Fehlerberichte deaktiviert sind, sehen Sie einen Link zur MailCopilot-Website, wo Sie den Support kontaktieren können.

Wenn die Anwendung auf einen unerwarteten Fehler stößt, erscheint auf dem Fehlerbildschirm ebenfalls ein Feedback-Formular, in dem Sie beschreiben können, was Sie vor dem Fehler getan haben.
