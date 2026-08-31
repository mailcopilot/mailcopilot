---
sidebar_position: 2
title: Adding an Account
---

# Adding an Email Account

MailCopilot supports any email provider that uses standard IMAP and SMTP protocols. You can also sign in with Google or with a Microsoft 365 / Outlook.com account using OAuth for a seamless experience.

## Adding via the Setup Wizard

When you click **Connect email** (the mail icon at the bottom of the sidebar) or open the account manager, you will see the setup wizard.

### Step 1: Choose Your Provider

The wizard now starts with an explicit provider picker -- you tell MailCopilot which provider you use before entering any credentials. Each provider is shown as a card with its provider logo or icon:

- **Gmail** -- jumps straight into the Google OAuth flow. A browser window opens where you authorize MailCopilot to access your Gmail account; no password entry is needed.
- **Outlook / Microsoft 365** -- jumps into the Microsoft OAuth flow (Authorization Code with PKCE) and connects via Microsoft Graph. Works for personal `@outlook.com` / `@hotmail.com` / `@live.com` accounts as well as Microsoft 365 work and school accounts.
- **Generic IMAP/SMTP** -- for any other provider (Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail Bridge, your company mail, self-hosted servers, and so on). Advances to a confirmation step that exposes a single **IMAP/SMTP account** button, which then opens the credential-entry form.

You can move between cards with the arrow keys and confirm the selection with **Enter** or **Space**. After picking a provider, the wizard proceeds with the steps appropriate for that provider. On Generic IMAP/SMTP, the **Back** button on the confirmation step returns to the provider picker; the credential-entry step also has a **Back** button, and it returns to the confirmation step (one step at a time). The server-detection and manual-configuration steps move forward only — to start over with a different provider, cancel the wizard and reopen it.

If you ever want to use Outlook over Generic IMAP/SMTP instead of OAuth, you can pick the Generic card and connect with an app password against `outlook.office365.com` / `smtp.office365.com`.

### Step 2: Enter Your Credentials (Generic IMAP/SMTP)

If you chose Generic IMAP/SMTP:

1. Enter your **email address** and **password**.
2. Optionally enter a **display name** (the name shown in outgoing messages).
3. Optionally enter an **email address (From)** -- this is the address used in the "From" field of outgoing messages. If left blank, the SMTP login address is used.
4. If your SMTP credentials are different from your IMAP credentials, check **"SMTP login/password is different"** and enter them separately.
5. Click **Next**.

### Step 3: Server Detection

MailCopilot will attempt to automatically detect your mail server settings using standard autodiscovery protocols. If successful, the detected IMAP and SMTP servers are shown in editable fields. You can review and adjust the display name, email address, server hosts, ports, and SSL settings before connecting.

- Click **Connect** to test the connection and save the account.
- If you want full manual control over all settings (including separate IMAP/SMTP credentials), click **Manual setup**.

### Manual Configuration

If automatic detection did not find your server, or if you need to customize the settings:

- **IMAP**: enter the host, port (typically 993), and check SSL/TLS.
- **SMTP**: enter the host, port (typically 465 or 587), and check SSL/TLS.
- Use the **Autoconfigure** button to try automatic detection again.
- Use the **Test connection** button to verify your settings before saving.

## Google Account (OAuth)

Pick the **Gmail** card in the wizard. A browser window will open where you can authorize MailCopilot. Once authorized, the account is added automatically with the correct IMAP and SMTP settings.

While the connection runs, the wizard replaces the provider list with a progress step showing what it is waiting on: your approval in the browser, then getting access, checking the mail and sending servers, and saving the account. Two parts have time limits: waiting for your approval in the browser (three minutes) and the server checks (30 seconds for incoming mail, 15 for outgoing, with one retry). The rest has none; everything else depends on the provider and your network, so the step reports what is happening rather than how long is left. If the account has no name yet and the provider supplies a usable one, it is filled in from the provider profile; a name you have edited is never overwritten by a later re-authorization. If the connection fails before the account is saved, the wizard returns to the provider list so you can try again. Closing the window does not cancel a connection that is already under way -- it continues in the background and may still add the account, so starting over at that moment can leave you with a duplicate. This progress step belongs to adding an account: re-authorizing an existing one from its settings shows a spinner on the button instead.

## Microsoft 365 / Outlook Account (OAuth)

Pick the **Outlook / Microsoft 365** card in the wizard. A browser window will open at the Microsoft sign-in page; sign in with your `@outlook.com`, `@hotmail.com`, `@live.com`, or work/school account and approve the requested permissions. The bundled Microsoft client uses the Authorization Code flow with PKCE without a client secret -- no client secret leaves your device. Custom builds that override the bundled client by setting **both** `MAILCOPILOT_MS_CLIENT_ID` (a custom Azure app registration) and `MAILCOPILOT_MS_CLIENT_SECRET` (intended for tenants that issued a confidential client) do send that secret to Microsoft's token endpoint over TLS. `MAILCOPILOT_MS_CLIENT_SECRET` on its own (without a custom client ID) is ignored. Once authorized, the account is added automatically.

The same waiting screen appears here as for Gmail, with the same stages and the same caveats -- the browser wait and the server checks are bounded, the rest is not, and closing the window does not cancel a connection in progress. Outlook skips the outgoing-server retry that Gmail does. Your name is taken from the Microsoft profile when the account has none and the profile supplies a usable one, and a name you have edited is never overwritten by a later re-authorization. The certificate prompt described below for Google appears on this path too, after the account has been saved.

For sending mail, MailCopilot uses Microsoft Graph (`POST /me/sendMail`) on Outlook accounts because Microsoft has disabled SMTP AUTH on most personal Outlook.com accounts created since 2024. The Graph send path is unaffected by that policy. Sent messages are saved to your Sent folder by Microsoft automatically.

If your Outlook account stops working after a long offline period, the OAuth refresh token may have expired. An OAuth refresh token that is missing from secure storage triggers the [Sign-In Expired Notice](#sign-in-expired-notice) immediately for both Google and Outlook accounts. If a stored token is rejected, any resulting IMAP authentication rejection follows the ordinary sign-in-failure flow; re-authorize the account from **Settings > Accounts** using the Microsoft re-authentication button.

## TLS Certificate Verification

MailCopilot always verifies TLS certificates when connecting to mail servers, checking them against both the built-in Mozilla certificate bundle and your operating system's certificate store (falling back to the built-in bundle alone if the OS store cannot be read). If your server uses a custom or self-signed certificate, a trust prompt will appear during the connection test. You can review the certificate details and choose to trust it: if the fingerprint has not been read yet, the button first reads **Read the certificate** -- click it, review the details, then confirm with **Trust and continue**; if **Trust and continue** is already showing, just click it. Servers reached over STARTTLS (typically IMAP port 143 or SMTP port 587) cannot hand over their certificate at this step, so only the fingerprint is stored for them -- a self-signed STARTTLS server cannot be trusted this way; use implicit TLS (typically port 993 or 465) instead if your server supports it.

When signing in with Google, if your network uses a proxy or antivirus that replaces TLS certificates with one your operating system does not already trust, MailCopilot will detect this and automatically offer to trust the certificate. You will see the certificate details (host, issuer, fingerprint) and can choose to accept or decline. The account is saved regardless, and you can manage certificate pins later in the account settings. If instead the proxy or antivirus root is already installed in your operating system's certificate store, the connection succeeds without any trust prompt -- MailCopilot flags this case separately with an informational notice (see below) rather than asking you to accept anything.

Trusting the system certificate store means that most corporate proxies and TLS-inspecting antivirus software work out of the box, without a trust prompt during setup. After your account's first successful sync in a session, MailCopilot checks once whether a connection is being inspected this way and, if so, shows a notice naming the software or proxy responsible; this check runs at most once per server for the lifetime of your profile, so interception turned on for a server after this check already ran will not be flagged. If a server's certificate later changes to one that cannot be trusted at all, MailCopilot will show a recovery dialog in the main window at that point -- see [TLS Certificate Trust](../settings/general#tls-certificate-trust) for details.

## Managing Multiple Accounts

You can add as many accounts as you need. To switch between accounts, use the sidebar or go to **Settings > Accounts**. The active account is highlighted, and you can set any account as the current one.

## Sign-In Expired Notice

If an account's credentials stop working -- for example an IMAP password was changed elsewhere, or the account has no password or OAuth authorization saved at all -- MailCopilot no longer fails silently in the background. A quiet notice appears above the message list: for example, "“Mail Account” is not receiving mail — its sign-in has expired. Sign in again to resume syncing." For an ordinary sign-in failure during regular mail operations, the notice appears only after two consecutive failed attempts for the same account. Two situations skip that threshold and show the notice right away instead. The first is an account with no credentials configured at all, since there is nothing left to retry. The second is a sign-in that the mail server rejects when MailCopilot starts background mail watching (IMAP IDLE) for that account: a full sign-in attempt that the server turned down is a conclusive verdict on your saved credentials, not just one operation that happened not to work, so there is no reason to wait for a second failure -- and a mailbox with folders set to manual updates might not get a second background sync to fail on. Click **Sign in again** to jump straight to that account's settings, where you can re-enter your password or re-authorize the OAuth connection.

The notice only appears for sign-in (authentication) failures reported by the mail server itself -- a temporary network drop or a certificate problem does not trigger it, since each of those already has its own separate indicator (see [TLS Certificate Verification](#tls-certificate-verification) above). An OAuth refresh token that is missing from secure storage triggers the notice immediately for both Google and Outlook accounts. If a stored token is rejected, any resulting IMAP authentication rejection follows the ordinary sign-in-failure flow; re-authorize the account from **Settings > Accounts**. It clears itself automatically as soon as any operation against that account succeeds -- not only a background sync, but also opening a message, moving mail, or searching -- so an account whose folders are all set to manual updates still clears the notice the moment you use it. There is nothing to dismiss by hand. This state is not saved between restarts -- if MailCopilot is closed while an account is flagged, the notice reappears only after the same failure pattern happens again following the next launch.

## Customizing Account Avatar

Each account is displayed in the sidebar with an avatar -- a colored circle with initials. You can personalize the avatar in **Settings > Accounts** by clicking the palette icon next to the account.

### Display modes

- **Letters** -- a colored circle with 1--2 characters (initials). You can enter custom initials if the automatic ones are not ideal (for example, when all accounts have the same display name).
- **Icon** -- a colored circle with an icon from a preset collection (mail, briefcase, star, rocket, etc.).
- **Gravatar** -- loads your profile picture from [Gravatar](https://gravatar.com) based on your email address. If no Gravatar is found, the avatar falls back to letters.

### Changing the color

Click any color in the palette to change the avatar background. The color is saved and stays the same across restarts.

### Tooltip

When you hover over an account avatar in the sidebar, a tooltip shows the account name and email address.

## Supported Providers

MailCopilot works with any IMAP/SMTP-compatible provider, including:

- Gmail (via OAuth or app password)
- Outlook / Microsoft 365
- Yahoo Mail
- Fastmail
- Yandex Mail
- Mail.ru
- ProtonMail (via ProtonMail Bridge)
- Self-hosted servers (Dovecot, Postfix, Zimbra, etc.)
