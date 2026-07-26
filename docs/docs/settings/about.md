---
sidebar_position: 6
title: About
---

# About

The **About** tab in Settings shows information about your MailCopilot installation and provides controls for diagnostics and updates.

## Version

Displays the current version of MailCopilot installed on your computer.

## Links

- **Website** -- opens the MailCopilot website in your browser.
- **Documentation** -- opens this documentation site.

## System Info

The **System info** panel displays technical details about your installation:

- **App version** -- the current MailCopilot version and release channel (stable, nightly, or dev).
- **Electron** -- the version of the Electron runtime used by MailCopilot.
- **Chromium** -- the version of the Chromium engine bundled with Electron.
- **Node.js** -- the Node.js version running inside the app.
- **Platform** -- the operating system and architecture.
- **Install path** -- the directory where MailCopilot is installed. If the path is marked as **read-only**, the installation is system-wide and automatic updates require administrator privileges.

This information is useful when reporting bugs or checking compatibility.

## Updates

The **Updates** section lets you control how MailCopilot keeps itself up to date.

### Automatically download updates in the background

When this option is enabled, MailCopilot silently downloads new versions as they become available. Once a download is complete, you are prompted to restart the application to apply the update. No action is needed until you are ready to restart.

When this option is disabled, MailCopilot notifies you that an update is available and shows a **Download** button. You control exactly when the download begins.

This setting is **disabled by default** (opt-in). Enable it to let MailCopilot download updates without a manual click.

### Check for updates

Click the **Check for updates** button to manually trigger an update check at any time. The button and status area reflect the current state of the update process:

- **idle** -- the **Check for updates** button is visible and ready to use.
- **Checking...** -- an update check is in progress; the button is disabled until the check completes.
- **You're on the latest version** -- no update is available.
- **Update available: vX.Y.Z** -- a new version is detected; a **Download X.Y.Z** button appears if the installation supports self-update.
- **Downloading... N%** -- the update file is being downloaded; a progress indicator shows the percentage.
- **Restart to install** -- the download is complete; click to restart MailCopilot and apply the update immediately.
- **Network error -- try again when you're online** -- the check or download failed due to a network problem.
- **Permission denied -- administrator required** -- the installation directory is not writable by the current user.
- **Update failed -- see logs for details** -- an unexpected error occurred; check Debug Logging for more information.
- **Updates are disabled in this build** -- MailCopilot is running in development or non-packaged mode; automatic updates are not available.

### Read-only installations

If MailCopilot was installed system-wide (for example, via a package manager that places the application in a protected directory), the **Install path** in System info is marked as **read-only**. In this case:

- The **Automatically download updates in the background** checkbox is shown but **disabled** (greyed out), with a tooltip explaining that the installation is read-only.
- The **Check for updates** button **remains functional** -- you can still check whether a new version is available.
- The **Download** and **Restart to install** controls are gated: they do not appear or do not function for read-only installations, because MailCopilot cannot write the update to a protected directory.

Update the application through your package manager or with administrator privileges.

## Anonymous Error Reports

When enabled, MailCopilot sends anonymous crash reports to help the developers find and fix bugs. No personal data, email content, or account information is ever collected -- only technical error details.

This setting is enabled by default. You can disable it at any time by unchecking the checkbox.

## Debug Logging

When enabled, MailCopilot writes detailed logs to a file for troubleshooting purposes. These logs are stored locally on your computer and are never sent automatically.

Debug logging is disabled by default. Enable it only when investigating an issue -- it may slightly affect performance.

## Report a Bug

Click the **Report a bug** button to send feedback directly to the MailCopilot developers. Describe the issue you encountered -- this helps us identify and fix problems faster.

Your feedback is sent securely through the same anonymous error reporting system. If error reporting is disabled, you will see a link to the MailCopilot website where you can contact support.

When the application encounters an unexpected error, a feedback form will also appear on the error screen, allowing you to describe what you were doing before the error occurred.
