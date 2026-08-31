---
sidebar_position: 3
title: Comporre email
---

# Comporre email

## Nuovo messaggio

Clicca su **Componi** o premi **c**. Si apre in una finestra separata.

## Campi

- **Da** -- se hai piu account, scegli da quale account inviare usando il menu a discesa in alto. Se l'account selezionato ha piu di una **identita** (indirizzo «From» alternativo, per esempio un alias sullo stesso account Gmail o Outlook), subito sotto il menu dell'account compare un selettore di identita che permette di scegliere da quale identita inviare. Vedi [Identita](../settings/identities) per capire come funzionano le identita e le firme per identita.
- **A** -- inserisci l'indirizzo. Piu destinatari con **Enter**, **Tab** o **virgola**.
- **Cc / Ccn** -- clicca su **Cc/Ccn**.
- **Oggetto** e **Corpo del messaggio**.

## Completamento automatico dei contatti

Suggerimenti basati sulla corrispondenza precedente.

## Allegati

Clicca su **Allega** o trascina i file. Massimo: 25 MB per file.

## Rispondi e inoltra

Rispondi (**r**), Rispondi a tutti (**a**), Inoltra (**f**).

## Bozze

Salvataggio automatico locale e nella cartella Bozze IMAP.

## Invio

Fare clic sul pulsante **Invia** per inviare il messaggio. La finestra di composizione si chiude immediatamente mentre il messaggio viene inviato in background. In caso di errore (ad esempio, un problema di connessione), verrà visualizzata una notifica sul desktop.

Se il messaggio è stato consegnato correttamente ma MailCopilot non è riuscito a salvare una copia nella cartella Posta inviata (ad esempio, se il server IMAP non è temporaneamente disponibile), viene visualizzata una notifica: **Messaggio consegnato, ma non è stato possibile salvare una copia nella cartella Posta inviata**. Fare clic su **Chiudi** per chiuderla. Il messaggio è stato consegnato al destinatario — solo la copia sul server non è stata salvata.

## Invia e archivia {#send--archive}

Quando si risponde a un'email, il menu a discesa del pulsante **Invia** include l'opzione **Invia e archivia**. Fare clic sulla piccola freccia **▾** accanto al pulsante Invia, quindi scegliere **Invia e archivia**. Questo invia la risposta e archivia automaticamente l'email originale in un solo passaggio.

Questo è particolarmente utile per un flusso di lavoro Inbox Zero — rispondi ed elimina l'email dalla posta in arrivo senza clic aggiuntivi.

## Invio programmato

È possibile programmare l'invio di un messaggio per un momento successivo:

1. Fare clic sulla piccola freccia **▾** accanto al pulsante Invia per aprire il menu a discesa.
2. Scegliere un orario predefinito:
   - **Più tardi oggi** — il prossimo segno di mezzora.
   - **Domani mattina (09:00)**.
   - **Lunedì mattina (09:00)**.
   - **Scegli data e ora** — selezionare una data e un'ora personalizzate.
3. Il messaggio verrà messo in coda e inviato automaticamente all'ora programmata.

I messaggi programmati appaiono nella cartella **Posta in uscita**, dove è possibile modificarli, riprogrammarli, inviarli immediatamente o annullarli.

## Ritardo di invio

Attiva un ritardo (5, 10 o 30 secondi) in **Impostazioni > Produttivita**.

## Utilizzare i modelli

I modelli ti permettono di inserire rapidamente messaggi predefiniti nella finestra di composizione, risparmiando tempo per le email che invii frequentemente.

### Applicare un modello

1. Apri la finestra di composizione.
2. Clicca sul pulsante **Modelli** (icona a griglia) nella barra degli strumenti.
3. Seleziona un modello dall'elenco a discesa.
4. L'oggetto e il corpo del modello vengono inseriti nella finestra di composizione.

### Variabili dei modelli

I modelli possono includere variabili che vengono sostituite automaticamente quando il modello viene applicato:

- `{name}` -- il nome del destinatario (se disponibile).
- `{email}` -- l'indirizzo email del destinatario.
- `{date}` -- la data odierna.

Ad esempio, un corpo del modello come "Gentile `{name}`, ..." sostituira `{name}` con il nome effettivo del destinatario.

Per creare e gestire i modelli, vai su **Impostazioni > Modelli**. Consulta la pagina [Impostazioni Modelli](../settings/templates) per i dettagli.

## Azioni rapide nella composizione

Sopra il corpo del messaggio appare una piccola barra degli strumenti IA con quattro pulsanti: **Migliora**, **Accorcia**, **Formale** e **Correggi grammatica**. Fai clic su uno di essi per far riscrivere all'IA il testo che hai scritto tu stesso -- il messaggio citato a cui stai rispondendo, qualsiasi intestazione di inoltro e la tua firma restano intatti, per risposte, inoltri e firme prodotti da MailCopilot stesso, e per le convenzioni di citazione diffuse degli altri client di posta. **Una bozza composta in un altro programma di posta può citare in uno stile che MailCopilot non riconosce -- su una bozza simile non viene trovato alcun confine, l'intero corpo conta come il tuo testo, e la citazione viene riscritta insieme ad esso.** Vedi l'elenco completo degli stili di citazione riconosciuti e non riconosciuti in [Azioni rapide nella composizione](../ai-assistant#azioni-rapide-nella-composizione).

MailCopilot mostra un pannello "Rivedi la riscrittura IA": il tuo testo e la riscrittura appaiono insieme come un unico passaggio scorrevole, con le modifiche evidenziate direttamente nel testo -- parole rimosse barrate, parole aggiunte evidenziate -- seguite da un elenco delle singole modifiche; copie in solo testo **Prima** / **Dopo** restano disponibili espandendo **Testo semplice**. Scegli **Sostituisci** per sostituire il tuo testo con la riscrittura (il messaggio citato e la firma sottostante restano invariati, se è stato trovato un confine -- vedi sopra), **Inserisci al cursore** per inserirla nella posizione attuale del cursore, oppure **Annulla** per scartare la riscrittura e lasciare la bozza invariata. Il corpo del messaggio viene modificato solo se scegli **Sostituisci** o **Inserisci al cursore** -- **Annulla** lascia la bozza invariata.

Le Azioni rapide richiedono un provider IA configurato (vedi [Assistente IA](../ai-assistant)) e testo scritto da te, sopra a qualsiasi citazione, da riscrivere. Vedi [Azioni rapide nella composizione](../ai-assistant#azioni-rapide-nella-composizione) per il comportamento completo e i dettagli sulla privacy.

## Traduzione della bozza

Se la [traduzione della bozza](../ai-assistant#traduzione-della-bozza) è abilitata per questo account, accanto alla barra degli strumenti IA sopra compaiono un elenco **Traduci la bozza in** e un pulsante **Traduci**. Scegli una lingua di destinazione -- oppure mantieni il suggerimento che MailCopilot potrebbe aver precompilato quando rispondi, la lingua rilevata del messaggio a cui stai rispondendo -- e fai clic su **Traduci**. Il risultato appare nello stesso pannello "Rivedi la riscrittura IA" usato sopra, con **Sostituisci**, **Inserisci al cursore** e **Annulla**; nulla viene inserito nella tua bozza da solo. Viene tradotto solo il testo che hai scritto tu stesso -- il messaggio citato, l'intestazione di inoltro e la firma restano intatti, quando viene trovato un confine: qui si usa lo stesso rilevamento delle azioni rapide sopra, quindi una bozza composta in un altro programma di posta con uno stile di citazione non riconosciuto non presenta alcun confine e viene tradotta per intero, citazione compresa. La traduzione della bozza condivide la stessa impostazione dell'account usata dalla traduzione del messaggio lato lettura; non c'è nulla di aggiuntivo da attivare. Vedi [Traduzione della bozza](../ai-assistant#traduzione-della-bozza) per il comportamento completo e i dettagli sulla privacy.

## Avviso destinatari errati

MailCopilot aiuta a evitare l'invio accidentale di email alle persone sbagliate. Prima dell'invio, controlla l'elenco dei destinatari e avvisa in due situazioni:

- **Dominio esterno** -- se la maggior parte dei destinatari condivide un dominio (ad es. @azienda.com) e hai aggiunto qualcuno da un dominio diverso e non attendibile, appare una finestra di conferma.
- **Nuovi destinatari nella risposta** -- quando rispondi, se hai aggiunto destinatari che non facevano parte della conversazione originale, viene mostrato un avviso.

Puoi aggiungere domini attendibili (che non devono attivare avvisi) in **Impostazioni > Produttività > Domini attendibili**.

## Firma

Se l'identita attiva (l'identita predefinita, salvo che ne abbia scelta un'altra) ha una firma configurata in **Impostazioni > Firme** o **Impostazioni > Identities**, viene aggiunta automaticamente ai nuovi messaggi. La firma non viene aggiunta a risposte e inoltri.

## Promemoria di follow-up

I promemoria di follow-up ti aiutano a tenere traccia delle email che richiedono una risposta. Se invii un messaggio importante e non ricevi risposta, MailCopilot te lo ricorderà.

### Impostare un promemoria

1. Nella finestra di composizione, seleziona la casella **"Ricorda se nessuna risposta"** nella parte inferiore.
2. Scegli un periodo di promemoria: **2 giorni**, **3 giorni** o **7 giorni**.
3. Invia il messaggio come al solito.

Se non viene ricevuta alcuna risposta entro il periodo scelto, riceverai una notifica sul desktop che ti ricorda di fare follow-up.

### La cartella Follow-up

I follow-up in attesa appaiono nella cartella **Follow-up** nella barra laterale (icona dell'orologio con segno di spunta). Il badge della cartella mostra il numero di promemoria attivi.

Ogni follow-up mostra:
- L'indirizzo del destinatario.
- L'oggetto del messaggio originale.
- Da quanto tempo il promemoria è scaduto.

### Eliminare un promemoria

Quando non hai più bisogno di un promemoria (ad esempio, la persona ha risposto al di fuori dell'email), clicca sul pulsante **Elimina** accanto al follow-up per rimuoverlo.
