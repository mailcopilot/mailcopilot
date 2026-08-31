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
- **Install path** -- the path to the currently running executable (`process.execPath`). On Windows and macOS this is where MailCopilot is installed. On an AppImage, `execPath` points inside a temporary `/tmp/.mount_*` location created while the app is running, not the location of the `.AppImage` file itself -- the **read-only** marker reflects the writability of the AppImage file's actual folder, not of the path shown here. This marker never appears for `.deb`/`.rpm`/pacman installations, which use administrator privileges to write updates instead of relying on folder permissions.

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
- **Checking…** — an update check is in progress; the button is disabled until the check completes.
- **You're on the latest version** -- no update is available.
- **available** -- a new version was found: a hint reading **(latest available X.Y.Z)** appears next to the version number above, and -- if the installation supports self-update -- a **Download X.Y.Z** button appears here.
- **Downloading... N%** -- the update file is being downloaded; a progress indicator shows the percentage.
- **Restart to install** -- the download is complete; click to restart MailCopilot and apply the update immediately.
- **Network error — try again when you're online** -- the check or download failed due to a network problem.
- **Permission denied — administrator required** -- the update mechanism or the operating system denied access. On installs that use administrator privileges (`.deb`/`.rpm`/pacman), this usually means the privilege-elevation step or the package installation step failed, not that a folder is unwritable.
- **Update failed — see logs for details** -- an unexpected error occurred; check Debug Logging for more information.
- **Updates are disabled in this build** -- MailCopilot is running in development or non-packaged mode; automatic updates are not available.

### When self-update isn't available

MailCopilot can normally update itself in place on every platform it supports: an AppImage install replaces the `.AppImage` file itself, and a `.deb`/`.rpm`/pacman install lets the update mechanism attempt the write by requesting administrator privileges (`pkexec`/`sudo`), the same way `apt`/`dnf`/`pacman` would. The actual outcome on those packaged-Linux installs is decided by the privilege-elevation prompt and the package manager, not by MailCopilot -- a failure there shows an **Update installation failed** dialog with a link to the downloads page, not silently.

MailCopilot only decides ahead of time that self-update is unavailable in two situations:

- **The build isn't packaged** -- a development or CI build. There is no updater at all: the **Check for updates** button and the status area do not appear, and a note reads **"Updates are disabled in this build"** instead.
- **The build is packaged, but MailCopilot has a specific reason to expect the write would fail**, which happens when:
  - the Linux build is neither an AppImage nor a supported system package -- for example, an extracted AppImage or a raw `linux-unpacked` folder, or
  - the folder MailCopilot would need to write into is not writable by your user account. On an AppImage that is the folder holding the `.AppImage` file; on Windows and macOS it is the folder holding the installed executable. This check does not apply to `.deb`/`.rpm`/pacman installs, because the update mechanism elevates privileges for those instead.

In the second case, checking for updates still works normally -- only writing the update in place is affected:

- The **Check for updates** button stays available and works -- you can always check whether a new version exists.
- The **Automatically download updates in the background** checkbox stays available and keeps saving your preference, but nothing downloads automatically until self-update becomes possible.
- A warning appears next to the checkbox explaining why -- for example, *"This build can't replace itself in place (it isn't running as an AppImage or a system package). Download the new version manually from the website."* or *"The folder that holds the app is not writable, so updates can't be installed in place. Download the new version manually, or move the app to a folder you own."* If MailCopilot cannot determine the specific reason, a neutral warning appears instead: *"This installation can't update itself automatically. Download the new version manually from the website."*
- The **Download** and **Restart to install** controls do not appear, because MailCopilot has no way to write the update itself.

This check runs once, when MailCopilot starts. If you move the AppImage file to a writable location or change permissions on the install folder, quit and restart MailCopilot for the change to take effect -- an already-running instance keeps its original verdict.

Update the application through your package manager, with administrator privileges, or by downloading the new version manually from the website.

## Diagnostics and Usage Data

When enabled, MailCopilot sends crash reports, performance measurements, product usage events (which features are used, which AI provider and model, the estimated cost of a request), and a random install identifier that links your sessions. Message content and your search text are never included; addresses, subjects, and folder names are ruled out entirely wherever the diagnostics use a closed field list (as in the sent-copy failure diagnostics), and elsewhere caught by best-effort scrubbing of recognizable address and path shapes -- a safety net, not a guarantee. The feedback form below is the only place an address is sent on purpose, so that you can get a reply; everywhere else it is only ever scrubbed, not guaranteed absent -- and because the install identifier is included, this data is not fully anonymous. See [Telemetry](../privacy/telemetry) for the full list of what is and is not sent.

This setting reflects the answer you gave on the consent screen shown the first time you started MailCopilot, and is **off by default** -- nothing is sent unless you actively allowed it. You can change your decision at any time by checking or unchecking the checkbox.

If MailCopilot has no record of an answer to the consent question -- for example, right after the list of collected data changes and a re-ask becomes due -- the checkbox here is shown unchecked and disabled, with a note that diagnostics stay off until you respond to the consent screen on the next start.

## Debug Logging

When enabled, MailCopilot writes detailed logs to a file for troubleshooting purposes. These logs are stored locally on your computer and are never sent automatically.

Debug logging is disabled by default. Enable it only when investigating an issue -- it may slightly affect performance.

MailCopilot decides whether to write this file once, at startup, based on this setting at that moment -- turning it on takes effect only after you restart MailCopilot. In an installed copy of the app, no log file exists at all until you have enabled this option and restarted at least once, so if you are chasing an issue, turn this on, restart, and only then try to reproduce it. The file only ever captures what happens in MailCopilot's main process; diagnostic output produced inside a particular window -- what you would see in that window's developer tools console -- is not written here.

## Report a Bug

Click the **Report a bug** button to send feedback directly to the MailCopilot developers. Describe the issue you encountered -- this helps us identify and fix problems faster.

Your feedback is sent securely through the same diagnostics reporting system described above. If error reporting is disabled, you will see a link to the MailCopilot website where you can contact support.

When the application encounters an unexpected error, a feedback form will also appear on the error screen, allowing you to describe what you were doing before the error occurred.
