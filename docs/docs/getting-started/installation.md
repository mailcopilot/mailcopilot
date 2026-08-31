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

When you start MailCopilot for the first time, you first see a consent screen titled **Send diagnostic data?**, asking whether MailCopilot may send diagnostic and usage data -- see [Telemetry](../privacy/telemetry) for exactly what that means. Nothing is sent until you answer, and your choice does not affect mail sync or the AI assistant. It does change one thing in Settings → About: with diagnostics off, the built-in feedback form is replaced with a link to the MailCopilot website instead. After you respond, the account setup wizard opens and guides you through connecting your first email account.

Your passwords are securely stored in the system keychain (via keytar) and are never written to plain-text configuration files.

## Automatic Updates

MailCopilot checks for updates automatically. When a new version is available, a notification will appear in the application. You can download the update and restart with one click.

:::note
MailCopilot's built-in update mechanism can attempt to update itself in place for AppImage, `.deb`/`.rpm`/pacman, Windows, and macOS installs. For an AppImage, MailCopilot replaces the `.AppImage` file itself, so it needs to be stored somewhere writable by your user account -- for example, your home directory. For a `.deb`/`.rpm`/pacman package, the update mechanism requests administrator privileges (`pkexec`/`sudo`) before attempting to write the update, the same way `apt`/`dnf`/`pacman` would -- the fact that the install directory is owned by root does not stop it, though the final outcome depends on that privilege prompt and the package manager, not on MailCopilot. Self-update is unavailable ahead of time only when MailCopilot isn't running as one of these packaged forms (for example, an extracted AppImage or a raw unpacked folder), or when the folder MailCopilot would need to write into isn't writable -- an AppImage's own folder, or on Windows and macOS the folder holding the installed executable. In those cases, update through your package manager or administrator privileges, or by downloading and reinstalling the latest package from the website.
:::
