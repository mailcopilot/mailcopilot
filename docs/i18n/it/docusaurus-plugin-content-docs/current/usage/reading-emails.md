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

### Vista del thread — pila di schede

I thread con due o più messaggi vengono visualizzati come una pila verticale di schede. Per impostazione predefinita, le schede sono ordinate **dal più recente al più vecchio**. Il messaggio più recente — l'ultimo ricevuto — è la scheda attiva espansa; i messaggi più vecchi sono compressi sotto di essa.

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
- **Elimina thread** -- sposta l'intero thread nel Cestino se l'account dispone di una cartella Cestino. Se il thread si trova già nel Cestino, o l'account non ha una cartella Cestino, MailCopilot chiede conferma prima dell'eliminazione definitiva.
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

Se il budget IA giornaliero e stato raggiunto, non e configurato alcun provider IA (questo include anche un **abbonamento Claude** configurato, che non e supportato per il Riepilogo IA del thread), o il provider restituisce un errore temporaneo, la barra mostra un messaggio esplicativo al posto del riepilogo. Compare un pulsante **Riprova** quando l'errore era un problema temporaneo del provider.

### Risposta immediata

Quando la Risposta immediata e abilitata per l'account, sulla scheda del messaggio attivamente aperta appare un pulsante **Risposta immediata**. Fai clic per far redigere all'IA due o tre brevi opzioni di risposta basate sul contenuto del messaggio.

Fai clic su un'opzione per aprirla in una **nuova finestra di composizione**, precompilata con quel testo -- nulla viene inviato automaticamente, continui a rivedere e inviare il messaggio tu stesso.

La Risposta immediata e **disattivata per impostazione predefinita** e va abilitata **per ciascun account** in **Impostazioni > IA > Risposta immediata**. Vedi [Assistente IA](../ai-assistant#risposta-immediata) per come abilitarla e cosa viene inviato al tuo provider IA.

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

Rispondi (**r**), Rispondi a tutti (**a**), Inoltra (**f**), Stella (**s**), Elimina (**#**), Archivia (**e**), Spam (**!**), Letto/Non letto (**Shift+I**/**Shift+U**), Sposta (**v**), Posticipa -- nascondi temporaneamente il messaggio e fallo riapparire in un secondo momento. Vedi sotto per i dettagli.
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

## Quando un messaggio non puo essere caricato

Se MailCopilot non riesce a recuperare il corpo del messaggio -- ad esempio perche la connessione al server IMAP e scaduta (dopo 10 secondi) -- mostra un segnaposto invece di una schermata vuota:

> «Il corpo del messaggio non e disponibile offline. Sono memorizzate nella cache solo le intestazioni.»

Sotto il messaggio appare un pulsante **Riprova**. Clicca su di esso per tentare nuovamente di recuperare il corpo. Se la connessione e stata ripristinata, il messaggio verra caricato normalmente.

## Inviti alle riunioni

Quando un messaggio contiene un invito di calendario (un allegato `.ics` che utilizza il protocollo iTIP), MailCopilot mostra una scheda **Invito alla riunione** incorporata sopra il corpo del messaggio. Non è necessaria alcuna app di calendario esterna o servizio cloud.

La scheda mostra:

- **Titolo dell'evento** — il riepilogo della riunione.
- **Quando** — la data e l'ora di inizio.
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

Nelle viste cartella di account, archiviare, segnare come spam o spostare nel cestino mostra una barra di annullamento con conto alla rovescia. Clicca su **Annulla** prima che il timer scada. Le eliminazioni definitive e alcune azioni nella posta unificata o tra account non mostrano la barra di annullamento.
