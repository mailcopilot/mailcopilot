---
sidebar_position: 7
title: FAQ
---

# Haeufig gestellte Fragen

## Was ist MailCopilot?

Ein moderner Desktop-E-Mail-Client mit IMAP/SMTP-Unterstuetzung, gebaut fuer Geschwindigkeit und Datenschutz.

## Welche Plattformen werden unterstuetzt?

Derzeit **Linux** (AppImage). Windows und macOS sind geplant.

## Wo werden Passwoerter gespeichert?

Im System-Schluesselring (keytar), niemals im Klartext.

## Welche Anbieter sind kompatibel?

Alle IMAP/SMTP-Anbieter: Gmail, Outlook, Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail (ueber Bridge), selbst gehostete Server.

## Kann ich mehrere Konten nutzen?

Ja, mit Wechsel in der Seitenleiste oder dem vereinheitlichten Posteingang.

## Der Verbindungstest zeigt einen TLS-Zertifikatfehler. Was soll ich tun?

MailCopilot prueft immer TLS-Zertifikate und gleicht sie sowohl mit dem integrierten Mozilla-Zertifikatspaket als auch mit dem Zertifikatspeicher Ihres Betriebssystems ab. Wenn Ihr Mailserver ein selbstsigniertes oder benutzerdefiniertes Zertifikat verwendet, erscheint eine Vertrauensabfrage. Pruefen Sie die Zertifikatsdetails und akzeptieren Sie es, wenn Sie sicher sind, dass der Server legitim ist. Wenn der Fingerabdruck noch nicht gelesen wurde, zeigt die Hauptschaltflaeche zunaechst **„Zertifikat lesen"** an -- klicken Sie darauf, pruefen Sie das Ergebnis, und klicken Sie dann zur Bestaetigung auf **„Vertrauen und fortfahren"**.

## Mein Antivirenprogramm oder Unternehmens-Proxy untersucht meine Mailverbindung. Funktioniert MailCopilot trotzdem?

Ja. MailCopilot vertraut zusaetzlich zu seinem integrierten Zertifikatspaket auch dem Zertifikatspeicher Ihres Betriebssystems, sodass Sicherheitssoftware, die TLS-Verkehr untersucht (zum Beispiel Antivirenprogramme mit HTTPS-Scan), und Unternehmens-Proxys die Mail-Synchronisierung nicht mehr unterbrechen. Nach der ersten erfolgreichen Synchronisierung Ihres Kontos in einer Sitzung prueft MailCopilot dies einmalig und zeigt gegebenenfalls einen Hinweis, der die verantwortliche Software oder den Proxy nennt; diese Pruefung laeuft hoechstens einmal pro Server fuer die gesamte Lebensdauer Ihres Profils, sodass eine erst spaeter auf einem Server eingerichtete Untersuchung nach dieser Pruefung nicht mehr erkannt wird. Falls sich das Zertifikat spaeter zu einem aendert, dem ueberhaupt nicht mehr vertraut werden kann (nicht nur ueber den Systemspeicher), zeigt MailCopilot einen Wiederherstellungsdialog an, in dem Sie die Details des neuen Zertifikats pruefen und entscheiden koennen, ob Sie ihm vertrauen.

## Mein selbstsignierter Mailserver verbindet sich nach dem Update von MailCopilot nicht mehr. Warum?

Zertifikat-Pinning verglich frueher Fingerabdruecke nur bei Zertifikaten, deren Kette bereits normal verifiziert wurde; selbstsignierte Zertifikate und Zertifikate privater Zertifizierungsstellen -- genau der Fall, fuer den Pinning existiert -- umgingen diese Fingerabdruckpruefung vollstaendig. Diese Luecke ist jetzt geschlossen, was eine Sicherheitsverbesserung ist -- aber wenn Sie vor dieser Aenderung einen selbstsignierten Server oder einen Server mit privater Zertifizierungsstelle gepinnt haben, enthaelt der gespeicherte Pin moeglicherweise nicht das fuer die Verifizierung noetige Zertifikat, und dieser Server wird sich nun nicht mehr verbinden. Oeffnen Sie den dafuer erscheinenden Dialog zur Zertifikatswiederherstellung: zeigt die Schaltflaeche **„Zertifikat lesen"**, klicken Sie zuerst darauf, dann auf **„Vertrauen und fortfahren"**; wird bereits **„Vertrauen und fortfahren"** angezeigt, klicken Sie nur darauf. Dadurch wird der Pin zusammen mit dem Zertifikat selbst gespeichert, und das Konto synchronisiert sich automatisch neu. Dies muessen Sie nur einmal pro betroffenem Server tun. Das manuelle Hinzufuegen oder Bearbeiten eines Pins in den Einstellungen behebt dies nicht -- ein manueller Pin kann das Vertrauen fuer einen Server nur einschraenken, der bereits ein normales, oeffentlich vertrauenswuerdiges Zertifikat hat; bei einem sonst nicht vertrauenswuerdigen Zertifikat (selbstsigniert oder von einer privaten Zertifizierungsstelle, die noch nicht im Zertifikatspeicher Ihres Betriebssystems vorhanden ist) kann nur der Wiederherstellungsdialog Vertrauen gewaehren.

Wenn Ihr Server STARTTLS verwendet (typischerweise IMAP-Port 143 oder SMTP-Port 587), kann MailCopilot dessen Zertifikat auf diese Weise nicht erfassen -- es wird nur der Fingerabdruck gespeichert, sodass ein selbstsignierter STARTTLS-Server weiterhin nicht verbindbar bleibt. Verwenden Sie stattdessen implizites TLS (typischerweise Port 993 fuer IMAP, 465 fuer SMTP), falls Ihr Server dies unterstuetzt.

## Wie suche ich nach Nachrichten?

Klicken Sie auf die Suchleiste (oder druecken Sie **/***) und geben Sie Ihre Anfrage ein.

Erweiterte Suchoperatoren:

- `from:user@example.com` -- Nachrichten von einem bestimmten Absender.
- `to:user@example.com` -- Nachrichten an einen bestimmten Empfaenger.
- `subject:Besprechung` -- Nachrichten mit einem Wort im Betreff.
- `has:attachment` -- Nachrichten mit Anhaengen.
- `is:unread` / `is:read` -- nach Lesestatus filtern.
- `is:starred` -- markierte Nachrichten.
- `before:2026-01-01` / `after:2025-12-01` -- nach Datum filtern.
- `in:Sent` -- Nachrichten in einem bestimmten Ordner.
- Negation mit `-`: `-from:spam@example.com`.
- Kombinieren mit `OR` oder `AND` (Gross-/Kleinschreibung egal): `from:alice OR from:bob`.

## Ist der KI-Assistent obligatorisch?

Nein, er ist vollstaendig optional.

## Wo kann ich sehen, was die KI mit meinen Daten macht?

Oeffnen Sie **Einstellungen → KI** und klappen Sie den Abschnitt **Datenschutz und Audit** auf. Dort finden Sie ein vollstaendiges Auditprotokoll jeder KI-Aktion: Zeitstempel, Anbieter, Modell, Ziel, verwendetes Werkzeug, geschaetzte Kosten und Ergebnis. Die Token-Anzahl wird aufgezeichnet, wenn der Anbieter sie ueber das SDK bereitstellt; andernfalls zeigen die Spalten **n/v**. Sie koennen das Protokoll auch als JSON oder CSV exportieren.

Weitere Details finden Sie unter [KI-Daten und Auditprotokoll](./privacy/ai-data).

## Wie aktualisiere ich MailCopilot?

Standardmaessig laedt MailCopilot Updates **nicht** automatisch herunter. Wenn eine neue Version erkannt wird, erscheint in **Einstellungen > Ueber** eine Schaltflaeche **X.Y.Z herunterladen**. Klicken Sie darauf, um den Download zu starten, und anschliessend auf **Neu starten, um zu installieren**, wenn der Download abgeschlossen ist.

Fuer eine manuelle Pruefung zu einem beliebigen Zeitpunkt oeffnen Sie **Einstellungen > Ueber** und klicken Sie auf **Nach Updates suchen**.

Um den automatischen Hintergrunddownload zu aktivieren, oeffnen Sie **Einstellungen > Ueber** und aktivieren Sie **Updates automatisch im Hintergrund herunterladen**. Wenn aktiviert, werden neue Versionen automatisch heruntergeladen und Sie werden zum Neustart aufgefordert, sobald das Update bereit ist.

Wenn MailCopilot systemweit installiert wurde (z. B. ueber einen Paketmanager), ist das Kontrollkaestchen fuer automatische Downloads deaktiviert und die Steuerelemente fuer Download und Neustart sind nicht verfuegbar. Verwenden Sie Ihren Paketmanager oder Administratorrechte fuer die Aktualisierung. Die Schaltflaeche **Nach Updates suchen** funktioniert in diesem Modus weiterhin.

## Kann ich automatische Updates deaktivieren?

Der automatische Hintergrunddownload ist standardmaessig deaktiviert. Wenn Sie die Option **Updates automatisch im Hintergrund herunterladen** aktiviert haben und sie deaktivieren moechten, oeffnen Sie **Einstellungen > Ueber** und deaktivieren Sie diese Option. MailCopilot benachrichtigt Sie weiterhin ueber verfuegbare Updates, aber der Download beginnt erst, wenn Sie auf **Herunterladen** klicken.

## MailCopilot synchronisiert nicht.

Pruefen Sie IMAP IDLE in den Einstellungen, klicken Sie auf Synchronisieren und pruefen Sie Ihre Internetverbindung.
