---
sidebar_position: 6
title: Informazioni
---

# Informazioni

La scheda **Informazioni** nelle Impostazioni mostra informazioni sulla vostra installazione di MailCopilot e fornisce controlli diagnostici e per gli aggiornamenti.

## Versione

Mostra la versione attuale di MailCopilot installata sul vostro computer.

## Link

- **Sito web** — apre il sito web di MailCopilot nel vostro browser.
- **Documentazione** — apre questo sito di documentazione.

## Informazioni di sistema

Il pannello **Informazioni di sistema** mostra dettagli tecnici sulla vostra installazione:

- **Versione dell'app** — la versione attuale di MailCopilot e il canale di rilascio (stable, nightly o dev).
- **Electron** — la versione dell'ambiente di esecuzione Electron utilizzato da MailCopilot.
- **Chromium** — la versione del motore Chromium integrato in Electron.
- **Node.js** — la versione di Node.js in esecuzione all'interno dell'applicazione.
- **Piattaforma** — il sistema operativo e l'architettura.
- **Percorso di installazione** — il percorso dell'eseguibile attualmente in esecuzione (`process.execPath`). Su Windows e macOS è il luogo reale in cui è installato MailCopilot. In un'AppImage, `execPath` punta a una posizione temporanea `/tmp/.mount_*` creata mentre l'app è aperta, non alla posizione del file `.AppImage` stesso — l'indicatore **sola lettura** riflette la scrivibilità della cartella reale del file AppImage, non del percorso mostrato qui. Questo indicatore non compare mai per le installazioni `.deb`/`.rpm`/pacman, che scrivono gli aggiornamenti con privilegi di amministratore invece di affidarsi ai permessi della cartella.

Queste informazioni sono utili per segnalare bug o verificare la compatibilità.

## Aggiornamenti

La sezione **Aggiornamenti** consente di controllare come MailCopilot si mantiene aggiornato.

### Scarica automaticamente gli aggiornamenti in background

Quando questa opzione è abilitata, MailCopilot scarica silenziosamente le nuove versioni man mano che diventano disponibili. Una volta completato il download, viene chiesto di riavviare l'applicazione per applicare l'aggiornamento. Non è richiesta alcuna azione fino a quando non si è pronti al riavvio.

Quando questa opzione è disabilitata, MailCopilot notifica che è disponibile un aggiornamento e mostra un pulsante **Scarica**. L'utente decide esattamente quando iniziare il download.

Questa impostazione è **disabilitata per impostazione predefinita** (richiede attivazione esplicita). Abilitatela per consentire a MailCopilot di scaricare gli aggiornamenti senza intervento manuale.

### Controlla aggiornamenti

Fate clic sul pulsante **Controlla aggiornamenti** per avviare manualmente una verifica in qualsiasi momento. Il pulsante e l'area di stato riflettono lo stato attuale del processo di aggiornamento:

- **inattivo** — il pulsante **Controlla aggiornamenti** è visibile e pronto all'uso.
- **Verifica…** — è in corso una verifica degli aggiornamenti; il pulsante è disabilitato fino al completamento.
- **Hai l'ultima versione** — nessun aggiornamento disponibile.
- **disponibile** — è stata rilevata una nuova versione: accanto al numero di versione sopra appare un'indicazione **(ultima versione disponibile X.Y.Z)**, e — se l'installazione supporta l'auto-aggiornamento — qui appare un pulsante **Scarica X.Y.Z**.
- **Download in corso… N %** — il file di aggiornamento è in fase di download; un indicatore di avanzamento mostra la percentuale.
- **Riavvia per installare** — il download è completo; fate clic per riavviare MailCopilot e applicare l'aggiornamento immediatamente.
- **Errore di rete — riprova quando sei online** — la verifica o il download non è riuscito a causa di un problema di rete.
- **Permesso negato — è richiesto un amministratore** — l'accesso è stato negato dal meccanismo di aggiornamento o dal sistema operativo. Nelle installazioni che usano privilegi di amministratore (`.deb`/`.rpm`/pacman), questo di solito significa che il passaggio di elevazione dei privilegi o quello di installazione del pacchetto è fallito, non che una cartella non è scrivibile.
- **Aggiornamento non riuscito — vedi i log per i dettagli** — si è verificato un errore imprevisto; consultate la registrazione di debug per ulteriori informazioni.
- **Gli aggiornamenti sono disabilitati in questa build** — MailCopilot è in esecuzione in modalità sviluppo o non è pacchettizzato; gli aggiornamenti automatici non sono disponibili.

### Quando l'auto-aggiornamento non è disponibile

Normalmente MailCopilot può aggiornarsi da solo su ogni piattaforma supportata: un'installazione AppImage sostituisce il file `.AppImage` stesso, e un'installazione `.deb`/`.rpm`/pacman lascia che il meccanismo di aggiornamento tenti la scrittura richiedendo privilegi di amministratore (`pkexec`/`sudo`), esattamente come farebbero `apt`/`dnf`/`pacman`. Il risultato effettivo su queste installazioni Linux pacchettizzate è deciso dalla richiesta di elevazione dei privilegi e dal gestore di pacchetti, non da MailCopilot — un fallimento in quel punto mostra una finestra di dialogo **Update installation failed** («Installazione dell'aggiornamento non riuscita») con un link alla pagina dei download, non silenziosamente.

MailCopilot decide in anticipo che l'auto-aggiornamento non è disponibile solo in due situazioni:

- **La build non è pacchettizzata** — una build di sviluppo o CI. In questo caso non esiste alcun meccanismo di aggiornamento: il pulsante **Controlla aggiornamenti** e l'area di stato non compaiono, e al loro posto viene mostrato l'avviso **«Gli aggiornamenti sono disabilitati in questa build»**.
- **La build è pacchettizzata, ma MailCopilot ha un motivo concreto per aspettarsi che la scrittura fallisca**, il che avviene quando:
  - la build Linux non è né un'AppImage né un pacchetto di sistema supportato — ad esempio un'AppImage estratta o una cartella `linux-unpacked` grezza, oppure
  - la cartella in cui MailCopilot dovrebbe scrivere non è scrivibile dal tuo account utente. In un'AppImage è la cartella che contiene il file `.AppImage`; su Windows e macOS è la cartella che contiene l'eseguibile installato. Questo controllo non si applica alle installazioni `.deb`/`.rpm`/pacman, perché per queste il meccanismo di aggiornamento eleva i privilegi invece di verificarlo.

Nel secondo caso, il controllo degli aggiornamenti continua a funzionare normalmente — è interessata solo la possibilità di scrivere l'aggiornamento sul posto:

- Il pulsante **Controlla aggiornamenti** resta disponibile e funziona — potete sempre verificare se esiste una nuova versione.
- La casella **Scarica automaticamente gli aggiornamenti in background** resta disponibile e continua a salvare la vostra preferenza, ma nulla viene scaricato automaticamente finché l'auto-aggiornamento non diventa possibile.
- Accanto alla casella compare un avviso che spiega il motivo — ad esempio: «Questa build non può sostituirsi sul posto (non è in esecuzione come AppImage né come pacchetto di sistema). Scarica manualmente la nuova versione dal sito.» oppure «La cartella che contiene l'app non è scrivibile, quindi l'aggiornamento non può essere installato sul posto. Scarica manualmente la nuova versione o sposta l'app in una cartella tua.» Se MailCopilot non riesce a determinare il motivo specifico, compare invece un avviso neutro: «Questa installazione non può aggiornarsi automaticamente. Scarica manualmente la nuova versione dal sito.»
- I controlli **Scarica** e **Riavvia per installare** non compaiono, perché MailCopilot non ha modo di scrivere l'aggiornamento da solo.

Questo controllo viene eseguito una sola volta, all'avvio di MailCopilot. Se spostate il file AppImage in una posizione scrivibile o cambiate i permessi della cartella di installazione, uscite e riavviate MailCopilot perché la modifica abbia effetto — un'istanza già in esecuzione mantiene il proprio verdetto originale.

Aggiornate l'applicazione tramite il gestore di pacchetti, con privilegi di amministratore, oppure scaricando la nuova versione manualmente dal sito web.

## Diagnostica e dati di utilizzo

Quando abilitato, MailCopilot invia rapporti sui crash, misurazioni delle prestazioni, eventi di utilizzo (quali funzioni vengono usate, quale fornitore e modello di IA, il costo stimato di una richiesta) e un identificatore casuale dell'installazione che collega le tue sessioni. Il contenuto dei messaggi e il testo delle tue ricerche non vengono mai inclusi; indirizzi, oggetti e nomi delle cartelle sono esclusi del tutto ovunque la diagnostica usi un elenco chiuso di campi (come nella diagnostica della copia inviata), e altrove vengono intercettati da una pulizia con il miglior sforzo di forme riconoscibili di indirizzi e percorsi -- una rete di sicurezza, non una garanzia. Il modulo di feedback qui sotto è l'unico posto in cui un indirizzo viene inviato di proposito, così puoi ricevere una risposta; ovunque altro, un indirizzo viene solo ripulito se riconosciuto, non garantito assente -- e, poiché include quell'identificatore dell'installazione, questi dati non sono del tutto anonimi. Per l'elenco completo di cosa viene inviato e cosa non viene mai inviato, vedete [Telemetria](../privacy/telemetry).

Questa impostazione riflette la risposta data nella schermata di consenso mostrata al primo avvio di MailCopilot, ed è **disabilitata per impostazione predefinita** — non viene inviato nulla finché non avete dato attivamente il consenso. Potete cambiare la vostra decisione in qualsiasi momento selezionando o deselezionando la casella.

Se MailCopilot non dispone di una risposta alla domanda di consenso iniziale — ad esempio, subito dopo che l'elenco dei dati raccolti è cambiato e una nuova richiesta diventa dovuta — la casella qui viene mostrata deselezionata e disabilitata, con una nota che spiega che la diagnostica resta disattivata finché non rispondete alla schermata di consenso al prossimo avvio.

## Registrazione di debug

Quando abilitata, MailCopilot scrive registri dettagliati in un file per la risoluzione dei problemi. Questi registri vengono archiviati localmente sul vostro computer e non vengono mai inviati automaticamente.

La registrazione di debug è disabilitata per impostazione predefinita. Abilitatela solo durante l'indagine di un problema — potrebbe influire leggermente sulle prestazioni.

## Segnala un bug

Fate clic sul pulsante **Segnala un bug** per inviare feedback direttamente agli sviluppatori di MailCopilot. Descrivete il problema riscontrato — questo ci aiuta a identificare e risolvere i problemi più rapidamente.

Il vostro feedback viene inviato in modo sicuro attraverso lo stesso sistema di diagnostica descritto sopra. Se la segnalazione errori è disattivata, vedrete un link al sito web di MailCopilot dove potete contattare il supporto.

Quando l'applicazione incontra un errore imprevisto, un modulo di feedback apparirà anche nella schermata di errore, permettendovi di descrivere cosa stavate facendo prima dell'errore.
