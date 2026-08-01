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

## Diagnostics and Usage Data

When enabled, MailCopilot sends crash reports, performance measurements, product usage events (which features are used, which AI provider and model, the estimated cost of a request), and a random install identifier that links your sessions. Message content and your search text are never included; addresses, subjects, and folder names are ruled out entirely wherever the diagnostics use a closed field list (as in the sent-copy failure diagnostics), and elsewhere caught by best-effort scrubbing of recognizable address and path shapes -- a safety net, not a guarantee. The feedback form below is the only place an address is sent on purpose, so that you can get a reply; everywhere else it is only ever scrubbed, not guaranteed absent -- and because the install identifier is included, this data is not fully anonymous. See [Telemetry](../privacy/telemetry) for the full list of what is and is not sent.

This setting reflects the answer you gave on the consent screen shown the first time you started MailCopilot, and is **off by default** -- nothing is sent unless you actively allowed it. You can change your decision at any time by checking or unchecking the checkbox.

If MailCopilot has no record of an answer to the consent question -- for example, right after the list of collected data changes and a re-ask becomes due -- the checkbox here is shown unchecked and disabled, with a note that diagnostics stay off until you respond to the consent screen on the next start.

## Debug Logging

When enabled, MailCopilot writes detailed logs to a file for troubleshooting purposes. These logs are stored locally on your computer and are never sent automatically.

Debug logging is disabled by default. Enable it only when investigating an issue -- it may slightly affect performance.

## Report a Bug

Click the **Report a bug** button to send feedback directly to the MailCopilot developers. Describe the issue you encountered -- this helps us identify and fix problems faster.

Your feedback is sent securely through the same diagnostics reporting system described above. If error reporting is disabled, you will see a link to the MailCopilot website where you can contact support.

When the application encounters an unexpected error, a feedback form will also appear on the error screen, allowing you to describe what you were doing before the error occurred.
