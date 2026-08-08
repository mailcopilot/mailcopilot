---
sidebar_position: 5
title: Regole email
---

# Regole email

Le regole email ti permettono di ordinare e organizzare automaticamente le email in arrivo in base a condizioni da te definite. Le regole vengono eseguite ogni volta che MailCopilot scarica la posta dal server, non necessariamente nell'istante in cui un messaggio vi arriva.

## Creare una regola

1. Apri **Impostazioni > Regole**.
2. Clicca su **Aggiungi regola**.
3. Assegna un nome alla regola.
4. Scegli a quale account si applica la regola (oppure seleziona «Tutti gli account»).

### Condizioni

Ogni regola ha una o più condizioni. Tutte le condizioni devono corrispondere affinché la regola si attivi (logica AND). Se hai bisogno della logica OR, crea regole separate.

Campi condizione disponibili:
- **Mittente** — confrontato con il nome visualizzato del mittente, se presente nel messaggio, e solo in sua assenza con l'indirizzo. Una regola pensata per un indirizzo può smettere di corrispondere non appena quel mittente inizia a usare un nome visualizzato: testa la regola dopo averla impostata e controlla se smette di attivarsi.
- **Destinatario** — indirizzo del destinatario.
- **Cc** — presente nell'editor delle regole, ma MailCopilot non memorizza il campo Cc per la posta in cache, quindi per una regola ogni messaggio ha il Cc vuoto. Questo fa sì che la condizione si comporti in modo imprevedibile invece di limitarsi a "non funzionare": far corrispondere un indirizzo specifico nel Cc non riesce mai, ma un operatore di esclusione come **non contiene**, o un'espressione regolare che corrisponde a una stringa vuota, corrisponde invece a **ogni** messaggio. Non usare una condizione sul Cc in una regola che sposta la posta nel cestino, la segna come spam o la sposta in un'altra cartella -- con l'operatore sbagliato può agire su tutta la tua casella di posta.
- **Oggetto** — l'oggetto dell'email.
- **Ha allegato** — se l'email contiene allegati.

Operatori disponibili:
- **contiene** / **non contiene** — corrispondenza parziale.
- **è uguale a** — corrispondenza esatta.
- **inizia con** / **finisce con** — corrispondenza per prefisso o suffisso.
- **corrisponde al regex** — ricerca avanzata tramite espressioni regolari.

### Azioni

Quando una regola corrisponde, vengono eseguite una o più azioni:

- **Archivia** — sposta nella cartella Archivio.
- **Sposta nel cestino** — sposta nella cartella Cestino.
- **Sposta nella cartella** — sposta in una cartella specifica a tua scelta.
- **Segna come letto** — segna automaticamente l'email come letta.
- **Aggiungi stella** — contrassegna l'email con una stella.
- **Segna come spam** — sposta nella cartella Spam.

### Interrompi l'elaborazione

Se attivi **«Non elaborare le regole successive»**, nessuna regola aggiuntiva verrà valutata dopo l'attivazione di questa. È utile quando hai una regola generica e vuoi evitare che sovrascriva regole più specifiche.

## Testare le regole

Prima di salvare una regola, clicca su **«Testa sulle email esistenti»** per vedere in anteprima quali delle tue email recenti nella posta in arrivo corrisponderebbero alle condizioni. L'anteprima controlla fino a 500 email nella posta in arrivo già scaricate su questo dispositivo e mostra fino a 20 corrispondenze -- è un controllo rapido, non una ricerca esaustiva in tutta la tua casella di posta. Per una regola limitata a un solo account, queste sono le tue email più recenti; per una regola valida per tutti gli account, le 500 email controllate provengono dall'insieme dei tuoi account, ma non sono necessariamente le più recenti in assoluto. Le email più vecchie e quelle non ancora scaricate su questo dispositivo non sono incluse.

## Applicare alle email esistenti

Seleziona **«Applica alle email esistenti nella posta in arrivo»** quando salvi una regola per eseguirla subito sulla posta che hai già. Questo copre fino a 1000 email nella posta in arrivo già scaricate su questo dispositivo -- per una regola limitata a un solo account, le tue email più recenti di questo tipo; per una regola valida per tutti gli account, fino a 1000 email provenienti dall'insieme dei tuoi account, non necessariamente le più recenti in assoluto. Non risale oltre nella cronologia della posta sul server e copre solo la posta in arrivo, non altre cartelle. Se un'azione fallisce, viene saltata solo quell'azione -- le altre azioni della stessa regola vengono comunque eseguite su quell'email, e il resto dell'operazione si completa comunque.

## Solo posta nuova

Le regole agiscono sulla posta nuova non appena arriva sul tuo dispositivo, indipendentemente da come vi sia arrivata -- una notifica push, una sincronizzazione periodica o una pagina con email più recenti di quelle già viste. In passato la via con cui un messaggio arrivava poteva contare, e una regola poteva non vederlo affatto; ora questa lacuna non c'è più. Tornare indietro nello scorrimento per caricare pagine più vecchie, però, non fa passare quelle email meno recenti attraverso le regole -- è intenzionale, lo stesso comportamento "nessuna scansione della cronologia" descritto più sotto, non una lacuna rimasta.

Detto questo, questa garanzia per la posta nuova non è assoluta in ogni situazione: un'email la cui azione fallisce per tre tentativi consecutivi (ad esempio per una connessione interrotta) viene abbandonata definitivamente -- MailCopilot la salta e prosegue in quella cartella, quindi un riavvio successivo non la farà riapparire. Ciò che un riavvio azzera davvero è un conteggio che non ha ancora raggiunto tre: se l'app si riavvia prima che un'email abbia fallito tre volte di fila, il conteggio riparte da zero, quindi un'azione che continua a fallire per un motivo che non si risolve può bloccare indefinitamente l'elaborazione di una cartella, senza mai raggiungere davvero quel limite di tre tentativi.

Le regole, inoltre, non esplorano mai da sole la cronologia completa di una cartella. Ogni cartella che MailCopilot già conosce all'avvio riceve subito un punto di partenza, prima ancora che avvenga qualsiasi sincronizzazione -- una cartella vuota riceve un punto di partenza pari a zero, quindi la sua primissima email viene valutata normalmente; una cartella che ha già posta in cache riceve un punto di partenza successivo a quella posta, così la posta esistente non viene ripresa, ma tutto ciò che arriva dopo sì. Una cartella che compare solo dopo quel momento di avvio -- appena creata o a cui ti sei appena iscritto -- viene gestita diversamente: non viene valutato nulla al suo interno finché MailCopilot non l'ha sincronizzata una prima volta, e conta solo la posta arrivata dopo quella prima sincronizzazione. Lo stesso nuovo inizio avviene se il server reimposta la numerazione dei messaggi di una cartella (raro, ma può accadere dopo alcune migrazioni lato server). Usa **«Applica alle email esistenti nella posta in arrivo»** (vedi sopra) se vuoi che una regola valuti anche la posta che hai già.

## Priorità delle regole

Le regole vengono valutate in ordine di priorità (numero più basso = priorità più alta). La priorità viene assegnata automaticamente alla creazione della regola -- al momento non è possibile modificarla dall'editor delle regole. Se due regole hanno la stessa priorità, quale delle due viene eseguita per prima non è definito.

## Regole IA

Se hai configurato un provider di IA (vedi [Assistente IA](../ai-assistant)), puoi anche creare regole basate sull'intelligenza artificiale. Le regole IA elaborano le email che non corrispondono a nessuna regola statica.

### Come funzionano le regole IA

1. Scrivi un prompt che descrive come ordinare le email (ad esempio, «Archivia le newsletter, sposta le email dei recruiter nella cartella Lavoro»).
2. Scegli quali azioni l'IA è autorizzata a eseguire.
3. Imposti un limite di budget giornaliero per controllare i costi.
4. L'IA valuta le email non elaborate in blocchi. Applica automaticamente solo le azioni reversibili (archiviare, spostare, segnare come letto, contrassegnare con stella); le azioni di cestinamento e spam vengono registrate come anteprime in sospeso che devi applicare tu stesso.

Le azioni delle regole IA vengono registrate in modo che tu possa verificare quale azione è stata applicata o proposta per ciascuna email.

### Le nuove regole IA partono disattivate

Una regola IA appena creata è **disattivata per impostazione predefinita**. Attiva **«Attivata»** sulla regola dopo aver verificato il suo prompt e le azioni consentite, per iniziare ad applicarla alla posta in arrivo. Questo evita che una regola agisca sulla tua casella di posta prima che tu abbia confermato che si comporta come previsto.

### Limite di regole attivate per account

Puoi attivare al massimo **20 regole IA per account** (le regole globali, applicate a tutti gli account, contano ai fini del limite di ciascun account). Se provi ad attivare una regola oltre questo limite, l'app mostra un messaggio e la regola resta disattivata — disattiva prima un'altra regola. Questo limite mantiene l'elaborazione in background veloce e prevedibile: tutte le regole attivate per un account vengono valutate insieme in un unico passaggio.

### Le azioni distruttive richiedono una verifica

Le azioni reversibili -- archiviare, spostare in cartella, segnare come letto, contrassegnare con stella -- vengono applicate automaticamente quando una regola IA corrisponde. **Sposta nel cestino** e **Segna come spam** non vengono mai applicate automaticamente: l'IA registra invece l'azione proposta come voce in sospeso nel registro delle azioni della regola. Per eseguire un'azione proposta di cestinamento o spam, devi aprire la voce e applicarla esplicitamente -- non viene eliminato né contrassegnato come spam nulla finché non lo fai. Questo impedisce all'IA di rimuovere definitivamente la posta dalla tua casella senza la tua conferma.

### Le regole vedono solo il proprio account

Una regola IA associata a un account specifico valuta e agisce esclusivamente sulla posta di quell'account. Non vede né influisce mai sui messaggi degli altri tuoi account.
