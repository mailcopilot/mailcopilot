---
sidebar_position: 1
title: Impostazioni generali
---

# Impostazioni generali

## Tema

Scegli tra **Chiaro** e **Scuro**. L'interfaccia si aggiorna immediatamente quando cambi tema. In modalità scura, le finestre si aprono con lo sfondo scuro fin dal primo fotogramma — nessun flash bianco.

## Lingua

6 lingue: English, Italiano, Francais, Deutsch, Espanol, Russo. Cambio istantaneo.

## Conservazione dei messaggi

Controlla per quanto tempo le copie complete dei messaggi (contenuto HTML, immagini incorporate e allegati) vengono conservate sul disco. Apri **Impostazioni > Generale** e usa l'elenco a discesa **Conserva la copia completa per** per scegliere un periodo. I messaggi più vecchi restano ricercabili tramite intestazioni e testo normale — solo il file `.eml` arricchito viene eliminato alla scadenza.

| Opzione | Durata |
|---------|--------|
| 30 giorni | ~1 mese |
| 90 giorni | ~3 mesi |
| 180 giorni | ~6 mesi |
| 1 anno | 365 giorni (predefinito) |
| Sempre | Nessuna eliminazione automatica |

Quando si riduce il periodo di conservazione, MailCopilot mostra un'anteprima del numero di messaggi in cache che verranno rimossi prima di applicare la modifica. I messaggi sul server non vengono mai modificati -- è interessata solo la copia locale.

## Applicazione email predefinita

L'interruttore stabilisce se MailCopilot si registra presso il sistema operativo come gestore dei link `mailto:`. Quando e attivo, cliccare un link «invia email» nel browser, nel terminale o in un'altra applicazione desktop apre la finestra di composizione di MailCopilot con destinatario e altri parametri (`to`, `cc`, `bcc`, `subject`, `body`) gia precompilati.

La registrazione e opt-in: MailCopilot non si appropria del protocollo finche non attivi esplicitamente questo interruttore. Su Linux la registrazione passa per la dichiarazione `MimeType` del file desktop; su macOS tramite `open-url`; su Windows tramite la voce di protocollo in `HKCR\mailto`. Puoi annullare l'operazione in qualunque momento disattivando questo interruttore o cambiando il gestore email predefinito nelle impostazioni di sistema.

Quando MailCopilot viene avviato una seconda volta -- per esempio cliccando un link `mailto:` mentre l'app e gia aperta -- la finestra esistente viene portata in primo piano invece di aprirne una duplicata, cosi e sempre attiva una sola istanza.

## Controllo ortografico

Il controllo ortografico è **disattivato per impostazione predefinita**. Attivarlo scarica un file di dizionario da un server esterno (quello di Google), e MailCopilot chiede prima il permesso -- per ogni nuova lingua aggiunta. È una scelta deliberata: MailCopilot non attiva mai una lingua che non hai approvato. Il download vero e proprio viene eseguito dal motore del browser integrato nell'applicazione (Chromium), che contatta il server di Google -- MailCopilot non può annullare una richiesta già avviata. Se un download parte comunque per una lingua che non hai approvato, MailCopilot se ne accorge e disattiva di nuovo il controllo ortografico, invece di lasciarlo attivo senza che tu lo sappia.

Attiva **«Controlla l’ortografia mentre scrivo»** per accendere il controllo. Da quel momento le parole scritte in modo errato vengono sottolineate ovunque tu possa digitare testo -- nella composizione, nei campi delle impostazioni e così via.

### Scegliere i dizionari

Una volta attivato il controllo ortografico, usa **«Dizionari»** per aggiungere una o più lingue. L'elenco delle lingue disponibili proviene dal motore di controllo ortografico stesso, non da un elenco fisso integrato in MailCopilot -- ciò che vedi dipende da ciò che questa build dell'applicazione può effettivamente offrire. Puoi aggiungere più lingue contemporaneamente; vengono tutte controllate insieme. Ogni lingua aggiunta può essere rimossa di nuovo con il suo pulsante **«Rimuovi»**. Se «Controlla l’ortografia mentre scrivo» è attivo ma non è stato scelto alcun dizionario, il controllo resta di fatto disattivato -- un dizionario è obbligatorio.

Il numero di dizionari attivi contemporaneamente è limitato; il limite attuale è mostrato accanto al selettore.

### Permesso di download

La prima volta che aggiungi una lingua non ancora approvata, MailCopilot mostra una finestra di dialogo che chiede se scaricare il dizionario di quella lingua, indicando il server esterno da cui proviene il file. Nulla di ciò che digiti viene mai inviato da nessuna parte -- il controllo avviene sempre sul tuo computer; viene scaricato solo il file del dizionario stesso.

- Scegliere **«Scarica»** approva la lingua: MailCopilot memorizza l'approvazione e lascia procedere il download. L'approvazione resta valida per quella lingua anche in seguito -- se il dizionario deve essere scaricato di nuovo più avanti (per esempio dopo aver riattivato una lingua già approvata), questo avviene senza chiedertelo di nuovo.
- Scegliere **«Annulla»** (o chiudere la finestra di dialogo) equivale a rifiutare: quella lingua **non** viene attivata, ma la decisione non viene memorizzata come rifiuto permanente -- puoi aggiungere di nuovo la stessa lingua più avanti e ti verrà semplicemente richiesto ancora. Le altre modifiche fatte nello stesso salvataggio vengono comunque applicate: rifiutare il download di un dizionario non blocca mai il resto delle tue modifiche.

### macOS

Su macOS, il controllo ortografico appartiene al sistema operativo, non a MailCopilot. Su macOS non c'è né un selettore di dizionari né una finestra di dialogo per il permesso di download, perché macOS non scarica nulla e ignora qualsiasi elenco di lingue che MailCopilot potrebbe inviargli -- le impostazioni lo spiegano e mostrano solo l'interruttore acceso/spento. Per cambiare le lingue controllate da macOS, apri Impostazioni di Sistema → Tastiera → Inserimento testo.

### Correggere una parola scritta in modo errato

Fai clic con il tasto destro su una parola sottolineata come errata per vedere un breve elenco di sostituzioni suggerite, oltre a una voce **«Aggiungi al dizionario»**. Cliccare su un suggerimento sostituisce la parola; **«Aggiungi al dizionario»** aggiunge la parola al tuo dizionario personale in modo che non venga più segnalata. Al momento non c'è modo di consultare o rimuovere le parole aggiunte al dizionario personale da MailCopilot.

## Icona nell'area di notifica e funzionamento in background

MailCopilot può mostrare un'icona nell'area di notifica del sistema. **«Mostra icona nell'area di notifica»** è attiva per impostazione predefinita; il suo menu offre **«Apri MailCopilot»**, **«Nuovo messaggio»**, **«Controlla la posta»** e **«Esci»**, e finché l'icona esiste, passandoci sopra con il mouse viene mostrato il numero di messaggi non letti nel suggerimento -- fino a 999, poi **«999+»**.

### Alla chiusura riduci nell'area di notifica

Attiva **«Alla chiusura riduci nell'area di notifica»** (disattivata per impostazione predefinita) affinché MailCopilot continui a funzionare quando chiudi la finestra principale invece di uscire -- la posta continua a sincronizzarsi in background e le notifiche di nuova posta continuano ad arrivare. Per far tornare la finestra, clicca sull'icona nell'area di notifica (o sulla sua voce di menu **«Apri MailCopilot»**); usa **«Esci»** nel menu dell'icona per uscire davvero dall'applicazione.

Scegliere **«Esci»** non rimuove subito l'icona dall'area di notifica. Prima di uscire davvero, MailCopilot esegue un checkpoint del suo database locale -- da qui la breve attesa, normalmente molto meno di un secondo. Durante questa fase, il suggerimento dell'icona mostra **«Chiusura in corso…»**, e il suo menu mostra un'unica voce inattiva **«Chiusura in corso…»** al posto delle opzioni abituali, così puoi capire che l'applicazione sta ancora chiudendosi invece di pensare che Esci abbia solo rimosso l'icona. Se al momento dell'uscita un messaggio era ancora in fase di invio, non va perso: MailCopilot invia attraverso una coda locale, quindi un invio non completato resta semplicemente in coda e riparte al successivo avvio di MailCopilot.

Questa impostazione dipende dal fatto che l'icona sia stata creata con successo, non da chi la disegni: su Linux, MailCopilot crea l'icona anche quando nessun host dell'area di notifica la accetta, quindi **«Alla chiusura riduci nell'area di notifica»** funziona ogni volta che l'oggetto icona esiste -- che il desktop la mostri davvero oppure no. L'impostazione non ha effetto solo se MailCopilot non è riuscito a creare l'icona (un'immagine dell'icona vuota o illeggibile, oppure una piattaforma che rifiuta di costruirla).

MailCopilot non verifica, prima di nascondere la finestra, se il desktop disegni davvero l'icona -- è una decisione del desktop, non di MailCopilot; una nota sotto l'impostazione lo segnala per Linux. Se l'icona non viene mai disegnata, non c'è nulla su cui cliccare, ma nascondere la finestra resta comunque reversibile: riavviare MailCopilot riporta in primo piano la finestra nascosta, che l'icona funzioni, venga disegnata male o non sia mai comparsa.

Se le notifiche sono attive, la prima volta che una chiusura nasconde la finestra nell'area di notifica in una sessione, MailCopilot mostra una breve notifica una tantum che conferma che l'app continua a funzionare in background e che cliccando sull'icona la finestra torna visibile.

Se un giorno chiudete MailCopilot aspettandovi che resti nell'area di notifica e poi non lo trovate più, consultate [Ho chiuso la finestra e ora non trovo più MailCopilot](../faq#ho-chiuso-la-finestra-e-ora-non-trovo-più-mailcopilot) nelle domande frequenti.

### Badge dei non letti

Finché ci sono messaggi non letti, MailCopilot mostra un badge sull'icona dell'applicazione -- un badge numerico nel dock (macOS) o nel launcher di Unity (Linux), e un punto sul pulsante della barra delle applicazioni (Windows); il numero stesso (fino a 999, poi **«999+»**) è disponibile nel suggerimento dell'icona nell'area di notifica finché quell'icona esiste. Il badge rispetta le stesse cartelle escluse dal conteggio dei non letti nelle [impostazioni delle cartelle](folders-settings#badge-dei-non-letti).

### Avvia all'accesso

Attiva **«Avvia all'accesso»** (disattivata per impostazione predefinita) per far avviare MailCopilot automaticamente quando accedi al tuo computer. Su Windows e macOS, questo registra MailCopilot come voce di avvio automatico presso il sistema operativo; su Linux, crea una voce di avvio automatico (un file `.desktop`) affinché il tuo ambiente desktop avvii MailCopilot all'accesso.

L'interruttore registra ciò che hai richiesto; sotto di esso compare una nota ogni volta che il risultato effettivo non corrisponde. Se questa piattaforma o versione non può registrare l'avvio automatico, MailCopilot avvisa che qui l'impostazione non ha effetto. Se l'attivazione non è riuscita, una nota spiega che l'avvio automatico non è stato registrato e che verrà ritentato al prossimo salvataggio. Se la disattivazione non è riuscita, MailCopilot avvisa che l'app continuerà comunque ad avviarsi all'accesso e che la rimozione verrà ritentata automaticamente al prossimo salvataggio -- così non pensi mai che l'avvio automatico sia disattivato quando in realtà non lo è.

## Attendibilita dei certificati TLS

MailCopilot verifica ogni certificato TLS presentato dai tuoi server di posta sia rispetto al pacchetto di certificati Mozilla integrato, sia rispetto all'archivio dei certificati del tuo sistema operativo. Attendersi anche all'archivio di sistema significa che i software di sicurezza che ispezionano il traffico TLS (per esempio Kaspersky e antivirus simili) e i proxy aziendali non interrompono piu la sincronizzazione della posta su Windows, macOS o Linux -- MailCopilot riconosce come validi i certificati presentati da questi strumenti invece di rifiutare la connessione. La verifica dei certificati non viene mai indebolita da questo: un certificato deve comunque essere attendibile secondo una di queste due fonti, oppure essere pinnato esplicitamente, per essere accettato. Se l'archivio dei certificati del tuo sistema operativo non puo essere letto, MailCopilot ripiega sul solo pacchetto Mozilla integrato invece di saltare la verifica.

### Ripristino dopo un cambio di certificato

Se un server presenta mai un certificato di cui non ci si puo fidare -- per esempio non corrisponde piu a un certificato accettato in precedenza, oppure un certificato autofirmato e cambiato dopo una rotazione -- MailCopilot mostra la finestra di dialogo **"Il server ha presentato un certificato diverso"** direttamente nella finestra principale, non solo durante la configurazione dell'account. La finestra elenca il server, l'emittente e l'impronta digitale SHA-256 del nuovo certificato.

La conferma avviene in massimo due passaggi, cosi che cio che approvi corrisponda sempre a cio che e effettivamente mostrato a schermo:

- Se l'impronta digitale non e ancora stata letta, il pulsante principale mostra **"Leggi il certificato"**. Clicca per recuperare il certificato dal server; i suoi dettagli sostituiscono poi il segnaposto nella finestra di dialogo.
- Una volta mostrata un'impronta digitale, il pulsante diventa **"Considera attendibile e continua"**. Clicca per accettare esattamente il certificato mostrato.
- Se il certificato del server cambia di nuovo tra l'apertura della finestra di dialogo e la conferma, MailCopilot rifiuta la conferma obsoleta e rilegge il certificato per mostrarti i nuovi dettagli -- ma l'offerta di attendibilita di quella finestra di dialogo era legata al certificato mostrato inizialmente, e rileggerlo non la rinnova: confermare di nuovo continuera quindi a fallire allo stesso modo. Clicca su **"Annulla"** per chiudere questa finestra di dialogo, poi lascia che MailCopilot riprovi la connessione; apparira una nuova finestra di dialogo con il certificato attuale, da confermare. Nel frattempo niente viene considerato attendibile.

Scegli **"Annulla"** in qualsiasi momento per mantenere lo stato precedente. Lo stesso server non mostrera questa finestra di dialogo piu di una volta al minuto. Anche l'offerta di attendibilita della finestra di dialogo non resta aperta indefinitamente -- se e rimasta senza risposta a lungo, confermarla puo essere rifiutato; anche in questo caso annulla e attendi che appaia una nuova finestra di dialogo.

### Riconfermare un server autofirmato pinnato dopo un aggiornamento

Il pinning dei certificati e ora applicato rigorosamente per i certificati che non superano la normale verifica della catena: in precedenza, il pinning confrontava le impronte digitali solo per i certificati la cui catena era gia verificata normalmente, mentre i certificati autofirmati e con autorita di certificazione privata -- il caso esatto per cui il pinning esiste -- aggiravano del tutto la verifica dell'impronta digitale. Questa lacuna e ora colmata. Se hai pinnato un server di posta autofirmato o con un'autorita di certificazione privata prima di questa modifica, il pin salvato potrebbe contenere solo un'impronta digitale senza il certificato necessario per verificarlo realmente -- un server del genere smettera di connettersi dopo l'aggiornamento, e MailCopilot mostrera la finestra di dialogo di ripristino del certificato descritta sopra.

Per risolvere, riconferma il certificato tramite quella stessa finestra di dialogo: se il pulsante mostra **"Leggi il certificato"**, clicca prima su quello per recuperare il certificato, poi su **"Considera attendibile e continua"**; se e gia mostrato **"Considera attendibile e continua"**, clicca solo su quello. Questo salva il pin insieme al certificato stesso, e la sincronizzazione riprende automaticamente. Devi farlo solo una volta per ogni server interessato. Aggiungere o modificare un pin manualmente nelle **Impostazioni** non risolve da solo il problema -- per un certificato altrimenti non attendibile (autofirmato, o emesso da un'autorita di certificazione privata non ancora presente nell'archivio del tuo sistema operativo), solo la finestra di dialogo di ripristino puo concedergli attendibilita; vedi [Quando usare il pinning dei certificati](#quando-usare-il-pinning-dei-certificati) piu sotto per il motivo.

### Avviso di ispezione

Dopo la prima sincronizzazione riuscita di un account in una sessione, MailCopilot verifica una volta se la sua connessione al server di posta viene ispezionata da un antivirus o proxy (il certificato e attendibile solo tramite l'archivio di sistema) e, in tal caso, mostra un avviso come "La connessione a `{{host}}` viene ispezionata.", indicando l'emittente quando e noto. Questa verifica viene eseguita al massimo una volta per server per l'intera durata del tuo profilo, sia che venga rilevata un'ispezione sia che non venga rilevata -- quindi se l'ispezione viene attivata su un server *dopo* che questa verifica una tantum e gia stata eseguita senza trovare nulla, MailCopilot non se ne accorgera. L'avviso puo essere chiuso.

Gli errori di certificato vengono ritentati con un intervallo lungo (6 ore) anziche l'intervallo breve usato per i normali problemi di rete, poiche richiedono una tua decisione e non si risolvono da soli.

## Pinning dei certificati TLS

Il pinning dei certificati TLS aggiunge un livello di sicurezza extra per le tue connessioni email. Garantisce che il tuo client si connetta solo a server che presentano un certificato specifico, proteggendoti dagli attacchi man-in-the-middle.

### Gestione dei certificati pinnati

1. Apri le **Impostazioni** e vai alla sezione **Account**.
2. Clicca su **Modifica** su un account per aprire le sue impostazioni.
3. Scorri verso il basso fino alla sezione **Pinning dei certificati TLS**.

La sezione mostra una tabella dei certificati pinnati con host, porta, impronta digitale e data di aggiunta.

### Aggiungere un pin

1. Clicca su **Aggiungi pin**.
2. Inserisci l'**host** (ad esempio, `imap.gmail.com`) e la **porta** (ad esempio, `993`).
3. Clicca su **Recupera e blocca**. MailCopilot si connette al server, recupera il suo certificato e ti mostra l'impronta digitale.
4. Conferma per salvare il pin.

Un pin aggiunto in questo modo *restringe* solo quale certificato viene accettato per un server gia attendibile tramite il pacchetto Mozilla abituale o l'archivio dei certificati del tuo sistema operativo -- non rende da solo attendibile un certificato autofirmato o con autorita di certificazione privata altrimenti non attendibile. Per un server di posta autofirmato (o con autorita di certificazione privata non ancora presente nell'archivio del tuo sistema operativo), aggiungere un pin qui non basta per connettersi; devi confermarlo tramite la finestra di dialogo di ripristino del certificato descritta in [Attendibilita dei certificati TLS](#attendibilita-dei-certificati-tls), l'unico punto in cui MailCopilot concede attendibilita a un certificato di questo tipo.

### Rimuovere un pin

Clicca sul pulsante di eliminazione accanto a qualsiasi pin nella tabella per rimuoverlo. Questo rimuove solo il pin salvato -- dopo, MailCopilot accetterà qualsiasi certificato valido da quel server.

Aggiungere un pin riconnette automaticamente MailCopilot al server di posta in modo che la modifica abbia effetto immediatamente. Rimuovere un pin non provoca una riconnessione automatica -- la modifica ha effetto alla prossima connessione di MailCopilot a quel server.

### Server STARTTLS (porte 143 e 587)

I server raggiunti tramite STARTTLS (tipicamente la porta IMAP 143 o la porta SMTP 587, dove la connessione inizia in chiaro e poi passa a TLS) non consegnano il proprio certificato nel momento in cui MailCopilot lo cattura per il pinning. Per questi server viene salvata solo l'impronta digitale, non il certificato stesso -- quindi un server STARTTLS autofirmato o con autorita di certificazione privata non puo essere reso utilizzabile in questo modo; usa il TLS implicito (tipicamente la porta 993 per IMAP, 465 per SMTP) se il tuo server lo supporta.

### Quando usare il pinning dei certificati

Il pinning dei certificati è particolarmente utile negli ambienti aziendali o in situazioni in cui è necessario verificare che le connessioni email vadano verso i server previsti. Per la maggior parte degli utenti privati, la verifica TLS predefinita è sufficiente.
