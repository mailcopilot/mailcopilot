---
sidebar_position: 1
title: AI Data & Audit Log
---

# Dati IA e registro di audit

Questa pagina spiega quali dati elabora l'assistente IA, come MailCopilot registra tale elaborazione in un registro di audit locale e quali controlli avete su quei dati.

## Cosa invia l'assistente IA ai provider

Quando utilizzate l'assistente IA, MailCopilot trasmette quanto segue al vostro provider IA scelto:

- Il contenuto dell'email o del thread di conversazione che state visualizzando (oggetto, corpo, mittente, destinatari).
- Gli allegati che chiedete esplicitamente all'assistente di leggere.
- Le note della memoria IA (se la funzionalità Memoria è configurata).
- Il testo del vostro messaggio all'assistente nella chat.

**Cosa non viene mai inviato:**

- Email o cartelle che non avete aperto o menzionato nella sessione corrente.
- Le vostre credenziali IMAP/SMTP o la configurazione del server.
- Le password dei vostri account email.
- Dati di account che non avete utilizzato esplicitamente nella richiesta IA corrente.

L'assistente IA è completamente opzionale. Se non configurate un provider, nessun dato email viene trasmesso a servizi esterni.

## Riepilogo IA del thread

Il [Riepilogo IA del thread](../ai-assistant#riepilogo-ia-del-thread) è una funzionalità separata e opzionale che genera un breve riepilogo di un thread aperto. Segue le stesse protezioni del resto dell'assistente IA:

- **Disattivato per impostazione predefinita, per ciascun account.** Non viene inviato nulla per il riepilogo finché non abilitate **Impostazioni > IA > Riepilogo IA del thread** per quello specifico account.
- **Contenuto avvolto.** Ogni messaggio incluso nella richiesta di riepilogo viene avvolto con marcatori di confine `wrapUntrusted()` prima di raggiungere il provider IA, la stessa protezione descritta più sotto in [Protezione contro l'iniezione di prompt](#protezione-contro-liniezione-di-prompt).
- **Generazioni sottoposte ad audit.** Ogni volta che un riepilogo viene effettivamente generato (e non servito dalla cache), viene scritta una voce nel [registro di audit IA](#il-registro-di-audit) con l'obiettivo corrispondente all'azione di riepilogo. Riaprire un thread già riepilogato legge il risultato dalla cache e non crea una nuova voce di audit né ricontatta il provider IA.
- **Cache limitata all'account.** Un riepilogo generato viene memorizzato nella cache e cercato per account: la chiave della cache combina il tuo account con l'identità del thread, quindi un riepilogo in cache di un account non viene mai riutilizzato né esposto per un altro account.
- **Attento al budget.** Se il budget IA giornaliero è stato raggiunto, il riepilogo viene rifiutato in modo controllato invece di essere generato — vedi [Riepilogo IA del thread](../ai-assistant#riepilogo-ia-del-thread) per cosa viene mostrato in questo caso.
- **Selezione del provider.** Il Riepilogo IA del thread utilizza il tuo **provider configurato tramite chiave API** (Anthropic, compatibile con OpenAI, o Google Gemini) — **un abbonamento Claude non è supportato per il Riepilogo IA del thread** e produce lo stesso rifiuto "nessun provider IA" dell'assenza totale di un provider configurato. È progettato per preferire un modello locale, sul dispositivo, non appena tale supporto sarà disponibile, in modo che il contenuto del thread non debba lasciare il vostro computer — quel supporto non è ancora disponibile, quindi oggi utilizza sempre il vostro provider remoto configurato tramite chiave API.
- **La telemetria non contiene contenuto dei messaggi.** L'evento di utilizzo anonimo registrato per ogni generazione riporta solo l'identificativo del provider, se il modello è stato eseguito localmente, i conteggi dei token in ingresso/uscita, la latenza e una classe di errore aggregata — mai l'oggetto, il corpo o gli indirizzi dei partecipanti del thread.

## Azioni rapide nella composizione

Le [Azioni rapide nella composizione](../ai-assistant#azioni-rapide-nella-composizione) riscrivono il testo attuale della bozza nella finestra di composizione (Migliora / Accorcia / Formale / Correggi grammatica). Seguono le stesse protezioni del resto dell'assistente IA:

- **Nessuna sostituzione silenziosa.** Una riscrittura viene mostrata solo come confronto prima/dopo. Il corpo della vostra bozza cambia solo dopo che avete fatto clic esplicitamente su **Sostituisci** o **Inserisci al cursore** — fare clic su **Annulla**, o chiudere il confronto, lascia la bozza invariata e non viene inviato nient'altro.
- **Contenuto avvolto.** Il testo della vostra bozza viene avvolto con marcatori di confine `wrapUntrusted()` prima di raggiungere il provider IA, la stessa protezione descritta in [Protezione contro l'iniezione di prompt](#protezione-contro-liniezione-di-prompt) più sotto — questo protegge anche da testo incollato da una fonte non attendibile.
- **Generazioni sottoposte ad audit.** Ogni riscrittura scrive una voce nel [registro di audit IA](#il-registro-di-audit) con `goal` impostato su `quick_action`; il preset specifico usato (Migliora / Accorcia / Formale / Correggi grammatica) viene registrato nello span di telemetria, non nella voce di audit.
- **Selezione del provider.** Le Azioni rapide utilizzano il vostro **provider configurato tramite chiave API** (Anthropic, compatibile con OpenAI, o Google Gemini) — **un abbonamento Claude non è supportato** e produce lo stesso rifiuto "nessun provider IA" dell'assenza totale di un provider configurato. Non esiste un'impostazione di attivazione/disattivazione dedicata: le Azioni rapide sono disponibili ogni volta che è configurato un provider adatto e la bozza contiene testo da riscrivere.
- **Attento al budget.** Se il budget IA giornaliero è stato raggiunto, la riscrittura viene rifiutata in modo controllato — vedi [Azioni rapide nella composizione](../ai-assistant#azioni-rapide-nella-composizione) per cosa viene mostrato in questo caso.
- **La telemetria non contiene contenuto dei messaggi.** L'evento di utilizzo anonimo registrato per ogni riscrittura riporta solo il preset usato, l'identificativo del provider, se il modello è stato eseguito localmente, i conteggi dei token, la latenza e una classe di errore aggregata — mai il testo della bozza stesso.

## Risposta immediata

La [Risposta immediata](../ai-assistant#risposta-immediata) è una funzionalità separata e opzionale che redige due o tre brevi opzioni di risposta per il messaggio che avete aperto. Segue le stesse protezioni del resto dell'assistente IA, più una salvaguardia aggiuntiva specifica per come recupera il corpo dell'email:

- **Disattivata per impostazione predefinita, per ciascun account.** Non viene inviato nulla per la redazione finché non abilitate **Impostazioni > IA > Risposta immediata** per quello specifico account. Quando è disattivata, il pulsante Risposta immediata non viene mostrato e non viene inviata alcuna richiesta.
- **Solo corpo dalla cache.** La Risposta immediata recupera il corpo dell'email di origine dalla cache locale di MailCopilot per account, cartella e UID del messaggio — non si fida mai del testo del corpo che potrebbe essere fornito dalla finestra stessa; questo esclude una classe di attacchi di cache-poisoning in cui una vista manipolata potrebbe altrimenti influenzare ciò che viene inviato al provider IA.
- **Contenuto avvolto.** Il corpo dell'email di origine viene avvolto con marcatori di confine `wrapUntrusted()` prima di raggiungere il provider IA, la stessa protezione descritta in [Protezione contro l'iniezione di prompt](#protezione-contro-liniezione-di-prompt) più sotto.
- **Mai invio automatico.** Scegliere un'opzione redatta precompila solo una **nuova** finestra di composizione. Non viene inviato nulla finché non rivedete esplicitamente la bozza e fate clic voi stessi su Invia.
- **Generazioni sottoposte ad audit.** Ogni volta che le bozze vengono effettivamente generate, viene scritta una voce nel [registro di audit IA](#il-registro-di-audit) con l'obiettivo corrispondente all'azione di risposta immediata.
- **Selezione del provider.** La Risposta immediata utilizza il vostro **provider configurato tramite chiave API** (Anthropic, compatibile con OpenAI, o Google Gemini) — **un abbonamento Claude non è supportato** e produce lo stesso rifiuto "nessun provider IA" dell'assenza totale di un provider configurato.
- **Attenta al budget.** Se il budget IA giornaliero è stato raggiunto, la redazione viene rifiutata in modo controllato — vedi [Risposta immediata](../ai-assistant#risposta-immediata) per cosa viene mostrato in questo caso.
- **La telemetria non contiene contenuto dei messaggi.** L'evento di utilizzo anonimo registrato per ogni generazione riporta solo l'identificativo del provider, se il modello è stato eseguito localmente, i conteggi dei token, la latenza e una classe di errore aggregata — mai l'oggetto, il corpo dell'email, gli indirizzi del mittente o del destinatario, o il testo della risposta redatta.

## Policy di egress IA

MailCopilot intercepta ogni chiamata a strumenti internet che l'IA vuole effettuare — ricerca web, recupero di pagine web e chiamate a strumenti MCP esterni — e mette in pausa l'IA per richiedere la vostra approvazione prima dell'esecuzione. Questo impedisce a un'email dannosa di esfiltrare silenziosamente i vostri dati tramite un attacco di iniezione di prompt.

### Funzionamento

Quando l'IA vuole usare uno strumento internet (ad esempio, eseguire una ricerca web), MailCopilot mette in pausa la risposta e mostra un modal di conferma integrato nel pannello IA con il messaggio **«L'IA vuole accedere a Internet»**. Il modal mostra:

- Il tipo di azione — «Ricerca web:», «Recupero URL:» o «Chiamata a strumento esterno»
- La query, l'URL o il nome dello strumento esterno richiesto dall'IA (quando disponibile)
- I pulsanti **Consenti** e **Rifiuta**

Fate clic su **Consenti** per consentire all'IA di procedere, o su **Rifiuta** per rifiutare. La vostra decisione si applica all'intero turno di risposta corrente — se l'IA effettua più chiamate a strumenti internet in una stessa risposta, vi viene chiesto solo una volta. Fare clic su **Consenti** concede l'accesso a tutte le chiamate rimanenti di quel turno.

Se non rispondete entro 30 secondi, MailCopilot rifiuta automaticamente la chiamata allo strumento.

### Icona scudo

Nel header del pannello IA viene mostrata un'icona a forma di scudo quando l'interception dell'egress è attiva. Passando il cursore sopra, appare: «L'accesso web dell'IA è intercettato — ogni chiamata in uscita richiede la tua approvazione». Questa icona conferma che l'interceptor è in funzione e che nessuna chiamata internet può bypassare la vostra approvazione.

### Impostazioni della policy

Potete regolare la policy di egress in **Impostazioni → AI** (sotto il controllo **Accesso web dell'IA**). Controlla quando l'IA può usare strumenti internet. Con **Nega per impostazione predefinita** o **Chiedi a ogni turno**, MailCopilot chiede conferma alla prima chiamata a strumento internet di ogni turno di risposta. Con **Consenti sempre**, la richiesta viene saltata — gli strumenti internet vengono eseguiti senza conferma:

- **Nega per impostazione predefinita (consigliato)** — intercepta tutte le chiamate a strumenti internet; approvate o rifiutate ogni turno tramite il modal di conferma.
- **Chiedi a ogni turno** — stesso comportamento del rifiuto predefinito: consenso esplicito per turno tramite il modal di conferma.
- **Consenti sempre** — l'IA può chiamare liberamente strumenti web. Avvertenza: l'IA potrebbe inviare contenuto email a servizi esterni.

### Registro di audit

Ogni chiamata a strumenti internet interceptata crea una riga nel registro di audit; le chiamate rifiutate incrementano la colonna **Bloccato**, mentre le chiamate approvate vengono registrate con **Bloccato** = 0. Ogni voce è anche conteggiata nell'evento di telemetria `ai.egress.intercepted` con tag che indicano il nome dello strumento, il risultato (approvato o rifiutato) e se il consenso per quel turno era già stato registrato. Per i dettagli su query e URL, il registro conserva solo un hash SHA-256 troncato ai primi 16 caratteri esadecimali; le query e gli URL grezzi non vengono mai scritti su disco.

## Il registro di audit

MailCopilot mantiene un registro di audit locale di ogni azione IA. Il registro è archiviato nel vostro database locale sul vostro dispositivo e non viene mai trasmesso a MailCopilot né a terzi.

### Cosa registra ogni voce

| Campo | Descrizione |
|-------|-------------|
| **Data e ora** | Data e ora esatte in cui è avvenuta l'azione. |
| **Provider** | Il provider IA utilizzato (ad es., Anthropic, OpenAI, Google). |
| **Modello** | La versione specifica del modello che ha gestito la richiesta. |
| **Obiettivo** | Una breve descrizione di ciò che è stato richiesto all'assistente. |
| **Strumento** | Lo strumento MCP chiamato, se presente (ad es., `send_email`, `mail_action`, `move_email`). |
| **Token ingresso / uscita** | Conteggio dei token in ingresso e in uscita per questa azione. I valori vengono registrati se il provider li espone tramite SDK; altrimenti le colonne mostrano **n/d**. |
| **Costo (USD)** | Costo stimato in base ai prezzi pubblicati dal provider, o **n/d** per i provider ad abbonamento. Il costo è il segnale principale per il monitoraggio della spesa. |
| **Avvolto** | Numero di invocazioni del marcatore `wrapUntrusted()`. Ogni invocazione significa che un blocco di contenuto email è stato isolato prima di essere passato all'IA per prevenire l'iniezione di prompt. |
| **Bloccato** | Numero di tentativi di egress in uscita bloccati dalla policy di sicurezza durante questa azione. |
| **Esito** | Risultato dell'azione: **OK** (completato con successo), **Errore** (fallito) o **Annullato** (interrotto da voi o dal sistema). |

### Immutabilità e conservazione

Le nuove voci vengono sempre aggiunte in fondo. Tutte le colonne ad eccezione di `deleted_at` sono immutabili dopo l'inserimento — i record esistenti non vengono mai modificati una volta scritti. Ciò significa che l'app non può alterare le voci passate (può solo eliminarle temporaneamente o lasciarle rimuovere dal limite di rotazione). L'eliminazione temporanea di una voce (vedi sotto) imposta il timestamp `deleted_at` e nasconde la voce dalla vista, ma tutte le altre colonne rimangono invariate.

Il registro è limitato a **10.000 voci**. Quando viene aggiunta una nuova voce e il totale supera questo limite, le righe più vecchie vengono rimosse automaticamente per mantenere il registro entro il limite. Le voci anteriori alle 10.000 più recenti vengono eliminate definitivamente dal database locale. Se avete bisogno di un archivio permanente, esportate regolarmente il registro tramite i pulsanti **Esporta JSON** o **Esporta CSV** prima che le voci vengano eliminate dalla rotazione.

### Accedere al registro di audit

Aprite **Impostazioni → IA** e espandete la sezione **Privacy e audit**. Il registro è paginato e ordinato dal più recente al meno recente.

### Esportare

Cliccate su **Esporta JSON** o **Esporta CSV** per scaricare il registro di audit attualmente visibile (righe attive entro il limite di rotazione di 10.000 voci; le voci eliminate temporaneamente e quelle rimosse dalla rotazione sono escluse). L'esportazione include tutti i campi elencati sopra per ciascuna voce inclusa. Il file CSV utilizza il formato RFC 4180 con separatori di riga CRLF ed escape corretto (i campi che contengono virgole, virgolette o interruzioni di riga sono correttamente escapati). Il file CSV è compatibile con Excel, Numbers e LibreOffice. Potete usarla per:

- Esaminare l'attività IA in qualsiasi momento.
- Rispondere a richieste di accesso ai dati personali ai sensi del GDPR o di normative simili.
- Conservare una copia offline per i propri archivi.

### Eliminare voci

**Eliminazione temporanea per riga** — cliccate sull'icona di eliminazione di una voce del registro per nasconderla dalla vista. Il timestamp `deleted_at` della voce viene impostato e scompare dall'elenco e dagli aggregati, ma i dati sottostanti vengono conservati per preservare l'integrità dell'audit.

**Cancella tutto** — marca tutte le voci di audit come eliminate temporaneamente (imposta `deleted_at` su ogni record). Prima di procedere, MailCopilot mostra una finestra di dialogo di conferma nativa del sistema operativo con il titolo "Clear AI audit log" e i pulsanti **Cancel** e **Delete All**. Le voci vengono nascoste dall'elenco, dagli aggregati e dalle esportazioni. Si noti che il limite automatico di 10.000 righe (vedi sopra) rimuove fisicamente le righe più vecchie nel tempo; le voci eliminate temporaneamente vengono conteggiate nel limite e alla fine saranno definitivamente eliminate dalla rotazione.

## Aggregati di token e costi

La parte superiore del pannello Privacy e audit mostra i totali di token e costi per provider. Selezionate un periodo — **Oggi**, **Ultimi 7 giorni** o **Ultimi 30 giorni** — per filtrare gli aggregati. Si tratta di finestre scorrevoli, non di settimana o mese calendario. Questi totali vengono calcolati dal registro di audit locale e non vengono mai inviati ad alcun server.

Per i provider ad abbonamento, i costi vengono mostrati come **n/d** perché la tariffazione per richiesta non si applica.

## Protezione contro l'iniezione di prompt

Ogni blocco di contenuto email passato all'IA viene avvolto con marcatori di confine `wrapUntrusted()`. Questi marcatori istruiscono l'IA a trattare il contenuto incluso come dati utente non attendibili — non come istruzioni — in modo che un'email dannosa non possa dirottare il comportamento dell'assistente. La colonna **Avvolto** nel registro di audit vi permette di vedere esattamente quante volte questa protezione è stata applicata in ogni richiesta. Il contatore è preciso: se la stessa email viene recuperata più di una volta nell'ambito di una singola richiesta (ad esempio, quando l'IA la rivisita durante un'attività a più passi), ogni recupero viene conteggiato separatamente, in modo che il totale rifletta accuratamente il numero effettivo di letture di email.

## Vedere anche

- [Assistente IA](../ai-assistant) — guida completa all'utilizzo dell'assistente IA.
- [Telemetria](./telemetry) — dati diagnostici anonimi raccolti da MailCopilot (separati dal registro di audit IA).
