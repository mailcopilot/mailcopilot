---
sidebar_position: 1
title: Installation
---

# Installation

## Downloading MailCopilot

Visit [mailcopilot.io](https://mailcopilot.io) to download the latest version of MailCopilot for your platform.

## Installing on Linux

:::warning Ubuntu 23.10+ / 24.04 and other recent distributions
On Ubuntu 23.10 and later (including 24.04 LTS), and on other distributions that ship the same kernel hardening, **install the `.deb` package** (or the `.rpm` on Fedora/openSUSE) rather than the AppImage.

These kernels restrict unprivileged user namespaces by default (`kernel.apparmor_restrict_unprivileged_userns=1`). MailCopilot is built on Electron, whose `chrome-sandbox` helper needs that capability when it is launched from an AppImage — so the AppImage crashes on startup with a `SIGTRAP`. The `.deb` and `.rpm` packages do not have this problem: their install scripts configure the `chrome-sandbox` helper appropriately — using SUID-root (`chmod 4755`) where unprivileged user namespaces are restricted, or installing an AppArmor profile on newer Ubuntu systems (24.04+).

Do **not** work around this by launching with `--no-sandbox` or by globally disabling `apparmor_restrict_unprivileged_userns` — both weaken the security boundary that protects you from untrusted email content. Use the `.deb` or `.rpm` instead.
:::

### Deb (Debian, Ubuntu, Mint) — recommended

1. Download the `.deb` file from the website.
2. Install it by double-clicking the file, or run in a terminal:
   ```bash
   sudo dpkg -i mailcopilot-*.deb
   ```
3. Launch MailCopilot from the application menu.

### RPM (Fedora, openSUSE)

1. Download the `.rpm` file from the website.
2. Install it by double-clicking the file, or run in a terminal:
   ```bash
   sudo rpm -i mailcopilot-*.rpm
   ```
3. Launch MailCopilot from the application menu.

### AppImage

The AppImage is a single self-contained file that does not require installation. It works well on older distributions, but see the warning above before using it on Ubuntu 23.10+ / 24.04.

1. Download the `.AppImage` file from the website.
2. Make the file executable:
   - Right-click the file, select **Properties**, go to the **Permissions** tab, and check **Allow executing file as program**.
   - Or run in a terminal: `chmod +x mailcopilot-*.AppImage`
3. Double-click the AppImage to launch MailCopilot.

The AppImage runtime requires FUSE. On recent Debian/Ubuntu releases install the `libfuse2t64` package (older releases call it `libfuse2`):

```bash
sudo apt install libfuse2t64
```

:::tip
You can move the AppImage to any convenient location, such as `~/Applications/`. The application is fully self-contained and does not require installation.
:::

## Installing on Windows

1. Download the `.exe` installer from the website.
2. Run the installer and follow the on-screen instructions. You can choose the installation directory.
3. Launch MailCopilot from the Start menu or desktop shortcut.

## First Launch

When you start MailCopilot for the first time, you will see the account setup wizard. The application will guide you through connecting your first email account.

Your passwords are securely stored in the system keychain (via keytar) and are never written to plain-text configuration files.

## Automatic Updates

MailCopilot checks for updates automatically. When a new version is available, a notification will appear in the application. You can download the update and restart with one click.

:::note
In-app self-update is available only when MailCopilot is installed in a writable location — for example, an AppImage stored in your home directory. When installed from a `.deb` or `.rpm` system package, the install directory is typically owned by root and is not writable by your user account, so MailCopilot disables the in-app updater automatically. In that case, update through your package manager (`apt`/`dnf`) or by downloading and reinstalling the latest package from the website.
:::
