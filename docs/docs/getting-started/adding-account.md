---
sidebar_position: 2
title: Adding an Account
---

# Adding an Email Account

MailCopilot supports any email provider that uses standard IMAP and SMTP protocols. Gmail connects with an app password (see [Gmail Account](#gmail-account)), and a Microsoft 365 / Outlook.com account can sign in with OAuth for a seamless experience.

## Adding via the Setup Wizard

When you click **Connect email** (the mail icon at the bottom of the sidebar) or open the account manager, you will see the setup wizard.

### Step 1: Choose Your Provider

The wizard now starts with an explicit provider picker -- you tell MailCopilot which provider you use before entering any credentials. Each provider is shown as a card with its provider logo or icon:

- **Gmail** -- leads to the app-password steps (the card reads "Connect with an app password"): you turn on 2-Step Verification, create an app password in your Google Account, and enter it together with your Gmail address. See [Gmail Account](#gmail-account) below. In a build made from source with its own Google OAuth client, the card instead reads "Sign in with Google OAuth" and jumps straight into the Google sign-in flow.
- **Outlook / Microsoft 365** -- jumps into the Microsoft OAuth flow (Authorization Code with PKCE) and connects via Microsoft Graph. Works for personal `@outlook.com` / `@hotmail.com` / `@live.com` accounts as well as Microsoft 365 work and school accounts.
- **Generic IMAP/SMTP** -- for any other provider (Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail Bridge, your company mail, self-hosted servers, and so on). Advances to a confirmation step that exposes a single **IMAP/SMTP account** button, which then opens the credential-entry form.

You can move between cards with the arrow keys and confirm the selection with **Enter** or **Space**. After picking a provider, the wizard proceeds with the steps appropriate for that provider. On Generic IMAP/SMTP, the **Back** button on the confirmation step returns to the provider picker; the credential-entry step also has a **Back** button, and it returns to the confirmation step (one step at a time). The server-detection and manual-configuration steps move forward only — to start over with a different provider, cancel the wizard and reopen it.

If you ever want to use Outlook over Generic IMAP/SMTP instead of OAuth, you can pick the Generic card and connect with an app password against `outlook.office365.com` / `smtp.office365.com`.

### Step 2: Enter Your Credentials (Generic IMAP/SMTP)

If you chose Generic IMAP/SMTP (a new Gmail mailbox arrives at the same form after its app-password step, see [Gmail Account](#gmail-account)):

1. Enter your **email address** and **password**.
2. Optionally enter a **display name** (the name shown in outgoing messages).
3. Optionally enter an **email address (From)** -- this is the address used in the "From" field of outgoing messages. If left blank, the SMTP login address is used.
4. If your SMTP credentials are different from your IMAP credentials, check **"SMTP login/password is different"** and enter them separately.
5. Click **Next**.

### Step 3: Server Detection

MailCopilot will attempt to automatically detect your mail server settings using standard autodiscovery protocols. If successful, the detected IMAP and SMTP servers are shown in editable fields. You can review and adjust the display name, email address, server hosts, ports, and SSL settings before connecting.

- Click **Connect** to test the connection and save the account.
- If a server accepts the connection but never answers (typically a network or VPN that blocks mail ports), the test fails with "Could not reach the mail server before it responded. This often means the network or a VPN blocks outgoing mail ports. Check your connection or VPN settings and try again." The same sentence is shown for the incoming (IMAP) and the outgoing (SMTP) server.
- When the account is saved, it appears in the main window right away. If it is your first account, the main window opens it on its own -- no restart or reload is needed.
- If you want full manual control over all settings (including separate IMAP/SMTP credentials), click **Manual setup**.

### Manual Configuration

If automatic detection did not find your server, or if you need to customize the settings:

- **IMAP**: enter the host, port (typically 993), and check SSL/TLS.
- **SMTP**: enter the host, port (typically 465 or 587), and check SSL/TLS.
- Use the **Autoconfigure** button to try automatic detection again.
- Use the **Test connection** button to verify your settings before saving.

## Gmail Account {#gmail-account}

Gmail connects over standard IMAP and SMTP. Google allows an app it has not verified to sign in only 100 new users in total, and that limit cannot be reset, so the official MailCopilot build does not connect **new** Gmail mailboxes with **Sign in with Google**. A new mailbox connects with an app password instead. This includes a second Gmail mailbox of someone who already uses MailCopilot with Google sign-in: it is a new mailbox too.

### Connecting a New Gmail Mailbox with an App Password

Pick the **Gmail** card in the wizard. The wizard opens **Connect Gmail with an app password** with the steps below and three buttons: **Back** (returns to the provider picker), **Open Google's instructions**, and **Next**.

1. Turn on 2-Step Verification for your Google Account -- app passwords need it.
2. Create an app password for MailCopilot in your Google Account. Google's first-party instructions are at [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833); the **Open Google's instructions** button opens that page in your browser.
3. Click **Next**, then enter your Gmail address and the 16-character app password (not your usual Google password).

The server settings are filled in automatically: IMAP `imap.gmail.com` on port 993 and SMTP `smtp.gmail.com` on port 465. Review them on the detection step and click **Connect**.

### Mailboxes That Already Sign In with Google

Gmail mailboxes that were connected with Google sign-in keep working, and you can reconnect them -- for example after you revoked access or changed your Google password -- from **Settings > Accounts** with the **Reconnect Google** button. A reconnection works only with the same Google address as the mailbox. If you sign in with another Google account, MailCopilot refuses with "That Google account is not (the mailbox address), so the mailbox was left unchanged. Sign in with the same address you are reconnecting." and nothing is changed. The other account keeps the access it has just granted to MailCopilot; remove it under third-party access in that Google Account.

The address of a mailbox that signs in with Google (or with any OAuth sign-in) can no longer be edited in the account settings: the IMAP and SMTP user fields are read-only for such a mailbox. To change the address, reconnect with the same Google account. If the Google address of the mailbox itself has changed (for example the account was renamed or moved to another domain), reconnecting is refused and nothing is changed; the way out is to remove the mailbox and add it again with an app password (the locally cached mail is downloaded again).

### If the App Passwords Option Is Missing

Google does not offer app passwords for every account. The option may be missing if the account is managed by an organization (ask its administrator), uses Advanced Protection, or uses only security keys for 2-Step Verification. In that case the remaining option is a build made from source with your own Google OAuth client; an app that is internal to an organization is exempt from Google's verification (see [Google's explanation](https://support.google.com/cloud/answer/7454865)). See also the [FAQ](../faq#app-passwords-missing).

### Builds with Their Own Google Client

A build made from source with its own Google OAuth client keeps Google sign-in for new mailboxes: self-builds have it by default, the Gmail card reads "Sign in with Google OAuth", and choosing it opens the browser flow described below. A build without any Google OAuth client shows no Google button at all; for a mailbox that signs in with Google, **Settings > Accounts** then says the mailbox signs in with Google but the build has no Google OAuth client, so it cannot be reconnected there. Outlook / Microsoft 365 is not affected by any of this.

### Google Sign-In Progress

The progress step below appears in builds that offer Google sign-in for new mailboxes.

While the connection runs, the wizard replaces the provider list with a progress step showing what it is waiting on: your approval in the browser, then getting access, checking the mail and sending servers, and saving the account. Two parts have time limits: waiting for your approval in the browser (three minutes) and the server checks (30 seconds for incoming mail, 15 for outgoing, with one retry). The rest has none; everything else depends on the provider and your network, so the step reports what is happening rather than how long is left. If the account has no name yet and the provider supplies a usable one, it is filled in from the provider profile; a name you have edited is never overwritten by a later re-authorization. If the connection fails before the account is saved, the wizard returns to the provider list so you can try again. Closing the window does not cancel a connection that is already under way -- it continues in the background and may still add the account, so starting over at that moment can leave you with a duplicate. This progress step belongs to adding an account: re-authorizing an existing one from its settings shows a spinner on the button instead.

## Microsoft 365 / Outlook Account (OAuth)

Pick the **Outlook / Microsoft 365** card in the wizard. A browser window will open at the Microsoft sign-in page; sign in with your `@outlook.com`, `@hotmail.com`, `@live.com`, or work/school account and approve the requested permissions. The bundled Microsoft client uses the Authorization Code flow with PKCE without a client secret -- no client secret leaves your device. Custom builds that override the bundled client by setting **both** `MAILCOPILOT_MS_CLIENT_ID` (a custom Azure app registration) and `MAILCOPILOT_MS_CLIENT_SECRET` (intended for tenants that issued a confidential client) do send that secret to Microsoft's token endpoint over TLS. `MAILCOPILOT_MS_CLIENT_SECRET` on its own (without a custom client ID) is ignored. Once authorized, the account is added automatically.

The same waiting screen appears here as for Gmail, with the same stages and the same caveats -- the browser wait and the server checks are bounded, the rest is not, and closing the window does not cancel a connection in progress. Outlook skips the outgoing-server retry that Gmail does. Your name is taken from the Microsoft profile when the account has none and the profile supplies a usable one, and a name you have edited is never overwritten by a later re-authorization. The certificate prompt described below for Google appears on this path too, after the account has been saved.

For sending mail, MailCopilot uses Microsoft Graph (`POST /me/sendMail`) on Outlook accounts because Microsoft has disabled SMTP AUTH on most personal Outlook.com accounts created since 2024. The Graph send path is unaffected by that policy. Sent messages are saved to your Sent folder by Microsoft automatically.

If your Outlook account stops working after a long offline period, the OAuth refresh token may have expired. An OAuth refresh token that is missing from secure storage triggers the [Sign-In Expired Notice](#sign-in-expired-notice) immediately for both Google and Outlook accounts. If a stored token is rejected, any resulting IMAP authentication rejection follows the ordinary sign-in-failure flow; re-authorize the account from **Settings > Accounts** using the Microsoft re-authentication button.

## TLS Certificate Verification

MailCopilot always verifies TLS certificates when connecting to mail servers, checking them against both the built-in Mozilla certificate bundle and your operating system's certificate store (falling back to the built-in bundle alone if the OS store cannot be read). The in-app trust prompt described in this section exists only for your **incoming mail server (IMAP)**. If that server uses a self-signed certificate, or one issued by a private certificate authority that is not already in your operating system's trust store -- for example an internal certificate authority run by a university or a company -- a trust prompt will appear during the connection test. You can review the certificate details and choose to trust it: if the fingerprint has not been read yet, the button first reads **Read the certificate** -- click it, review the details, then confirm with **Trust and continue**; if **Trust and continue** is already showing, just click it. Trust granted this way is tied to that exact certificate and to this server's specific address and port -- a different server that happens to be issued by the same certificate authority is not trusted automatically, and if this server's certificate changes again later you will need to confirm the new one the same way. As an alternative, you can install the certificate authority's root certificate into your operating system's trust store instead; MailCopilot only reads that store once, the first time it is needed, and keeps that snapshot until you restart the app, so this alternative requires restarting MailCopilot before it takes effect, while confirming the trust prompt here does not. Servers reached over STARTTLS (typically IMAP port 143 or SMTP port 587) cannot hand over their certificate at this step, so only the fingerprint is stored for them -- a self-signed STARTTLS server cannot be trusted this way; use implicit TLS (typically port 993 or 465) instead if your server supports it.

The **Details** line of the trust prompt states, in your app language, why the certificate was refused -- for example that it is self-signed or has expired; the full list of reasons is in [TLS Certificate Trust](../settings/general#tls-certificate-trust).

Your **outgoing mail server (SMTP)** has no equivalent trust prompt today. If it presents a self-signed certificate or one from a private certificate authority not already in your operating system's trust store, the connection test for it will simply fail -- there is no remedy from inside the app. The certificate must be trusted outside MailCopilot instead, either by installing that certificate authority's root certificate into your operating system's trust store (restart MailCopilot afterward to pick it up), or through the `NODE_EXTRA_CA_CERTS` environment variable for advanced setups.

When signing in with Google, if your network uses a proxy or antivirus that replaces TLS certificates with one your operating system does not already trust, MailCopilot will detect this and automatically offer to trust the certificate. You will see the certificate details (host, issuer, fingerprint) and can choose to accept or decline. The account is saved regardless, and you can manage certificate pins later in the account settings. If instead the proxy or antivirus root is already installed in your operating system's certificate store, the connection succeeds without any trust prompt -- MailCopilot flags this case separately with an informational notice (see below) rather than asking you to accept anything.

Trusting the system certificate store means that most corporate proxies and TLS-inspecting antivirus software work out of the box, without a trust prompt during setup. After your account's first successful sync in a session, MailCopilot checks once whether a connection is being inspected this way and, if so, shows a notice naming the software or proxy responsible; this check runs at most once per server for the lifetime of your profile, so interception turned on for a server after this check already ran will not be flagged. If a server's certificate later changes to one that cannot be trusted at all, MailCopilot will show a recovery dialog in the main window at that point -- see [TLS Certificate Trust](../settings/general#tls-certificate-trust) for details.

For connections to your incoming (IMAP) and outgoing (SMTP) mail servers and to the AI provider, MailCopilot also no longer trusts certificates that chain to three certificate authority roots tied to a compromised-intermediate incident -- `emSign ECC Root CA - G3`, `emSign Root TLS CA - G3` and `AAA Certificate Services` -- even if your operating system still trusts them. A server whose certificate chains to one of them is treated like any other untrusted certificate: for your incoming mail server (IMAP), the certificate trust prompt described above appears (for your outgoing server there is no prompt, as explained above). A certificate you have already confirmed in that prompt keeps working.

## Encrypted Connection Required (STARTTLS)

When the **SSL/TLS** checkbox of the incoming or outgoing server is cleared -- typically IMAP port 143 or SMTP port 587, where the connection starts unencrypted and is then upgraded with STARTTLS -- MailCopilot requires the server to complete that upgrade before it sends your password or any message. If the server does not offer or accept STARTTLS, the connection is refused and the connection test (or the failed sync or send) shows: "The server does not offer an encrypted connection (STARTTLS), so MailCopilot sent no password or message. Check the port and security settings, or contact the mail provider." There is deliberately no option to continue without encryption. To fix it, check the port and the **SSL/TLS** checkbox (typically IMAP port 993 and SMTP port 465 with **SSL/TLS** checked), or ask your mail provider which settings its server expects. Connections that use **SSL/TLS** are not affected.

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

- Gmail (via app password; mailboxes that already sign in with Google keep working)
- Outlook / Microsoft 365
- Yahoo Mail
- Fastmail
- Yandex Mail
- Mail.ru
- ProtonMail (via ProtonMail Bridge)
- Self-hosted servers (Dovecot, Postfix, Zimbra, etc.)
