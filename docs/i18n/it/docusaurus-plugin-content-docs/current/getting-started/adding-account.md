---
sidebar_position: 2
title: Aggiungere un account
---

# Aggiungere un account email

MailCopilot supporta qualsiasi provider che utilizza IMAP e SMTP. Gmail si collega con una password per le app (vedi [Account Gmail](#gmail-account)), e un account Microsoft 365 / Outlook.com può accedere tramite OAuth, senza inserire la password.

## Procedura guidata

Clicca su **Connetti email** (icona busta in basso nella barra laterale).

### Passo 1: Scegli il provider

La procedura ora inizia con un selettore esplicito di provider: dici a MailCopilot quale provider usi prima ancora di inserire qualunque credenziale. Ogni provider e mostrato come scheda con il logo o l'icona del provider:

- **Gmail** -- porta ai passaggi della password per le app (la scheda riporta «Collega con una password per le app»): attivi la verifica in due passaggi, crei una password per le app nel tuo Account Google e la inserisci insieme al tuo indirizzo Gmail. Vedi [Account Gmail](#gmail-account) più sotto. In una versione compilata dal codice sorgente con un proprio client Google OAuth, la scheda riporta invece «Accedi con Google OAuth» e passa direttamente all'accesso con Google.
- **Outlook / Microsoft 365** -- avvia il flusso OAuth di Microsoft (Authorization Code con PKCE) e si collega tramite Microsoft Graph. Funziona sia per account personali `@outlook.com` / `@hotmail.com` / `@live.com` sia per account aziendali e scolastici di Microsoft 365.
- **Generic IMAP/SMTP** -- per qualsiasi altro provider (Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail Bridge, posta aziendale, server self-hosted e cosi via). Passa prima a uno step di conferma con un unico pulsante **Account IMAP/SMTP**, che apre poi il modulo di inserimento delle credenziali.

Tra le schede puoi spostarti con i tasti freccia e confermare con **Invio** o **Spazio**. Dopo aver scelto un provider, la procedura prosegue con i passi specifici. Sul percorso Generic IMAP/SMTP, il pulsante **Indietro** dello step di conferma riporta al selettore di provider; lo step di inserimento credenziali ha anch'esso un pulsante **Indietro**, che riporta allo step di conferma (uno step alla volta). Gli step di rilevamento del server e configurazione manuale vanno solo avanti -- per ricominciare con un altro provider, annulla la procedura e riaprila.

Se vuoi usare Outlook tramite Generic IMAP/SMTP invece di OAuth, scegli la scheda Generic e collegati con una password app contro `outlook.office365.com` / `smtp.office365.com`.

### Passo 2: Inserisci le credenziali (Generic IMAP/SMTP)

Una nuova casella Gmail arriva a questo stesso modulo dopo il passaggio della password per le app (vedi [Account Gmail](#gmail-account)).

1. Inserisci **indirizzo email** e **password**.
2. Opzionalmente, un **nome visualizzato**.
3. Facoltativamente, inserisci un **indirizzo email (Da)** -- questo indirizzo viene utilizzato nel campo «Da» dei messaggi in uscita. Se lasciato vuoto, viene utilizzato l'indirizzo di accesso SMTP.
4. Se le credenziali SMTP sono diverse, attiva l'opzione corrispondente.
5. Clicca su **Avanti**.

### Passo 3: Rilevamento del server

MailCopilot tentera di rilevare automaticamente le impostazioni del server utilizzando i protocolli standard di rilevamento automatico. Se ha successo, i server IMAP e SMTP rilevati vengono mostrati in campi modificabili. Puoi verificare e modificare il nome visualizzato, l'indirizzo email, gli host dei server, le porte e le impostazioni SSL prima di connetterti.

- Clicca su **Connetti** per testare la connessione e salvare l'account.
- Se un server accetta la connessione ma non risponde mai (in genere una rete o una VPN che blocca le porte di posta), il test fallisce con il messaggio «Impossibile raggiungere il server di posta prima che rispondesse. Spesso significa che la rete o una VPN blocca le porte della posta in uscita. Controlla la connessione o le impostazioni VPN e riprova.» La stessa frase viene mostrata per il server in ricezione (IMAP) e per quello in invio (SMTP).
- Una volta salvato, l'account compare subito nella finestra principale. Se è il tuo primo account, la finestra principale lo apre da sola -- non serve riavviare né ricaricare.
- Se desideri il controllo manuale completo su tutte le impostazioni (incluse credenziali IMAP/SMTP separate), clicca su **Configurazione manuale**.

## Account Gmail {#gmail-account}

Gmail si collega tramite i protocolli standard IMAP e SMTP. Google consente a un'app non verificata di far accedere in totale solo 100 nuovi utenti, e questo limite non può essere azzerato, quindi la versione ufficiale di MailCopilot non collega **nuove** caselle Gmail con **Accedi con Google**. Una nuova casella si collega invece con una password per le app. Questo vale anche per una seconda casella Gmail di chi usa già MailCopilot con l'accesso Google: è anch'essa una nuova casella.

### Collegare una nuova casella Gmail con una password per le app

Scegli la scheda **Gmail** nella procedura. La procedura apre **Collegare Gmail con una password per le app** con i passaggi seguenti e tre pulsanti: **Indietro** (torna alla selezione del provider), **Apri le istruzioni di Google** e **Avanti**.

1. Attiva la verifica in due passaggi sul tuo Account Google: le password per le app la richiedono.
2. Crea una password per le app per MailCopilot nel tuo Account Google. Le istruzioni ufficiali di Google sono su [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833); il pulsante **Apri le istruzioni di Google** apre quella pagina nel browser.
3. Fai clic su **Avanti**, poi inserisci il tuo indirizzo Gmail e la password per le app di 16 caratteri (non la tua solita password Google).

Le impostazioni del server vengono compilate automaticamente: IMAP `imap.gmail.com` sulla porta 993 e SMTP `smtp.gmail.com` sulla porta 465. Controllale nel passaggio di rilevamento e fai clic su **Connetti**.

### Caselle che accedono già con Google

Le caselle Gmail collegate con l'accesso Google continuano a funzionare e puoi ricollegarle (per esempio dopo aver revocato l'accesso o cambiato la password di Google) da **Impostazioni > Account** con il pulsante **Riconnetti Google**. La riconnessione funziona solo con lo stesso indirizzo Google della casella. Se accedi con un altro account Google, MailCopilot rifiuta: «Questo account Google non è (l'indirizzo della casella), quindi la casella non è stata modificata. Accedi con lo stesso indirizzo che stai ricollegando.», e non cambia nulla. L'altro account mantiene l'accesso appena concesso a MailCopilot; rimuovilo in quell'Account Google, tra gli accessi di terze parti.

L'indirizzo di una casella che accede con Google (o con qualsiasi accesso OAuth) non può più essere modificato nelle impostazioni dell'account: i campi utente IMAP e SMTP sono di sola lettura per tale casella. Per cambiare l'indirizzo, ricollegati con lo stesso account Google. Se l'indirizzo Google della casella stessa è cambiato (per esempio l'account è stato rinominato o spostato su un altro dominio), la riconnessione viene rifiutata e non cambia nulla; la soluzione è rimuovere la casella e aggiungerla di nuovo con una password per le app (la posta nella cache locale viene scaricata di nuovo).

### Se manca l'opzione delle password per le app

Google non offre le password per le app per tutti gli account. L'opzione può mancare se l'account è gestito da un'organizzazione (chiedi al suo amministratore), usa la Protezione avanzata o usa solo chiavi di sicurezza per la verifica in due passaggi. In tal caso resta una sola possibilità: una versione compilata dal codice sorgente con il tuo client Google OAuth; un'app interna a un'organizzazione è esente dalla verifica di Google (vedi [la spiegazione di Google](https://support.google.com/cloud/answer/7454865)). Vedi anche le [FAQ](../faq#app-passwords-missing).

### Versioni con un proprio client Google

Una versione compilata dal codice sorgente con un proprio client Google OAuth mantiene l'accesso Google per le nuove caselle: le versioni compilate in proprio lo hanno per impostazione predefinita, la scheda Gmail riporta «Accedi con Google OAuth» e sceglierla apre il flusso nel browser descritto più sotto. Una versione senza alcun client Google OAuth non mostra alcun pulsante Google; per una casella che accede con Google, **Impostazioni > Account** segnala allora che la casella accede con Google ma questa versione non include un client Google OAuth, quindi non può essere ricollegata lì. Outlook / Microsoft 365 non è interessato.

### Avanzamento dell'accesso con Google

Il passaggio di avanzamento descritto di seguito compare nelle versioni che offrono l'accesso Google per le nuove caselle.


Durante la connessione la procedura sostituisce l’elenco dei provider con un passaggio di avanzamento che mostra cosa sta attendendo: la tua autorizzazione nel browser, poi l’ottenimento dell’accesso, la verifica del server di posta e del server di invio e il salvataggio dell’account. Due parti hanno un limite di tempo: l’attesa della tua autorizzazione nel browser (tre minuti) e le verifiche dei server (30 secondi per la ricezione e 15 per l’invio, con un tentativo ripetuto). Il resto non ne ha; il resto dipende dal provider e dalla tua rete, quindi il passaggio indica cosa sta succedendo, non quanto manca. Se l’account non ha ancora un nome e il provider ne fornisce uno utilizzabile, viene preso dal profilo; un nome che hai modificato non viene mai sovrascritto da una riautorizzazione successiva. Se la connessione fallisce prima del salvataggio dell’account, la procedura torna all’elenco dei provider per riprovare. Chiudere la finestra non annulla una connessione gia avviata: prosegue in background e puo comunque creare l’account, quindi ricominciare in quel momento rischia di lasciare un duplicato. Questo passaggio riguarda l’aggiunta di un account: riautorizzando un account esistente dalle sue impostazioni compare solo un indicatore sul pulsante.

## Account Microsoft 365 / Outlook (OAuth)

Seleziona la scheda **Outlook / Microsoft 365** nella procedura. Si aprira una finestra del browser sulla pagina di accesso Microsoft; accedi con il tuo account `@outlook.com`, `@hotmail.com`, `@live.com` o aziendale/scolastico e approva i permessi richiesti. Il client Microsoft incluso usa il flusso Authorization Code con PKCE senza client secret: nessun client secret lascia il tuo dispositivo. Le build personalizzate che sostituiscono il client incluso impostando **entrambe** le variabili d'ambiente `MAILCOPILOT_MS_CLIENT_ID` (una propria registrazione di app Azure) e `MAILCOPILOT_MS_CLIENT_SECRET` (pensata per i tenant che hanno emesso un client confidential) inviano quel secret al token endpoint di Microsoft via TLS. `MAILCOPILOT_MS_CLIENT_SECRET` da solo (senza un client ID personalizzato) viene ignorato. Una volta autorizzato, l'account viene aggiunto automaticamente.

Qui compare la stessa schermata di attesa vista per Gmail, con le stesse fasi e le stesse avvertenze: l’attesa nel browser e le verifiche dei server hanno un limite di tempo, il resto no e chiudere la finestra non annulla una connessione in corso. A differenza di Gmail, qui non c’e un tentativo ripetuto per il server di invio. Il tuo nome viene preso dal profilo Microsoft se l’account non ne ha uno e il profilo ne fornisce uno utilizzabile; un nome che hai modificato non viene mai sovrascritto da una riautorizzazione successiva. La richiesta di fiducia nel certificato descritta piu avanti per Google compare anche su questo percorso, dopo il salvataggio dell’account.

Per inviare la posta MailCopilot usa Microsoft Graph (`POST /me/sendMail`) sugli account Outlook, perche Microsoft ha disabilitato SMTP AUTH sulla maggior parte degli account personali Outlook.com creati a partire dal 2024. Il percorso di invio via Graph non e influenzato da questa policy. I messaggi inviati vengono salvati automaticamente da Microsoft nella cartella «Posta inviata».

Se il tuo account Outlook smette di funzionare dopo un lungo periodo offline, il refresh token OAuth potrebbe essere scaduto. Un refresh token OAuth mancante nell'archivio sicuro attiva subito l'[avviso di accesso scaduto](#avviso-di-accesso-scaduto), sia per gli account Google sia per quelli Outlook. Se un token salvato viene rifiutato, il conseguente rifiuto di autenticazione IMAP segue il normale flusso di un errore di accesso; riautorizza l'account da **Impostazioni > Account** usando il pulsante di re-autenticazione Microsoft.


## Verifica del certificato TLS

MailCopilot verifica sempre i certificati TLS, confrontandoli sia con il pacchetto di certificati Mozilla integrato sia con l'archivio dei certificati del tuo sistema operativo (ripiegando sul solo pacchetto integrato se l'archivio di sistema non puo essere letto). La richiesta di fiducia interna all'app descritta in questa sezione esiste solo per il tuo **server di ricezione (IMAP)**. Se questo server usa un certificato autofirmato, oppure uno rilasciato da un'autorità di certificazione privata non ancora presente nell'archivio attendibile del tuo sistema operativo -- per esempio un'autorità di certificazione interna gestita da un'università o un'azienda --, apparirà una richiesta di fiducia: se l'impronta digitale non è ancora stata letta, il pulsante mostra prima **"Leggi il certificato"** -- clicca, controlla i dettagli, poi conferma con **"Considera attendibile e continua"**; se è già mostrato **"Considera attendibile e continua"**, clicca solo su quello. La fiducia concessa in questo modo è legata a quel certificato esatto e all'indirizzo e alla porta specifici di questo server -- un altro server rilasciato dalla stessa autorità di certificazione non diventa attendibile automaticamente, e se il certificato di questo server cambia di nuovo in seguito dovrai confermare il nuovo allo stesso modo. In alternativa, puoi installare il certificato radice dell'autorità di certificazione nell'archivio attendibile del tuo sistema operativo; MailCopilot legge quell'archivio solo una volta -- la prima volta che serve -- e conserva quell'istantanea fino al riavvio dell'app, quindi questa alternativa richiede il riavvio di MailCopilot per avere effetto, mentre confermare la richiesta di fiducia descritta qui non lo richiede. I server raggiunti tramite STARTTLS (tipicamente la porta IMAP 143 o la porta SMTP 587) non possono consegnare il proprio certificato in questo passaggio, quindi per loro viene salvata solo l'impronta digitale -- un server STARTTLS autofirmato non puo essere reso attendibile in questo modo; usa invece il TLS implicito (tipicamente la porta 993 o 465) se il tuo server lo supporta.

La riga **«Dettagli»** della richiesta di fiducia indica, nella lingua dell'app, perché il certificato è stato rifiutato -- ad esempio perché è autofirmato o scaduto; l'elenco completo dei motivi è in [Attendibilità dei certificati TLS](../settings/general#attendibilita-dei-certificati-tls).

Il tuo **server di invio (SMTP)** non ha oggi alcuna richiesta di fiducia equivalente. Se presenta un certificato autofirmato o di un'autorità di certificazione privata non ancora presente nell'archivio attendibile del tuo sistema operativo, il test di connessione per quel server fallirà semplicemente -- non esiste alcun rimedio dall'interno dell'app. Il certificato deve essere reso attendibile al di fuori di MailCopilot, installando il certificato radice di quell'autorità di certificazione nell'archivio attendibile del tuo sistema operativo (riavvia poi MailCopilot perché la modifica abbia effetto), oppure tramite la variabile d'ambiente `NODE_EXTRA_CA_CERTS` per configurazioni avanzate.

Durante l'accesso con Google, se la tua rete utilizza un proxy o un antivirus che sostituisce i certificati TLS con uno che il tuo sistema operativo non conosce ancora, MailCopilot lo rileverà e proporrà automaticamente di accettare il certificato. Vedrai i dettagli del certificato (host, emittente, impronta digitale) e potrai accettarlo o rifiutarlo. L'account viene salvato in ogni caso, e potrai gestire i certificati in seguito nelle impostazioni dell'account. Se invece il certificato radice del proxy o dell'antivirus e gia installato nell'archivio del tuo sistema operativo, la connessione riesce senza alcuna richiesta di fiducia -- MailCopilot segnala questo caso separatamente con un avviso informativo (vedi sotto) invece di chiederti di accettare qualcosa.

Attendersi all'archivio dei certificati di sistema significa che la maggior parte dei proxy aziendali e degli antivirus che ispezionano il traffico TLS funzionano subito, senza una richiesta di fiducia durante la configurazione. Dopo la prima sincronizzazione riuscita del tuo account in una sessione, MailCopilot verifica una volta se una connessione viene ispezionata in questo modo e, in tal caso, mostra un avviso che indica il software o il proxy responsabile; questa verifica viene eseguita al massimo una volta per server per l'intera durata del tuo profilo, quindi un'ispezione attivata su un server dopo questa verifica non verra rilevata. Se il certificato di un server cambia in seguito in uno di cui non ci si puo fidare del tutto, MailCopilot mostrera a quel punto una finestra di dialogo di ripristino nella finestra principale -- vedi [Attendibilita dei certificati TLS](../settings/general#attendibilita-dei-certificati-tls) per i dettagli.

Nelle connessioni ai server in arrivo (IMAP) e in uscita (SMTP) e al fornitore di IA, MailCopilot inoltre non si fida più dei certificati la cui catena porta a tre radici di autorità di certificazione legate a un incidente di certificati intermedi compromessi -- `emSign ECC Root CA - G3`, `emSign Root TLS CA - G3` e `AAA Certificate Services` -- anche se il sistema operativo continua a considerarle attendibili. Un server il cui certificato porta a una di esse viene trattato come qualsiasi altro certificato non attendibile: per il server di posta in arrivo (IMAP) compare la richiesta di fiducia descritta sopra (per il server in uscita non c'è alcuna richiesta, come spiegato sopra). Un certificato che hai già confermato in quella richiesta continua a funzionare.

## Connessione cifrata obbligatoria (STARTTLS)

Quando la casella **SSL/TLS** del server in arrivo o in uscita è deselezionata -- tipicamente porta IMAP 143 o porta SMTP 587, dove la connessione inizia senza cifratura e poi passa a quella cifrata con STARTTLS -- MailCopilot richiede che il server completi questo passaggio prima di inviare la password o qualsiasi messaggio. Se il server non offre STARTTLS o non lo accetta, la connessione viene rifiutata e il test di connessione (o la sincronizzazione o l'invio non riusciti) mostra: «Il server non offre una connessione cifrata (STARTTLS), quindi MailCopilot non ha inviato né password né messaggi. Controlla la porta e le impostazioni di sicurezza oppure contatta il provider di posta.» Volutamente non esiste alcuna opzione per proseguire senza cifratura. Per risolvere, controlla la porta e la casella **SSL/TLS** (tipicamente porta IMAP 993 e porta SMTP 465 con **SSL/TLS** selezionata) oppure chiedi al provider di posta quali impostazioni si aspetta il suo server. Le connessioni con **SSL/TLS** non sono interessate.

## Gestire piu account

Puoi aggiungere tutti gli account che ti servono. Per passare da un account all'altro, usa la barra laterale o vai in **Impostazioni > Account**. L'account attivo e evidenziato e puoi impostare qualsiasi account come corrente.

## Avviso di accesso scaduto

Se le credenziali di un account smettono di funzionare -- ad esempio una password IMAP cambiata altrove, o un account senza alcuna password o autorizzazione OAuth salvata -- MailCopilot non fallisce più in silenzio in background. Appare un avviso discreto sopra l'elenco dei messaggi: ad esempio, «Account di posta» non riceve più posta: l’accesso è scaduto. Accedi di nuovo per riprendere la sincronizzazione. Per un normale errore di accesso durante le operazioni di posta abituali, l'avviso appare solo dopo due errori consecutivi per lo stesso account. Due situazioni saltano questa soglia e mostrano l'avviso subito. La prima è un account privo di qualsiasi credenziale salvata, dato che non c'è nulla da ritentare. La seconda è un accesso che il server di posta rifiuta quando MailCopilot avvia il monitoraggio della posta in background (IMAP IDLE) per quell'account: un tentativo di accesso completo respinto dal server è un verdetto definitivo sulle tue credenziali salvate, non solo un'operazione che non ha funzionato, quindi non ha senso attendere un secondo errore -- e una casella con tutte le cartelle impostate su aggiornamento manuale potrebbe non avere una seconda sincronizzazione in background su cui fallire di nuovo. Clicca su **Accedi di nuovo** per aprire direttamente le impostazioni di quell'account, dove puoi reinserire la password o riautorizzare la connessione OAuth.

L'avviso compare solo per errori di accesso (autenticazione) segnalati dal server di posta stesso -- un'interruzione di rete temporanea o un problema di certificato non lo attivano, poiché ciascuno di questi casi ha già un proprio indicatore separato (vedi [Verifica del certificato TLS](#verifica-del-certificato-tls) sopra). Un refresh token OAuth mancante nell'archivio sicuro attiva subito l'avviso, sia per gli account Google sia per quelli Outlook. Se un token salvato viene rifiutato, il conseguente rifiuto di autenticazione IMAP segue il normale flusso di un errore di accesso; in tal caso, riautorizza l'account manualmente da **Impostazioni > Account**. Scompare automaticamente non appena una qualsiasi operazione su quell'account va a buon fine -- non solo una sincronizzazione in background, ma anche l'apertura di un messaggio, lo spostamento della posta o una ricerca -- così anche un account con tutte le cartelle impostate su aggiornamento manuale rimuove l'avviso non appena lo usi. Non c'è nulla da chiudere manualmente. Questo stato non viene salvato tra i riavvii -- se MailCopilot viene chiuso mentre un account è segnalato, l'avviso ricompare solo se lo stesso schema di errori si ripete dopo il successivo avvio.

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

Gmail (con una password per le app; le caselle che accedono già con Google continuano a funzionare), Outlook, Yahoo, Fastmail, Yandex Mail, Mail.ru, ProtonMail (tramite Bridge), server propri.
