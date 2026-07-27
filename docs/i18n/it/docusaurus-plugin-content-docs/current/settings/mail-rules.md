---
sidebar_position: 5
title: Regole email
---

# Regole email

Le regole email ti permettono di ordinare e organizzare automaticamente le email in arrivo in base a condizioni da te definite. Le regole vengono valutate ogni volta che arrivano nuovi messaggi.

## Creare una regola

1. Apri **Impostazioni > Regole**.
2. Clicca su **Aggiungi regola**.
3. Assegna un nome alla regola.
4. Scegli a quale account si applica la regola (oppure seleziona «Tutti gli account»).

### Condizioni

Ogni regola ha una o più condizioni. Tutte le condizioni devono corrispondere affinché la regola si attivi (logica AND). Se hai bisogno della logica OR, crea regole separate.

Campi condizione disponibili:
- **Da** — nome o indirizzo del mittente.
- **A** — indirizzo del destinatario.
- **CC** — indirizzo in copia.
- **Oggetto** — l'oggetto dell'email.
- **Ha allegato** — se l'email contiene allegati.

Operatori disponibili:
- **contiene** / **non contiene** — corrispondenza parziale.
- **è uguale a** — corrispondenza esatta.
- **inizia con** / **finisce con** — corrispondenza per prefisso o suffisso.
- **corrisponde a espressione regolare** — ricerca avanzata tramite espressioni regolari.

### Azioni

Quando una regola corrisponde, vengono eseguite una o più azioni:

- **Archivia** — sposta nella cartella Archivio.
- **Sposta nel cestino** — sposta nella cartella Cestino.
- **Sposta in cartella** — sposta in una cartella specifica a tua scelta.
- **Segna come letto** — segna automaticamente l'email come letta.
- **Contrassegna con stella** — contrassegna l'email con una stella.
- **Segna come spam** — sposta nella cartella Spam.

### Interrompi l'elaborazione

Se attivi **«Interrompi l'elaborazione delle regole successive»**, nessuna regola aggiuntiva verrà valutata dopo l'attivazione di questa. È utile quando hai una regola generica e vuoi evitare che sovrascriva regole più specifiche.

## Testare le regole

Prima di salvare una regola, clicca su **«Testa sulle email esistenti»** per vedere quali delle tue email esistenti corrispondono alle condizioni. Questo ti aiuta a verificare che la regola funzioni come previsto prima di applicarla alla nuova posta.

## Applicare alle email esistenti

Seleziona **«Applica alle email esistenti nella posta in arrivo»** quando salvi una regola per applicarla immediatamente alle email già presenti nella tua casella di posta.

## Priorità delle regole

Le regole vengono valutate in ordine di priorità (numero più basso = priorità più alta). Puoi modificare la priorità durante la modifica di una regola. Se due regole hanno la stessa priorità, vengono valutate nell'ordine di creazione.

## Regole IA

Se hai configurato un provider di IA (vedi [Assistente IA](../ai-assistant)), puoi anche creare regole basate sull'intelligenza artificiale. Le regole IA elaborano le email che non corrispondono a nessuna regola statica.

### Come funzionano le regole IA

1. Scrivi un prompt che descrive come ordinare le email (ad esempio, «Archivia le newsletter, sposta le email dei recruiter nella cartella Lavoro»).
2. Scegli quali azioni l'IA è autorizzata a eseguire.
3. Imposti un limite di budget giornaliero per controllare i costi.
4. L'IA valuta le email non elaborate in blocchi. Applica automaticamente solo le azioni reversibili (archiviare, spostare, segnare come letto, contrassegnare con stella); le azioni di cestinamento e spam vengono registrate come anteprime in sospeso che devi applicare tu stesso.

Le azioni delle regole IA vengono registrate in modo che tu possa verificare quale azione è stata applicata o proposta per ciascuna email.

### Le nuove regole IA partono disattivate

Una regola IA appena creata è **disattivata per impostazione predefinita**. Attiva **«Attivato»** sulla regola dopo aver verificato il suo prompt e le azioni consentite, per iniziare ad applicarla alla posta in arrivo. Questo evita che una regola agisca sulla tua casella di posta prima che tu abbia confermato che si comporta come previsto.

### Limite di regole attivate per account

Puoi attivare al massimo **20 regole IA per account** (le regole globali, applicate a tutti gli account, contano ai fini del limite di ciascun account). Se provi ad attivare una regola oltre questo limite, l'app mostra un messaggio e la regola resta disattivata — disattiva prima un'altra regola. Questo limite mantiene l'elaborazione in background veloce e prevedibile: tutte le regole attivate per un account vengono valutate insieme in un unico passaggio.

### Le azioni distruttive richiedono una verifica

Le azioni reversibili -- archiviare, spostare in cartella, segnare come letto, contrassegnare con stella -- vengono applicate automaticamente quando una regola IA corrisponde. **Sposta nel cestino** e **Segna come spam** non vengono mai applicate automaticamente: l'IA registra invece l'azione proposta come voce in sospeso nel registro delle azioni della regola. Per eseguire un'azione proposta di cestinamento o spam, devi aprire la voce e applicarla esplicitamente -- non viene eliminato né contrassegnato come spam nulla finché non lo fai. Questo impedisce all'IA di rimuovere definitivamente la posta dalla tua casella senza la tua conferma.

### Le regole vedono solo il proprio account

Una regola IA associata a un account specifico valuta e agisce esclusivamente sulla posta di quell'account. Non vede né influisce mai sui messaggi degli altri tuoi account.
