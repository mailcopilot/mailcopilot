---
sidebar_position: 2
title: Leggere le email
---

# Leggere le email

## Visualizzare un messaggio

Clicca su un messaggio per aprirlo. Tastiera: **j**/**k** (successivo/precedente), **o** o **Enter** (aprire), **u** (tornare alla lista).

## Intestazioni dei destinatari

Il riquadro di lettura mostra i campi **To**, **Cc** e (per i messaggi inviati) **Bcc** sopra il corpo del messaggio. Quando un campo contiene più di tre indirizzi, MailCopilot comprime il resto: i primi tre nomi vengono mostrati in linea, seguiti da un pulsante **+N altri**, dove N è il numero di indirizzi nascosti.

Fare clic su **+N altri** per espandere l'elenco completo dei destinatari su più righe. Fare clic nuovamente sul pulsante per tornare alla vista riassuntiva. È anche possibile premere **Esc** mentre l'elenco è espanso per comprimerlo.

Passare il cursore sul nome di un destinatario per visualizzare un tooltip con la stringa completa `Nome <email@host>`. Gli utenti della tastiera possono navigare con Tab verso ogni chip dei destinatari e il pulsante **+N altri**; premendo **Invio** o **Spazio** sul pulsante si attiva/disattiva lo stato espanso.

**Privacy Bcc:** la riga Bcc viene mostrata solo per i messaggi inviati dall'utente stesso. Non viene mai visualizzata per i messaggi ricevuti, quindi i destinatari Bcc dei messaggi in arrivo rimangono privati.

## Immagini esterne

Bloccate per impostazione predefinita. Clicca su **Mostra immagini** o attiva l'opzione nelle Impostazioni.

## Testo citato

Quando si riceve una risposta o un messaggio inoltrato, MailCopilot comprime automaticamente la cronologia delle citazioni in modo da mostrare solo il nuovo contenuto. La parte citata è nascosta dietro un controllo **Mostra testo citato** in fondo al corpo del messaggio.

Fare clic su **Mostra testo citato** per espandere l'intera cronologia direttamente nel messaggio. Il collasso delle citazioni si applica **esclusivamente alle email HTML**: i blocchi `<blockquote>` di primo livello e annidati vengono ciascuno compressi in modo indipendente tramite un elemento nativo `<details>`/`<summary>` — non è richiesto JavaScript. MailCopilot rileva inoltre i pattern di attribuzione in stile Outlook (`-----Original Message-----`, `On … wrote:`) quando precedono immediatamente un blocco `<blockquote>`, e comprime quelle righe di attribuzione insieme al blocco citato corrispondente.

Le email in testo normale mostrano la cronologia delle citazioni così com'è, senza alcun collasso. Si tratta di una limitazione nota, che sarà risolta in una versione futura.

Se il messaggio non contiene testo citato, il controllo non viene visualizzato.

## Thread di conversazione

Quando il raggruppamento per conversazioni è attivo (impostazione predefinita), i messaggi correlati vengono raggruppati in thread. Nell'elenco dei messaggi, i thread con più di un messaggio mostrano un badge `+N` accanto all'oggetto — indica quanti messaggi aggiuntivi ci sono nel thread; il tooltip mostra il totale. Clicca sul thread nell'elenco dei messaggi per aprirlo nel riquadro di lettura.

### Stato di non letto di una riga di thread

Una riga di thread nell'elenco dei messaggi viene mostrata come non letta (in grassetto) quando **almeno un** messaggio all'interno del thread attualmente visualizzato nell'elenco non è letto — non solo il più recente. In questo modo, un messaggio non letto sepolto nel mezzo di una conversazione non risulta mai invisibile nell'elenco, anche se il messaggio più recente di quello stesso thread è già stato letto.

Cliccando su un thread non letto si apre il **messaggio non letto più vecchio** del thread come scheda attiva espansa. Se tutti i messaggi del thread sono già stati letti, il clic apre invece il messaggio principale del thread — con l'ordinamento predefinito per data, è il messaggio più recente.

Aprire un messaggio in questo modo non segna il resto del thread come letto. Segnare tutti i messaggi di un thread come letti resta un'azione separata ed esplicita -- vedi **Segna thread come letto** in [Azioni sul thread](#azioni-sul-thread) più sotto.

### Vista del thread — pila di schede

I thread con due o più messaggi vengono visualizzati come una pila verticale di schede. Per impostazione predefinita, le schede sono ordinate **dal più recente al più vecchio**. La scheda attiva espansa è quella del messaggio aperto — il messaggio non letto più vecchio se il thread ne contiene, altrimenti il messaggio principale del thread; le altre restano compresse.

- Le **schede compresse** mostrano l'avatar del mittente, il nome del mittente, la data in formato intelligente e un breve estratto di testo. Se il messaggio non ha testo anteprima disponibile, la scheda mostra **«(anteprima non disponibile)»**.
- Clicca su qualsiasi scheda compressa per espanderla. Clicca di nuovo su una scheda espansa per comprimerla. Può essere espansa una sola scheda alla volta: aprire un altro messaggio chiude quello precedente.

I thread con un singolo messaggio e gli account con il raggruppamento disattivato continuano a utilizzare il visualizzatore semplice — la vista a pila compare solo in presenza di due o più messaggi.

Disattivabile in **Impostazioni > Produttività > Raggruppa i messaggi in conversazioni**.

### Ordine di conversazione

Per impostazione predefinita, il messaggio più recente appare in cima alla pila di schede, così da vedere subito l'ultima risposta — proprio come i nuovi messaggi appaiono nella casella di posta in arrivo. È possibile modificare l'ordine in **Impostazioni > Produttività > Ordine di conversazione**:

- **Più recente prima** (predefinito) — il messaggio più recente si trova in cima; i messaggi più vecchi sono sotto.
- **Più vecchio prima** — i messaggi sono ordinati cronologicamente dall'alto verso il basso, con il messaggio più recente in fondo alla pila.

L'impostazione si applica a tutti i thread nel riquadro di lettura e ha effetto immediatamente al momento della modifica.

### Azioni sul thread

Quando visualizzi un thread con due o più messaggi, la barra degli strumenti unica nella parte superiore del visualizzatore di messaggi passa alla modalità thread. È la stessa barra degli strumenti utilizzata per i messaggi singoli — i suoi pulsanti si adattano alla semantica del thread:

- **Rispondi** -- componi una risposta al mittente del messaggio più recente del thread.
- **Rispondi a tutti** -- rispondi a tutti i partecipanti del messaggio più recente, escludendo l'indirizzo principale del tuo account.
- **Inoltra** -- inoltra il messaggio più recente del thread a qualcun altro.
- **Archivia thread** -- sposta l'intero thread nella cartella Archivio. Disabilitato se non è configurata alcuna cartella Archivio.
- **Elimina thread** -- deciso cartella per cartella: ogni messaggio che può ancora essere spostato nel Cestino viene spostato lì immediatamente. Ogni messaggio già presente nel Cestino, o appartenente a un account senza cartella Cestino, viene invece coperto da una finestra di conferma prima dell'eliminazione definitiva. Un thread confinato in un'unica cartella percorre quindi esattamente uno di questi due percorsi, come prima; un thread i cui messaggi si estendono su più cartelle (ad esempio una risposta già archiviata nel Cestino insieme al resto della conversazione) può percorrere entrambi contemporaneamente -- i messaggi spostabili vengono spostati, e la finestra di conferma copre solo ciò che rimane.
- **Segna thread come letto** -- segna tutti i messaggi del thread come letti. Questo pulsante appare solo quando almeno un messaggio del thread non è letto; viene nascosto quando l'intero thread è già stato letto.
- **Posticipa** -- nasconde temporaneamente **l'intero thread** e fa riapparire tutti i suoi messaggi al momento scelto. La finestra di dialogo è ancorata al messaggio più recente, ma vengono posticipati tutti i messaggi del thread insieme. Stesse opzioni del posticipo dei singoli messaggi. Nascosto nella cartella Bozze.
- **Spam** -- in modalità thread, apre una finestra di conferma che chiede se contrassegnare tutti i messaggi del thread come spam. Annullare un'etichetta di spam è più difficile che annullare un'archiviazione; la conferma aggiuntiva è intenzionale.
- **Aggiungi stella, Fissa, Stampa, Apri in finestra, Apri nell'account** -- questi pulsanti agiscono sul messaggio attualmente attivo (espanso) nel thread, non sull'intero thread.

Rispondi, Rispondi a tutti e Inoltra si riferiscono al messaggio più recente del thread. Archivia thread, Elimina thread, Segna thread come letto e Posticipa si applicano a tutti i messaggi del thread contemporaneamente.

### Riepilogo IA del thread

Quando apri un thread con **tre o piu messaggi**, e il Riepilogo IA del thread e abilitato per l'account, sopra la pila di schede appare un riepilogo generato dall'IA in una riga. Fai clic per espandere cinque punti elenco con gli aspetti chiave della conversazione. Fai di nuovo clic sulla riga del riepilogo per comprimere i punti elenco.

Il Riepilogo IA del thread e **disattivato per impostazione predefinita** e va abilitato **per ciascun account** in **Impostazioni > IA > Riepilogo IA del thread**. Vedi [Assistente IA](../ai-assistant#riepilogo-ia-del-thread) per come abilitarlo e cosa viene inviato al tuo provider IA.

I thread piu brevi (meno di tre messaggi) non mostrano mai la barra del riepilogo -- la pila e abbastanza piccola da leggere direttamente. Viene riepilogato solo il thread che hai aperto attivamente; MailCopilot non riepiloga mai i thread in background o sull'intera casella di posta.

Una volta riepilogato un thread, riaprirlo mostra il riepilogo memorizzato nella cache istantaneamente -- MailCopilot non lo rigenera finche i messaggi del thread non cambiano.

Se il budget IA giornaliero e stato raggiunto, non e configurato alcun provider IA, o il provider restituisce un errore temporaneo, la barra mostra un messaggio esplicativo al posto del riepilogo. Compare un pulsante **Riprova** quando l'errore era un problema temporaneo del provider.

### Risposta immediata

Quando la Risposta immediata e abilitata per l'account, sulla scheda del messaggio attivamente aperta appare un pulsante **Risposta immediata**. Fai clic per far redigere all'IA due o tre brevi opzioni di risposta basate sul contenuto del messaggio.

Fai clic su un'opzione per aprirla in una **nuova finestra di composizione**, precompilata con quel testo -- nulla viene inviato automaticamente, continui a rivedere e inviare il messaggio tu stesso.

La Risposta immediata e **disattivata per impostazione predefinita** e va abilitata **per ciascun account** in **Impostazioni > IA > Risposta immediata**. Vedi [Assistente IA](../ai-assistant#risposta-immediata) per come abilitarla e cosa viene inviato al tuo provider IA.

## Traduzione del messaggio

MailCopilot può tradurre il messaggio che stai leggendo nella lingua che preferisci.

La Traduzione del messaggio è **disattivata per impostazione predefinita** e va abilitata **per ciascun account** in **Impostazioni > IA > Traduzione con IA** (spunta «Consenti la traduzione dei messaggi ricevuti e delle tue bozze con l’IA»). La stessa impostazione abilita anche la [Traduzione della bozza](../ai-assistant#traduzione-della-bozza) nella finestra di scrittura. Vedi [Assistente IA](../ai-assistant#traduzione-del-messaggio) per come abilitarla e cosa viene inviato al tuo provider IA.

### Come usarla

Fai clic su **Traduci** sopra il corpo del messaggio, quindi scegli una lingua di destinazione dall'elenco **Traduci in**. MailCopilot chiama il tuo provider IA configurato solo in quel momento -- non c'è alcuna traduzione automatica all'apertura di un messaggio, quindi aprire un'email in una lingua straniera non consuma mai da solo il tuo budget IA.

Una volta mostrata la traduzione, un interruttore **Mostra l'originale** / **Mostra la traduzione** sopra il corpo ti permette di alternare in qualsiasi momento. Il messaggio salvato non viene mai modificato -- la traduzione è solo una vista sovrapposta ad esso.

**I messaggi HTML vengono tradotti a partire dalla loro versione testuale.** La traduzione viene sempre mostrata come testo semplice, anche per un messaggio HTML -- la formattazione, il layout e le immagini incorporate non ne fanno parte. Una didascalia sopra il testo tradotto lo indica esplicitamente: «La traduzione parte dalla versione testuale del messaggio, quindi la sua formattazione e le sue immagini non ne fanno parte.»

### Lingua di origine rilevata

Prima di tradurre, MailCopilot cerca di identificare la lingua originale del messaggio sul tuo dispositivo e, quando ci riesce, la indica in una didascalia sopra la traduzione (per esempio: «Traduzione automatica dall'inglese all'italiano. L'originale è a un clic di distanza.»). Il rilevamento avviene localmente e viene usato solo come etichetta -- non decide mai se il messaggio può essere tradotto.

La didascalia è correggibile in entrambi i casi, non solo quando il rilevamento fallisce. Se la lingua non può essere identificata con sufficiente sicurezza, MailCopilot traduce comunque e semplicemente non mostra alcuna didascalia, proponendo un selettore **Lingua di questo messaggio** (segnaposto: **Scegli una lingua**) per indicarla tu stesso. Se invece una didascalia È mostrata ma indica la lingua sbagliata -- il rilevamento locale può confondere con sicurezza lingue strettamente imparentate --, accanto compare un link **Non è la lingua giusta?** che apre lo stesso selettore. In entrambi i casi, indicare la lingua è facoltativo e aggiorna solo la didascalia della traduzione già mostrata, presa dalla cache, senza una nuova chiamata al provider.

### Cache delle traduzioni

La traduzione di un messaggio in una determinata lingua viene memorizzata nella cache localmente sul tuo dispositivo, associata al contenuto stesso del messaggio, alla lingua di destinazione e alla versione del contratto di traduzione (provider, modello e forma del prompt) con cui è stata prodotta -- riaprire lo stesso messaggio e scegliere di nuovo la stessa lingua riutilizza la traduzione in cache invece di chiamare di nuovo il provider, e un cambiamento successivo nel modo in cui MailCopilot produce le traduzioni viene registrato sotto una nuova chiave invece di far passare il risultato di un contratto precedente come attuale. La cache continua a non avere una scadenza propria; al suo posto è il limite sottostante a far invecchiare le voci. Ogni account conserva le sue 500 traduzioni più recenti; una volta raggiunto quel limite, le traduzioni più vecchie di quell'account vengono eliminate per fare spazio a quelle nuove. Rimuovere un account elimina anche le sue traduzioni in cache.

### Se la traduzione non è disponibile

MailCopilot indica il motivo specifico per cui la traduzione non è riuscita, invece di mostrare un errore generico:

- La traduzione è disattivata per questo account.
- Non è ancora configurato alcun provider IA.
- Il provider IA non ha restituito una traduzione.
- Il testo del messaggio non è ancora stato scaricato.
- Il messaggio è troppo lungo per essere tradotto in una sola volta, e non è possibile tradurne solo una parte: per il limite conta l'intero messaggio, compresa la corrispondenza precedente che potrebbe esservi citata.
- Il budget IA di questo periodo è esaurito.

## Allegati

Quando il messaggio attivo ha degli allegati, questi appaiono sopra il corpo del messaggio. Per ogni allegato vengono mostrati:

- Un'**icona del tipo di file** scelta in base al tipo MIME, con fallback sull'estensione del nome file quando il tipo MIME e mancante, generico (`application/octet-stream`) o non riconosciuto: PDF, immagine, archivio, documento, foglio di calcolo, presentazione, testo semplice, messaggio `.eml` incorporato oppure un'icona di file generica quando non si applica nulla di piu specifico.
- Il **nome del file**.
- La **dimensione del file**.

Le immagini di impaginazione che il corpo del messaggio mostra gia in linea -- ad esempio un logo in una firma HTML -- non vengono mai rimosse dall'elenco. MailCopilot non puo stabilire in modo affidabile, dall'esterno del browser, se una determinata parte sia effettivamente diventata visibile a schermo -- lo decidono l'impaginazione, il CSS e la scelta all'interno di un'immagine responsive --, quindi invece di indovinare mantiene ogni parte raggiungibile: gli allegati veri (i file che il mittente ha effettivamente allegato) sono elencati per primi, e le immagini in linea renderizzate nel corpo vengono retrocesse in fondo all'elenco, dietro lo stesso interruttore di espansione descritto piu sotto.

Un interruttore di espansione compare ogni volta che c'e piu da mostrare di quanto ci stia da chiuso -- piu di quattro allegati veri, oppure qualunque immagine in linea retrocessa, anche con quattro o meno allegati veri. Clicca su **Mostra altri (N)**, dove N conta solo gli elementi non visibili in questo momento, per rivelare tutto, e su **Mostra meno** per richiudere l'elenco.

Clicca sul pulsante di download nella riga di un allegato per salvare il file sul computer. Il pulsante di download ha un'etichetta accessibile esplicita, in modo che gli screen reader annuncino l'azione insieme al nome del file.

## Link

MailCopilot verifica i link: link non corrispondenti, HTTP e domini IDN.

### Clic destro su un link

Fai clic destro su un link nel corpo di un messaggio per aprire un piccolo menu contestuale con:

- **Apri il link nel browser** -- apre il link nello stesso modo di un clic, inclusi i controlli di sicurezza descritti sopra (avvisi per dominio non corrispondente e per HTTP, segnalazione di domini IDN/punycode). Questa voce compare solo nella finestra principale e nella finestra di messaggio autonoma (vedi [Apri in finestra](#apri-in-finestra)) -- non e offerta nelle finestre Impostazioni, Componi o Account, che non mostrano link di posta.
- **Copia indirizzo del link** -- copia negli appunti la destinazione reale del link, non il suo testo visibile, e mai la forma di instradamento interna che MailCopilot usa per rappresentare il link. Per un indirizzo web (`http:`/`https:`) con un nome di dominio internazionalizzato, l'indirizzo viene copiato nella sua forma punycode (ASCII) -- la forma che il browser usera effettivamente -- anziche nella forma Unicode, cosi che un indirizzo copiato non possa nascondere un dominio ingannevole dietro caratteri leggibili. Per un indirizzo `mailto:`, un dominio internazionalizzato viene invece codificato in percentuale, poiche i client di posta non lo risolvono come host punycode. Le credenziali incorporate in un link (`https://user:pass@host/…`) vengono copiate cosi come sono, senza essere rimosse -- se incolli quel link altrove, le credenziali lo accompagnano.

Nessuna delle due voci compare per i link che non iniziano con `http:`, `https:` o `mailto:` (per esempio un link `javascript:` o `data:` incorporato in un messaggio), ne per un indirizzo di link piu lungo di 8192 caratteri.

## Azioni

Rispondi (**r**), Rispondi a tutti (**a**), Inoltra (**f**), Stella (**s**), Elimina (**#**), Archivia (**e**), Spam (**!**), Letto/Non letto (**Shift+I**/**Shift+U**), Sposta (**v**) -- trascinare un messaggio su una cartella nella barra laterale funziona allo stesso modo: ogni messaggio viene spostato dalla propria cartella di origine, quindi trascinare da un risultato di una ricerca **Tutte le cartelle**, o da una conversazione i cui messaggi si trovano in cartelle diverse, sposta ogni messaggio da dove effettivamente si trova. Posticipa -- nascondi temporaneamente il messaggio e fallo riapparire in un secondo momento. Vedi sotto per i dettagli.
- **Fissa / Sblocca** -- fissa un messaggio in cima alla lista. I messaggi fissati appaiono sempre per primi, indipendentemente dall'ordinamento (scorciatoia: **p**).
- **Apri in finestra** -- apre il messaggio in una finestra separata autonoma, così puoi leggerlo affiancato ad altri contenuti.
- **Stampa** -- stampa l'email corrente (scorciatoia: **Ctrl+P**).

## Apri in finestra

L'azione **Apri in finestra** apre il messaggio corrente in una finestra autonoma dedicata. Ciò è utile quando si desidera leggere un messaggio o agire su di esso mantenendo la finestra principale libera per sfogliare altre cartelle.

La finestra autonoma è un'area di lavoro completamente funzionale. Include una barra delle azioni completa nella parte superiore con tutti i pulsanti necessari:

- **Rispondi** -- componi una risposta al mittente.
- **Rispondi a tutti** -- rispondi a tutti i destinatari.
- **Inoltra** -- inoltra il messaggio a un altro destinatario.
- **Archivia** -- sposta il messaggio nella cartella Archivio. Il pulsante è disabilitato se non è configurata alcuna cartella Archivio per l'account.
- **Elimina** -- sposta il messaggio nel Cestino quando l'account dispone di una cartella Cestino. Se l'account non ha una cartella Cestino, o il messaggio si trova già nel Cestino, MailCopilot chiede conferma prima di eliminarlo definitivamente.
- **Aggiungi stella / Rimuovi stella** -- attiva o disattiva lo stato con stella del messaggio.
- **Segna come letto / non letto** -- cambia lo stato di lettura.
- **Stampa** -- stampa il corpo del messaggio.

Quando si fa clic su **Archivia**, o su **Elimina** per un messaggio che può essere spostato nel Cestino, la finestra autonoma mostra un banner di annullamento integrato per 3 secondi prima che MailCopilot completi lo spostamento e chiuda la finestra. Fare clic su **Annulla** per interrompere l'operazione — il messaggio rimane al suo posto e la finestra rimane aperta. Finché il banner di annullamento è visibile, i pulsanti **Archivia** e **Elimina** sono disabilitati; **Rispondi**, **Rispondi a tutti**, **Inoltra**, **Aggiungi stella / Rimuovi stella**, **Segna come letto / non letto** e **Stampa** rimangono disponibili.

Se l'account non ha una cartella Cestino, o il messaggio si trova già nel Cestino, **Elimina** chiede conferma prima di eliminarlo definitivamente — non appare alcun banner di annullamento e l'azione è irreversibile.

La finestra autonoma utilizza le stesse protezioni fondamentali del pannello di lettura principale: HTML sanificato in un iframe isolato senza script, immagini remote bloccate e avvisi di phishing per i link.

## Posticipare i messaggi

La funzione Posticipa ti permette di nascondere temporaneamente un messaggio e farlo riapparire all'orario scelto, così potrai occupartene quando sei pronto.

### Come posticipare

Fai clic destro su un messaggio nella lista e scegli **Posticipa** dal menu contestuale.

### Opzioni di posticipo

Scegli tra orari preimpostati o imposta una data e un'ora personalizzate:

- **Più tardi oggi** -- il prossimo intervallo di mezz'ora.
- **Domani mattina (09:00)**.
- **Settimana prossima (lunedì 09:00)**.
- **Personalizzato** -- scegli qualsiasi data e ora futura.

### La cartella Posticipati

I messaggi posticipati appaiono nella cartella **Posticipati** nella barra laterale. Quando arriva l'orario impostato, il messaggio torna visibile nella sua cartella originale e ricevi una notifica.

Clicca su un messaggio posticipato per aprirlo e leggerlo senza annullare il posticipo. Per annullare il posticipo in anticipo, clicca sul pulsante **Annulla** accanto al messaggio.

## Leggi più tardi

La funzione «Leggi più tardi» ti permette di salvare le email per leggerle in seguito — ideale per newsletter lunghe, materiale di riferimento o qualsiasi cosa a cui vuoi tornare con calma.

### Come aggiungere a «Leggi più tardi»

- Fai clic destro su un messaggio e scegli **Leggi più tardi** dal menu contestuale.
- Oppure chiedi all'assistente IA di contrassegnare un'email per la lettura successiva.

### La cartella «Leggi più tardi»

I messaggi contrassegnati appaiono nella cartella **Leggi più tardi** nella barra laterale (icona del libro). A differenza dei messaggi posticipati, le email «Leggi più tardi» rimangono visibili nella loro cartella originale — la cartella è una vista aggiuntiva, non un filtro.

Clicca su un messaggio nella cartella «Leggi piu tardi» per aprirlo e leggerlo. Per rimuovere un messaggio dalla lista, clicca sul pulsante **Rimuovi dalla lista** accanto ad esso.

Puoi aprire la cartella «Leggi piu tardi» dalla barra laterale.

## Messaggi molto grandi

MailCopilot si protegge dalla posta patologicamente grande, ma la protezione esatta che si applica dipende da come viene aperto il messaggio.

**Il limite rigido di 100 MB protegge ogni lettura completa di un messaggio.** Ogni volta che MailCopilot deve leggere per intero il contenuto grezzo di un messaggio -- che tu stia aprendo una copia già salvata sul tuo dispositivo, oppure che MailCopilot stia scaricando un messaggio per intero per renderlo disponibile offline -- un messaggio più grande di 100 MB (dimensione grezza, così come archiviata sul server) non viene analizzato affatto. Questo copre il corpo del messaggio, i suoi allegati e qualsiasi invito al calendario incorporato. Aprendo uno di questi messaggi appare una scheda segnaposto costruita a partire dai dati di intestazione disponibili -- mittente, oggetto e data quando sono noti -- insieme a un avviso che indica che il messaggio supera il limite di 100 MB, senza una dimensione esatta; se il download stesso è stato rifiutato a metà, questi dati provengono dal tuo elenco messaggi già sincronizzato anziché dal messaggio stesso, e possono essere incompleti. Non esiste deliberatamente un'opzione «apri comunque»: è una protezione contro i blocchi per esaurimento della memoria e contro la posta patologica o dannosa, non una dimensione che ci si aspetta di incontrare nell'uso normale. La maggior parte dei provider di posta per privati rifiuta i messaggi intorno ai 20-50 MB prima ancora che raggiungano la tua casella di posta, quindi raggiungere questo limite dovrebbe essere estremamente raro -- anche se non impossibile: alcuni sistemi di posta aziendali (ad esempio Microsoft 365 con un limite organizzativo alzato) possono far passare messaggi più grandi. Il messaggio stesso resta intatto sul server -- puoi aprirlo in un'altra applicazione di posta.

**Il limite «mostrato solo l'inizio» di 1 MB si applica ogni volta che MailCopilot legge un messaggio tramite il percorso di lettura completa usato per l'accesso offline.** Questo include i messaggi aperti da una copia già salvata sul tuo dispositivo, e anche la primissima apertura di un messaggio in una cartella con accesso offline attivato, quando MailCopilot scarica il messaggio per intero per mostrarlo -- anche se i limiti della tua cache impediscono poi di salvare quella copia su disco. Questo è il caso normale per la tua Posta in arrivo, che per impostazione predefinita mantiene disponibili offline i messaggi recenti, e per qualsiasi altra cartella per cui hai attivato l'accesso offline (**Impostazioni > Cartelle**, vedi [Modalità offline](../settings/folders-settings#offline-mode)). Per questi, se il corpo decodificato supera 1 MB, viene mostrato solo l'inizio: un banner sotto il testo dice «È mostrato solo l’inizio di questo messaggio.» Accanto compare il pulsante **Mostra il messaggio completo**. Gli allegati restano elencati per intero anche nella vista troncata. Clicca sul pulsante per rileggere il messaggio con un limite più alto, ma comunque finito (8 MB) -- MailCopilot lo fa solo quando lo richiedi esplicitamente. Se anche il limite alzato non basta a mostrare l'intero messaggio, il banner resta, ma il pulsante viene sostituito da una nota che indica che questo è tutto ciò che MailCopilot può mostrare.

**I messaggi aperti direttamente dal server non sono interessati dal limite di 1 MB / 8 MB descritto sopra.** Le cartelle per cui l'accesso offline è disattivato -- l'impostazione predefinita per tutte le cartelle diverse dalla Posta in arrivo -- recuperano il testo di un messaggio direttamente dal server ogni volta che lo apri, senza prima scaricare e salvare il messaggio per intero. Questo recupero ha propri limiti di dimensione separati per ciascuna parte recuperata, ben al di sotto del limite rigido di 100 MB. Aprire un messaggio molto grande in questo modo non mostra né la scheda segnaposto né il banner «mostrato solo l'inizio»: MailCopilot può semplicemente mostrare meno contenuto di un messaggio molto grande, senza segnalarlo.

## Quando un messaggio non puo essere caricato

Se MailCopilot non riesce a recuperare il corpo del messaggio, mostra un segnaposto invece di una schermata vuota. Ci sono tre motivi distinti per questo, e MailCopilot li distingue invece di mostrare lo stesso messaggio in tutti i casi. La regola che segue e che il segnaposto dichiara soltanto cio che MailCopilot sa davvero, e non nomina una causa che sta solo ipotizzando:

**Hai chiesto di lavorare offline.** Hai attivato «Lavora offline», quindi il server non e mai stato contattato e il corpo del messaggio non e mai stato scaricato: nella cache locale ci sono solo le sue intestazioni:

> «Il contenuto del messaggio non è disponibile offline. Solo le intestazioni sono memorizzate nella cache.»

**La richiesta ha esaurito il tempo a disposizione.** MailCopilot concede 10 secondi al recupero del corpo del messaggio prima di rinunciare. Quel tempo e un cronometro, non una diagnosi: scade senza aver appreso perche il recupero fosse lento. Il piu delle volte il motivo e che nel momento in cui apri il messaggio un lavoro in background -- la sincronizzazione di altre cartelle, l'indicizzazione dei corpi dei messaggi per la ricerca -- sta occupando la connessione al server di posta, ma un server lento, una connessione scadente o un messaggio molto grande producono esattamente lo stesso risultato. Il messaggio esiste quasi certamente sul server: MailCopilot semplicemente non e riuscito a raggiungerlo in tempo:

> «Il messaggio non è stato caricato entro il tempo previsto. Può succedere quando un'attività in background occupa la connessione, quando il server risponde lentamente o quando il messaggio è molto grande. Puoi riprovare.»

**Il caricamento non e riuscito.** MailCopilot ha provato a caricare il contenuto del messaggio e alla fine non lo ha ottenuto. Qui rientra di tutto: una rete caduta, una password che il server non accetta piu, un certificato inatteso, una casella che non esiste piu -- e rientra anche cio che accade *dopo* l'arrivo del messaggio, per esempio lo spazio su disco esaurito mentre lo si salva nella cache locale. MailCopilot sceglie deliberatamente di non indovinare quale di questi casi sia, perche il segnaposto sbaglierebbe piu spesso di quanto azzeccherebbe; per lo stesso motivo non da la colpa al server di posta, che nel caso del disco pieno non ha fatto nulla di sbagliato. Dove la causa *e* nota, la nomina l'elemento dell'interfaccia che puo esserne certo: l'avviso **Accedi di nuovo** sopra l'elenco dei messaggi quando le tue credenziali hanno smesso di funzionare, oppure la finestra di dialogo sulla sicurezza della connessione quando non e stato possibile fidarsi del certificato del server.

> «MailCopilot non è riuscito a caricare il contenuto di questo messaggio: vengono mostrate solo le sue intestazioni. Puoi riprovare.»

In tutti e tre i casi, sotto il segnaposto appare un pulsante **Riprova**, sia nella finestra principale sia in una finestra di messaggio separata. Clicca su di esso per tentare nuovamente di recuperare il corpo: in caso di tempo scaduto, di solito basta un secondo tentativo una volta terminato il lavoro in background. Se la modalita offline e attiva o le tue credenziali sono scadute, riprovare continuera a produrre lo stesso segnaposto finche non disattivi la modalita offline o non accedi di nuovo.

## Inviti alle riunioni

Quando un messaggio contiene un invito di calendario (un allegato `.ics` che utilizza il protocollo iTIP), MailCopilot mostra una scheda **Invito alla riunione** incorporata sopra il corpo del messaggio. Non è necessaria alcuna app di calendario esterna o servizio cloud.

La scheda mostra:

- **Titolo dell'evento** — il riepilogo della riunione.
- **Quando** — la data e l'ora di inizio. Nella maggior parte dei casi l'orario viene convertito e mostrato nel fuso orario del vostro dispositivo, indipendentemente dal fuso orario usato dall'organizzatore per inviare l'invito; se il fuso orario dell'invito è diverso dal vostro, sotto compare una didascalia che indica il fuso orario originale dell'organizzatore, così potete vedere a colpo d'occhio che è avvenuta una conversione. La conversione non è possibile in due casi, ed entrambi mostrano l'orario originale dell'organizzatore così come inviato: quando l'invito specifica un fuso orario che MailCopilot non riesce a risolvere (alcuni inviti Outlook/Exchange usano un nome di fuso orario in stile Windows anziché uno standard) — qui la didascalia compare comunque e indica di quale fuso orario si tratta; e quando l'invito non contiene alcuna informazione sul fuso orario né uno scostamento UTC esplicito — qui non c'è nulla che una didascalia possa indicare, quindi non ne compare nessuna, e l'orario mostrato sono semplicemente i numeri dell'organizzatore così come sono, senza indicazione di quale fuso orario li riguardi.
- **Organizzatore** — l'organizzatore indicato nell'invito di calendario (può differire dal mittente dell'email se l'invito è stato inviato per conto di qualcun altro).
- **Luogo** — la sala riunioni o il link alla conferenza, se indicato.

Sotto i dettagli dell'evento sono disponibili tre pulsanti di risposta: **Accetta**, **Forse** e **Rifiuta**. Facendo clic su uno di essi, MailCopilot invia un'e-mail di risposta iTIP standard all'organizzatore tramite SMTP utilizzando le credenziali del tuo account. La scheda si aggiorna per confermare la tua scelta (ad esempio, «Hai accettato questo invito»). Se la risposta non può essere inviata, viene mostrato un messaggio di errore.

I pulsanti Accetta / Forse / Rifiuta vengono visualizzati solo per gli inviti a riunione attivi (`METHOD:REQUEST`) in cui l'organizzatore non sei tu. Annullamenti, pubblicazioni di feed di calendario, risposte ed eventi organizzati da te non mostrano pulsanti RSVP — al loro posto vedrai un'etichetta «Annullato» o un avviso «Non azionabile».

### Limitazioni in questa versione

- **Nessuna integrazione con il calendario di sistema.** MailCopilot non aggiunge l'evento al calendario del sistema operativo (macOS Calendario, GNOME Calendar, ecc.). Questa funzionalità è prevista in una versione futura.
- **Eventi ricorrenti.** Le riunioni ripetute vengono mostrate come un singolo evento; il modello di ricorrenza non viene visualizzato.
- **Contro-proposte.** Non è possibile proporre un orario diverso — sono disponibili solo Accetta, Forse o Rifiuta.
- **Eventi annullati.** Quando l'organizzatore annulla una riunione, la scheda mostra «Questo evento è stato annullato» e i pulsanti di risposta vengono nascosti.

## Annulla

Nelle viste cartella di account, archiviare, segnare come spam o spostare nel cestino mostra una barra di annullamento con conto alla rovescia. Clicca su **Annulla** prima che il timer scada. Ciò che determina l'idoneità sono i messaggi che l'azione sposta effettivamente, non le cartelle da cui proveniva la selezione originale: i messaggi già presenti nella cartella di destinazione, o appartenenti a un account senza cartella per quel ruolo, vengono messi da parte e gestiti separatamente anziché spostati. La barra di annullamento copre sempre e solo una singola cartella di origine, quindi appare solo quando tutti i messaggi effettivamente spostati provengono dalla cartella attualmente aperta. Un'eliminazione può essere mista: i messaggi che vanno nel cestino ricevono una barra di annullamento se soddisfano questa condizione, mentre i messaggi già nel cestino, o appartenenti a un account senza cartella Cestino, vengono eliminati definitivamente -- MailCopilot chiede conferma prima di farlo e attende la tua risposta anziché agire immediatamente. Le azioni tra account, e qualsiasi azione i cui messaggi spostati si estendano ancora su più di una cartella di origine -- ad esempio un'azione massiva su una selezione proveniente da una ricerca **Tutte le cartelle** -- non mostrano la barra di annullamento: quella parte dell'azione avviene comunque immediatamente, cartella per cartella, semplicemente non può più essere annullata in un unico passaggio.
