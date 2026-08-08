---
sidebar_position: 1
title: Panoramica dell'interfaccia
---

# Panoramica dell'interfaccia

MailCopilot ha un layout pulito a tre colonne.

## Barra laterale

A sinistra: selettore account, elenco cartelle con badge dei non letti, pulsanti Componi, Sincronizza e Impostazioni, posta in arrivo unificata.

- **Lavora offline** — attiva e disattiva la modalità offline. Quando attivata, MailCopilot interrompe tutte le attività di rete e lavora esclusivamente con i dati memorizzati nella cache. È possibile leggere le email precedentemente sincronizzate, contrassegnarle come lette o importanti e sfogliare le cartelle. Le modifiche effettuate offline verranno sincronizzate al ritorno online. L'icona del pulsante alterna tra Wi-Fi (online) e Wi-Fi barrato (offline).

**Inbox Zero** -- quando elabori le email (archiviare, eliminare, posticipare, segnalare come spam o spostare in una cartella) e la tua casella di posta diventa vuota, nell'area dell'elenco messaggi appare un messaggio di congratulazioni «Inbox Zero!» insieme al numero di email elaborate oggi. Il contatore si azzera automaticamente a mezzanotte e al riavvio dell'applicazione.

Puo essere compressa in modalita solo icone. Le icone compresse mostrano suggerimenti.

## Elenco messaggi

Colonna centrale: mittente, oggetto, data, indicatori di non letto, stella, allegati e conteggio thread.

In modalita **Posta in arrivo unificata**, l'indirizzo e-mail dell'account viene mostrato accanto al nome del mittente per identificare quale account ha ricevuto il messaggio.

Usa i pulsanti filtro per visualizzare i messaggi Non letti, Con allegati o Con stella. Clicca su un pulsante per attivare il filtro, clicca di nuovo per disattivarlo. Selezionare un altro pulsante sostituisce il filtro attivo.

Per cambiare l'ordine di ordinamento (data, mittente, oggetto), vai su **Impostazioni > Produttivita > Sort emails by**.

### Menu contestuale dei messaggi

Fai clic destro su qualsiasi messaggio dell'elenco per aprire il menu contestuale. Da qui puoi eseguire rapidamente:

- **Posticipare** il messaggio
- **Archiviare**
- **Eliminare**
- **Segna come letto / non letto**
- Altre azioni: **Leggi piu tardi**, **Fissa**, **Sposta in cartella**, **Segna come spam**, **Rispondi**, **Rispondi a tutti**, **Inoltra**

Quando sono selezionati piu messaggi, il menu contestuale consente di segnare letto/non letto, spostare, segnare come spam, archiviare o eliminare tutti contemporaneamente. Leggi piu tardi e Fissa si applicano sempre solo al messaggio su cui e stato aperto il menu. Posticipa si applica all'intero thread quando il raggruppamento per conversazione e attivo, altrimenti solo al messaggio. Rispondi, Rispondi a tutti e Inoltra sono nascosti nella modalita di selezione multipla.

### Selezione messaggi e barra delle azioni

- Clicca su un messaggio per selezionarlo e leggerlo.
- Tieni premuto **Shift** e clicca per selezionare un intervallo.
- Premi **x** per alternare la selezione.
- Una barra delle azioni e sempre visibile sopra l'elenco messaggi. Quando selezioni uno o piu messaggi, i pulsanti diventano attivi: segnare letto/non letto, segnare come spam, archiviare, eliminare e spostare. Lo spostamento e disabilitato nella posta in arrivo unificata. La barra funziona in tutte le altre modalita.

## Pannello di lettura

Colonna destra: intestazioni, corpo del messaggio, allegati e pulsanti di azione (rispondi, inoltra, elimina, archivia, posticipa, ecc.). In modalita thread, la barra degli strumenti diventa consapevole del thread: Rispondi/Inoltra si riferiscono al messaggio piu recente, Archivia ed Elimina agiscono sull'intero thread. Vedi [Leggere le email](./reading-emails#azioni-sul-thread) per i dettagli.

## Colonne ridimensionabili

Trascina il bordo tra le colonne. La tua preferenza viene salvata tra le sessioni.

## Selezione e modifica del testo

Fai clic destro in qualsiasi campo di testo -- la barra di ricerca, un messaggio che stai componendo, il campo del prompt dell'assistente IA o qualsiasi altra casella modificabile -- per aprire un piccolo menu contestuale con **Taglia**, **Copia**, **Incolla** e **Seleziona tutto**. Il clic destro su testo selezionato e non modificabile (per esempio un passaggio evidenziato nel corpo di un messaggio) offre solo **Copia**.

Il clic destro su un link nel corpo di un messaggio apre un menu diverso con opzioni per aprire o copiare il link; vedi [Clic destro su un link](./reading-emails#clic-destro-su-un-link).

## Barra di stato

Una barra di stato persistente attraversa la parte inferiore della finestra, simile a quella di VS Code. Mostra l'attivita in background che prima era visibile solo dentro il pannello di ricerca:

- **Indicatore di sincronizzazione**: appare quando una cartella e in fase di sincronizzazione con il server IMAP, includendo l'account, il nome della cartella, il numero corrente di messaggi e una percentuale dove applicabile.
- **Copertura intestazioni**: quante cartelle hanno completato la sincronizzazione iniziale delle intestazioni (per esempio, «Intestazioni: 5/8 cartelle»).
- **Avanzamento dell'indicizzazione dei corpi**: la percentuale dei messaggi in cache il cui corpo e stato indicizzato per la ricerca full-text.
- **Badge dei risultati remoti**: quando una ricerca restituisce ulteriori corrispondenze dal server oltre alla cache locale, qui appare un badge «+N dal server».

La barra di stato resta visibile finche e in corso del lavoro di sincronizzazione o di indicizzazione, non solo durante una ricerca. Quando non c'e nulla da segnalare, si chiude automaticamente. Il contenuto si aggiorna in background circa ogni 30 secondi. La barra viene nascosta in fase di stampa.

## Centro notifiche

Un'icona a forma di campanella nell'intestazione della lista dei messaggi apre il centro notifiche. Raccoglie due tipi di notifiche:

- **Promemoria di follow-up**: quando scade un follow-up impostato su un messaggio inviato (vedi [Comporre email](./composing-emails) per i dettagli).
- **Errori di invio**: quando un messaggio nella coda di invio si arrende dopo errori di consegna permanenti (SMTP o, per gli account Outlook, Microsoft Graph).

La campanella mostra un piccolo badge con il numero di nuove notifiche. Clicca sulla campanella per aprire il pannello a discesa: li puoi leggere ciascuna notifica, contrassegnarla come letta, contrassegnarle tutte come lette in un colpo solo, oppure eliminare singoli elementi. Le notifiche sono memorizzate localmente nella cache SQLite e quindi sopravvivono al riavvio dell'app; le voci piu vecchie di 30 giorni vengono rimosse automaticamente.

Quando le notifiche del sistema operativo sono consentite, gli stessi eventi attivano anche una notifica nativa del desktop.

## Finestra unica

MailCopilot impone una sola istanza in esecuzione per utente. Se avvii l'applicazione una seconda volta -- per esempio cliccando su un link `mailto:` o un'altra scorciatoia del desktop -- la finestra esistente viene portata in primo piano e messa a fuoco anziche aprirne una duplicata. In questo modo si evita che due copie parallele si contendano le stesse connessioni IMAP e la cache locale.

## Link `mailto:` e client email predefinito

Puoi registrare MailCopilot come gestore di sistema per i link `mailto:`, in modo che cliccando su un link «invia email» nel browser, nel terminale o in un'altra applicazione si apra la finestra di composizione di MailCopilot con il destinatario e gli altri parametri gia precompilati.

L'interruttore per registrare MailCopilot come applicazione email predefinita si trova in **Impostazioni > Generali**. I parametri `mailto:` supportati comprendono `to`, `cc`, `bcc`, `subject` e `body`.

## Lavorare offline

Il pulsante «Lavora offline» nella barra laterale (icona Wi-Fi, barrata quando si e offline) attiva e disattiva la modalita offline. Quando sei offline:

- Tutta l'attivita di rete si interrompe: non viene aperta alcuna connessione IMAP o SMTP.
- Puoi comunque leggere i messaggi gia sincronizzati, sfogliare le cartelle, contrassegnare i messaggi come letti o con stella e cosi via.
- I messaggi in uscita vengono accodati nella Posta in uscita e inviati automaticamente quando torni online.
- Le operazioni di spostamento ed eliminazione creano segnaposto locali, cosi il messaggio scompare subito dalla cartella di origine invece di restare visibile fino alla riconnessione. Lo spostamento effettivo lato server viene rieseguito al ripristino della connessione e il segnaposto locale viene riconciliato con il risultato del server.
- Il comportamento offline per cartella (se scaricare i corpi per la lettura offline e per quale finestra temporale) si configura in **Impostazioni > Cartelle**; vedi [Impostazioni delle cartelle](../settings/folders-settings).

## Temi chiaro e scuro

Cambia in **Impostazioni > Generali > Tema**.
