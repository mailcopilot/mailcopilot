---
sidebar_position: 1
title: Datenschutzrichtlinie
---

# Datenschutzrichtlinie

**Geltungsdatum:** 13. Februar 2026
**Zuletzt aktualisiert:** 13. Februar 2026

## 1. Einleitung

MailCopilot ("die Anwendung", "wir", "unser") ist ein Desktop-E-Mail-Client fuer Windows, macOS und Linux. Diese Datenschutzrichtlinie beschreibt, wie wir Ihre personenbezogenen Daten erfassen, verwenden, speichern und schuetzen, wenn Sie die Anwendung nutzen.

Durch die Nutzung von MailCopilot stimmen Sie den in dieser Datenschutzrichtlinie beschriebenen Praktiken zu. Wenn Sie nicht einverstanden sind, nutzen Sie die Anwendung bitte nicht.

## 2. Daten, die wir erfassen

### 2.1 E-Mail-Kontodaten

- **E-Mail-Adresse** — erforderlich, um eine Verbindung zu Ihrem Mailserver herzustellen.
- **Passwort** (IMAP/SMTP) — wenn Sie die passwortbasierte Authentifizierung verwenden.
- **OAuth-Token** (Access-Token, Refresh-Token) — wenn Sie Google OAuth 2.0 oder einen anderen OAuth-Anbieter verwenden.

### 2.2 E-Mail-Daten

Wenn Sie Ihr Konto verbinden, laedt die Anwendung folgende Daten herunter und speichert sie im Cache:

- E-Mail-Header (Betreff, Absender, Empfaenger, Datum).
- E-Mail-Text (Text und HTML).
- Anhangsmetadaten (Dateinamen und -typen; Anhaenge selbst werden standardmaessig nicht zwischengespeichert).
- E-Mail-Flags (gelesen/ungelesen, markiert).
- Nachrichtenkennungen (Message-ID, In-Reply-To, References) fuer die Konversationsverkettung.

### 2.3 Kontaktinformationen

- E-Mail-Adressen und Namen von Personen, mit denen Sie korrespondieren.
- Nutzungshaeufigkeit und Datum der letzten Interaktion fuer Autovervollstaendigungsvorschlaege.

### 2.4 Ordnerstruktur

- Liste der Postfachordner, deren Namen und Spezialverwendungsattribute (Posteingang, Gesendet, Entwuerfe, Papierkorb, Spam, Archiv).
- Ordnerbezogene Einstellungen (Sichtbarkeit, Badge-Einstellungen, Synchronisierungsmodus).

### 2.5 Anwendungseinstellungen

- Sprache, Design, AI-Einstellungen und andere Konfigurationsoptionen.
- Benutzerdefinierte E-Mail-Adresse fuer den "Von"-Header (falls konfiguriert).
- E-Mail-Signaturen.

### 2.6 Fehlerberichte

- Wenn die Sentry-Fehlerberichterstattung aktiv ist, erfassen wir **anonyme Absturzberichte** (Stack-Traces, Anwendungsversion, Betriebsumgebung). **Keine personenbezogenen Daten** (E-Mail-Inhalte, Adressen, Passwoerter oder Token) sind in den Fehlerberichten enthalten (`sendDefaultPii: false`).

## 3. Wie wir Ihre Daten speichern

**Alle Benutzerdaten werden lokal auf Ihrem Computer gespeichert.** MailCopilot betreibt keine Cloud-Server zur Speicherung Ihrer E-Mails, Kontakte oder Einstellungen.

| Daten | Speichermethode |
|---|---|
| Passwoerter und API-Schluessel | Sichere Speicherung auf Betriebssystemebene (keytar): Windows DPAPI, macOS Keychain, Linux Secret Service |
| E-Mail-Cache und Kontakte | Lokale SQLite-Datenbank (`~/.mailcopilot/cache.db`) |
| Einstellungen und Kontokonfiguration | Lokale JSON-Datei (electron-store) |
| OAuth-Token | Lokale verschluesselte Speicherung ueber electron-store |

Sie koennen alle lokalen Daten jederzeit loeschen, indem Sie das Verzeichnis `~/.mailcopilot/` entfernen (oder das ueber `MAILCOPILOT_DATA_DIR` konfigurierte Datenverzeichnis).

## 4. Wie wir Ihre Daten verwenden

Wir verwenden Ihre Daten **ausschliesslich**, um die Kernfunktionalitaet der Anwendung bereitzustellen:

- **Verbindung zu Ihrem Mailserver** ueber IMAP/SMTP zum Senden, Empfangen und Verwalten von E-Mails.
- **Lokales Zwischenspeichern von E-Mails** fuer schnelleren Zugriff und Offline-Lesen.
- **Autovervollstaendigung** fuer Empfaengeradressen basierend auf Ihrer Kontakthistorie.
- **Anzeige der Ordnerstruktur** und Anzahl ungelesener Nachrichten.
- **AI-Assistenzfunktionen** (optional) — siehe Abschnitt 5.

Wir verwenden Ihre Daten **nicht** fuer:

- Werbung, Marketing oder Anzeigentargeting.
- Verkauf oder Weitergabe an Datenhaendler.
- Erstellung von Nutzerprofilen fuer Dritte.
- Bonitaetspruefungen oder Finanzbewertungen.
- Ueberwachung oder Tracking.
- Training allgemeiner AI/ML-Modelle.

## 5. AI-Assistent und AI-Drittanbieter

MailCopilot bietet einen optionalen AI-Assistenten, der Ihnen beim Verfassen von Antworten, Zusammenfassen von E-Mails und Ausfuehren von E-Mail-Aktionen helfen kann.

### 5.1 Ausdrueckliche Zustimmung erforderlich

Der AI-Assistent ist **standardmaessig deaktiviert**. Bevor E-Mail-Daten an einen AI-Anbieter gesendet werden, muessen Sie:

1. Den AI-Assistenten in den Einstellungen aktivieren.
2. Ausdruecklich der Weitergabe von E-Mail-Daten an den ausgewaehlten AI-Anbieter zustimmen (Einstellung `aiPrivacyConsent`).

### 5.2 Welche Daten an AI-Anbieter gesendet werden

Wenn Sie den AI-Assistenten verwenden, koennen folgende Daten an den ausgewaehlten Anbieter gesendet werden:

- Inhalt der E-Mail(s), mit der/denen Sie arbeiten (Betreff, Text, Absender, Empfaenger).
- Ihre Anweisungen oder Fragen an die AI.

Daten werden **nur auf Ihre ausdrueckliche Anfrage** gesendet — niemals automatisch oder im Hintergrund.

### 5.3 Unterstuetzte AI-Anbieter

| Anbieter | Dienst |
|---|---|
| Anthropic | Claude API (api.anthropic.com) |
| OpenAI-kompatibel | Standardmaessig die OpenAI-API (api.openai.com), oder stattdessen ein von Ihnen konfigurierter kompatibler Endpunkt (zum Beispiel OpenRouter, LiteLLM, Azure OpenAI oder ein selbst gehosteter Server), wenn Sie eine benutzerdefinierte Basis-URL festlegen |
| Google | Gemini API |

Jeder Anbieter hat seine eigene Datenschutzrichtlinie. Wir empfehlen Ihnen, die Datenschutzrichtlinie Ihres gewaehlten Anbieters zu lesen:

- [Anthropic Datenschutzrichtlinie](https://www.anthropic.com/privacy)
- [OpenAI Datenschutzrichtlinie](https://openai.com/privacy) — gilt bei Nutzung der Standard-OpenAI-API; wenn Sie eine benutzerdefinierte Basis-URL festgelegt haben, lesen Sie stattdessen die Datenschutzrichtlinie des Betreibers dieses Endpunkts.
- [Google Datenschutzrichtlinie](https://policies.google.com/privacy)

### 5.4 AI-Budgetkontrolle

Sie koennen in den Einstellungen taegliche und monatliche Ausgabenlimits fuer die AI-Nutzung festlegen.

## 6. Google API Services — Offenlegung der eingeschraenkten Nutzung {#google-limited-use}

Die Nutzung und Uebertragung von Informationen, die MailCopilot von Google APIs erhaelt, an andere Anwendungen erfolgt in Uebereinstimmung mit der [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), einschliesslich der Anforderungen zur eingeschraenkten Nutzung (Limited Use).

Im Einzelnen:

1. **Wir verwenden Google-Nutzerdaten nur, um benutzerseitige Funktionen bereitzustellen und zu verbessern**, die in der Benutzeroberflaeche der Anwendung sichtbar und erkennbar sind (E-Mails lesen, senden, organisieren).
2. **Wir uebertragen Google-Nutzerdaten nicht an Dritte**, ausser:
   - Soweit erforderlich, um benutzerseitige Funktionen bereitzustellen oder zu verbessern (z. B. Senden von E-Mail-Inhalten an einen AI-Anbieter **nur mit Ihrer ausdruecklichen Zustimmung**).
   - Soweit zur Einhaltung geltender Gesetze erforderlich.
   - Im Rahmen einer Fusion, Uebernahme oder eines Vermoegensverkaufs, mit Benachrichtigung der Nutzer.
3. **Wir verwenden Google-Nutzerdaten nicht fuer Werbung**, einschliesslich Retargeting, personalisierter Werbung oder interessenbasierter Werbung.
4. **Wir gestatten Menschen keinen Zugriff auf Google-Nutzerdaten**, es sei denn:
   - Wir haben Ihre ausdrueckliche Zustimmung (z. B. technischer Support auf Ihre Anfrage).
   - Es ist aus Sicherheitsgruenden erforderlich (z. B. Untersuchung von Missbrauch).
   - Es ist zur Einhaltung geltender Gesetze erforderlich.
   - Die Daten sind fuer interne Zwecke aggregiert und anonymisiert.
5. **Wir verwenden Google-Nutzerdaten nicht zum Training allgemeiner AI/ML-Modelle.** Wenn Sie den AI-Assistenten nutzen, werden Ihre E-Mail-Inhalte ausschliesslich an den ausgewaehlten AI-Anbieter gesendet, um eine Antwort fuer Sie zu generieren — nicht fuer das Modelltraining.

## 7. Google OAuth 2.0

Wenn Sie ein Gmail-Konto verbinden, verwendet MailCopilot Google OAuth 2.0 mit PKCE (RFC 7636), um Zugriff zu erhalten. Wir fordern die folgenden Berechtigungen an:

| Berechtigung | Zweck |
|---|---|
| `https://mail.google.com/` | IMAP/SMTP-Zugriff zum Lesen, Senden und Verwalten Ihrer E-Mails |
| `openid` | Verifizierung Ihrer Identitaet |
| `email` | Abruf Ihrer E-Mail-Adresse |
| `profile` | Abruf Ihres Anzeigenamens |

OAuth-Token werden lokal auf Ihrem Geraet gespeichert (siehe Abschnitt 3). Wir uebermitteln Ihre Token niemals an einen von uns betriebenen Server.

## 8. Datenweitergabe

Wir geben Ihre personenbezogenen Daten **nicht** an Dritte weiter, ausser in den folgenden eingeschraenkten Faellen:

- **AI-Anbieter** — nur mit Ihrer ausdruecklichen Zustimmung, wie in Abschnitt 5 beschrieben.
- **Sentry** — nur anonyme Absturzberichte, ohne personenbezogene Daten (siehe Abschnitt 2.6).
- **Ihr E-Mail-Anbieter** — ueber Standard-IMAP/SMTP-Protokolle zur Bereitstellung der E-Mail-Funktionalitaet.

Wir verkaufen, vermieten oder handeln nicht mit Ihren personenbezogenen Daten.

## 9. Datenaufbewahrung und -loeschung

- **E-Mail-Cache**: Wird lokal gespeichert, solange Sie die Anwendung nutzen. Sie koennen den Cache jederzeit in den Einstellungen loeschen oder das Datenverzeichnis entfernen.
- **Anmeldedaten**: Werden in der sicheren Speicherung auf Betriebssystemebene gespeichert, bis Sie das Konto aus MailCopilot entfernen.
- **Einstellungen**: Werden lokal gespeichert, bis Sie die Anwendung deinstallieren oder die Konfigurationsdateien loeschen.

Da alle Daten lokal gespeichert werden, werden durch die Deinstallation der Anwendung und das Loeschen des Verzeichnisses `~/.mailcopilot/` alle Daten dauerhaft entfernt.

## 10. Ihre Rechte

Sie haben die volle Kontrolle ueber Ihre Daten:

- **Zugriff**: Alle Ihre Daten werden lokal auf Ihrem Geraet gespeichert — Sie koennen jederzeit darauf zugreifen.
- **Loeschung**: Entfernen Sie ein beliebiges Konto aus MailCopilot, um dessen zwischengespeicherte Daten zu loeschen, oder loeschen Sie das gesamte Datenverzeichnis.
- **OAuth-Zugriff widerrufen**: Sie koennen den Zugriff von MailCopilot auf Ihr Google-Konto jederzeit ueber die [Google-Kontoberechtigungen](https://myaccount.google.com/permissions) widerrufen.
- **AI deaktivieren**: Sie koennen den AI-Assistenten jederzeit in den Einstellungen deaktivieren.
- **Export**: Ihre E-Mails verbleiben auf Ihrem Mailserver und sind ueber jeden E-Mail-Client zugaenglich.

## 11. Sicherheit

Wir setzen die folgenden Sicherheitsmassnahmen um:

- **Verschluesselte Speicherung**: Passwoerter und API-Schluessel werden in der sicheren Speicherung auf Betriebssystemebene (keytar) gespeichert.
- **TLS 1.2+**: Alle Verbindungen zu Mailservern sind verschluesselt.
- **TLS-Zertifikatpruefung**: Zertifikate werden gegen das integrierte Mozilla-Zertifikatspaket und den Zertifikatspeicher Ihres Betriebssystems geprueft (mit Ausweichen auf das integrierte Paket allein, falls der Systemspeicher nicht verfuegbar ist); Verbindungen zu Servern mit nicht vertrauenswuerdigen Zertifikaten werden blockiert, bis Sie ihnen ausdruecklich vertrauen.
- **TLS-Zertifikat-Pinning**: Optionale SHA-256-Zertifikatpin-Verifizierung zur Verhinderung von MITM-Angriffen; bei jeder Verbindung zu einem gepinnten Server strikt durchgesetzt.
- **Sandbox-Isolierung**: Der Renderer-Prozess laeuft in einer Sandbox-Umgebung ohne direkten Zugriff auf das Betriebssystem.
- **IPC-Validierung**: Alle Interprozesskommunikation wird mithilfe von Zod-Schemata validiert.
- **PKCE**: Der OAuth-2.0-Ablauf verwendet Proof Key for Code Exchange (RFC 7636).

## 12. Automatische Updates

MailCopilot prueft regelmaessig auf Updates. Update-Metadaten (Versionsnummer, Datei-Hash) werden von unserem Release-Repository heruntergeladen. **Es werden keine personenbezogenen Daten** waehrend der Update-Pruefung gesendet. Sie koennen die automatische Update-Pruefung in den Einstellungen deaktivieren.

## 13. Datenschutz fuer Kinder

MailCopilot richtet sich nicht an Kinder unter 16 Jahren. Wir erfassen wissentlich keine personenbezogenen Daten von Kindern.

## 14. Aenderungen dieser Richtlinie

Wir koennen diese Datenschutzrichtlinie von Zeit zu Zeit aktualisieren. Aenderungen werden auf dieser Seite mit einem aktualisierten Datum unter "Zuletzt aktualisiert" veroeffentlicht. Wir empfehlen Ihnen, diese Richtlinie regelmaessig zu ueberpruefen.

## 15. Kontakt

Wenn Sie Fragen zu dieser Datenschutzrichtlinie haben, kontaktieren Sie uns bitte:

- **E-Mail**: privacy@mailcopilot.io
- **Website**: [mailcopilot.io](https://mailcopilot.io)
