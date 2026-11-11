---
sidebar_position: 7
title: FAQ
---

# Domande frequenti

## Cos'e MailCopilot?

Un moderno client di posta desktop con supporto IMAP/SMTP, progettato per velocita e privacy.

## Quali piattaforme sono supportate?

**Linux** (AppImage). Windows e macOS sono previsti.

## Dove vengono conservate le password?

Nel portachiavi di sistema (keytar), mai in testo semplice.

## Quali provider sono compatibili?

Qualsiasi provider IMAP/SMTP: Gmail, Outlook, Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail (tramite Bridge), server propri.

## Come collego un account Gmail?

Scegli la scheda **Gmail** nella procedura di configurazione e segui i passaggi: attiva la verifica in due passaggi sul tuo Account Google, crea una password per le app per MailCopilot (istruzioni di Google: [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833)), poi inserisci il tuo indirizzo Gmail e la password per le app di 16 caratteri, non la tua solita password Google. Le impostazioni del server (`imap.gmail.com` porta 993, `smtp.gmail.com` porta 465) vengono compilate automaticamente. Per i passaggi completi vedi [Account Gmail](./getting-started/adding-account#gmail-account).

## Perché non posso aggiungere una nuova casella Gmail con l'accesso Google?

Google consente a un'app non verificata di far accedere in totale solo 100 nuovi utenti, e questo limite non può essere azzerato. Per questo la versione ufficiale di MailCopilot non collega nuove caselle Gmail con **Accedi con Google**: ogni nuova casella Gmail, compresa una seconda casella di chi usa già MailCopilot, si collega invece con una password per le app (vedi la domanda precedente). Le caselle Gmail che accedono già con Google continuano a funzionare e puoi ricollegarle (per esempio dopo un token revocato o un cambio di password), ma solo con lo stesso indirizzo Google. Se accedi con un altro account Google, MailCopilot rifiuta, non modifica nulla. L'altro account mantiene l'accesso appena concesso; rimuovilo in quell'Account Google, tra gli accessi di terze parti. L'indirizzo di una tale casella non può essere modificato nelle impostazioni dell'account (i campi utente IMAP e SMTP sono di sola lettura); per cambiarlo, ricollegati con lo stesso account Google. Se l'indirizzo Google della casella stessa è cambiato (per esempio l'account è stato rinominato o spostato su un altro dominio), la riconnessione viene rifiutata e non cambia nulla: rimuovi la casella e aggiungila di nuovo con una password per le app (la posta nella cache locale viene scaricata di nuovo). Una versione compilata dal codice sorgente con un proprio client Google OAuth mantiene l'accesso Google per le nuove caselle; una versione senza alcun client Google OAuth non mostra alcun pulsante Google e una casella che accede con Google non può essere ricollegata lì. Outlook / Microsoft 365 non è interessato.

## Manca l'opzione delle password per le app. Cosa devo fare? {#app-passwords-missing}

Google non offre le password per le app per tutti gli account. L'opzione può mancare se l'account è gestito da un'organizzazione (chiedi al suo amministratore), usa la Protezione avanzata o usa solo chiavi di sicurezza per la verifica in due passaggi. In tal caso resta una sola possibilità: una versione compilata dal codice sorgente con il tuo client Google OAuth. Un'app interna a un'organizzazione è esente dalla verifica di Google, vedi [la spiegazione di Google](https://support.google.com/cloud/answer/7454865).

## Posso usare piu account?

Si, con cambio nella barra laterale o nella posta in arrivo unificata.

## Il test di connessione mostra un errore di certificato TLS. Cosa devo fare?

MailCopilot verifica sempre i certificati TLS, confrontandoli sia con il pacchetto di certificati Mozilla integrato sia con l'archivio dei certificati del tuo sistema operativo. Questa richiesta di fiducia interna all'app esiste solo per il tuo **server di ricezione (IMAP)**. Se questo server usa un certificato autofirmato, oppure uno rilasciato da un'autorita di certificazione privata non ancora presente nell'archivio attendibile del tuo sistema operativo (per esempio un'autorita di certificazione interna gestita da un'universita o un'azienda), apparira una richiesta di fiducia. Controlla i dettagli del certificato e accettalo se sei sicuro che il server sia legittimo. Se l'impronta digitale non e ancora stata letta, il pulsante principale mostra prima **"Leggi il certificato"** -- clicca, controlla il risultato, poi clicca su **"Considera attendibile e continua"** per confermare. La fiducia concessa in questo modo e legata a quel certificato esatto e all'indirizzo e alla porta specifici di questo server; un altro server, anche se rilasciato dalla stessa autorita di certificazione, non diventa attendibile automaticamente, e un successivo cambio del certificato di questo server richiedera di confermare il nuovo allo stesso modo. La riga **«Dettagli»** della finestra di dialogo indica, nella lingua dell'app, perché il certificato non è stato accettato (ad esempio perché è scaduto, è autofirmato o è stato emesso per un altro nome di server).

Se invece l'errore riguarda il tuo **server di invio (SMTP)**, MailCopilot non offre affatto questa richiesta di fiducia -- un certificato autofirmato o di un'autorita di certificazione privata sul lato SMTP non ha alcun rimedio interno all'app. Il certificato deve essere reso attendibile al di fuori di MailCopilot: rendendo il certificato radice dell'autorita di certificazione attendibile nel sistema operativo stesso (MailCopilot ha bisogno di un riavvio per recepirlo), oppure tramite la variabile d'ambiente `NODE_EXTRA_CA_CERTS` per configurazioni avanzate.

## Il mio antivirus o il proxy aziendale ispeziona la mia connessione di posta. MailCopilot funzionera comunque?

Si. MailCopilot si affida all'archivio dei certificati del tuo sistema operativo oltre al suo pacchetto di certificati integrato, quindi i software di sicurezza che ispezionano il traffico TLS (per esempio antivirus con scansione HTTPS) e i proxy aziendali non interrompono piu la sincronizzazione della posta. Dopo la prima sincronizzazione riuscita del tuo account in una sessione, MailCopilot verifica questo una volta e, se lo trova, mostra un avviso che identifica il software o il proxy responsabile; questa verifica viene eseguita al massimo una volta per server per l'intera durata del tuo profilo, quindi un'ispezione attivata su un server dopo che questa verifica e gia stata eseguita non verra rilevata. Se il certificato cambia in seguito in uno di cui non ci si puo piu fidare del tutto (e non solo tramite l'archivio di sistema), MailCopilot mostra una finestra di dialogo di ripristino dove puoi controllare i dettagli del nuovo certificato e decidere se fidarti.

## Il mio server di posta autofirmato ha smesso di connettersi dopo l'aggiornamento di MailCopilot. Perche?

Il pinning dei certificati in passato confrontava le impronte digitali solo per i certificati la cui catena era gia verificata normalmente; i certificati autofirmati e con autorita di certificazione privata -- il caso esatto per cui il pinning esiste -- aggiravano del tutto questa verifica dell'impronta digitale. Questa lacuna e ora colmata, il che e un miglioramento della sicurezza -- ma se hai pinnato un server autofirmato o con autorita di certificazione privata prima di questa modifica, il pin salvato potrebbe non includere il certificato necessario per verificarlo, e quel server ora smettera di connettersi. Per il tuo **server di ricezione (IMAP)**, apri la finestra di dialogo di ripristino del certificato che appare per lui: se il pulsante mostra **"Leggi il certificato"**, clicca prima su quello, poi su **"Considera attendibile e continua"**; se e gia mostrato **"Considera attendibile e continua"**, clicca solo su quello. Questo salva il pin insieme al certificato stesso, e l'account si risincronizza automaticamente. Devi farlo solo una volta per ogni server interessato. Aggiungere o modificare un pin manualmente nelle Impostazioni non risolve il problema -- un pin manuale puo solo restringere l'attendibilita per un server che ha gia un certificato normale e pubblicamente attendibile; per un certificato altrimenti non attendibile (autofirmato, o di un'autorita di certificazione privata non ancora presente nell'archivio del tuo sistema operativo), solo la finestra di dialogo di ripristino puo concedergli attendibilita. Se in seguito aggiungi un pin per impronta digitale per lo stesso server e non corrisponde al certificato gia confermato li, viene rifiutato allo stesso modo -- MailCopilot riapre la finestra di dialogo di ripristino invece di usarlo. Per il tuo **server di invio (SMTP)**, non esiste alcuna finestra di dialogo di ripristino -- un server SMTP autofirmato o con autorita di certificazione privata che si rompe in questo modo resta rotto finche il certificato non diventa attendibile al di fuori di MailCopilot: o il certificato radice della sua autorita di certificazione diventa attendibile direttamente nel sistema operativo, oppure tramite la variabile d'ambiente `NODE_EXTRA_CA_CERTS` per configurazioni avanzate.

Se il tuo server usa STARTTLS (tipicamente la porta IMAP 143 o la porta SMTP 587), MailCopilot non puo catturare il suo certificato in questo modo -- viene salvata solo l'impronta digitale, quindi un server STARTTLS autofirmato restera non connettibile. Usa invece il TLS implicito (tipicamente la porta 993 per IMAP, 465 per SMTP) se il tuo server lo supporta.

## La connessione indica che il server non offre una connessione cifrata (STARTTLS). Cosa significa?

Il tuo account è configurato senza **SSL/TLS** immediato (tipicamente porta IMAP 143 o porta SMTP 587), quindi MailCopilot si aspetta che il server passi la connessione alla modalità cifrata con STARTTLS prima di inviare qualsiasi password o messaggio. Questo server non ha offerto né accettato il passaggio, perciò MailCopilot ha rifiutato di proseguire e non ha inviato né password né messaggi. Volutamente non esiste un'opzione «consenti senza cifratura». Controlla la porta e la casella **SSL/TLS** in **Settings > Accounts** (tipicamente porta IMAP 993 e porta SMTP 465 con **SSL/TLS** selezionata) oppure contatta il provider di posta. Vedi [Connessione cifrata obbligatoria (STARTTLS)](./getting-started/adding-account#connessione-cifrata-obbligatoria-starttls).

## L'invio non riesce e il messaggio dice che la rete o una VPN potrebbero bloccare le porte della posta in uscita. Cosa devo fare?

Questo messaggio compare quando MailCopilot non è riuscito a raggiungere affatto il server di posta in uscita: la connessione è fallita prima che il server rispondesse, il che di solito indica una porta bloccata, una VPN o una rete irraggiungibile. Questi invii vengono ritentati automaticamente con ritardi crescenti; se alla fine falliscono definitivamente, vedi questo suggerimento al posto di un errore tecnico grezzo. Controlla la connessione a Internet, disattiva o riconfigura la VPN, assicurati che la rete o il firewall consenta connessioni in uscita verso la porta del tuo server di posta (tipicamente 465 o 587) e riprova a inviare.

Lo stesso messaggio compare quando aggiungi un account o ne testi la connessione e un server accetta la connessione ma non risponde mai: il test di connessione sia del server in ricezione (IMAP) sia di quello in invio (SMTP) termina con questo messaggio, invece che con un errore tecnico grezzo. Il consiglio è lo stesso: controlla la connessione a Internet, disattiva o riconfigura la VPN e assicurati che la rete consenta connessioni in uscita verso le porte del tuo server di posta.

## L'invio non riesce e il messaggio dice che non si sa se è stato inviato. Cosa devo fare?

Questo messaggio compare quando la connessione al server di posta in uscita si è interrotta dopo che il server era stato raggiunto, ma prima che confermasse l'invio, ad esempio per un timeout, un reset della connessione o perché il server ha chiuso la connessione senza rispondere. MailCopilot non può quindi sapere se il server ha accettato il messaggio e perciò **non** ritenta l'invio automaticamente, perché un nuovo tentativo potrebbe consegnare il messaggio due volte. Il messaggio passa invece allo stato di errore. Non fare affidamento sulla cartella Posta inviata: MailCopilot salva la sua copia lì solo dopo un invio confermato, quindi la copia di solito manca anche se il messaggio è partito. Chiedi al destinatario o controlla i messaggi inviati nell'interfaccia del tuo provider di posta per sapere se è arrivato; in caso contrario, apri la **Outbox** e usa **Send now** (oppure modifica prima il messaggio) per inviarlo di nuovo a mano. Gli errori prima che il server risponda (porta bloccata, VPN, rete irraggiungibile) vengono ancora ritentati automaticamente con ritardi crescenti, i rifiuti con codice di risposta 4xx vengono ritentati anch'essi, mentre i rifiuti 5xx non vengono ritentati e mostrano il motivo indicato dal server stesso.

## Come cerco i messaggi?

Clicca sulla barra di ricerca (o premi **/***) e digita la tua ricerca.

Operatori di ricerca avanzata:

- `from:user@example.com` -- messaggi da un mittente specifico.
- `to:user@example.com` -- messaggi inviati a un destinatario specifico.
- `subject:riunione` -- messaggi con una parola nell'oggetto.
- `has:attachment` -- messaggi con allegati.
- `is:unread` / `is:read` -- filtrare per stato di lettura.
- `is:starred` -- messaggi con stella.
- `before:2026-01-01` / `after:2025-12-01` -- filtrare per data.
- `in:Sent` -- messaggi in una cartella specifica.
- Negazione con `-`: `-from:spam@example.com`.
- Combinare con `OR` o `AND` (senza distinzione tra maiuscole e minuscole): `from:alice OR from:bob`.

## L'assistente IA e obbligatorio?

No, e completamente opzionale.

## Dove posso vedere cosa fa l'IA con i miei dati?

Aprite **Impostazioni → IA** e espandete la sezione **Privacy e audit**. Li troverete un registro di audit completo di ogni azione IA: data e ora, provider, modello, obiettivo, strumento utilizzato, costo stimato e esito. Il conteggio dei token viene registrato se il provider lo espone tramite SDK; altrimenti le colonne mostrano **n/d**. Potete anche esportare il registro in formato JSON o CSV.

Per maggiori dettagli, consultate [Dati IA e registro di audit](./privacy/ai-data).

## Come aggiornare MailCopilot?

Per impostazione predefinita, MailCopilot **non** scarica gli aggiornamenti automaticamente. Quando viene rilevata una nuova versione, in **Impostazioni > Informazioni** appare un pulsante **Scarica X.Y.Z**. Fate clic su di esso per avviare il download, poi fate clic su **Riavvia per installare** quando il download e completato.

Per una verifica manuale in qualsiasi momento, aprite **Impostazioni > Informazioni** e fate clic su **Controlla aggiornamenti**.

Per attivare il download automatico in background, aprite **Impostazioni > Informazioni** e selezionate **Scarica automaticamente gli aggiornamenti in background**. Quando attivata, le nuove versioni vengono scaricate silenziosamente e viene chiesto di riavviare quando l'aggiornamento e pronto.

MailCopilot normalmente puo aggiornarsi da solo su ogni piattaforma supportata: un'installazione AppImage sostituisce il file `.AppImage` stesso, e un'installazione `.deb`/`.rpm`/pacman lascia che il meccanismo di aggiornamento tenti la scrittura richiedendo privilegi di amministratore (`pkexec`/`sudo`), esattamente come farebbero `apt`/`dnf`/`pacman` -- il risultato effettivo lo decidono quella richiesta di elevazione dei privilegi e il gestore di pacchetti, non MailCopilot.

L'auto-aggiornamento puo non essere disponibile in due modi diversi, e MailCopilot mostra controlli diversi per ciascuno:

- **La build non e pacchettizzata** -- una build di sviluppo o CI. In questo caso non esiste alcun meccanismo di aggiornamento: il pulsante **Controlla aggiornamenti** e l'area di stato non compaiono, e al loro posto viene mostrato l'avviso **"Gli aggiornamenti sono disabilitati in questa build"**.
- **La build e pacchettizzata, ma l'auto-aggiornamento e bloccato** -- o perche MailCopilot non e riuscito a determinare la cartella in cui dovrebbe scrivere l'aggiornamento sul posto, o perche quella cartella non e scrivibile dal vostro account. Il primo caso si verifica su Linux quando l'app non e in esecuzione come un'AppImage montata (per esempio un'AppImage estratta o una build grezza `linux-unpacked`) -- in quel caso non c'e nessuna cartella in cui scrivere. Il secondo caso significa che la cartella di un'AppImage in esecuzione non e scrivibile (un'installazione `.deb`/`.rpm`/pacman non e interessata, perche queste elevano i privilegi al posto vostro); su Windows e macOS significa che la cartella che contiene l'eseguibile installato non e scrivibile. In entrambi i casi compare un avviso che spiega il motivo, il pulsante **Controlla aggiornamenti** continua a funzionare, e la casella di download automatico resta disponibile -- ma i controlli di download e riavvio sono nascosti.

## Posso disabilitare gli aggiornamenti automatici?

Il download automatico in background e disabilitato per impostazione predefinita. Se avete attivato l'opzione **Scarica automaticamente gli aggiornamenti in background** e desiderate disattivarla, aprite **Impostazioni > Informazioni** e deselezionatela. MailCopilot continuera a notificarvi quando e disponibile un aggiornamento, ma il download non iniziera fino a quando non fate clic su **Scarica**.

Indipendentemente dai download, MailCopilot cerca nuove versioni in background all'avvio e circa una volta all'ora. Per impedirgli di avviare da solo nuove ricerche, aprite **Impostazioni > Informazioni** e deselezionate **Cerca aggiornamenti in background**. La modifica ha effetto subito, senza riavvio. Il pulsante **Controlla aggiornamenti** continua a funzionare. Con la ricerca in background disattivata, MailCopilot non avvia né nuove ricerche automatiche né nuovi download automatici, anche se **Scarica automaticamente gli aggiornamenti in background** è selezionata; una ricerca o un download già in corso quando disattivate l'opzione può comunque completarsi.

## MailCopilot non sincronizza.

Verifica IMAP IDLE nelle impostazioni, clicca su Sincronizza e controlla la tua connessione internet.

## Ho chiuso la finestra e ora non trovo più MailCopilot.

Con **«Alla chiusura riduci nell'area di notifica»** attiva, chiudere la finestra la nasconde dietro l'icona nell'area di notifica (a condizione che MailCopilot sia riuscito a crearla) -- clicca sull'icona per farla tornare. Su alcuni desktop Linux l'icona potrebbe non venire disegnata affatto: in quel caso non c'è nulla su cui cliccare.

In entrambi i casi, avvia semplicemente di nuovo MailCopilot. Se è ancora in esecuzione con una finestra nascosta, la riporta in primo piano invece di aprirne una seconda copia; se si era già chiuso, si apre una finestra nuova.
