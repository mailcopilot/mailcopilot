---
sidebar_position: 1
title: General Settings
---

# General Settings

Open the settings window by clicking the gear icon in the sidebar or going to **Settings**.

## Theme

Choose between **Light** and **Dark** themes. The interface updates immediately when you switch. When dark mode is active, windows open with a dark background from the very first frame -- no white flash.

## Language

MailCopilot supports 6 interface languages:

- English
- Russian
- French
- German
- Spanish
- Italian

Select your preferred language from the dropdown. The interface switches instantly without needing a restart.

## Message Retention

Controls how long full message copies (HTML content, inline images, and attachments) are kept on disk. Open **Settings > General** and use the **Keep full message copy for** dropdown to choose a retention period. Older messages remain searchable through their headers and plain text — only the rich `.eml` file is deleted when the period expires.

| Option | Duration |
|--------|----------|
| 30 days | ~1 month |
| 90 days | ~3 months |
| 180 days | ~6 months |
| 1 year | 365 days (default) |
| Forever | No automatic pruning |

When you shorten the retention period, MailCopilot shows a preview of how many cached messages will be removed before applying the change. Messages on the server are never modified -- only the local copy is affected.

## Default Email Application

Toggle whether MailCopilot is registered with your operating system as the default handler for `mailto:` links. When enabled, clicking a "Send email" link in your browser, terminal, or another desktop application opens the MailCopilot compose window with the recipient and any other parameters pre-filled (`to`, `cc`, `bcc`, `subject`, `body`).

Registration is opt-in -- MailCopilot does not claim the protocol unless you explicitly enable this toggle. On Linux the registration goes through the desktop file's `MimeType` declaration; on macOS through `open-url`; on Windows through the protocol entry under `HKCR\mailto`. You can revert at any time by toggling this off, or by changing the default email handler in your system settings.

When MailCopilot is launched a second time -- for example by clicking a `mailto:` link while the app is already open -- the existing window is brought to the front instead of opening a duplicate, so you only ever have one running instance.

## TLS Certificate Trust

MailCopilot verifies every TLS certificate presented by your mail servers against both the built-in Mozilla certificate bundle and your operating system's certificate store. Trusting the system store as well means that security software that inspects TLS traffic (for example Kaspersky and similar antivirus products) and corporate proxies no longer break mail sync on Windows, macOS, or Linux -- MailCopilot recognizes the certificates these tools present as valid instead of rejecting the connection. Certificate verification itself is never weakened by this: a certificate still has to be trusted by one of these two sources, or explicitly pinned, to be accepted. If your operating system's certificate store cannot be read, MailCopilot falls back to the built-in Mozilla bundle alone rather than skipping verification.

### Certificate change recovery

If a server ever presents a certificate that cannot be trusted -- for example it no longer matches a certificate you previously accepted, or a self-signed certificate changed after rotation -- MailCopilot shows **The server presented a different certificate** directly in the main window, not only during account setup. The dialog lists the server, the issuer, and the SHA-256 fingerprint of the new certificate.

Confirming works in up to two steps, so that what you approve always matches what is actually on screen:

- If the fingerprint has not been read yet, the main button reads **Read the certificate**. Click it to fetch the certificate from the server; its details then replace the placeholder in the dialog.
- Once a fingerprint is shown, the button reads **Trust and continue**. Click it to accept exactly the certificate displayed.
- If the server's certificate changes again between opening the dialog and confirming, MailCopilot refuses the stale confirmation and re-reads the certificate to show you the new details -- but the dialog's offer to trust was tied to the certificate it first showed, and re-reading does not renew it, so confirming again will keep failing the same way. Click **Cancel** to close this dialog, then let MailCopilot try the connection again; a fresh dialog with the current certificate will appear for you to confirm. Nothing is trusted in the meantime.

Choose **Cancel** at any point to keep the previous state instead. The same server will not show this dialog again more than once per minute. The dialog's offer to trust does not stay open indefinitely either -- if it has been sitting unanswered for a long time, confirming it can be refused; here too, cancel and wait for a fresh dialog to appear.

### Reconfirming a pinned self-signed server after updating

Certificate pinning is now strictly enforced for certificates that fail ordinary chain verification: previously, pinning only compared fingerprints for certificates whose chain already verified normally, while self-signed and private-CA certificates -- the exact case pinning exists for -- bypassed the fingerprint check entirely. That gap is now closed. If you pinned a self-signed or private-CA mail server before this change, the pin on file may hold only a fingerprint without the certificate needed to actually verify it -- such a server will stop connecting after updating, and MailCopilot will show the certificate recovery dialog described above.

To fix this, reconfirm the certificate through that dialog: if the button reads **Read the certificate**, click it first to fetch the certificate, then click **Trust and continue**; if **Trust and continue** is already showing, just click it. This saves the pin together with the certificate itself, and sync resumes automatically. You only need to do this once per affected server. Adding or editing a pin manually in **Settings** cannot fix this on its own -- for a certificate that is otherwise untrusted (self-signed, or issued by a private certificate authority not already in your OS trust store), only the recovery dialog can grant it trust; see [When to Use Certificate Pinning](#when-to-use-certificate-pinning) below for why.

### Interception notice

After the first successful sync of an account in a session, MailCopilot checks once whether its mail server connection is being inspected by antivirus software or a proxy (the certificate is only trusted through the system store) and, if so, shows a notice such as "The connection to `{host}` is being inspected." naming the issuer when it is known. This check runs at most once per server for the lifetime of your profile, whether or not interception was found -- so if interception is turned on for a server *after* this one-time check already ran clean, MailCopilot will not notice it. The notice can be dismissed.

Certificate errors are retried on a long interval (6 hours) rather than the short interval used for ordinary network failures, since they require your decision and will not resolve on their own.

## TLS Certificate Pinning

TLS Certificate Pinning adds an extra layer of security for your email connections. It ensures that your client only connects to servers presenting a specific certificate, protecting against man-in-the-middle attacks.

### Managing Certificate Pins

1. Open **Settings** and go to the **Accounts** section.
2. Click **Edit** on an account to open its settings.
3. Scroll down to the **TLS Certificate Pinning** section.

The section shows a table of pinned certificates with their host, port, fingerprint, and the date they were added.

### Adding a Pin

1. Click **Add pin**.
2. Enter the **host** (e.g., `imap.gmail.com`) and **port** (e.g., `993`).
3. Click **Fetch & Pin**. MailCopilot connects to the server, retrieves its certificate, and shows you the fingerprint.
4. Confirm to save the pin.

A pin added this way only *narrows* which certificate is accepted for a server that is already trusted through the normal Mozilla bundle or your OS certificate store -- it does not by itself make an otherwise-untrusted self-signed or private-CA certificate trusted. For a self-signed mail server (or one from a private certificate authority not already in your OS trust store), adding a pin here is not enough to connect; you need to confirm it through the certificate recovery dialog described in [TLS Certificate Trust](#tls-certificate-trust), which is the only place MailCopilot grants trust to such a certificate.

### Removing a Pin

Click the delete button next to any pin in the table to remove it. This only removes the saved pin -- afterwards, MailCopilot will accept any valid certificate from that server.

Adding a pin automatically reconnects to the mail server so the change takes effect immediately. Removing a pin does not reconnect automatically -- it takes effect the next time MailCopilot connects to that server.

### STARTTLS servers (ports 143 and 587)

Servers reached over STARTTLS (typically IMAP port 143 or SMTP port 587, where the connection starts in plain text and upgrades to TLS) do not hand over their certificate at the point where MailCopilot captures it for pinning. For these servers only the fingerprint is stored, not the certificate itself -- so a self-signed or private-CA STARTTLS server cannot be made to connect this way; use implicit TLS (typically port 993 for IMAP, 465 for SMTP) if your server supports it.

### When to Use Certificate Pinning

Certificate pinning is especially useful for corporate environments or situations where you need to verify that your email connections are going to the expected servers. For most personal use, the default TLS verification is sufficient.
