---
sidebar_position: 1
title: Installation
---

# Installation

## MailCopilot herunterladen

Besuchen Sie [mailcopilot.io](https://mailcopilot.io), um die neueste Version herunterzuladen.

## Installation unter Linux

:::warning Ubuntu 23.10+ / 24.04 und andere aktuelle Distributionen
Unter Ubuntu 23.10 und spaeteren Versionen (einschliesslich 24.04 LTS) sowie unter anderen Distributionen mit derselben Kernel-Haertung **installieren Sie das `.deb`-Paket** (oder das `.rpm` unter Fedora/openSUSE) anstelle des AppImage.

Diese Kernel schraenken standardmaessig unprivilegierte Benutzer-Namespaces ein (`kernel.apparmor_restrict_unprivileged_userns=1`). MailCopilot basiert auf Electron, dessen `chrome-sandbox`-Hilfsprogramm diese Berechtigung beim Start aus einem AppImage benoetigt — daher stuerzt das AppImage beim Start mit einem `SIGTRAP` ab. Die `.deb`- und `.rpm`-Pakete haben dieses Problem nicht: Ihre Installationsskripte konfigurieren das `chrome-sandbox`-Hilfsprogramm entsprechend — mit SUID-root (`chmod 4755`), wo unprivilegierte Benutzer-Namespaces eingeschraenkt sind, oder durch die Installation eines AppArmor-Profils auf neueren Ubuntu-Systemen (24.04+).

Umgehen Sie dies **nicht** durch den Start mit `--no-sandbox` oder durch das globale Deaktivieren von `apparmor_restrict_unprivileged_userns` — beides schwaecht die Sicherheitsgrenze, die Sie vor nicht vertrauenswuerdigen E-Mail-Inhalten schuetzt. Verwenden Sie stattdessen das `.deb` oder `.rpm`.
:::

### Deb (Debian, Ubuntu, Mint) — empfohlen

1. Laden Sie die `.deb`-Datei von der Website herunter.
2. Installieren Sie sie per Doppelklick oder im Terminal:
   ```bash
   sudo dpkg -i mailcopilot-*.deb
   ```
3. Starten Sie MailCopilot aus dem Anwendungsmenue.

### RPM (Fedora, openSUSE)

1. Laden Sie die `.rpm`-Datei von der Website herunter.
2. Installieren Sie sie per Doppelklick oder im Terminal:
   ```bash
   sudo rpm -i mailcopilot-*.rpm
   ```
3. Starten Sie MailCopilot aus dem Anwendungsmenue.

### AppImage

Das AppImage ist eine einzelne, eigenstaendige Datei, die keine Installation erfordert. Es funktioniert gut auf aelteren Distributionen, lesen Sie jedoch die obige Warnung, bevor Sie es unter Ubuntu 23.10+ / 24.04 verwenden.

1. Laden Sie die `.AppImage`-Datei von der Website herunter.
2. Machen Sie die Datei ausfuehrbar:
   - Rechtsklick > **Eigenschaften** > **Berechtigungen** > **Ausfuehren als Programm erlauben**.
   - Oder im Terminal: `chmod +x mailcopilot-*.AppImage`
3. Doppelklicken Sie auf das AppImage, um MailCopilot zu starten.

Die AppImage-Laufzeit benoetigt FUSE. Auf aktuellen Debian/Ubuntu-Versionen installieren Sie das Paket `libfuse2t64` (auf aelteren Versionen heisst es `libfuse2`):

```bash
sudo apt install libfuse2t64
```

:::tip
Sie koennen das AppImage an einen beliebigen Ort verschieben, z.B. `~/Applications/`. Die Anwendung ist vollstaendig eigenstaendig.
:::

## Installation unter Windows

1. Laden Sie den `.exe`-Installer von der Website herunter.
2. Fuehren Sie den Installer aus und folgen Sie den Anweisungen. Sie koennen das Installationsverzeichnis waehlen.
3. Starten Sie MailCopilot ueber das Startmenue oder die Desktop-Verknuepfung.

## Erster Start

Beim ersten Start erscheint der Kontoeinrichtungs-Assistent. Die Anwendung fuehrt Sie durch die Verbindung Ihres ersten E-Mail-Kontos.

Ihre Passwoerter werden sicher im System-Schluesselring gespeichert (ueber keytar) und werden niemals in Klartextkonfigurationsdateien geschrieben.

## Automatische Updates

MailCopilot prueft automatisch auf Updates. Bei einer neuen Version erscheint eine Benachrichtigung. Sie koennen das Update mit einem Klick herunterladen und neu starten.

:::note
In-App-Selbstaktualisierungen sind nur verfuegbar, wenn MailCopilot an einem beschreibbaren Speicherort installiert ist — zum Beispiel ein AppImage im Home-Verzeichnis. Bei Installation ueber ein `.deb`- oder `.rpm`-Systempaket gehoert das Installationsverzeichnis in der Regel root und ist fuer Ihren Benutzeraccount nicht beschreibbar, daher deaktiviert MailCopilot den In-App-Updater automatisch. In diesem Fall aktualisieren Sie ueber Ihren Paketmanager (`apt`/`dnf`) oder durch Herunterladen und erneutes Installieren des neuesten Pakets von der Website.
:::
