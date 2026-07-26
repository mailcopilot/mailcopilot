---
sidebar_position: 1
title: Informativa sulla Privacy
---

# Informativa sulla Privacy

**Data di entrata in vigore:** 13 febbraio 2026
**Ultimo aggiornamento:** 13 febbraio 2026

## 1. Introduzione

MailCopilot ("l'Applicazione", "noi", "nostro/a") è un client di posta elettronica desktop per Windows, macOS e Linux. La presente Informativa sulla Privacy descrive come raccogliamo, utilizziamo, archiviamo e proteggiamo i Suoi dati personali quando utilizza l'Applicazione.

Utilizzando MailCopilot, Lei accetta le pratiche descritte nella presente Informativa sulla Privacy. Se non è d'accordo, La preghiamo di non utilizzare l'Applicazione.

## 2. Dati che raccogliamo

### 2.1 Credenziali dell'account email

- **Indirizzo email** — necessario per connettersi al Suo server di posta.
- **Password** (IMAP/SMTP) — se utilizza l'autenticazione basata su password.
- **Token OAuth** (access token, refresh token) — se utilizza Google OAuth 2.0 o un altro provider OAuth.

### 2.2 Dati email

Quando connette il Suo account, l'Applicazione scarica e memorizza in cache:

- Intestazioni delle email (oggetto, mittente, destinatari, data).
- Corpo delle email (testo e HTML).
- Metadati degli allegati (nomi e tipi di file; gli allegati stessi non vengono memorizzati in cache per impostazione predefinita).
- Flag delle email (letto/non letto, contrassegnato).
- Identificatori dei messaggi (Message-ID, In-Reply-To, References) per il raggruppamento in conversazioni.

### 2.3 Informazioni di contatto

- Indirizzi email e nomi delle persone con cui corrisponde.
- Frequenza di utilizzo e data dell'ultima interazione per i suggerimenti di completamento automatico.

### 2.4 Struttura delle cartelle

- Elenco delle cartelle della casella di posta, i relativi nomi e gli attributi di uso speciale (Posta in arrivo, Inviati, Bozze, Cestino, Spam, Archivio).
- Preferenze per cartella (visibilità, impostazioni dei badge, modalità di sincronizzazione).

### 2.5 Impostazioni dell'applicazione

- Lingua, tema, preferenze AI e altre opzioni di configurazione.
- Indirizzo email personalizzato per l'intestazione "Da" (se configurato).
- Firme email.

### 2.6 Segnalazioni di errori

- Se la segnalazione errori tramite Sentry è attiva, raccogliamo **rapporti anonimi sugli arresti anomali** (stack trace, versione dell'applicazione, ambiente operativo). **Nessun dato personale** (contenuto delle email, indirizzi, password o token) viene incluso nelle segnalazioni di errori (`sendDefaultPii: false`).

## 3. Come archiviamo i Suoi dati

**Tutti i dati dell'utente sono archiviati localmente sul Suo computer.** MailCopilot non gestisce alcun server cloud per archiviare le Sue email, i contatti o le impostazioni.

| Dato | Metodo di archiviazione |
|---|---|
| Password e chiavi API | Archiviazione sicura a livello di sistema operativo (keytar): Windows DPAPI, macOS Keychain, Linux Secret Service |
| Cache email e contatti | Database SQLite locale (`~/.mailcopilot/cache.db`) |
| Impostazioni e configurazione account | File JSON locale (electron-store) |
| Token OAuth | Archiviazione locale crittografata tramite electron-store |

Può eliminare tutti i dati locali in qualsiasi momento rimuovendo la directory `~/.mailcopilot/` (o la directory dati configurata tramite `MAILCOPILOT_DATA_DIR`).

## 4. Come utilizziamo i Suoi dati

Utilizziamo i Suoi dati **esclusivamente** per fornire le funzionalità principali dell'Applicazione:

- **Connettersi al Suo server di posta** tramite IMAP/SMTP per inviare, ricevere e gestire le email.
- **Memorizzare le email localmente in cache** per un accesso più rapido e la lettura offline.
- **Fornire il completamento automatico** per gli indirizzi dei destinatari basandosi sulla Sua cronologia dei contatti.
- **Visualizzare la struttura delle cartelle** e il conteggio dei messaggi non letti.
- **Funzionalità dell'Assistente AI** (opzionale) — vedere la Sezione 5.

**Non** utilizziamo i Suoi dati per:

- Pubblicità, marketing o targeting pubblicitario.
- Vendita o condivisione con intermediari di dati.
- Creazione di profili utente per terze parti.
- Valutazione del merito creditizio o analisi finanziarie.
- Sorveglianza o tracciamento.
- Addestramento di modelli AI/ML di uso generale.

## 5. Assistente AI e provider AI di terze parti

MailCopilot offre un assistente AI opzionale che può aiutarLa a redigere risposte, riassumere email ed eseguire operazioni sulla posta.

### 5.1 Consenso esplicito richiesto

L'assistente AI è **disabilitato per impostazione predefinita**. Prima che qualsiasi dato email venga inviato a un provider AI, è necessario:

1. Abilitare l'assistente AI nelle Impostazioni.
2. Acconsentire esplicitamente alla condivisione dei dati email con il provider AI selezionato (impostazione `aiPrivacyConsent`).

### 5.2 Quali dati vengono inviati ai provider AI

Quando utilizza l'assistente AI, i seguenti dati possono essere inviati al provider selezionato:

- Contenuto dell'email o delle email su cui sta lavorando (oggetto, corpo, mittente, destinatari).
- Le Sue istruzioni o domande all'AI.

I dati vengono inviati **solo su Sua esplicita richiesta** — mai automaticamente o in background.

### 5.3 Provider AI supportati

| Provider | Servizio |
|---|---|
| Anthropic | Claude API (api.anthropic.com) |
| OpenAI | GPT API (api.openai.com) |
| Google | Gemini API |
| Claude Code | Strumento CLI locale (abbonamento) |

Ogni provider ha la propria informativa sulla privacy. Le consigliamo di consultare l'informativa sulla privacy del provider scelto:

- [Informativa sulla Privacy di Anthropic](https://www.anthropic.com/privacy)
- [Informativa sulla Privacy di OpenAI](https://openai.com/privacy)
- [Informativa sulla Privacy di Google](https://policies.google.com/privacy)

### 5.4 Controlli del budget AI

Può impostare limiti di spesa giornalieri e mensili per l'utilizzo dell'AI nelle Impostazioni.

## 6. Servizi API di Google — Dichiarazione sull'uso limitato {#google-limited-use}

L'uso e il trasferimento da parte di MailCopilot a qualsiasi altra applicazione delle informazioni ricevute dalle API di Google saranno conformi alla [Politica sui dati utente dei servizi API di Google](https://developers.google.com/terms/api-services-user-data-policy), inclusi i requisiti sull'uso limitato.

Nello specifico:

1. **Utilizziamo i dati utente di Google solo per fornire e migliorare le funzionalità rivolte all'utente** che sono visibili e apparenti nell'interfaccia dell'Applicazione (lettura, invio, organizzazione delle email).
2. **Non trasferiamo i dati utente di Google a terze parti** eccetto:
   - Quando necessario per fornire o migliorare le funzionalità rivolte all'utente (ad es., invio del contenuto email a un provider AI **solo con il Suo consenso esplicito**).
   - Quando necessario per conformarsi alla legge applicabile.
   - Nell'ambito di una fusione, acquisizione o vendita di asset, con notifica all'utente.
3. **Non utilizziamo i dati utente di Google per la pubblicità**, incluso il retargeting, la pubblicità personalizzata o la pubblicità basata sugli interessi.
4. **Non consentiamo a persone di leggere i dati utente di Google** a meno che:
   - Non abbiamo il Suo consenso esplicito (ad es., supporto tecnico su Sua richiesta).
   - Sia necessario per finalità di sicurezza (ad es., indagine su abusi).
   - Sia necessario per conformarsi alla legge applicabile.
   - I dati siano aggregati e anonimizzati per operazioni interne.
5. **Non utilizziamo i dati utente di Google per addestrare modelli AI/ML di uso generale.** Quando sceglie di utilizzare l'assistente AI, il contenuto della Sua email viene inviato al provider AI selezionato esclusivamente per generare una risposta per Lei — non per l'addestramento del modello.

## 7. Google OAuth 2.0

Quando connette un account Gmail, MailCopilot utilizza Google OAuth 2.0 con PKCE (RFC 7636) per ottenere l'accesso. Richiediamo i seguenti ambiti:

| Ambito | Scopo |
|---|---|
| `https://mail.google.com/` | Accesso IMAP/SMTP per leggere, inviare e gestire le Sue email |
| `openid` | Verificare la Sua identità |
| `email` | Recuperare il Suo indirizzo email |
| `profile` | Recuperare il Suo nome visualizzato |

I token OAuth sono archiviati localmente sul Suo dispositivo (vedere la Sezione 3). Non trasmettiamo mai i Suoi token a nessun server da noi gestito.

## 8. Condivisione dei dati

**Non** condividiamo i Suoi dati personali con terze parti, eccetto nelle seguenti circostanze limitate:

- **Provider AI** — solo con il Suo consenso esplicito, come descritto nella Sezione 5.
- **Sentry** — solo rapporti anonimi sugli arresti anomali, senza dati personali (vedere la Sezione 2.6).
- **Il Suo provider email** — attraverso i protocolli standard IMAP/SMTP per fornire le funzionalità email.

Non vendiamo, affittiamo o scambiamo i Suoi dati personali.

## 9. Conservazione e cancellazione dei dati

- **Cache email**: archiviata localmente per tutto il tempo in cui utilizza l'Applicazione. Può svuotare la cache in qualsiasi momento dalle Impostazioni o eliminando la directory dei dati.
- **Credenziali**: archiviate nell'archiviazione sicura a livello di sistema operativo fino alla rimozione dell'account da MailCopilot.
- **Impostazioni**: archiviate localmente fino alla disinstallazione dell'Applicazione o all'eliminazione dei file di configurazione.

Poiché tutti i dati sono archiviati localmente, la disinstallazione dell'Applicazione e l'eliminazione della directory `~/.mailcopilot/` rimuovono definitivamente tutti i dati.

## 10. I Suoi diritti

Lei ha il pieno controllo sui Suoi dati:

- **Accesso**: tutti i Suoi dati sono archiviati localmente sul Suo dispositivo — può accedervi in qualsiasi momento.
- **Cancellazione**: rimuova qualsiasi account da MailCopilot per eliminare i relativi dati memorizzati in cache, oppure elimini l'intera directory dei dati.
- **Revoca dell'accesso OAuth**: può revocare l'accesso di MailCopilot al Suo account Google in qualsiasi momento tramite le [Autorizzazioni dell'account Google](https://myaccount.google.com/permissions).
- **Disabilitazione dell'AI**: può disabilitare l'assistente AI in qualsiasi momento nelle Impostazioni.
- **Esportazione**: le Sue email rimangono sul Suo server di posta e sono accessibili tramite qualsiasi client email.

## 11. Sicurezza

Implementiamo le seguenti misure di sicurezza:

- **Archiviazione crittografata**: password e chiavi API sono archiviate nell'archiviazione sicura a livello di sistema operativo (keytar).
- **TLS 1.2+**: tutte le connessioni ai server di posta sono crittografate.
- **Verifica del certificato TLS**: i certificati vengono verificati rispetto al pacchetto di certificati Mozilla integrato e all'archivio dei certificati del Suo sistema operativo (con ripiego sul solo pacchetto integrato se l'archivio di sistema non e disponibile); le connessioni a server che presentano certificati non attendibili vengono bloccate finché non decide esplicitamente di considerarli attendibili.
- **Pinning del certificato TLS**: verifica opzionale del pin del certificato SHA-256 per prevenire attacchi MITM; applicata rigorosamente a ogni connessione verso un server pinnato.
- **Isolamento sandbox**: il processo di rendering viene eseguito in un ambiente sandbox senza accesso diretto al sistema operativo.
- **Validazione IPC**: tutte le comunicazioni tra processi sono validate tramite schemi Zod.
- **PKCE**: il flusso OAuth 2.0 utilizza Proof Key for Code Exchange (RFC 7636).

## 12. Aggiornamenti automatici

MailCopilot verifica periodicamente la disponibilità di aggiornamenti. I metadati degli aggiornamenti (numero di versione, hash del file) vengono scaricati dal nostro repository di rilascio. **Nessun dato personale viene inviato** durante la verifica degli aggiornamenti. Può disabilitare la verifica automatica degli aggiornamenti nelle Impostazioni.

## 13. Privacy dei minori

MailCopilot non è destinato a minori di età inferiore ai 16 anni. Non raccogliamo consapevolmente dati personali di minori.

## 14. Modifiche alla presente Informativa

Potremmo aggiornare la presente Informativa sulla Privacy di tanto in tanto. Le modifiche saranno pubblicate su questa pagina con una data di "Ultimo aggiornamento" aggiornata. Le consigliamo di consultare periodicamente la presente informativa.

## 15. Contattaci

Per domande relative alla presente Informativa sulla Privacy, può contattarci:

- **Email**: privacy@mailcopilot.io
- **Sito web**: [mailcopilot.io](https://mailcopilot.io)
