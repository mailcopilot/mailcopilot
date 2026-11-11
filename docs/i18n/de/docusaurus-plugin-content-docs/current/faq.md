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

## Wie verbinde ich ein Gmail-Konto?

Wählen Sie im Einrichtungsassistenten die Karte **Gmail** und folgen Sie den Schritten: Aktivieren Sie die Bestätigung in zwei Schritten für Ihr Google-Konto, erstellen Sie ein App-Passwort für MailCopilot (Anleitung von Google: [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833)) und geben Sie dann Ihre Gmail-Adresse und das 16-stellige App-Passwort ein – nicht Ihr gewohntes Google-Passwort. Die Servereinstellungen (`imap.gmail.com` Port 993, `smtp.gmail.com` Port 465) werden automatisch eingetragen. Alle Schritte finden Sie unter [Gmail-Konto](./getting-started/adding-account#gmail-account).

## Warum kann ich kein neues Gmail-Postfach mit der Google-Anmeldung hinzufügen?

Google erlaubt einer nicht verifizierten App insgesamt nur 100 neue Nutzer, und dieses Limit lässt sich nicht zurücksetzen. Deshalb verbindet die offizielle MailCopilot-Version neue Gmail-Postfächer nicht über **Mit Google anmelden**; jedes neue Gmail-Postfach, auch ein zweites von jemandem, der MailCopilot bereits nutzt, wird stattdessen mit einem App-Passwort verbunden (siehe die vorige Frage). Gmail-Postfächer, die sich bereits mit Google anmelden, funktionieren weiter, und Sie können sie neu verbinden (zum Beispiel nach einem widerrufenen Token oder einer Passwortänderung) – aber nur mit derselben Google-Adresse. Wenn Sie sich mit einem anderen Google-Konto anmelden, lehnt MailCopilot ab und ändert nichts. Das andere Konto behält den Zugriff, den es soeben erteilt hat; entfernen Sie ihn in diesem Google-Konto unter dem Zugriff durch Drittanbieter. Die Adresse eines solchen Postfachs lässt sich in den Kontoeinstellungen nicht bearbeiten (die IMAP- und SMTP-Benutzerfelder sind schreibgeschützt); um sie zu ändern, verbinden Sie sich mit demselben Google-Konto neu. Hat sich die Google-Adresse des Postfachs selbst geändert (zum Beispiel wurde das Konto umbenannt oder zu einer anderen Domain verschoben), wird die erneute Verbindung abgelehnt und nichts geändert: Entfernen Sie das Postfach und fügen Sie es mit einem App-Passwort erneut hinzu (die lokal zwischengespeicherte E-Mail wird erneut heruntergeladen). Eine aus dem Quellcode erstellte Version mit eigenem Google-OAuth-Client behält die Google-Anmeldung für neue Postfächer; eine Version ganz ohne Google-OAuth-Client zeigt keine Google-Schaltfläche, und ein Postfach, das sich mit Google anmeldet, kann dort nicht neu verbunden werden. Outlook / Microsoft 365 ist nicht betroffen.

## Die Option für App-Passwörter fehlt. Was soll ich tun? {#app-passwords-missing}

Google bietet App-Passwörter nicht für jedes Konto an. Die Option kann fehlen, wenn das Konto von einer Organisation verwaltet wird (fragen Sie deren Administrator), den erweiterten Schutz nutzt oder für die Bestätigung in zwei Schritten nur Sicherheitsschlüssel verwendet. Dann bleibt nur eine aus dem Quellcode erstellte Version mit Ihrem eigenen Google-OAuth-Client. Eine App, die intern für eine Organisation bestimmt ist, ist von der Verifizierung durch Google ausgenommen, siehe [Googles Erläuterung](https://support.google.com/cloud/answer/7454865).

## Kann ich mehrere Konten nutzen?

Ja, mit Wechsel in der Seitenleiste oder dem vereinheitlichten Posteingang.

## Der Verbindungstest zeigt einen TLS-Zertifikatfehler. Was soll ich tun?

MailCopilot prueft immer TLS-Zertifikate und gleicht sie sowohl mit dem integrierten Mozilla-Zertifikatspaket als auch mit dem Zertifikatspeicher Ihres Betriebssystems ab. Diese Vertrauensabfrage innerhalb der App gibt es nur fuer Ihren **eingehenden Mailserver (IMAP)**. Wenn dieser Server ein selbstsigniertes Zertifikat verwendet, oder eines, das von einer privaten Zertifizierungsstelle ausgestellt wurde, die noch nicht im Zertifikatspeicher Ihres Betriebssystems eingetragen ist (zum Beispiel eine interne Zertifizierungsstelle einer Universität oder eines Unternehmens), erscheint eine Vertrauensabfrage. Prüfen Sie die Zertifikatsdetails und akzeptieren Sie es, wenn Sie sicher sind, dass der Server legitim ist. Wenn der Fingerabdruck noch nicht gelesen wurde, zeigt die Hauptschaltfläche zunächst **„Zertifikat abrufen"** an -- klicken Sie darauf, prüfen Sie das Ergebnis, und klicken Sie dann zur Bestätigung auf **„Vertrauen und fortfahren"**. Das so gewährte Vertrauen ist an genau dieses Zertifikat sowie an die Adresse und den Port dieses bestimmten Servers gebunden; ein anderer Server, selbst mit einem Zertifikat derselben Zertifizierungsstelle, wird nicht automatisch vertrauenswürdig, und ein späterer Zertifikatswechsel dieses Servers erfordert erneut eine Bestätigung auf demselben Weg. Die Zeile **„Details“** im Dialog nennt in der Sprache der App, warum das Zertifikat nicht akzeptiert wurde (zum Beispiel weil es abgelaufen oder selbstsigniert ist oder für einen anderen Servernamen ausgestellt wurde).

Liegt der Fehler stattdessen bei Ihrem **ausgehenden Mailserver (SMTP)**, bietet MailCopilot diese Vertrauensabfrage ueberhaupt nicht an -- ein selbstsigniertes Zertifikat oder eines einer privaten Zertifizierungsstelle auf der SMTP-Seite hat keine Abhilfe innerhalb der App. Das Zertifikat muss ausserhalb von MailCopilot vertrauenswuerdig gemacht werden: entweder indem das Stammzertifikat der Zertifizierungsstelle im Betriebssystem selbst vertrauenswuerdig gemacht wird (MailCopilot benoetigt einen Neustart, um das zu uebernehmen), oder ueber die Umgebungsvariable `NODE_EXTRA_CA_CERTS` fuer fortgeschrittene Konfigurationen.

## Mein Antivirenprogramm oder Unternehmens-Proxy untersucht meine Mailverbindung. Funktioniert MailCopilot trotzdem?

Ja. MailCopilot vertraut zusaetzlich zu seinem integrierten Zertifikatspaket auch dem Zertifikatspeicher Ihres Betriebssystems, sodass Sicherheitssoftware, die TLS-Verkehr untersucht (zum Beispiel Antivirenprogramme mit HTTPS-Scan), und Unternehmens-Proxys die Mail-Synchronisierung nicht mehr unterbrechen. Nach der ersten erfolgreichen Synchronisierung Ihres Kontos in einer Sitzung prueft MailCopilot dies einmalig und zeigt gegebenenfalls einen Hinweis, der die verantwortliche Software oder den Proxy nennt; diese Pruefung laeuft hoechstens einmal pro Server fuer die gesamte Lebensdauer Ihres Profils, sodass eine erst spaeter auf einem Server eingerichtete Untersuchung nach dieser Pruefung nicht mehr erkannt wird. Falls sich das Zertifikat spaeter zu einem aendert, dem ueberhaupt nicht mehr vertraut werden kann (nicht nur ueber den Systemspeicher), zeigt MailCopilot einen Wiederherstellungsdialog an, in dem Sie die Details des neuen Zertifikats pruefen und entscheiden koennen, ob Sie ihm vertrauen.

## Mein selbstsignierter Mailserver verbindet sich nach dem Update von MailCopilot nicht mehr. Warum?

Zertifikat-Pinning verglich frueher Fingerabdruecke nur bei Zertifikaten, deren Kette bereits normal verifiziert wurde; selbstsignierte Zertifikate und Zertifikate privater Zertifizierungsstellen -- genau der Fall, fuer den Pinning existiert -- umgingen diese Fingerabdruckpruefung vollstaendig. Diese Luecke ist jetzt geschlossen, was eine Sicherheitsverbesserung ist -- aber wenn Sie vor dieser Aenderung einen selbstsignierten Server oder einen Server mit privater Zertifizierungsstelle gepinnt haben, enthaelt der gespeicherte Pin moeglicherweise nicht das fuer die Verifizierung noetige Zertifikat, und dieser Server wird sich nun nicht mehr verbinden. Fuer Ihren **eingehenden Mailserver (IMAP)** oeffnen Sie den dafuer erscheinenden Dialog zur Zertifikatswiederherstellung: zeigt die Schaltflaeche **„Zertifikat abrufen"**, klicken Sie zuerst darauf, dann auf **„Vertrauen und fortfahren"**; wird bereits **„Vertrauen und fortfahren"** angezeigt, klicken Sie nur darauf. Dadurch wird der Pin zusammen mit dem Zertifikat selbst gespeichert, und das Konto synchronisiert sich automatisch neu. Dies muessen Sie nur einmal pro betroffenem Server tun. Das manuelle Hinzufuegen oder Bearbeiten eines Pins in den Einstellungen behebt dies nicht -- ein manueller Pin kann das Vertrauen fuer einen Server nur einschraenken, der bereits ein normales, oeffentlich vertrauenswuerdiges Zertifikat hat; bei einem sonst nicht vertrauenswuerdigen Zertifikat (selbstsigniert oder von einer privaten Zertifizierungsstelle, die noch nicht im Zertifikatspeicher Ihres Betriebssystems vorhanden ist) kann nur der Wiederherstellungsdialog Vertrauen gewaehren. Wenn Sie danach fuer denselben Server einen Fingerabdruck-Pin hinzufuegen, der nicht zu dem dort bereits bestaetigten Zertifikat passt, wird er auf dieselbe Weise abgelehnt -- MailCopilot oeffnet erneut den Wiederherstellungsdialog, statt ihn zu verwenden. Fuer Ihren **ausgehenden Mailserver (SMTP)** gibt es ueberhaupt keinen Wiederherstellungsdialog -- ein selbstsignierter oder ueber eine private Zertifizierungsstelle laufender SMTP-Server, der auf diese Weise ausgefallen ist, bleibt ausgefallen, bis das Zertifikat ausserhalb von MailCopilot vertrauenswuerdig gemacht wird: entweder wird das Stammzertifikat seiner Zertifizierungsstelle direkt im Betriebssystem vertrauenswuerdig gemacht, oder ueber die Umgebungsvariable `NODE_EXTRA_CA_CERTS` fuer fortgeschrittene Konfigurationen.

Wenn Ihr Server STARTTLS verwendet (typischerweise IMAP-Port 143 oder SMTP-Port 587), kann MailCopilot dessen Zertifikat auf diese Weise nicht erfassen -- es wird nur der Fingerabdruck gespeichert, sodass ein selbstsignierter STARTTLS-Server weiterhin nicht verbindbar bleibt. Verwenden Sie stattdessen implizites TLS (typischerweise Port 993 fuer IMAP, 465 fuer SMTP), falls Ihr Server dies unterstuetzt.

## Die Verbindung meldet, dass der Server keine verschlüsselte Verbindung (STARTTLS) anbietet. Was bedeutet das?

Ihr Konto ist ohne sofortiges **SSL/TLS** eingerichtet (typischerweise IMAP-Port 143 oder SMTP-Port 587), daher erwartet MailCopilot, dass der Server die Verbindung per STARTTLS auf Verschlüsselung umstellt, bevor ein Passwort oder eine Nachricht gesendet wird. Dieser Server hat die Umstellung weder angeboten noch akzeptiert, deshalb hat MailCopilot die Verbindung abgebrochen und weder Passwort noch Nachricht gesendet. Eine Option „unverschlüsselt zulassen“ gibt es bewusst nicht. Prüfen Sie Port und Kontrollkästchen **SSL/TLS** unter **Settings > Accounts** (typischerweise IMAP-Port 993 und SMTP-Port 465 mit aktiviertem **SSL/TLS**) oder wenden Sie sich an Ihren Mail-Anbieter. Siehe [Verschlüsselte Verbindung erforderlich (STARTTLS)](./getting-started/adding-account#verschlüsselte-verbindung-erforderlich-starttls).

## Der Versand schlägt fehl und die Meldung besagt, dass Netzwerk oder VPN ausgehende Mail-Ports blockieren könnten. Was tun?

Diese Meldung erscheint, wenn MailCopilot Ihren Postausgangsserver gar nicht erreichen konnte -- die Verbindung scheiterte, bevor der Server antwortete, was typischerweise auf einen blockierten Port, ein VPN oder ein nicht erreichbares Netzwerk hindeutet. Solche Sendungen werden automatisch mit wachsenden Abständen wiederholt; schlagen sie schließlich endgültig fehl, sehen Sie diesen Hinweis statt eines rohen technischen Fehlers. Prüfen Sie Ihre Internetverbindung, deaktivieren oder konfigurieren Sie das VPN neu, stellen Sie sicher, dass Netzwerk oder Firewall ausgehende Verbindungen zum Port Ihres Mailservers erlauben (typischerweise 465 oder 587), und versuchen Sie den Versand erneut.

Dieselbe Meldung erscheint, wenn Sie ein Konto hinzufügen oder seine Verbindung testen und ein Server die Verbindung annimmt, aber nie antwortet: Der Verbindungstest für den eingehenden (IMAP) und für den ausgehenden (SMTP) Server endet dann damit, statt mit einem rohen technischen Fehler. Der Rat ist derselbe: Prüfen Sie Ihre Internetverbindung, deaktivieren oder konfigurieren Sie das VPN um und stellen Sie sicher, dass Ihr Netzwerk ausgehende Verbindungen zu den Ports Ihres Mailservers erlaubt.

## Der Versand schlägt fehl und die Meldung besagt, dass nicht bekannt ist, ob die Nachricht gesendet wurde. Was tun?

Diese Meldung erscheint, wenn die Verbindung zu Ihrem Postausgangsserver abbrach, nachdem der Server erreicht wurde, aber bevor er den Versand bestätigt hat -- zum Beispiel durch ein Timeout, einen Verbindungsabbruch oder weil der Server die Verbindung ohne Antwort schließt. MailCopilot kann dann nicht wissen, ob der Server die Nachricht angenommen hat, und wiederholt den Versand deshalb **nicht** automatisch, denn eine Wiederholung könnte die Nachricht doppelt zustellen. Stattdessen wechselt die Nachricht in den Fehlerzustand. Verlassen Sie sich nicht auf den Ordner „Gesendet“: MailCopilot speichert seine Kopie dort erst nach einem bestätigten Versand, daher fehlt sie meist auch dann, wenn die Nachricht tatsächlich versendet wurde. Fragen Sie den Empfänger oder sehen Sie in der Ansicht „Gesendet“ Ihres Mail-Anbieters nach, ob die Nachricht angekommen ist; falls nicht, öffnen Sie den **Outbox** und verwenden Sie **Send now** (oder bearbeiten Sie die Nachricht zuvor), um sie manuell erneut zu senden. Fehler, bevor der Server antwortet (blockierter Port, VPN, nicht erreichbares Netzwerk), werden weiterhin automatisch mit wachsenden Abständen wiederholt, Ablehnungen mit einem 4xx-Antwortcode werden ebenfalls wiederholt, 5xx-Ablehnungen dagegen nicht -- sie zeigen den Grund des Servers selbst an.

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

MailCopilot kann sich normalerweise auf jeder unterstuetzten Plattform selbst aktualisieren: Eine AppImage-Installation ersetzt die `.AppImage`-Datei selbst, und eine `.deb`/`.rpm`/pacman-Installation laesst den Update-Mechanismus den Schreibvorgang versuchen, indem sie Administratorrechte anfordert (`pkexec`/`sudo`), genau wie es `apt`/`dnf`/`pacman` tun wuerden -- das tatsaechliche Ergebnis entscheiden die Rechteerhoehungsabfrage und der Paketmanager, nicht MailCopilot.

Selbstaktualisierung kann auf zwei unterschiedliche Arten nicht verfuegbar sein, und MailCopilot zeigt dafuer jeweils unterschiedliche Steuerelemente:

- **Die Version ist nicht gepackt** -- eine Entwicklungs- oder CI-Version. In diesem Fall gibt es ueberhaupt keinen Update-Mechanismus: Die Schaltflaeche **Nach Updates suchen** und der Statusbereich erscheinen nicht, stattdessen zeigt ein Hinweis **„Updates sind in dieser Version deaktiviert“**.
- **Die Version ist gepackt, aber die Selbstaktualisierung ist blockiert** -- entweder weil MailCopilot das Verzeichnis, in das das Update an Ort und Stelle geschrieben werden muesste, nicht bestimmen konnte, oder weil dieses Verzeichnis fuer Ihr Konto nicht beschreibbar ist. Der erste Fall tritt unter Linux auf, wenn die Anwendung nicht als eingehaengtes AppImage laeuft (zum Beispiel ein entpacktes AppImage oder eine rohe `linux-unpacked`-Build) -- dann gibt es kein Verzeichnis, in das geschrieben werden koennte. Der zweite Fall bedeutet, dass das Verzeichnis einer laufenden AppImage nicht beschreibbar ist (eine `.deb`/`.rpm`/pacman-Installation ist davon nicht betroffen, da dort stattdessen Rechte erhoeht werden); unter Windows und macOS bedeutet es, dass das Verzeichnis mit der installierten ausfuehrbaren Datei nicht beschreibbar ist. In beiden Faellen erklaert ein Hinweis den Grund, die Schaltflaeche **Nach Updates suchen** funktioniert weiterhin, und das Kontrollkaestchen fuer automatische Downloads bleibt verfuegbar -- aber die Steuerelemente fuer Download und Neustart werden ausgeblendet.

## Kann ich automatische Updates deaktivieren?

Der automatische Hintergrunddownload ist standardmaessig deaktiviert. Wenn Sie die Option **Updates automatisch im Hintergrund herunterladen** aktiviert haben und sie deaktivieren moechten, oeffnen Sie **Einstellungen > Ueber** und deaktivieren Sie diese Option. MailCopilot benachrichtigt Sie weiterhin ueber verfuegbare Updates, aber der Download beginnt erst, wenn Sie auf **Herunterladen** klicken.

Unabhängig von Downloads sucht MailCopilot beim Start und danach etwa einmal pro Stunde im Hintergrund nach neuen Versionen. Damit es nicht von sich aus neue Prüfungen startet, öffnen Sie **Einstellungen > Über** und deaktivieren Sie **Im Hintergrund nach Updates suchen**. Das wirkt sofort, ein Neustart ist nicht nötig. Die Schaltfläche **Nach Updates suchen** funktioniert weiterhin. Bei ausgeschalteter Hintergrundprüfung startet MailCopilot weder neue automatische Prüfungen noch neue automatische Downloads, selbst wenn **Updates automatisch im Hintergrund herunterladen** aktiviert ist; eine Prüfung oder ein Download, die bzw. der beim Ausschalten bereits lief, kann trotzdem noch abgeschlossen werden.

## MailCopilot synchronisiert nicht.

Pruefen Sie IMAP IDLE in den Einstellungen, klicken Sie auf Synchronisieren und pruefen Sie Ihre Internetverbindung.

## Ich habe das Fenster geschlossen und finde MailCopilot jetzt nicht mehr.

Ist **„Beim Schließen in den Infobereich minimieren“** aktiviert, wird das Fenster beim Schließen hinter dem Symbol im Infobereich verborgen (vorausgesetzt, MailCopilot konnte das Symbol überhaupt erstellen) -- klicken Sie auf das Symbol, um es zurückzuholen. Auf manchen Linux-Arbeitsumgebungen wird das Symbol gar nicht gezeichnet; dann gibt es nichts zum Anklicken.

Starten Sie MailCopilot in jedem Fall einfach erneut. Läuft es noch mit einem verborgenen Fenster, holt es dieses Fenster in den Vordergrund, statt eine zweite Kopie zu öffnen; wurde es bereits beendet, öffnet sich ein neues Fenster.
