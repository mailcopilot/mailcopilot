---
sidebar_position: 2
title: Konto hinzufuegen
---

# E-Mail-Konto hinzufuegen

MailCopilot unterstuetzt jeden E-Mail-Anbieter mit IMAP und SMTP. Gmail wird mit einem App-Passwort verbunden (siehe [Gmail-Konto](#gmail-account)), und ein Microsoft 365 / Outlook.com-Konto kann sich per OAuth anmelden -- ohne Passworteingabe.

## Einrichtungsassistent

Klicken Sie auf **E-Mail verbinden** (Briefsymbol unten in der Seitenleiste).

### Schritt 1: Anbieter waehlen

Der Assistent startet jetzt mit einer expliziten Anbieterauswahl -- Sie sagen MailCopilot, welchen Anbieter Sie verwenden, bevor Sie ueberhaupt Zugangsdaten eingeben. Jeder Anbieter wird als Karte mit dem Anbieter-Logo oder -Symbol angezeigt:

- **Gmail** -- führt zu den Schritten für das App-Passwort (die Karte zeigt „Mit App-Passwort verbinden“): Sie aktivieren die Bestätigung in zwei Schritten, erstellen in Ihrem Google-Konto ein App-Passwort und geben es zusammen mit Ihrer Gmail-Adresse ein. Siehe [Gmail-Konto](#gmail-account) unten. In einer aus dem Quellcode erstellten Version mit eigenem Google-OAuth-Client zeigt die Karte stattdessen „Anmelden mit Google OAuth“ und startet direkt die Google-Anmeldung.
- **Outlook / Microsoft 365** -- startet den OAuth-Flow von Microsoft (Authorization Code mit PKCE) und verbindet sich ueber Microsoft Graph. Funktioniert sowohl fuer persoenliche `@outlook.com` / `@hotmail.com` / `@live.com` Konten als auch fuer Microsoft-365-Geschaefts- und Schulkonten.
- **Generic IMAP/SMTP** -- fuer jeden anderen Anbieter (Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail Bridge, Firmenmail, selbst gehostete Server und so weiter). Fuehrt zuerst zu einem Bestaetigungsschritt mit einer einzigen Schaltflaeche **IMAP/SMTP-Konto**, die dann das Eingabeformular fuer die Zugangsdaten oeffnet.

Zwischen den Karten koennen Sie mit den Pfeiltasten navigieren und die Auswahl mit **Enter** oder **Leertaste** bestaetigen. Nachdem Sie einen Anbieter gewaehlt haben, fuehrt Sie der Assistent durch die jeweils passenden Schritte. Beim Generic-IMAP/SMTP-Pfad bringt die Schaltflaeche **Zurueck** auf dem Bestaetigungsschritt zur Anbieterauswahl zurueck; der Schritt zur Eingabe der Zugangsdaten hat ebenfalls eine **Zurueck**-Schaltflaeche, und sie bringt zurueck zum Bestaetigungsschritt (jeweils einen Schritt). Die Schritte zur Server-Erkennung und manuellen Konfiguration fuehren nur vorwaerts -- um mit einem anderen Anbieter neu anzufangen, brechen Sie den Assistenten ab und oeffnen ihn erneut.

Falls Sie Outlook lieber ueber Generic IMAP/SMTP statt OAuth verbinden moechten, waehlen Sie die Generic-Karte und melden sich mit einem App-Passwort gegen `outlook.office365.com` / `smtp.office365.com` an.

### Schritt 2: Zugangsdaten eingeben (Generic IMAP/SMTP)

Ein neues Gmail-Postfach gelangt nach dem Schritt für das App-Passwort zu demselben Formular (siehe [Gmail-Konto](#gmail-account)).

1. Geben Sie **E-Mail-Adresse** und **Passwort** ein.
2. Optional: **Anzeigename**.
3. Geben Sie optional eine **E-Mail-Adresse (Von)** ein -- diese Adresse wird im „Von"-Feld ausgehender Nachrichten verwendet. Wenn nicht angegeben, wird die SMTP-Anmeldeadresse verwendet.
4. Falls SMTP-Zugangsdaten abweichen, aktivieren Sie die Option.
5. Klicken Sie auf **Weiter**.

### Schritt 3: Servererkennung

MailCopilot versucht, die Servereinstellungen mithilfe standardmaessiger Autodiscovery-Protokolle automatisch zu erkennen. Bei Erfolg werden die erkannten IMAP- und SMTP-Server in bearbeitbaren Feldern angezeigt. Sie koennen den Anzeigenamen, die E-Mail-Adresse, Server-Hosts, Ports und SSL-Einstellungen vor dem Verbinden ueberpruefen und anpassen.

- Klicken Sie auf **Verbinden**, um die Verbindung zu testen und das Konto zu speichern.
- Nimmt ein Server die Verbindung an, antwortet aber nie (typischerweise ein Netzwerk oder VPN, das Mail-Ports blockiert), schlägt der Test mit der Meldung „Der Mailserver war nicht erreichbar, bevor er antwortete. Häufig blockiert das Netzwerk oder ein VPN die Ports für ausgehende Mails. Prüfen Sie Ihre Verbindung oder VPN-Einstellungen und versuchen Sie es erneut.“ fehl. Derselbe Satz erscheint für den eingehenden (IMAP) und den ausgehenden (SMTP) Server.
- Sobald das Konto gespeichert ist, erscheint es sofort im Hauptfenster. Ist es Ihr erstes Konto, öffnet das Hauptfenster es von selbst -- ein Neustart oder erneutes Laden ist nicht nötig.
- Wenn Sie die volle manuelle Kontrolle ueber alle Einstellungen wuenschen (einschliesslich separater IMAP/SMTP-Zugangsdaten), klicken Sie auf **Manuelle Einrichtung**.

### Manuelle Konfiguration

- **IMAP**: Host, Port (normalerweise 993), SSL/TLS.
- **SMTP**: Host, Port (normalerweise 465 oder 587), SSL/TLS.

## Gmail-Konto {#gmail-account}

Gmail wird über die Standardprotokolle IMAP und SMTP verbunden. Google erlaubt einer nicht verifizierten App insgesamt nur 100 neue Nutzer, und dieses Limit lässt sich nicht zurücksetzen. Deshalb verbindet die offizielle MailCopilot-Version **neue** Gmail-Postfächer nicht mehr über **Mit Google anmelden**. Ein neues Postfach wird stattdessen mit einem App-Passwort verbunden. Das gilt auch für ein zweites Gmail-Postfach von jemandem, der MailCopilot bereits mit der Google-Anmeldung nutzt: Auch das ist ein neues Postfach.

### Ein neues Gmail-Postfach mit einem App-Passwort verbinden

Wählen Sie im Assistenten die Karte **Gmail**. Der Assistent öffnet **Gmail mit einem App-Passwort verbinden** mit den folgenden Schritten und drei Schaltflächen: **Zurück** (zurück zur Anbieterauswahl), **Anleitung von Google öffnen** und **Weiter**.

1. Aktivieren Sie die Bestätigung in zwei Schritten für Ihr Google-Konto – App-Passwörter setzen sie voraus.
2. Erstellen Sie in Ihrem Google-Konto ein App-Passwort für MailCopilot. Die offizielle Anleitung von Google finden Sie unter [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833); die Schaltfläche **Anleitung von Google öffnen** öffnet diese Seite in Ihrem Browser.
3. Klicken Sie auf **Weiter** und geben Sie dann Ihre Gmail-Adresse und das 16-stellige App-Passwort ein (nicht Ihr gewohntes Google-Passwort).

Die Servereinstellungen werden automatisch eingetragen: IMAP `imap.gmail.com` auf Port 993 und SMTP `smtp.gmail.com` auf Port 465. Prüfen Sie sie im Schritt der Servererkennung und klicken Sie auf **Verbinden**.

### Postfächer, die sich bereits mit Google anmelden

Gmail-Postfächer, die mit der Google-Anmeldung verbunden wurden, funktionieren weiter, und Sie können sie neu verbinden – zum Beispiel nach einem Widerruf des Zugriffs oder einer Änderung Ihres Google-Passworts – unter **Einstellungen > Konten** mit der Schaltfläche **Google erneut verbinden**. Eine erneute Verbindung funktioniert nur mit derselben Google-Adresse wie das Postfach. Wenn Sie sich mit einem anderen Google-Konto anmelden, lehnt MailCopilot ab: „Dieses Google-Konto ist nicht (Postfachadresse), das Postfach wurde daher nicht geändert. Melden Sie sich mit derselben Adresse an, die Sie neu verbinden.“ – und es wird nichts geändert. Das andere Konto behält den Zugriff, den es MailCopilot soeben erteilt hat; entfernen Sie ihn in diesem Google-Konto unter dem Zugriff durch Drittanbieter.

Die Adresse eines Postfachs, das sich mit Google (oder mit einer anderen OAuth-Anmeldung) anmeldet, lässt sich in den Kontoeinstellungen nicht mehr bearbeiten: Die IMAP- und SMTP-Benutzerfelder sind für ein solches Postfach schreibgeschützt. Um die Adresse zu ändern, verbinden Sie sich mit demselben Google-Konto neu. Hat sich die Google-Adresse des Postfachs selbst geändert (zum Beispiel wurde das Konto umbenannt oder zu einer anderen Domain verschoben), wird die erneute Verbindung abgelehnt und nichts geändert; der Ausweg ist, das Postfach zu entfernen und mit einem App-Passwort erneut hinzuzufügen (die lokal zwischengespeicherte E-Mail wird erneut heruntergeladen).

### Wenn die Option für App-Passwörter fehlt

Google bietet App-Passwörter nicht für jedes Konto an. Die Option kann fehlen, wenn das Konto von einer Organisation verwaltet wird (fragen Sie deren Administrator), den erweiterten Schutz nutzt oder für die Bestätigung in zwei Schritten nur Sicherheitsschlüssel verwendet. Dann bleibt nur eine aus dem Quellcode erstellte Version mit Ihrem eigenen Google-OAuth-Client; eine App, die intern für eine Organisation bestimmt ist, ist von der Verifizierung durch Google ausgenommen (siehe [Googles Erläuterung](https://support.google.com/cloud/answer/7454865)). Siehe auch die [FAQ](../faq#app-passwords-missing).

### Versionen mit eigenem Google-Client

Eine aus dem Quellcode erstellte Version mit eigenem Google-OAuth-Client behält die Google-Anmeldung für neue Postfächer: Selbst erstellte Versionen haben sie standardmäßig, die Gmail-Karte zeigt „Anmelden mit Google OAuth“, und ihre Auswahl startet den unten beschriebenen Ablauf im Browser. Eine Version ganz ohne Google-OAuth-Client zeigt überhaupt keine Google-Schaltfläche; bei einem Postfach, das sich mit Google anmeldet, weist **Einstellungen > Konten** dann darauf hin, dass sich das Postfach mit Google anmeldet, diese Version aber keinen Google-OAuth-Client enthält und es daher dort nicht neu verbunden werden kann. Outlook / Microsoft 365 ist davon nicht betroffen.

### Fortschritt der Google-Anmeldung

Der unten beschriebene Fortschrittsschritt erscheint in Versionen, die die Google-Anmeldung für neue Postfächer anbieten.


Waehrend der Verbindung ersetzt der Assistent die Provider-Liste durch einen Fortschrittsschritt, der zeigt, worauf gewartet wird: Ihre Freigabe im Browser, dann Zugriff abrufen, E-Mail- und Versandserver pruefen und Konto speichern. Zeitlich begrenzt sind zwei Teile: das Warten auf Ihre Freigabe im Browser (drei Minuten) und die Serverpruefungen (30 Sekunden fuer den Posteingang, 15 fuer den Versand, mit einem Wiederholungsversuch). Der Rest hat kein Limit; alles Uebrige haengt vom Anbieter und Ihrem Netzwerk ab, deshalb zeigt der Schritt, was gerade geschieht, und nicht, wie lange es noch dauert. Hat das Konto noch keinen Namen und liefert der Anbieter einen brauchbaren, wird er aus dem Anbieterprofil uebernommen; ein von Ihnen bearbeiteter Name wird bei einer spaeteren erneuten Autorisierung nie ueberschrieben. Schlaegt die Verbindung fehl, bevor das Konto gespeichert wurde, kehrt der Assistent zur Provider-Liste zurueck, damit Sie es erneut versuchen koennen. Das Schliessen des Fensters bricht eine bereits laufende Verbindung nicht ab -- sie laeuft im Hintergrund weiter und kann das Konto trotzdem anlegen; ein Neustart in diesem Moment kann also ein Duplikat hinterlassen. Dieser Schritt gehoert zum Hinzufuegen eines Kontos: Beim erneuten Autorisieren eines vorhandenen Kontos erscheint stattdessen nur ein Ladeindikator auf der Schaltflaeche.

## Microsoft 365 / Outlook-Konto (OAuth)

Waehlen Sie im Assistenten die Karte **Outlook / Microsoft 365**. Es oeffnet sich ein Browserfenster mit der Microsoft-Anmeldeseite; melden Sie sich mit Ihrem `@outlook.com`-, `@hotmail.com`-, `@live.com`- oder Geschaefts-/Schulkonto an und genehmigen Sie die angeforderten Berechtigungen. Der mitgelieferte Microsoft-Client verwendet den Authorization-Code-Flow mit PKCE ohne Client-Secret -- es verlaesst kein Client-Secret Ihr Geraet. Eigene Builds, die den mitgelieferten Client durch das Setzen **beider** Umgebungsvariablen `MAILCOPILOT_MS_CLIENT_ID` (eigene Azure-App-Registrierung) und `MAILCOPILOT_MS_CLIENT_SECRET` (gedacht fuer Tenants mit Confidential Client) ueberschreiben, senden dieses Secret per TLS an den Token-Endpunkt von Microsoft. `MAILCOPILOT_MS_CLIENT_SECRET` allein (ohne eigene Client-ID) wird ignoriert. Nach der Autorisierung wird das Konto automatisch hinzugefuegt.

Der gleiche Wartebildschirm erscheint auch hier wie bei Gmail -- mit denselben Stufen und denselben Einschraenkungen: Zeitlich begrenzt sind das Warten im Browser und die Serverpruefungen, der Rest nicht, und das Schliessen des Fensters bricht eine laufende Verbindung nicht ab. Den Wiederholungsversuch fuer den Versandserver gibt es hier im Gegensatz zu Gmail nicht. Ihr Name wird aus dem Microsoft-Profil uebernommen, wenn das Konto keinen hat und das Profil einen brauchbaren liefert; ein von Ihnen bearbeiteter Name wird bei einer spaeteren erneuten Autorisierung nie ueberschrieben. Die weiter unten fuer Google beschriebene Zertifikatsabfrage erscheint auch auf diesem Weg -- nach dem Speichern des Kontos.

Zum Versenden nutzt MailCopilot bei Outlook-Konten Microsoft Graph (`POST /me/sendMail`), weil Microsoft SMTP AUTH bei den meisten persoenlichen Outlook.com-Konten, die seit 2024 erstellt wurden, deaktiviert hat. Der Graph-Sendepfad ist von dieser Richtlinie nicht betroffen. Gesendete Nachrichten werden von Microsoft automatisch im Ordner „Gesendet" abgelegt.

Wenn Ihr Outlook-Konto nach langer Offlinezeit den Dienst einstellt, ist moeglicherweise das OAuth-Refresh-Token abgelaufen. Ein OAuth-Refresh-Token, das im sicheren Speicher fehlt, loest den [Hinweis auf abgelaufene Anmeldung](#hinweis-auf-abgelaufene-anmeldung) sofort aus -- sowohl bei Google- als auch bei Outlook-Konten. Wird ein gespeichertes Token vom Anbieter abgelehnt, folgt eine daraus resultierende IMAP-Authentifizierungsablehnung dem gewoehnlichen Ablauf eines Anmeldefehlers; autorisieren Sie das Konto ueber **Einstellungen > Konten** mit der Microsoft-Erneuerungsschaltflaeche erneut.


## TLS-Zertifikatpruefung

MailCopilot prueft immer TLS-Zertifikate, indem es sie sowohl mit dem integrierten Mozilla-Zertifikatspaket als auch mit dem Zertifikatspeicher Ihres Betriebssystems abgleicht (und weicht auf das integrierte Paket allein aus, wenn der Systemspeicher nicht gelesen werden kann). Die in diesem Abschnitt beschriebene Vertrauensabfrage innerhalb der App gibt es nur fuer Ihren **eingehenden Mailserver (IMAP)**. Bei selbstsignierten Zertifikaten dieses Servers, oder solchen, die von einer privaten Zertifizierungsstelle ausgestellt wurden, die noch nicht im Zertifikatspeicher Ihres Betriebssystems eingetragen ist -- zum Beispiel eine interne Zertifizierungsstelle einer Universität oder eines Unternehmens --, erscheint eine Vertrauensabfrage: Wenn der Fingerabdruck noch nicht gelesen wurde, zeigt die Schaltfläche zunächst **„Zertifikat abrufen"** an -- klicken Sie darauf, prüfen Sie die Details, und bestätigen Sie dann mit **„Vertrauen und fortfahren"**; wird bereits **„Vertrauen und fortfahren"** angezeigt, klicken Sie nur darauf. Das auf diese Weise gewährte Vertrauen ist an genau dieses Zertifikat sowie an die Adresse und den Port dieses bestimmten Servers gebunden -- ein anderer Server, selbst mit einem Zertifikat derselben Zertifizierungsstelle, wird nicht automatisch vertrauenswürdig, und ändert sich das Zertifikat dieses Servers erneut, müssen Sie das neue auf dieselbe Weise bestätigen. Als Alternative können Sie stattdessen das Stammzertifikat der Zertifizierungsstelle in den Zertifikatspeicher Ihres Betriebssystems installieren; MailCopilot liest diesen Speicher nur einmal -- beim ersten Bedarf -- und behaelt diesen Schnappschuss bis zum naechsten Neustart der App, sodass diese Alternative einen Neustart von MailCopilot erfordert, um wirksam zu werden, während das Bestätigen der hier beschriebenen Vertrauensabfrage das nicht tut. Server, die über STARTTLS erreicht werden (typischerweise IMAP-Port 143 oder SMTP-Port 587), koennen ihr Zertifikat an dieser Stelle nicht herausgeben, sodass fuer sie nur der Fingerabdruck gespeichert wird -- ein selbstsignierter STARTTLS-Server kann auf diese Weise nicht vertrauenswuerdig gemacht werden; verwenden Sie stattdessen implizites TLS (typischerweise Port 993 oder 465), falls Ihr Server dies unterstuetzt.

Die Zeile **„Details“** der Vertrauensabfrage nennt in der Sprache der App, warum das Zertifikat abgelehnt wurde -- zum Beispiel weil es selbstsigniert oder abgelaufen ist; die vollständige Liste der Gründe steht unter [TLS-Zertifikatvertrauen](../settings/general#tls-zertifikatvertrauen).

Fuer Ihren **ausgehenden Mailserver (SMTP)** gibt es heute keine entsprechende Vertrauensabfrage. Legt er ein selbstsigniertes Zertifikat oder eines einer privaten Zertifizierungsstelle vor, die noch nicht im Zertifikatspeicher Ihres Betriebssystems eingetragen ist, schlaegt der Verbindungstest dafuer schlicht fehl -- innerhalb der App gibt es dafuer keine Abhilfe. Das Zertifikat muss ausserhalb von MailCopilot vertrauenswuerdig gemacht werden: entweder indem Sie das Stammzertifikat dieser Zertifizierungsstelle direkt im Zertifikatspeicher Ihres Betriebssystems installieren (starten Sie MailCopilot anschliessend neu, damit die Aenderung wirksam wird), oder ueber die Umgebungsvariable `NODE_EXTRA_CA_CERTS` fuer fortgeschrittene Konfigurationen.

Bei der Anmeldung mit Google erkennt MailCopilot automatisch, wenn Ihr Netzwerk einen Proxy oder ein Antivirenprogramm verwendet, das TLS-Zertifikate durch ein Ihrem Betriebssystem noch nicht bekanntes Zertifikat ersetzt, und bietet an, das Zertifikat zu akzeptieren. Sie sehen die Zertifikatsdetails (Host, Aussteller, Fingerabdruck) und können es akzeptieren oder ablehnen. Das Konto wird in jedem Fall gespeichert, und Sie können Zertifikate später in den Kontoeinstellungen verwalten. Ist das Stammzertifikat des Proxys oder Antivirenprogramms dagegen bereits im Zertifikatspeicher Ihres Betriebssystems installiert, gelingt die Verbindung ohne jede Vertrauensabfrage -- MailCopilot kennzeichnet diesen Fall stattdessen separat mit einem informativen Hinweis (siehe unten), statt Sie um eine Bestaetigung zu bitten.

Dass dem Systemzertifikatspeicher vertraut wird, bedeutet, dass die meisten Unternehmens-Proxys und TLS-untersuchenden Antivirenprogramme sofort funktionieren, ohne Vertrauensabfrage bei der Einrichtung. Nach der ersten erfolgreichen Synchronisierung Ihres Kontos in einer Sitzung prueft MailCopilot einmalig, ob eine Verbindung auf diese Weise untersucht wird, und zeigt gegebenenfalls einen Hinweis an, der die verantwortliche Software oder den Proxy nennt; diese Pruefung laeuft hoechstens einmal pro Server fuer die gesamte Lebensdauer Ihres Profils, sodass eine erst nach dieser Pruefung eingerichtete Untersuchung nicht erkannt wird. Falls sich das Zertifikat eines Servers später zu einem ändert, dem ueberhaupt nicht vertraut werden kann, zeigt MailCopilot zu diesem Zeitpunkt einen Wiederherstellungsdialog im Hauptfenster an -- siehe [TLS-Zertifikatvertrauen](../settings/general#tls-zertifikatvertrauen) für Details.

Bei Verbindungen zu Ihrem Posteingangsserver (IMAP), Ihrem Postausgangsserver (SMTP) und zum KI-Anbieter vertraut MailCopilot außerdem keinen Zertifikaten mehr, deren Kette zu drei Zertifizierungsstellen-Wurzeln führt, die mit einem Vorfall kompromittierter Zwischenzertifikate zusammenhängen -- `emSign ECC Root CA - G3`, `emSign Root TLS CA - G3` und `AAA Certificate Services` --, selbst wenn Ihr Betriebssystem ihnen weiterhin vertraut. Ein Server, dessen Zertifikat zu einer davon führt, wird wie jedes andere nicht vertrauenswürdige Zertifikat behandelt: Für Ihren Posteingangsserver (IMAP) erscheint die oben beschriebene Vertrauensabfrage (für Ihren Postausgangsserver gibt es, wie oben erklärt, keine Abfrage). Ein Zertifikat, das Sie in dieser Abfrage bereits bestätigt haben, funktioniert weiterhin.

## Verschlüsselte Verbindung erforderlich (STARTTLS)

Ist das Kontrollkästchen **SSL/TLS** des Posteingangs- oder Postausgangsservers deaktiviert -- typischerweise IMAP-Port 143 oder SMTP-Port 587, bei denen die Verbindung unverschlüsselt beginnt und dann per STARTTLS umgestellt wird --, verlangt MailCopilot, dass der Server diese Umstellung abschließt, bevor Ihr Passwort oder eine Nachricht gesendet wird. Bietet der Server STARTTLS nicht an oder akzeptiert es nicht, wird die Verbindung abgelehnt, und der Verbindungstest (oder die fehlgeschlagene Synchronisierung bzw. der fehlgeschlagene Versand) zeigt: „Der Server bietet keine verschlüsselte Verbindung (STARTTLS) an, daher hat MailCopilot weder Passwort noch Nachricht gesendet. Prüfen Sie Port und Sicherheitseinstellungen oder wenden Sie sich an Ihren Mail-Anbieter.“ Eine Option, ohne Verschlüsselung fortzufahren, gibt es bewusst nicht. Zur Behebung prüfen Sie den Port und das Kontrollkästchen **SSL/TLS** (typischerweise IMAP-Port 993 und SMTP-Port 465 mit aktiviertem **SSL/TLS**) oder fragen Sie Ihren Mail-Anbieter, welche Einstellungen sein Server erwartet. Verbindungen mit **SSL/TLS** sind nicht betroffen.

## Mehrere Konten verwalten

Sie können beliebig viele Konten hinzufügen. Um zwischen den Konten zu wechseln, nutzen Sie die Seitenleiste oder gehen zu **Einstellungen > Konten**. Das aktive Konto ist hervorgehoben, und Sie können jedes Konto als das aktuelle festlegen.

## Hinweis auf abgelaufene Anmeldung

Wenn die Zugangsdaten eines Kontos nicht mehr funktionieren -- zum Beispiel weil ein IMAP-Passwort anderswo geändert wurde, oder für das Konto überhaupt kein Passwort und keine OAuth-Autorisierung gespeichert ist -- scheitert MailCopilot nicht mehr stillschweigend im Hintergrund. Ein unaufdringlicher Hinweis erscheint oberhalb der Nachrichtenliste: zum Beispiel: „Konto“ empfängt keine E-Mails mehr – die Anmeldung ist abgelaufen. Melden Sie sich erneut an, um die Synchronisierung fortzusetzen. Bei einem gewöhnlichen Anmeldefehler im laufenden Mailbetrieb erscheint der Hinweis erst nach zwei aufeinanderfolgenden fehlgeschlagenen Versuchen für dasselbe Konto. Zwei Situationen überspringen diese Schwelle und zeigen den Hinweis sofort an. Die erste ist ein Konto ganz ohne gespeicherte Zugangsdaten, da es nichts zu wiederholen gibt. Die zweite ist eine Anmeldung, die der Mailserver ablehnt, wenn MailCopilot für dieses Konto die Hintergrundüberwachung der Mail (IMAP IDLE) startet: Ein vollständiger Anmeldeversuch, den der Server abgelehnt hat, ist ein endgültiges Urteil über Ihre gespeicherten Zugangsdaten und nicht nur ein einzelner fehlgeschlagener Vorgang, sodass es keinen Grund gibt, auf einen zweiten Fehlschlag zu warten -- und ein Postfach, dessen Ordner alle auf manuelle Aktualisierung eingestellt sind, bekommt womöglich keine zweite Hintergrundsynchronisierung, an der es erneut scheitern könnte. Klicken Sie auf **Erneut anmelden**, um direkt zu den Einstellungen dieses Kontos zu gelangen, wo Sie Ihr Passwort neu eingeben oder die OAuth-Verbindung erneut autorisieren können.

Der Hinweis erscheint nur bei Anmelde- (Authentifizierungs-)Fehlern, die vom Mailserver selbst gemeldet werden -- ein vorübergehender Netzwerkausfall oder ein Zertifikatsproblem löst ihn nicht aus, da beide bereits über eigene, separate Anzeigen verfügen (siehe [TLS-Zertifikatprüfung](#tls-zertifikatpruefung) oben). Ein OAuth-Refresh-Token, das im sicheren Speicher fehlt, löst den Hinweis sofort aus -- sowohl bei Google- als auch bei Outlook-Konten. Wird ein gespeichertes Token abgelehnt, folgt eine daraus resultierende IMAP-Authentifizierungsablehnung dem gewöhnlichen Ablauf eines Anmeldefehlers; autorisieren Sie das Konto in diesem Fall manuell über **Einstellungen > Konten** erneut. Er verschwindet automatisch, sobald irgendeine Operation für dieses Konto erfolgreich ist -- nicht nur eine Hintergrundsynchronisierung, sondern auch das Öffnen einer Nachricht, das Verschieben von Mails oder eine Suche -- sodass auch ein Konto, dessen Ordner alle auf manuelle Aktualisierung eingestellt sind, den Hinweis abräumt, sobald Sie es benutzen. Es gibt nichts manuell zu schließen. Dieser Zustand wird nicht über Neustarts hinweg gespeichert -- wird MailCopilot geschlossen, während ein Konto markiert ist, erscheint der Hinweis erst wieder, wenn sich dasselbe Fehlermuster nach dem nächsten Start erneut zeigt.

## Konto-Avatar anpassen

Jedes Konto wird in der Seitenleiste mit einem Avatar angezeigt -- ein farbiger Kreis mit Initialen. Sie können den Avatar in **Einstellungen > Konten** anpassen, indem Sie auf das Palettensymbol neben dem Konto klicken.

### Anzeigemodi

- **Buchstaben** -- ein farbiger Kreis mit 1--2 Zeichen (Initialen). Sie können eigene Initialen eingeben, wenn die automatischen nicht passen.
- **Symbol** -- ein farbiger Kreis mit einem Symbol aus der Sammlung (Post, Koffer, Stern, Rakete usw.).
- **Gravatar** -- lädt Ihr Profilbild von [Gravatar](https://gravatar.com) basierend auf Ihrer E-Mail-Adresse. Wenn kein Gravatar gefunden wird, werden Buchstaben angezeigt.

### Farbe ändern

Klicken Sie auf eine Farbe in der Palette, um den Hintergrund des Avatars zu ändern. Die Farbe wird gespeichert und bleibt nach dem Neustart gleich.

### Tooltip

Bewegen Sie die Maus über einen Avatar in der Seitenleiste, um den Kontonamen und die E-Mail-Adresse anzuzeigen.

## Unterstuetzte Anbieter

Gmail (mit App-Passwort; Postfächer, die sich bereits mit Google anmelden, funktionieren weiter), Outlook, Yahoo, Fastmail, Yandex Mail, Mail.ru, ProtonMail (über Bridge), selbst gehostete Server.
