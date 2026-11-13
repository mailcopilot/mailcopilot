---
sidebar_position: 1
title: Informativa sulla Privacy
---

# Informativa sulla Privacy

**Data di entrata in vigore:** 13 febbraio 2026
**Ultimo aggiornamento:** 4 novembre 2026

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

- Se hai accettato la diagnostica, Sentry riceve **segnalazioni di errori** (stack trace, versione dell'applicazione, ambiente operativo) e diagnostica di utilizzo e prestazioni (contatori, durate, un riepilogo della sessione). Contengono un identificatore casuale di installazione sottoposto a hash, quindi le segnalazioni di una stessa installazione possono essere collegate tra loro: sono dati pseudonimi. Non contengono contenuto delle email, indirizzi, password, token o prompt dell'IA (`sendDefaultPii: false`). I dettagli sono nella pagina [Telemetria](../privacy/telemetry.md).

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
| Compatibile con OpenAI | L'API OpenAI standard (api.openai.com) per impostazione predefinita, oppure un endpoint compatibile configurato da voi (ad esempio OpenRouter, LiteLLM, Azure OpenAI o un server self-hosted) se impostate un URL base personalizzato |
| Google | Gemini API |

Ogni provider ha la propria informativa sulla privacy. Le consigliamo di consultare l'informativa sulla privacy del provider scelto:

- [Informativa sulla Privacy di Anthropic](https://www.anthropic.com/privacy)
- [Informativa sulla Privacy di OpenAI](https://openai.com/privacy) — si applica quando utilizzate l'API OpenAI standard; se avete impostato un URL base personalizzato, consultate invece l'informativa sulla privacy dell'operatore di quell'endpoint.
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

Quando connette un account Gmail con l'accesso tramite Google, MailCopilot utilizza Google OAuth 2.0 con PKCE (RFC 7636) per ottenere l'accesso. Nella build ufficiale di MailCopilot l'accesso tramite Google non viene più proposto per le nuove caselle Gmail (si collegano con una password per le app tramite IMAP/SMTP); rimane disponibile per le caselle che lo utilizzano già e per le build create dal codice sorgente con un proprio client Google. Quando si utilizza l'accesso tramite Google, richiediamo i seguenti ambiti:

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
- **Sentry**: segnalazioni di errori e diagnostica di utilizzo e prestazioni, inviate solo con il tuo consenso. Contengono un identificatore casuale di installazione sottoposto a hash e nessun contenuto dei messaggi, indirizzo o prompt (vedere la Sezione 2.6 e [Telemetria](../privacy/telemetry.md)).
- **Il Suo provider email** — attraverso i protocolli standard IMAP/SMTP per fornire le funzionalità email.
- **Gravatar**: finché le foto dei mittenti sono attive, MailCopilot invia a Gravatar l'hash SHA-256 di ogni indirizzo di mittente e il tuo indirizzo IP, come descritto in [Foto dei mittenti (Gravatar)](../privacy/sender-photos.md). Per un account il cui avatar è impostato su Gravatar, invia l'hash dell'indirizzo di quell'account e il tuo indirizzo IP. Sulle nuove installazioni l'opzione è disattivata. Un'installazione aggiornata da una versione precedente alla 1.27.2 mantiene l'impostazione salvata, che per la maggior parte delle installazioni è attiva. Puoi disattivarla in Impostazioni > Produttività.

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

MailCopilot cerca aggiornamenti in background: all'avvio e poi circa una volta all'ora. Una ricerca di aggiornamenti è una normale richiesta HTTPS al nostro server di aggiornamento per ottenere un piccolo file di metadati (numero di versione e hash del file). Come per qualsiasi richiesta web, il server vede il Suo indirizzo IP e, dal nome del file richiesto, il tipo di sistema operativo e l'architettura del processore. La ricerca in sé non invia la versione di MailCopilot in uso (l'applicazione confronta le versioni localmente) e non sono inclusi posta, dati degli account o dati di utilizzo. La richiesta contiene solo normali intestazioni HTTP, ad esempio uno user agent generico. Un'intestazione di compatibilità che la libreria di aggiornamento usa per i rilasci graduali viene inviata con un valore fisso di soli zeri, identico per tutte le installazioni, quindi non identifica nulla. Il download di un aggiornamento è diverso: rivela le versioni, perché i nomi dei file richiesti contengono numeri di versione e, quando si usa un download differenziale, la richiesta del file block map della versione attualmente installata (nome del tipo `mailcopilot-<current-version>-setup.exe.blockmap` su Windows) indica al server quale versione è in esecuzione.

È Lei a decidere se ciò avvenga. **Cerca aggiornamenti in background** è attivata per impostazione predefinita e può essere disattivata in Impostazioni → Informazioni → Aggiornamenti oppure nella schermata del primo avvio. Non serve riavviare: la disattivazione interrompe le nuove ricerche automatiche non appena salva. Una ricerca o un download automatico che la libreria di aggiornamento ha già avviato può comunque completarsi (un download già iniziato non viene annullato; una ricerca può essere a metà della lettura della propria configurazione e ritenta più volte una connessione rifiutata). A parte questo, quando è disattivata, MailCopilot non contatta mai da solo il server di aggiornamento: né una ricerca all'avvio né ricerche ogni ora. Il pulsante **Controlla aggiornamenti** continua a funzionare, perché fare clic su di esso è una Sua richiesta esplicita. Un nuovo download automatico non può partire senza una ricerca, quindi l'opzione «Scarica automaticamente gli aggiornamenti in background» non ha effetto finché la ricerca in background è disattivata. Su un'installazione del tutto nuova (un profilo senza una risposta precedente alla schermata del primo avvio e senza account di posta), MailCopilot non invia alcuna richiesta di aggiornamento automatica finché non ha risposto a quella schermata; chiuderla senza rispondere non registra nulla, quindi l'attesa continua. Tutti i profili esistenti continuano a cercare, compreso uno a cui la schermata del primo avvio viene mostrata di nuovo dopo una modifica dell'informativa.

In Windows, il programma di installazione mostra, prima dei passaggi di installazione, una pagina con un'informativa sulla privacy (un breve riepilogo con un link a questa informativa) nella lingua del programma di installazione (inglese, russo, francese, tedesco, spagnolo o italiano; per le altre lingue viene mostrato l'inglese). Deve accettarla per continuare. Questa pagina non viene mostrata nelle installazioni silenziose né negli aggiornamenti automatici. I pacchetti per Linux e macOS non hanno una pagina del programma di installazione; per essi, la schermata del primo avvio e le Impostazioni sono i luoghi in cui queste informazioni e la scelta vengono presentate.

## 13. Privacy dei minori

MailCopilot non è destinato a minori di età inferiore ai 16 anni. Non raccogliamo consapevolmente dati personali di minori.

## 14. Modifiche alla presente Informativa

Potremmo aggiornare la presente Informativa sulla Privacy di tanto in tanto. Le modifiche saranno pubblicate su questa pagina con una data di "Ultimo aggiornamento" aggiornata. Le consigliamo di consultare periodicamente la presente informativa.

## 15. Contattaci

Per domande relative alla presente Informativa sulla Privacy, può contattarci:

- **Email**: privacy@mailcopilot.io
- **Sito web**: [mailcopilot.io](https://mailcopilot.io)
