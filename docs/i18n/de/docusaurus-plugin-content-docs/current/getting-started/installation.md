---
sidebar_position: 1
title: Installation
---

# Installation

## MailCopilot herunterladen

Besuchen Sie [mailcopilot.io](https://mailcopilot.io), um die neueste Version herunterzuladen.

## Installation unter Linux

:::warning Ubuntu 23.10+ / 24.04 und andere aktuelle Distributionen
Unter Ubuntu 23.10 und späteren Versionen (einschließlich 24.04 LTS) sowie unter anderen Distributionen mit derselben Kernel-Härtung **installieren Sie das `.deb`-Paket** (oder das `.rpm` unter Fedora/openSUSE) anstelle des AppImage.

Diese Kernel schränken standardmäßig unprivilegierte Benutzer-Namespaces ein (`kernel.apparmor_restrict_unprivileged_userns=1`). MailCopilot basiert auf Electron, dessen `chrome-sandbox`-Hilfsprogramm diese Berechtigung beim Start aus einem AppImage benötigt — daher stürzt das AppImage beim Start mit einem `SIGTRAP` ab. Die `.deb`- und `.rpm`-Pakete haben dieses Problem nicht: Ihre Installationsskripte konfigurieren das `chrome-sandbox`-Hilfsprogramm entsprechend — mit SUID-root (`chmod 4755`), wo unprivilegierte Benutzer-Namespaces eingeschränkt sind, oder durch die Installation eines AppArmor-Profils auf neueren Ubuntu-Systemen (24.04+).

Umgehen Sie dies **nicht** durch den Start mit `--no-sandbox` oder durch das globale Deaktivieren von `apparmor_restrict_unprivileged_userns` — beides schwächt die Sicherheitsgrenze, die Sie vor nicht vertrauenswürdigen E-Mail-Inhalten schützt. Verwenden Sie stattdessen das `.deb` oder `.rpm`.
:::

### Deb (Debian, Ubuntu, Mint) — empfohlen

1. Laden Sie die `.deb`-Datei von der Website herunter.
2. Installieren Sie sie per Doppelklick oder im Terminal:
   ```bash
   sudo dpkg -i mailcopilot-*.deb
   ```
3. Starten Sie MailCopilot aus dem Anwendungsmenü.

### RPM (Fedora, openSUSE)

1. Laden Sie die `.rpm`-Datei von der Website herunter.
2. Installieren Sie sie per Doppelklick oder im Terminal:
   ```bash
   sudo rpm -i mailcopilot-*.rpm
   ```
3. Starten Sie MailCopilot aus dem Anwendungsmenü.

### AppImage

Das AppImage ist eine einzelne, eigenständige Datei, die keine Installation erfordert. Es funktioniert gut auf älteren Distributionen, lesen Sie jedoch die obige Warnung, bevor Sie es unter Ubuntu 23.10+ / 24.04 verwenden.

1. Laden Sie die `.AppImage`-Datei von der Website herunter.
2. Machen Sie die Datei ausführbar:
   - Rechtsklick > **Eigenschaften** > **Berechtigungen** > **Ausführen als Programm erlauben**.
   - Oder im Terminal: `chmod +x mailcopilot-*.AppImage`
3. Doppelklicken Sie auf das AppImage, um MailCopilot zu starten.

Die AppImage-Laufzeit benötigt FUSE. Auf aktuellen Debian/Ubuntu-Versionen installieren Sie das Paket `libfuse2t64` (auf älteren Versionen heißt es `libfuse2`):

```bash
sudo apt install libfuse2t64
```

:::tip
Sie können das AppImage an einen beliebigen Ort verschieben, z.B. `~/Applications/`. Die Anwendung ist vollständig eigenständig.
:::

## Installation unter Windows

1. Laden Sie den `.exe`-Installer von der Website herunter.
2. Führen Sie den Installer aus und folgen Sie den Anweisungen. Sie können das Installationsverzeichnis wählen.
3. Starten Sie MailCopilot über das Startmenü oder die Desktop-Verknüpfung.

## Erster Start

Beim ersten Start sehen Sie zunächst einen Zustimmungsbildschirm mit dem Titel **Diagnosedaten senden?**, der fragt, ob MailCopilot Diagnose- und Nutzungsdaten senden darf -- siehe [Telemetrie](../privacy/telemetry) für die genaue Bedeutung. Bevor Sie antworten, wird nichts gesendet, und Ihre Wahl hat keinen Einfluss auf die Mail-Synchronisierung oder den KI-Assistenten. Eine Sache ändert sich unter Einstellungen -> Über: Bei ausgeschalteter Diagnose wird das eingebaute Feedback-Formular durch einen Link zur MailCopilot-Website ersetzt. Nach Ihrer Antwort öffnet sich der Kontoeinrichtungs-Assistent, der Sie durch die Verbindung Ihres ersten E-Mail-Kontos führt.

Ihre Passwörter werden sicher im System-Schlüsselring gespeichert (über keytar) und werden niemals in Klartextkonfigurationsdateien geschrieben.

## Automatische Updates

MailCopilot prüft automatisch auf Updates. Bei einer neuen Version erscheint eine Benachrichtigung. Sie können das Update mit einem Klick herunterladen und neu starten.

:::note
Der eingebaute Update-Mechanismus von MailCopilot kann versuchen, sich selbst zu aktualisieren — bei AppImage-, `.deb`/`.rpm`/pacman-Installationen sowie unter Windows und macOS. Bei einer AppImage ersetzt MailCopilot die `.AppImage`-Datei selbst, sie muss also an einem Ort liegen, der für Ihr Benutzerkonto beschreibbar ist — zum Beispiel im Home-Verzeichnis. Bei einem `.deb`/`.rpm`/pacman-Paket fordert der Update-Mechanismus vor dem Versuch, das Update zu schreiben, Administratorrechte an (`pkexec`/`sudo`), genau wie es `apt`/`dnf`/`pacman` tun würden — dass das Installationsverzeichnis root gehört, ist daher kein Hindernis, auch wenn das endgültige Ergebnis von dieser Rechteerhöhungsabfrage und dem Paketmanager abhängt, nicht von MailCopilot. Selbstaktualisierung ist im Voraus nur dann nicht möglich, wenn MailCopilot nicht in einer dieser gepackten Formen läuft (zum Beispiel eine entpackte AppImage oder ein rohes, nicht gepacktes Verzeichnis), oder wenn das Verzeichnis, in das MailCopilot schreiben müsste, nicht beschreibbar ist — der eigene Ordner der AppImage, oder unter Windows und macOS der Ordner mit der installierten ausführbaren Datei. In diesen Fällen aktualisieren Sie über Ihren Paketmanager, mit Administratorrechten, oder durch Herunterladen und erneutes Installieren des neuesten Pakets von der Website.
:::
