---
sidebar_position: 2
title: Aggiungere un account
---

# Aggiungere un account email

MailCopilot supporta qualsiasi provider che utilizza IMAP e SMTP. Puoi anche accedere con Google o con un account Microsoft 365 / Outlook.com tramite OAuth, senza inserire la password.

## Procedura guidata

Clicca su **Connetti email** (icona busta in basso nella barra laterale).

### Passo 1: Scegli il provider

La procedura ora inizia con un selettore esplicito di provider: dici a MailCopilot quale provider usi prima ancora di inserire qualunque credenziale. Ogni provider e mostrato come scheda con il logo o l'icona del provider:

- **Gmail** -- avvia direttamente il flusso OAuth di Google. Si apre una finestra del browser dove autorizzi MailCopilot ad accedere al tuo account Gmail; nessuna password richiesta.
- **Outlook / Microsoft 365** -- avvia il flusso OAuth di Microsoft (Authorization Code con PKCE) e si collega tramite Microsoft Graph. Funziona sia per account personali `@outlook.com` / `@hotmail.com` / `@live.com` sia per account aziendali e scolastici di Microsoft 365.
- **Generic IMAP/SMTP** -- per qualsiasi altro provider (Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail Bridge, posta aziendale, server self-hosted e cosi via). Passa prima a uno step di conferma con un unico pulsante **Account IMAP/SMTP**, che apre poi il modulo di inserimento delle credenziali.

Tra le schede puoi spostarti con i tasti freccia e confermare con **Invio** o **Spazio**. Dopo aver scelto un provider, la procedura prosegue con i passi specifici. Sul percorso Generic IMAP/SMTP, il pulsante **Indietro** dello step di conferma riporta al selettore di provider; lo step di inserimento credenziali ha anch'esso un pulsante **Indietro**, che riporta allo step di conferma (uno step alla volta). Gli step di rilevamento del server e configurazione manuale vanno solo avanti -- per ricominciare con un altro provider, annulla la procedura e riaprila.

Se vuoi usare Outlook tramite Generic IMAP/SMTP invece di OAuth, scegli la scheda Generic e collegati con una password app contro `outlook.office365.com` / `smtp.office365.com`.

### Passo 2: Inserisci le credenziali (Generic IMAP/SMTP)

1. Inserisci **indirizzo email** e **password**.
2. Opzionalmente, un **nome visualizzato**.
3. Facoltativamente, inserisci un **indirizzo email (Da)** -- questo indirizzo viene utilizzato nel campo «Da» dei messaggi in uscita. Se lasciato vuoto, viene utilizzato l'indirizzo di accesso SMTP.
4. Se le credenziali SMTP sono diverse, attiva l'opzione corrispondente.
5. Clicca su **Avanti**.

### Passo 3: Rilevamento del server

MailCopilot tentera di rilevare automaticamente le impostazioni del server utilizzando i protocolli standard di rilevamento automatico. Se ha successo, i server IMAP e SMTP rilevati vengono mostrati in campi modificabili. Puoi verificare e modificare il nome visualizzato, l'indirizzo email, gli host dei server, le porte e le impostazioni SSL prima di connetterti.

- Clicca su **Connetti** per testare la connessione e salvare l'account.
- Se desideri il controllo manuale completo su tutte le impostazioni (incluse credenziali IMAP/SMTP separate), clicca su **Configurazione manuale**.

## Account Google (OAuth)

Seleziona la scheda **Gmail** nella procedura. Si aprira una finestra del browser dove autorizzi MailCopilot. Una volta autorizzato, l'account viene aggiunto automaticamente con le impostazioni IMAP e SMTP corrette.

Durante la connessione la procedura sostituisce l’elenco dei provider con un passaggio di avanzamento che mostra cosa sta attendendo: la tua autorizzazione nel browser, poi l’ottenimento dell’accesso, la verifica del server di posta e del server di invio e il salvataggio dell’account. Due parti hanno un limite di tempo: l’attesa della tua autorizzazione nel browser (tre minuti) e le verifiche dei server (30 secondi per la ricezione e 15 per l’invio, con un tentativo ripetuto). Il resto non ne ha; il resto dipende dal provider e dalla tua rete, quindi il passaggio indica cosa sta succedendo, non quanto manca. Se l’account non ha ancora un nome e il provider ne fornisce uno utilizzabile, viene preso dal profilo; un nome che hai modificato non viene mai sovrascritto da una riautorizzazione successiva. Se la connessione fallisce prima del salvataggio dell’account, la procedura torna all’elenco dei provider per riprovare. Chiudere la finestra non annulla una connessione gia avviata: prosegue in background e puo comunque creare l’account, quindi ricominciare in quel momento rischia di lasciare un duplicato. Questo passaggio riguarda l’aggiunta di un account: riautorizzando un account esistente dalle sue impostazioni compare solo un indicatore sul pulsante.

## Account Microsoft 365 / Outlook (OAuth)

Seleziona la scheda **Outlook / Microsoft 365** nella procedura. Si aprira una finestra del browser sulla pagina di accesso Microsoft; accedi con il tuo account `@outlook.com`, `@hotmail.com`, `@live.com` o aziendale/scolastico e approva i permessi richiesti. Il client Microsoft incluso usa il flusso Authorization Code con PKCE senza client secret: nessun client secret lascia il tuo dispositivo. Le build personalizzate che sostituiscono il client incluso impostando **entrambe** le variabili d'ambiente `MAILCOPILOT_MS_CLIENT_ID` (una propria registrazione di app Azure) e `MAILCOPILOT_MS_CLIENT_SECRET` (pensata per i tenant che hanno emesso un client confidential) inviano quel secret al token endpoint di Microsoft via TLS. `MAILCOPILOT_MS_CLIENT_SECRET` da solo (senza un client ID personalizzato) viene ignorato. Una volta autorizzato, l'account viene aggiunto automaticamente.

Qui compare la stessa schermata di attesa vista per Gmail, con le stesse fasi e le stesse avvertenze: l’attesa nel browser e le verifiche dei server hanno un limite di tempo, il resto no e chiudere la finestra non annulla una connessione in corso. A differenza di Gmail, qui non c’e un tentativo ripetuto per il server di invio. Il tuo nome viene preso dal profilo Microsoft se l’account non ne ha uno e il profilo ne fornisce uno utilizzabile; un nome che hai modificato non viene mai sovrascritto da una riautorizzazione successiva. La richiesta di fiducia nel certificato descritta piu avanti per Google compare anche su questo percorso, dopo il salvataggio dell’account.

Per inviare la posta MailCopilot usa Microsoft Graph (`POST /me/sendMail`) sugli account Outlook, perche Microsoft ha disabilitato SMTP AUTH sulla maggior parte degli account personali Outlook.com creati a partire dal 2024. Il percorso di invio via Graph non e influenzato da questa policy. I messaggi inviati vengono salvati automaticamente da Microsoft nella cartella «Posta inviata».

Se il tuo account Outlook smette di funzionare dopo un lungo periodo offline, il refresh token OAuth potrebbe essere scaduto. Apri **Impostazioni > Account**, modifica l'account e usa il pulsante di re-autenticazione Microsoft per accedere di nuovo.


## Verifica del certificato TLS

MailCopilot verifica sempre i certificati TLS, confrontandoli sia con il pacchetto di certificati Mozilla integrato sia con l'archivio dei certificati del tuo sistema operativo (ripiegando sul solo pacchetto integrato se l'archivio di sistema non puo essere letto). Se il tuo server usa un certificato autofirmato, apparira una richiesta di fiducia: se l'impronta digitale non e ancora stata letta, il pulsante mostra prima **"Leggi il certificato"** -- clicca, controlla i dettagli, poi conferma con **"Considera attendibile e continua"**; se e gia mostrato **"Considera attendibile e continua"**, clicca solo su quello. I server raggiunti tramite STARTTLS (tipicamente la porta IMAP 143 o la porta SMTP 587) non possono consegnare il proprio certificato in questo passaggio, quindi per loro viene salvata solo l'impronta digitale -- un server STARTTLS autofirmato non puo essere reso attendibile in questo modo; usa invece il TLS implicito (tipicamente la porta 993 o 465) se il tuo server lo supporta.

Durante l'accesso con Google, se la tua rete utilizza un proxy o un antivirus che sostituisce i certificati TLS con uno che il tuo sistema operativo non conosce ancora, MailCopilot lo rileverà e proporrà automaticamente di accettare il certificato. Vedrai i dettagli del certificato (host, emittente, impronta digitale) e potrai accettarlo o rifiutarlo. L'account viene salvato in ogni caso, e potrai gestire i certificati in seguito nelle impostazioni dell'account. Se invece il certificato radice del proxy o dell'antivirus e gia installato nell'archivio del tuo sistema operativo, la connessione riesce senza alcuna richiesta di fiducia -- MailCopilot segnala questo caso separatamente con un avviso informativo (vedi sotto) invece di chiederti di accettare qualcosa.

Attendersi all'archivio dei certificati di sistema significa che la maggior parte dei proxy aziendali e degli antivirus che ispezionano il traffico TLS funzionano subito, senza una richiesta di fiducia durante la configurazione. Dopo la prima sincronizzazione riuscita del tuo account in una sessione, MailCopilot verifica una volta se una connessione viene ispezionata in questo modo e, in tal caso, mostra un avviso che indica il software o il proxy responsabile; questa verifica viene eseguita al massimo una volta per server per l'intera durata del tuo profilo, quindi un'ispezione attivata su un server dopo questa verifica non verra rilevata. Se il certificato di un server cambia in seguito in uno di cui non ci si puo fidare del tutto, MailCopilot mostrera a quel punto una finestra di dialogo di ripristino nella finestra principale -- vedi [Attendibilita dei certificati TLS](../settings/general#attendibilita-dei-certificati-tls) per i dettagli.

## Gestire piu account

Puoi aggiungere tutti gli account che ti servono. Per passare da un account all'altro, usa la barra laterale o vai in **Impostazioni > Account**. L'account attivo e evidenziato e puoi impostare qualsiasi account come corrente.

## Personalizzare l'avatar dell'account

Ogni account viene visualizzato nella barra laterale con un avatar -- un cerchio colorato con le iniziali. Puoi personalizzare l'avatar in **Impostazioni > Account** cliccando sull'icona della tavolozza accanto all'account.

### Modalità di visualizzazione

- **Lettere** -- un cerchio colorato con 1--2 caratteri (iniziali). Puoi inserire iniziali personalizzate se quelle automatiche non sono adatte.
- **Icona** -- un cerchio colorato con un'icona dalla collezione (posta, valigetta, stella, razzo, ecc.).
- **Gravatar** -- carica la tua foto profilo da [Gravatar](https://gravatar.com) in base al tuo indirizzo email. Se non viene trovato un Gravatar, vengono mostrate le lettere.

### Cambiare il colore

Clicca su qualsiasi colore nella tavolozza per cambiare lo sfondo dell'avatar. Il colore viene salvato e rimane lo stesso dopo il riavvio.

### Tooltip

Passando il mouse su un avatar nella barra laterale, viene mostrato il nome dell'account e l'indirizzo email.

## Provider supportati

Gmail, Outlook, Yahoo, Fastmail, Yandex Mail, Mail.ru, ProtonMail (tramite Bridge), server propri.
