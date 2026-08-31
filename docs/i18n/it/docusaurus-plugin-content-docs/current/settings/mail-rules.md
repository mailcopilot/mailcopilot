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
- **Mittente — indirizzo** — confrontato solo con l'indirizzo email del mittente. Se una regola che sposta, archivia, elimina la posta o la segna come spam filtra sul mittente, questo è l'unico campo mittente che MailCopilot le consente di usare -- vedi sotto.
- **Mittente — nome visualizzato** — confrontato solo con il nome visualizzato del mittente, il testo libero che compare accanto all'indirizzo (ad esempio «Mario Rossi» in `Mario Rossi <mario@example.com>`). Limite noto: se il nome visualizzato salvato di un mittente è testualmente identico al suo stesso indirizzo, MailCopilot considera quel mittente come privo di nome visualizzato, e questa condizione non corrisponderà -- per quel mittente confronta invece con **Mittente — indirizzo**. MailCopilot non permette a questo campo di condizionare una regola che sposta, archivia, elimina la posta o la segna come spam -- vedi sotto.
- **Mittente — nome o indirizzo (obsoleto)** — il campo combinato originale: corrisponde se corrisponde *o* il nome visualizzato *o* l'indirizzo (**non contiene** è l'eccezione -- vedi sotto). Il suo comportamento di corrispondenza è cambiato quando il campo sopra è stato diviso in **Mittente — indirizzo** e **Mittente — nome visualizzato**: prima confrontava un unico valore -- il nome visualizzato, ricorrendo all'indirizzo solo quando il mittente non aveva un nome visualizzato impostato -- quindi una regola su questo campo non corrispondeva mai per indirizzo a un mittente con una firma. Ora confronta sempre entrambi i valori insieme, quindi una regola già configurata su questo campo può iniziare a corrispondere a messaggi a cui prima non corrispondeva (e, per **non contiene**, può smettere di escludere messaggi che prima escludeva). Se hai regole esistenti su questo campo, controlla a cosa corrispondono ora, in particolare quelle che spostano, eliminano o segnano la posta come spam. Non viene più proposto per le nuove condizioni -- vedi «Campo obsoleto» qui sotto. **Non contiene** su questo campo è l'eccezione: poiché significa "non deve corrispondere a nessuno dei due", richiede che il testo sia assente sia dal nome visualizzato sia dall'indirizzo. Ad esempio, una regola «non contiene example.com» non corrisponderà a un messaggio il cui nome visualizzato include quel testo, anche se l'indirizzo non lo include.
- **Destinatario** — indirizzo del destinatario.
- **Cc** — non è più proposto quando aggiungi una nuova condizione. MailCopilot non memorizza il campo Cc per la posta in cache, quindi una condizione su di esso non poteva mai essere verificata davvero, e a seconda dell'operatore si comportava in modo imprevedibile invece di limitarsi a "non funzionare": far corrispondere un indirizzo specifico nel Cc non riusciva mai, ma un operatore di esclusione come **non contiene**, o un'espressione regolare che corrisponde a una stringa vuota, corrispondeva invece a **ogni** messaggio -- una regola pensata per intercettare una manciata di messaggi poteva svuotare un'intera casella di posta. Se una regola configurata prima di questa modifica contiene ancora una condizione sul Cc, continua a comparire nell'editor delle regole con un avviso che la condizione non può mai essere soddisfatta, quindi la regola non corrisponde più a nulla e non viene più eseguita -- ma la regola stessa resta nel tuo elenco, invariata, finché non la apri per modificarla, e l'elenco delle regole stesso la segnala con l'etichetta **«Non applicata»**, così non serve aprirla per accorgersene (vedi «Regole segnalate come non applicate» più sotto). Aprirla nell'editor e salvarla viene rifiutato, così come attivare **«Applica alle email esistenti nella posta in arrivo»** per essa, finché non rimuovi la condizione sul Cc o non la sostituisci con un campo supportato. Non resti comunque bloccato: la casella accanto alla regola nell'elenco continua ad attivarla o disattivarla, ed eliminarla dall'elenco funziona sempre.
- **Oggetto** — l'oggetto dell'email.
- **Ha allegato** — se l'email contiene allegati.

Operatori disponibili:
- **contiene** / **non contiene** — corrispondenza parziale.
- **è uguale a** — corrispondenza esatta.
- **inizia con** / **finisce con** — corrispondenza per prefisso o suffisso.
- **corrisponde al regex** — ricerca avanzata tramite espressioni regolari.

### Il nome visualizzato può essere falsificato

Un mittente controlla completamente il proprio nome visualizzato -- è testo libero che imposta lui stesso, non qualcosa che il server di posta verifica. Questo significa che un mittente può impostare il proprio nome visualizzato in modo che si legga esattamente come un indirizzo, ad esempio `user@example.com`, indipendentemente da quale indirizzo indichi davvero l'intestazione `From:` del messaggio. Una regola come «Mittente — nome visualizzato è uguale a user@example.com» corrisponde a quel nome visualizzato di per sé, indipendentemente dall'indirizzo -- e lo stesso vale per la stessa condizione su **Mittente — nome o indirizzo (obsoleto)**, perché anche quel campo controlla il nome visualizzato.

L'indirizzo e il nome visualizzato vengono memorizzati e confrontati separatamente, quindi il testo che un mittente scrive nel nome visualizzato non viene mai letto come un indirizzo -- ma questo non rende l'indirizzo di per sé affidabile: il mittente scrive l'intera intestazione `From:`, indirizzo compreso, quindi è altrettanto falsificabile (vedi sotto). Ciò che offre questa separazione è più limitato: se una regola che sposta, archivia, elimina la posta o la segna come spam filtra sul mittente, e quel filtro è su **Mittente — nome visualizzato** o sul campo obsoleto, MailCopilot la rifiuta -- una regola che combina uno di questi campi con **Sposta nel cestino**, **Segna come spam**, **Archivia** o **Sposta nella cartella** non può essere salvata. Si tratta solo di quale campo usa una condizione sul *mittente*; una regola che esegue una di queste azioni senza filtrare affatto sul mittente -- per oggetto, destinatario o presenza di allegato, ad esempio -- non ne è interessata. Se una regola già esistente ha già questa combinazione -- risalente a prima di questa restrizione --, aprirla nell'editor e salvarla viene rifiutato, così come eseguire **«Applica alle email esistenti nella posta in arrivo»** su di essa; il messaggio indica il campo e l'azione che hanno causato il rifiuto e ti rimanda invece a **Mittente — indirizzo**. Finché non lo correggi, anche quella regola smette di corrispondere alla posta nuova -- ma non silenziosamente: l'elenco delle regole la segnala con l'etichetta **«Non applicata»**, così non serve aprirla per accorgersene (vedi «Regole segnalate come non applicate» più sotto). **Non resti comunque bloccato: la casella accanto alla regola nell'elenco continua ad attivarla o disattivarla, indipendentemente dal rifiuto -- è il modo più rapido per fermare una regola che altrimenti non puoi salvare.** Anche eliminare la regola dall'elenco funziona sempre. La restrizione in sé non riguarda **Segna come letto** e **Aggiungi stella**: nessuna delle due può distruggere o nascondere posta, quindi un mittente falsificato che attiva una di queste azioni non ti costa nulla di irreversibile, ed entrambi i campi possono ancora condizionarle.

Vale la pena essere precisi su cosa dimostra e cosa non dimostra **Mittente — indirizzo**, dato che è il campo verso cui rimanda questa restrizione: non è una garanzia che il messaggio provenga davvero da quell'indirizzo. Viene letto direttamente dall'intestazione `From:` del messaggio, e MailCopilot non verifica quell'intestazione in modo crittografico -- controllarla rispetto alle firme DKIM o DMARC è un lavoro a parte, non ancora implementato -- quindi un messaggio può comunque dichiarare qualsiasi indirizzo in quel campo, con la stessa libertà di qualsiasi nome visualizzato. Ciò che la corrispondenza su questo campo ti offre è più limitato ma reale: poiché l'indirizzo e il nome visualizzato sono campi distinti, un nome visualizzato che un mittente ha scritto per somigliare a un indirizzo non viene mai confrontato come tale, quindi un nome visualizzato falsificato può soddisfare una condizione su **Mittente — nome visualizzato**, ma non può, da solo, soddisfare una condizione su **Mittente — indirizzo**. Considera una corrispondenza su **Mittente — indirizzo** come «questo indirizzo è stato dichiarato nel messaggio», non come un'identità verificata.

### Campo obsoleto

**Mittente — nome o indirizzo (obsoleto)** è il campo «Mittente» originale, non diviso, mantenuto per le regole già configurate su di esso prima della divisione descritta sopra. Puoi ancora aprire e modificare una regola che lo usa, ma il suo comportamento di corrispondenza è cambiato da allora -- vedi la nota in «Condizioni» sopra -- quindi vale la pena controllare a cosa corrisponde ora una regola esistente su questo campo, in particolare quelle che spostano, eliminano, archiviano la posta o la segnano come spam (perché quella combinazione viene rifiutata -- vedi «Il nome visualizzato può essere falsificato» sopra).

Il punto importante è una porta a senso unico nell'editor delle regole: il campo obsoleto compare nel menu a tendina dei campi condizione solo finché una condizione è ancora impostata su di esso. Non appena passi quella condizione a un altro campo (anche passando e poi tornando indietro), l'opzione obsoleta scompare dal menu e non c'è più modo di selezionarla di nuovo tramite l'interfaccia -- dovresti invece ricreare la condizione su **Mittente — indirizzo** o **Mittente — nome visualizzato**. Decidi prima di passare, non dopo.

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

## Regole segnalate come non applicate

Se le condizioni o le azioni di una regola non possono giustificare in modo affidabile ciò che la regola fa, MailCopilot si rifiuta di eseguirla -- e lo segnala nell'elenco delle regole invece di lasciarla inerte in silenzio. L'etichetta compare al posto del riepilogo abituale "N condizioni, M azioni" per quella regola, sia essa attivata o disattivata, così non serve aprire una regola per scoprire che in realtà non è in esecuzione.

- **«Non applicabile»** -- la regola stessa non può essere letta: ad alcune delle sue condizioni o azioni mancano parti di cui MailCopilot ha bisogno per eseguirla, il più delle volte perché ciò che l'ha creata (ad esempio un assistente IA a cui è stato chiesto di configurare una regola) non l'ha scritta correttamente fino in fondo. Aprire la regola mostra lo stesso messaggio, e i suoi elenchi di condizioni e azioni risultano vuoti nell'editor -- non c'è nulla da correggere, solo da ricostruire da zero.
- **«Non applicata»** -- la regola è leggibile, ma MailCopilot non può giustificarne l'esecuzione così com'è scritta. Questo copre le due situazioni descritte sopra: una condizione che corrisponde a un campo che MailCopilot non memorizza per la posta in cache (come il **Cc**), che non può mai essere davvero verificato; oppure un'azione distruttiva -- **Sposta nel cestino**, **Segna come spam**, **Archivia** o **Sposta nella cartella** -- condizionata dal nome visualizzato del mittente (**Mittente — nome visualizzato** o il campo obsoleto **Mittente — nome o indirizzo**), che il mittente può impostare a piacere, quindi non può giustificare l'azione (vedi «Il nome visualizzato può essere falsificato» sopra).

Se una regola rientra in entrambi i verdetti, **«Non applicabile»** ha la precedenza -- le etichette non compaiono mai insieme; viene mostrata solo la dicitura di regola illeggibile.

Passando il mouse su una delle due etichette, un suggerimento mostra in una riga il motivo del rifiuto; raggiungendo l'etichetta da tastiera quel suggerimento non compare. Per **«Non applicata»** il motivo fa parte anche di ciò che uno screen reader annuncia per l'etichetta, e l'etichetta stessa è un pulsante: cliccandoci sopra si apre la regola nell'editor, così puoi correggere la condizione o l'azione che lo causa. **«Non applicabile»** è solo una dicitura, non un pulsante: nell'editor non c'è nulla da indicarti, quindi apri quella regola con il pulsante di modifica (matita) sulla sua riga. Una regola in uno di questi due stati resta invariata nel tuo elenco finché non la correggi -- la casella accanto continua ad attivarla o disattivarla, ed eliminarla dall'elenco funziona sempre, ma la regola stessa non fa nulla finché è segnalata in questo modo.

## Testare le regole

Prima di salvare una regola, clicca su **«Testa sulle email esistenti»** per vedere in anteprima quali delle tue email recenti nella posta in arrivo corrisponderebbero alle condizioni. L'anteprima controlla fino a 500 email nella posta in arrivo già scaricate su questo dispositivo e mostra fino a 20 corrispondenze -- è un controllo rapido, non una ricerca esaustiva in tutta la tua casella di posta. Per una regola limitata a un solo account, queste sono le tue email più recenti; per una regola valida per tutti gli account, le 500 email controllate provengono dall'insieme dei tuoi account, ma non sono necessariamente le più recenti in assoluto. Le email più vecchie e quelle non ancora scaricate su questo dispositivo non sono incluse.

## Applicare alle email esistenti

Seleziona **«Applica alle email esistenti nella posta in arrivo»** quando salvi una regola per eseguirla subito sulla posta che hai già. Questo copre fino a 1000 email nella posta in arrivo già scaricate su questo dispositivo -- per una regola limitata a un solo account, le tue email più recenti di questo tipo; per una regola valida per tutti gli account, fino a 1000 email provenienti dall'insieme dei tuoi account, non necessariamente le più recenti in assoluto. Non risale oltre nella cronologia della posta sul server e copre solo la posta in arrivo, non altre cartelle. Se un'azione fallisce, viene saltata solo quell'azione -- le altre azioni della stessa regola vengono comunque eseguite su quell'email, e il resto dell'operazione si completa comunque. Una regola con una condizione che MailCopilot non può verificare, o in cui il nome visualizzato (o il campo obsoleto) condiziona un'azione di spostamento o distruttiva, viene rifiutata anche qui -- vedi «Condizioni» sopra.

## Solo posta nuova

Le regole agiscono sulla posta nuova non appena arriva sul tuo dispositivo, indipendentemente da come vi sia arrivata -- una notifica push, una sincronizzazione periodica o una pagina con email più recenti di quelle già viste. In passato la via con cui un messaggio arrivava poteva contare, e una regola poteva non vederlo affatto; ora questa lacuna non c'è più. Tornare indietro nello scorrimento per caricare pagine più vecchie, però, non fa passare quelle email meno recenti attraverso le regole -- è intenzionale, lo stesso comportamento "nessuna scansione della cronologia" descritto più sotto, non una lacuna rimasta.

Detto questo, questa garanzia per la posta nuova non è assoluta in ogni situazione: un'email la cui azione fallisce per tre tentativi consecutivi (ad esempio per una connessione interrotta) viene abbandonata definitivamente -- MailCopilot la salta e prosegue in quella cartella, quindi un riavvio successivo non la farà riapparire. Ciò che un riavvio azzera davvero è un conteggio che non ha ancora raggiunto tre: se l'app si riavvia prima che un'email abbia fallito tre volte di fila, il conteggio riparte da zero, quindi un'azione che continua a fallire per un motivo che non si risolve può bloccare indefinitamente l'elaborazione di una cartella, senza mai raggiungere davvero quel limite di tre tentativi.

Le regole, inoltre, non esplorano mai da sole la cronologia completa di una cartella. Ogni cartella che MailCopilot già conosce all'avvio riceve subito un punto di partenza, prima ancora che avvenga qualsiasi sincronizzazione -- una cartella vuota riceve un punto di partenza pari a zero, quindi la sua primissima email viene valutata normalmente; una cartella che ha già posta in cache riceve un punto di partenza successivo a quella posta, così la posta esistente non viene ripresa, ma tutto ciò che arriva dopo sì. Una cartella che compare solo dopo quel momento di avvio -- appena creata o a cui ti sei appena iscritto -- viene gestita diversamente: non viene valutato nulla al suo interno finché MailCopilot non l'ha sincronizzata una prima volta, e conta solo la posta arrivata dopo quella prima sincronizzazione. Lo stesso nuovo inizio avviene se il server reimposta la numerazione dei messaggi di una cartella (raro, ma può accadere dopo alcune migrazioni lato server). Usa **«Applica alle email esistenti nella posta in arrivo»** (vedi sopra) se vuoi che una regola valuti anche la posta che hai già.

## Priorità delle regole

Le regole vengono valutate in ordine di priorità (numero più basso = priorità più alta). La priorità viene assegnata automaticamente alla creazione della regola -- al momento non è possibile modificarla dall'editor delle regole. Se due regole hanno la stessa priorità, quale delle due viene eseguita per prima non è definito.

## Regole IA

Se hai configurato un provider di IA (vedi [Assistente IA](../ai-assistant)), puoi anche creare regole basate sull'intelligenza artificiale. Le regole IA elaborano le email che non corrispondono a nessuna regola statica.

Questo è diverso dal chiedere all'assistente, in chat, di creare o modificare una regola per te. In quel caso l'assistente crea o modifica una regola **statica** -- quella descritta sopra, con le proprie condizioni e azioni -- e tutte le restrizioni descritte sopra le si applicano per intero: non può creare una condizione sul Cc, perché MailCopilot non lo memorizza; non può condizionare una regola che sposta, cestina, archivia o segna la posta come spam sul nome visualizzato del mittente, ma solo su **Mittente — indirizzo**; e se restituisce una regola che MailCopilot non può applicare per qualche altro motivo, la regola non viene salvata -- chiedigli di riprovare, oppure crea tu stesso la regola nell'editor. Una **regola IA**, di cui tratta il resto di questa sezione, è tutt'altra cosa: invece delle condizioni ha un prompt che descrive con parole tue cosa vuoi, più un elenco di azioni che permetti all'IA di eseguire.

### Come funzionano le regole IA

1. Scrivi un prompt che descrive come ordinare le email (ad esempio, «Archivia le newsletter, sposta le email dei recruiter nella cartella Lavoro»).
2. Scegli quali azioni l'IA è autorizzata a eseguire.
3. Imposti un limite di budget giornaliero per controllare i costi.
4. L'IA valuta le email non elaborate in blocchi. Applica automaticamente le azioni reversibili (archiviare, spostare, segnare come letto, contrassegnare con stella); per **Sposta nel cestino** o **Segna come spam**, non tocca affatto l'email -- registra invece l'azione proposta come voce nel registro.

Le azioni delle regole IA vengono registrate in modo che tu possa verificare quale azione è stata applicata o proposta per ciascuna email.

Una regola IA non ha condizioni da limitare, quindi le regole su Cc e indirizzo del mittente descritte sopra per le regole statiche semplicemente non le riguardano -- non c'è nulla che somigli a una condizione a cui potrebbero applicarsi. La sua protezione funziona diversamente: sei tu a scegliere quali azioni può compiere in assoluto (vedi sotto); tra queste, tutte si applicano automaticamente tranne **Sposta nel cestino** e **Segna come spam** -- vedi «Le azioni distruttive richiedono una verifica» più sotto per cosa succede con queste due.

### Le nuove regole IA partono disattivate

Una regola IA appena creata è **disattivata per impostazione predefinita**. Attiva **«Attivata»** sulla regola dopo aver verificato il suo prompt e le azioni consentite, per iniziare ad applicarla alla posta in arrivo. Questo evita che una regola agisca sulla tua casella di posta prima che tu abbia confermato che si comporta come previsto.

### Limite di regole attivate per account

Puoi attivare al massimo **20 regole IA per account** (le regole globali, applicate a tutti gli account, contano ai fini del limite di ciascun account). Se provi ad attivare una regola oltre questo limite, l'app mostra un messaggio e la regola resta disattivata — disattiva prima un'altra regola. Questo limite mantiene l'elaborazione in background veloce e prevedibile: tutte le regole attivate per un account vengono valutate insieme in un unico passaggio.

### Le azioni distruttive richiedono una verifica

Le azioni reversibili -- archiviare, spostare in cartella, segnare come letto, contrassegnare con stella -- vengono applicate automaticamente quando una regola IA corrisponde. **Sposta nel cestino** e **Segna come spam** non vengono mai applicate automaticamente: l'email non viene toccata, e l'IA registra invece l'azione proposta come voce nel registro delle azioni della regola, così nulla viene eliminato o contrassegnato come spam solo per decisione di una regola IA. Non c'è un pulsante per eseguire una proposta registrata -- se sei d'accordo, agisci tu stesso su quell'email nel modo consueto (dalla lista dei messaggi o dal suo menu contestuale).

### Le regole vedono solo il proprio account

Una regola IA associata a un account specifico valuta e agisce esclusivamente sulla posta di quell'account. Non vede né influisce mai sui messaggi degli altri tuoi account.
