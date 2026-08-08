---
title: Telemetry
sidebar_position: 2
---

# Telemetria

MailCopilot può inviare una piccola quantità di dati diagnostici e d'uso -- ma solo dopo che dai il tuo consenso attivo. Non contengono mai il contenuto della tua posta, ma includono un identificatore casuale di questa installazione: i dati **non sono quindi del tutto anonimi** -- vedi [Identificatore di installazione](#identificatore-di-installazione) più sotto per sapere esattamente cosa permette e cosa non permette di sapere questo identificatore. Questa pagina documenta esattamente cosa viene raccolto e -- altrettanto importante -- cosa non viene mai raccolto.

## Consenso al primo avvio

Al primo avvio di MailCopilot, prima che si apra la procedura guidata di configurazione dell'account, vedi una schermata di consenso intitolata **Inviare dati diagnostici?**. Elenca cosa verrebbe inviato se lo consenti e cosa non viene mai inviato, e offre due pulsanti della stessa dimensione: **Consenti** e **Non consentire**. Nessuno dei due è preselezionato o evidenziato, e non c'è alcuna casella precompilata -- devi compiere una scelta attiva.

Da questo derivano alcune conseguenze:

- **Prima della tua risposta non viene raccolto nulla, non solo non viene inviato nulla.** I contatori e i buffer alla base della diagnostica e dell'uso non vengono mai aperti finché il consenso è in sospeso -- MailCopilot non accumula silenziosamente un arretrato per poi inviarlo tutto insieme quando lo consenti. Ciò che è accaduto prima della tua risposta semplicemente scompare; nel momento in cui consenti, il conteggio riparte da zero da quell'istante (una misurazione della durata della sessione, per esempio, inizia a contare dal momento del consenso, non dall'avvio dell'app).
- **Chiudere la schermata o premere Esc equivale a "Non consentire".** Non c'è modo di chiudere la schermata e ritrovarsi comunque considerati consenzienti.
- **La tua decisione viene memorizzata insieme alla versione di questa informativa.** MailCopilot mostra di nuovo la schermata solo se l'elenco di ciò che viene raccolto si amplia davvero -- una nuova categoria di dati, una nuova destinazione, o una portata più ampia di prima. I normali aggiornamenti dell'app, le modifiche di formulazione e le correzioni di bug non causano mai una nuova richiesta.
- **Se avevi già disattivato la diagnostica** in Impostazioni -> Informazioni prima che esistesse questa schermata, quel rifiuto viene rispettato e non ti viene chiesto di nuovo. A tutti gli altri la diagnostica viene disattivata automaticamente, e la domanda viene posta una volta al prossimo avvio.
- **Puoi cambiare idea in qualsiasi momento** in **Impostazioni -> Informazioni**. Finché non rispondi alla domanda iniziale, l'interruttore lì viene mostrato spento e disabilitato, con una nota che spiega che avrà effetto solo dopo che avrai risposto sulla schermata di consenso.

## Cosa inviamo

Se lo consenti, MailCopilot invia:

- **Errori e arresti anomali** -- il tipo di errore e lo stack trace che indica in quale punto del codice è avvenuto. Alcuni percorsi di errore passano già attraverso un insieme chiuso di campi strutturali che esclude del tutto il testo grezzo di un server di terze parti -- per esempio, quando il salvataggio di una copia di un messaggio inviato nella tua cartella Inviata fallisce, la diagnostica porta il ruolo della cartella (`sent`, mai il suo nome), un hash SHA-256 con salt dell'identificatore del messaggio, troncato a 12 caratteri esadecimali (mai l'identificatore stesso -- questa è un'etichetta pseudonima, non un'anonimizzazione: chi possiede un identificatore di messaggio candidato può confermare una corrispondenza ricalcolando l'hash), la lunghezza della risposta del server e un insieme chiuso di codici di protocollo (come `AUTHENTICATIONFAILED` oppure `OVERQUOTA`). Altri report di errore non ancora convertiti a questa forma strutturata possono comunque inoltrare testo grezzo di un server di terze parti, intercettato solo dalla pulizia di indirizzi e percorsi descritta più sotto -- non da una garanzia strutturale -- vedi [Come vengono ripuliti indirizzi e percorsi](#come-vengono-ripuliti-indirizzi-e-percorsi).
- **Versioni** -- la versione di MailCopilot, il tuo sistema operativo e la sua versione.
- **Prestazioni** -- la durata di operazioni come sincronizzazione della posta, ricerca, invio e richieste all'IA.
- **Uso delle funzioni** -- quali funzioni hai usato in una sessione e con quale frequenza (ricerca, scrittura dei messaggi, IA, regole, modelli, posticipo e altro), oltre, quando usi l'assistente IA, a quale fornitore e modello hanno gestito la richiesta e al costo stimato di quella richiesta. Vedi [Log di utilizzo dell'IA](#log-di-utilizzo-dellia) più sotto per i campi specifici dell'IA.
- **Attività del portachiavi IA** -- azioni sul portachiavi in cui sono conservate le tue chiavi API IA: quale provider, se la chiave è stata letta, salvata o eliminata, e come è andata, incluso se lì è stata trovata una chiave. Il valore della chiave non viene mai inviato -- né come testo, né come lunghezza, né come hash.
- **Contesto di configurazione** -- quanti account hai collegato, il tipo di servizio di posta di ciascuno (per esempio Gmail o Outlook), come hai eseguito l'accesso (OAuth o password), la lingua della tua interfaccia e il tuo tema.
- **Identificatore di installazione** -- un identificatore casuale creato al primo avvio, descritto in dettaglio più sotto. Collega tra loro i dati delle tue diverse sessioni -- questo è esattamente il motivo per cui i dati non sono del tutto anonimi.

## Cosa non raccogliamo mai

MailCopilot non progetta alcun percorso di codice per inviare quanto segue. Per le metriche tipizzate e la diagnostica del mancato salvataggio della copia inviata, questa è una garanzia assoluta, applicata da un insieme chiuso di campi strutturali che il codice ha il permesso di compilare. Tutti gli altri report diagnostici fanno affidamento innanzitutto sul fatto che il punto di invio non vi metta il contenuto in primo luogo, sostenuto da un filtro basato sulla forma che intercetta, come seconda linea, forme riconoscibili di indirizzi e percorsi -- non un filtro universale del contenuto. Vedi [Come vengono ripuliti indirizzi e percorsi](#come-vengono-ripuliti-indirizzi-e-percorsi) più sotto per sapere esattamente cosa intercetta e cosa non intercetta questa seconda linea.

- Il testo dei tuoi messaggi (oggetto, corpo, allegati, bozze)
- I tuoi indirizzi email o quelli dei tuoi contatti -- il modulo di feedback in Impostazioni -> Informazioni è l'unico posto in cui un indirizzo viene inviato di proposito, quando ne digiti uno tu stesso per poter ricevere una risposta.
- I nomi o i percorsi delle tue cartelle sul tuo server IMAP -- nei dati compare solo il tipo generale di cartella (per esempio Posta in arrivo, Inviata o Cestino), mai il nome che le hai dato
- Nomi dei file degli allegati
- Ciò che digiti nella ricerca -- vengono conteggiate solo la lunghezza della richiesta e il numero di risultati, mai il testo stesso
- Il contenuto delle conversazioni o della memoria dell'assistente IA
- Hostname dei server, porte o credenziali
- Il tuo indirizzo IP come dato che alleghiamo -- ogni evento indica esplicitamente a Sentry di non registrarne uno. La connessione di rete in sé espone inevitabilmente il tuo IP a tutto ciò che tocca lungo il tragitto; ciò che un server ricevente, un proxy o i suoi stessi log ne fanno è una questione di configurazione di quell'infrastruttura, non qualcosa che il payload di MailCopilot controlla.
- Il nome del tuo account del sistema operativo nei report diagnostici che costruiamo -- le lacune documentate sono descritte in [Come vengono ripuliti indirizzi e percorsi](#come-vengono-ripuliti-indirizzi-e-percorsi)

## Come vengono instradati i dati

Tutta la telemetria viene inviata a [Sentry](https://sentry.io), la nostra piattaforma di monitoraggio errori e prestazioni, e solo dopo che l'hai consentito nella schermata di consenso (o in seguito, attivando l'interruttore in Impostazioni -> Informazioni). Quando la diagnostica è disattivata -- che tu abbia rifiutato, non abbia ancora risposto, o abbia disattivato l'interruttore in seguito -- la pipeline viene completamente bypassata e non viene inviato nulla. Se attivi il logging di debug, gli stessi eventi compaiono anche nel tuo `main.log` locale, così puoi ispezionare esattamente cosa verrebbe trasmesso.

### Identificatore di installazione

Al primo avvio, MailCopilot genera un UUID casuale e lo memorizza nel file di configurazione locale. Questo UUID non lascia mai il tuo dispositivo. Ciò che viene trasmesso al suo posto è un hash SHA-256, troncato a 16 caratteri esadecimali, che chiamiamo `install_id_hash`. Viene allegato a ogni evento di telemetria come Sentry user id, su ogni evento e transazione, non solo su quelli a livello di sessione, in modo da poter rispondere a domande come «quante installazioni distinte stanno usando la versione X» oppure «il crash Y interessa 1 utente o 100». L'hash è:

- **Pseudonimo, non identificativo, ma nemmeno inconciliabile** -- non è derivato da alcuna email di account, impronta del dispositivo, indirizzo IP o identificatore hardware, e dal nostro lato non esiste alcuna corrispondenza che lo riporti all'UUID o al tuo dispositivo. È però deliberatamente pensato come identificatore stabile di questa specifica installazione: collega in un unico filo ogni evento e transazione che questa installazione invii mai -- e, come qualsiasi identificatore pseudonimo consegnato a terzi, potrebbe in linea di principio essere incrociato con altri dati a disposizione di Sentry o nostra. Questo è il motivo per cui la schermata di consenso definisce i dati «non del tutto anonimi» anziché anonimi.
- **Stabile tra le release**: la stessa installazione mantiene lo stesso hash dopo un aggiornamento automatico, in modo che le metriche di retention sopravvivano ai cambi di versione.
- **Eliminato quando disattivi la telemetria**: spostare l'interruttore di Impostazioni su off cancella immediatamente l'identificatore dal client Sentry e ferma ogni ulteriore trasmissione.

Usiamo questo identificatore come uno strumento di analytics web userebbe un visitor id: ci permette di contare *installazioni distinte* invece dei *totale eventi*. Questa differenza è proprio il motivo per cui la telemetria è utile: senza, una sola installazione molto attiva sembrerebbe uguale a cento installazioni tranquille.

### Come vengono ripuliti indirizzi e percorsi

Due filtri basati sulla forma vengono eseguiti su ogni evento in uscita e ogni voce di log strutturata, in entrambi i processi -- principale e renderer -- come ultima tappa prima della trasmissione -- con un'eccezione: la busta del modulo di feedback, il cui indirizzo hai digitato tu stesso apposta perché potessimo risponderti, è deliberatamente esclusa dal filtro degli indirizzi. Sono una rete di sicurezza per contenuti che non avrebbero mai dovuto arrivare fin lì, non il meccanismo principale -- il meccanismo principale è che i tag delle metriche tipizzate sono già di per sé enumerazioni chiuse e campi strutturali, quindi lì non c'è testo libero da ripulire.

- **Il testo con la forma di un'email** viene sostituito con `<email>`. Il pattern riconosce la forma pratica e comune di un indirizzo (lettere, cifre e un piccolo insieme di segni di punteggiatura prima della `@`, un dominio con punto dopo) -- non la grammatica email formale completa. Un'esclusione deliberata: `root@localhost` e indirizzi simili senza dominio con punto vengono lasciati intatti, così che un testo comune che menziona un pacchetto come `@types/node` non venga alterato. Una parte locale costruita con punteggiatura insolita può lasciare un frammento iniziale dopo la rimozione del suo `@dominio.tld`.
- **I percorsi verso la directory home** (`/home/<nome>/...`, `/Users/<nome>/...`, `C:\Users\<nome>\...`) hanno il segmento del nome dell'account sostituito con `<user>`. L'unico caso residuo documentato: un nome account con uno spazio al suo interno, proprio alla fine di un percorso, senza virgoletta di chiusura o separatore dopo, può lasciare la sua seconda parola (`C:\Users\Mario Rossi` a fine riga conserva «Rossi»). Il processo principale sostituisce inoltre il tuo percorso letterale della directory home ovunque compaia testualmente -- cosa che il renderer, nella sua sandbox, non può fare.
- Entrambi i filtri percorrono un insieme noto e limitato di campi dell'evento (testo dello stack trace, messaggi, dati della richiesta, breadcrumb e simili), più una scansione limitata in profondità e dimensione dei contenitori a forma libera (al massimo 4 livelli di profondità e 500 nodi visitati, dove ogni elemento di contenitore e ogni chiave di oggetto conta ai fini di questo budget, non solo le stringhe effettivamente riscritte) -- non una scansione illimitata dell'intero evento, quindi il contenuto oltre quel limite non viene visitato. Un campo non viene toccato deliberatamente: il nome host della macchina che l'SDK di Sentry stesso allega a ogni evento (`server_name`), perché su macOS e Windows spesso deriva dal nome dell'account e nessuna regola di pulizia può distinguerlo in modo affidabile da un nome host non correlato.
- Una fuga in una forma che nessuno dei due filtri riconosce -- un nome di cartella, una riga di oggetto, testo libero del server -- non viene intercettata qui. Per questo le tabelle delle metriche più sotto, e la diagnostica del mancato salvataggio della copia inviata, sono costruite con campi strutturali chiusi invece di affidarsi alla pulizia del testo libero.

### Log di utilizzo dell'IA

Ogni volta che invii un messaggio all'assistente IA, MailCopilot registra una voce di log strutturata al termine della richiesta, in aggiunta al booleano nel riepilogo di utilizzo descritto sopra. Quella voce riporta: il **fornitore IA** (per esempio il fornitore della tua chiave API, oppure «subscription»), il **modello** che ha gestito la richiesta, il **numero totale di chiamate agli strumenti** e i **nomi degli strumenti chiamati** (per esempio `send_email` o `mail_action`, mai gli argomenti passati loro), se la richiesta è stata annullata o ha generato un errore, e il **costo stimato** della richiesta in USD quando il fornitore espone i prezzi. Nulla di tutto ciò include il testo della tua richiesta, la risposta dell'IA o contenuti di posta -- per l'analisi completa di ciò che l'assistente IA stesso invia ai fornitori (un argomento distinto e molto più ampio, da non confondere con questa voce di log strutturata), vedi [Dati IA e registro di audit](./ai-data). Le misurazioni di latenza specifiche per singole funzioni IA portano propri campi aggregati (tipo di contesto della conversazione, se era già presente una cronologia, conteggi dei token, il preset di riscrittura usato, il numero di bozze di risposta generate e simili) -- vedi [Span di prestazioni](#span-di-prestazioni) più sotto.

## Eventi

### Ciclo di vita dell'app

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | no | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Una volta all'avvio dell'app. Porta `install_id_hash` per DAU/MAU. |
| `app.session_ended` | histogram | no | `reason`, `install_id_hash` | Una volta alla chiusura regolare. value_ms = durata della sessione. |
| `app.updated` | event | no | `from_version`, `to_version` | Una volta dopo che un auto-update installa una nuova versione. |
| `app.startup_ms` | histogram | no | `accounts_count` | Tempo da `app.whenReady` alla prima `BrowserWindow` visibile. |
| `window.rescued` | event | no | `windows_moved`, `pass` | Un passaggio di salvataggio ha riportato in vista almeno una finestra finita fuori schermo dopo un cambio della configurazione dei display (collegamento di un monitor, cambio di risoluzione, ripresa dallo standby). |

### Consenso alla telemetria

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `telemetry.consent_granted` | event | no | `version` | Si attiva solo quando premi Consenti nella schermata di consenso, con la versione dell'elenco che hai visto. Un rifiuto non genera alcun evento -- misurare un «no» sarebbe di per sé la trasmissione che il rifiuto intende impedire. Riattivare l'interruttore in Impostazioni -> Informazioni dopo averlo disattivato non genera questo evento -- solo una risposta alla schermata di consenso lo fa. |

### Riepilogo d'uso

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | no | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | Bitmap a fine sessione: quali funzionalità sono state usate almeno una volta. |

### Onboarding

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | no | `first_run` | L'utente ha aperto il flusso di aggiunta account. |
| `onboarding.method_selected` | event | no | `method` | L'utente ha scelto OAuth o IMAP/SMTP manuale. |
| `onboarding.autoconfig_result` | event | no | `success`, `provider` | Sondaggio di autoconfigurazione completato: i parametri IMAP/SMTP sono stati trovati? |
| `onboarding.connection_test_result` | event | no | `kind`, `success`, `failure_kind` | Test di connettività IMAP o SMTP completato. |
| `onboarding.google_oauth_result` | event | no | `success`, `failure_kind` | Flusso Google OAuth2 completato. |
| `onboarding.account_saved` | event | no | `provider`, `auth_type` | Le credenziali dell'account sono state scritte in keytar/electron-store. |
| `onboarding.first_headers_sync_completed` | histogram | no | `provider`, `folder_count_bucket` | Tempo da `account_saved` alla prima sincronizzazione delle intestazioni completata (value_ms). |
| `onboarding.first_message_opened` | event | no | `time_since_sync_bucket` | L'utente ha aperto il primo messaggio dopo l'accesso. |

### Composizione

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `compose.opened` | event | no | `source`, `has_draft` | Finestra di composizione aperta; traccia il punto di ingresso. |

### Coda d'invio

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `send_queue.enqueued` | event | no | `scheduled`, `send_and_archive`, `has_attachments`, `body_size_bucket` | Messaggio in uscita aggiunto a `send_queue` (immediato o pianificato). |
| `send_queue.sent` | histogram | no | `scheduled` | Tempo dall'inserimento in coda alla consegna SMTP riuscita (value_ms). |
| `send_queue.failed` | event | no | `failure_kind` | Tentativo di invio SMTP fallito in modo permanente (la coda si arrende). |
| `send_queue.retried` | event | no | `attempt_number` | Errore di invio SMTP transitorio: messaggio rischedulato. |
| `send_queue.append_failed` | event | no | `reason`, `provider_id` | La consegna SMTP è riuscita, ma il salvataggio di una copia del messaggio nella cartella Inviata via IMAP è fallito. Vedi la diagnostica della copia inviata descritta sopra in «Cosa inviamo». |

### Avvisi di destinatario errato

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `misdirection.prompted` | event | no | `kind` | La composizione ha mostrato il dialog di avviso. |
| `misdirection.outcome` | event | no | `outcome`, `kind` | L'utente ha risposto all'avviso. |

### Modelli

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `template.applied` | event | no | `var_count` | L'utente ha inserito un modello nella composizione. |

### Promemoria di follow-up

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `followup.created` | event | no | `duration_days_bucket` | Un promemoria di follow-up è stato collegato a un messaggio in uscita. |

### Ricerca

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | no | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | Latenza end-to-end della ricerca FTS (lato main, prima del merge con i risultati remoti). Verrà sostituito da `search.completed` in PR 2. |
| `search.error` | event | no | `scope`, `kind` | Il gestore della ricerca ha sollevato un'eccezione: annullamento dell'utente o errore reale. |

### Indicizzatore dei corpi

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | no | `indexed`, `folders_scanned` | Un tick completo dell'indicizzatore su tutte le cartelle. |
| `body_indexer.coverage_pct` | gauge | no | `total_messages`, `indexed_messages` | Frazione dei messaggi in cache con `body_text` indicizzato. |
| `body_indexer.backlog` | gauge | no | -- | Numero assoluto di messaggi in cache ancora privi di `body_text`. |
| `body_indexer.folder_error` | event | no | `folder_role`, `error_streak`, `backoff_ms` | L'indicizzatore ha incontrato una serie di errori su una cartella ed è andato in backoff. |

### Manutenzione dell'indice full-text

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `fts.optimize.duration_ms` | histogram | no | `segments_before`, `segments_after`, `reduction` | Passaggio FTS5 optimize: durata e numero di segmenti prima/dopo. |
| `fts.optimize.failed` | event | no | `reason` | FTS5 optimize ha sollevato un errore. |

### Sincronizzazione delle intestazioni

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | no | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Esecuzione completa di `syncFolderHeaders`: separa upsert dal resto per il profiling. |
| `sync.headers.coalesced` | event | no | `folder_role` | Un tentativo duplicato di `syncFolderHeaders` si è attaccato a un'esecuzione in corso. |

### Strumentazione dell'apertura dei messaggi

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | no | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Latenza end-to-end dell'apertura di un messaggio, osservata lato renderer (dal clic al rendering del corpo). Il tag `cache_hit_level` indica quale livello di cache ha servito il corpo: `memory`, `db`, `eml`, `imap` o `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | no | `cache_hit_level` | Tempo wall del gestore IPC `net:messageDetails` nel processo principale. Isola la latenza lato server dal rumore del round-trip renderer verso main. Un campione per ramo terminale (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | no | `requester`, `wait_ms_bucket` | Tempo di attesa per acquisire una connessione dal pool IMAP per account. Emesso solo quando l'attesa supera 500 ms, in modo che le dashboard catturino la coda lunga senza il rumore delle acquisizioni veloci. |

### Analisi dei file EML

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `eml.parse_dispatch` | event | no | `path`, `size_bucket` | Una singola analisi EML, con il percorso effettivamente seguito: `worker` (analizzato fuori dal thread principale), `worker_failed` (il worker era disponibile, ma proprio questa analisi è fallita), `worker_aborted` (avete chiuso il messaggio prima che il worker finisse), `inline_below_threshold` (abbastanza piccolo da essere analizzato per progetto nel thread principale), oppure `inline_unavailable` (analizzato nel thread principale perché il worker stesso è inutilizzabile in questa sessione). |
| `eml.parse_worker_unavailable` | event | no | `reason` | Si attiva al massimo una volta per sessione, nel momento in cui l'analisi EML fuori dal thread principale risulta impossibile per il resto di quella sessione — ogni analisi successiva ricadrà su `inline_unavailable` sopra. `reason` è `script_missing`, `spawn_failed`, `startup_failed` o `not_main_thread`. |

Nessuno dei due eventi è aggregato: ciascuno viene registrato singolarmente invece di essere accorpato ad altri della stessa raffica, perché altrimenti l'informazione di cui un maintainer ha bisogno — quale percorso ha seguito un'analisi, o perché il worker è morto — andrebbe persa nel conteggio. Ciò che è garantito è un evento `eml.parse_dispatch` per ogni file EML che MailCopilot analizza effettivamente — non un evento per ogni messaggio che apri. Aprire un messaggio già presente nella cache dei dettagli in memoria o su disco (i livelli `memory` e `db` del tag `cache_hit_level`, descritti più sopra in [Strumentazione dell'apertura dei messaggi](#strumentazione-dellapertura-dei-messaggi)) non analizza mai un file `.eml`, quindi per quell'apertura non viene prodotto alcun evento; l'evento scatta solo quando un messaggio viene letto da un file `.eml` salvato localmente oppure è appena stato scaricato e deve essere analizzato. Ogni evento che scatta porta il `path` di quella specifica analisi e il `size_bucket` di quello specifico messaggio, oltre a — come ogni altro evento inviato dall'app — l'identificatore di installazione descritto in [Identificatore di installazione](#identificatore-di-installazione), che lo collega al resto degli eventi della tua sessione. Il tag `size_bucket` usa lo stesso trattamento a fasce grossolane già applicato altrove in questa pagina alla dimensione dei messaggi (vedi `body_size_bucket` in [Coda d'invio](#coda-dinvio) e [Strumentazione dell'apertura dei messaggi](#strumentazione-dellapertura-dei-messaggi)): una di cinque fasce — `<1KB`, `1-10KB`, `10-100KB`, `100KB-1MB`, `1MB+` — non una dimensione esatta in byte, non una dimensione con risoluzione più fine, e mai un oggetto, un mittente, un nome di file o un identificatore di messaggio.

### Inviti del calendario

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `mail.invite_rsvp` | event | no | `method`, `hadLocation` | Si attiva quando una risposta a un invito del calendario (Accetta / Provvisorio / Rifiuta) viene inviata con successo. `hadLocation` registra solo se l'invito originale aveva un campo luogo, non cosa diceva. Gli invii di risposta falliti non vengono conteggiati qui. |

### Refresh dei token OAuth IMAP

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | no | `provider` | Refresh del token OAuth innescato da un fallimento di autenticazione IMAP (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | no | `provider` | Refresh riuscito: il retry IMAP userà il token aggiornato. |
| `imap.auth_refresh_failure` | event | no | `provider`, `reason` | Refresh fallito: l'errore di autenticazione originale viene propagato al chiamante. |
| `imap.auth_refresh_suppressed` | event | no | `reason` | Il cooldown per account ha soppresso un tentativo di refresh per evitare raffiche di richieste a `/token` quando un refresh token è stato revocato. |
| `imap.idle_auth_refreshed` | event | no | `provider` | Il loop IDLE si è ripreso da un fallimento di autenticazione a metà ciclo tramite un refresh in-loop: la consegna push è proseguita senza il backoff di 60 min. |
| `imap.auth_refresh_exhausted` | event | no | `provider`, `consecutive` | Il loop IDLE ha attivato lo storm-brake: N refresh consecutivi sono andati a buon fine lato provider ma IMAP ha continuato a rifiutare i token aggiornati, quindi si torna al backoff di autenticazione ordinario. |

### Recupero della fiducia nei certificati

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `imap.cert_error` | event | sì (finestra 10 s) | `provider` | Un'operazione IMAP è fallita con un errore TLS classificato come relativo al certificato (autofirmato, catena non attendibile, mancata corrispondenza del pin, mancata corrispondenza del nome host). |
| `cert.recovery_dialog_shown` | event | no | `provider` | La finestra di dialogo di recupero del certificato è stata mostrata per un host, al massimo una volta per finestra di storm-guard. |
| `cert.trust_clicked` | event | no | `provider`, `pem` | Hai accettato un certificato presentato, salvando un pin TLS e attivando una risincronizzazione dell'account. `pem` registra solo se il corpo del certificato è stato acquisito insieme al pin, il che determina se un server autofirmato potrà essere considerato attendibile in seguito. |
| `cert.trust_rejected` | event | no | `provider`, `reason` | Un tentativo di fiducia non si è concluso con un pin salvato -- per esempio hai rifiutato la conferma, oppure il certificato presentato dal server non corrispondeva a quello mostrato dalla finestra di recupero. |
| `cert.interception_notice_shown` | event | no | `provider` | È stato mostrato un avviso una tantum che la catena di certificati del tuo server di posta si verifica solo rispetto all'archivio certificati del tuo sistema operativo, non rispetto all'elenco di radici pubbliche incluso -- il segno di un antivirus o di un proxy aziendale che ispeziona la connessione. |

Nessuno di questi tag porta mai il nome host, l'impronta del certificato, il nome dell'emittente o il testo di errore grezzo -- solo la classificazione enumerata `provider` e codici di motivo chiusi.

### Conservazione della cache

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | no | `count_bucket`, `freed_bytes_bucket` | La pulizia di conservazione ha eliminato file `.eml` più vecchi del limite configurato. Conteggi e dimensioni sono trasmessi solo come intervalli — nessun percorso o numero esatto viene inviato. |
| `cache.folder_index_disabled` | event | no | `count`, `role` | Una cartella è stata esclusa dalla ricerca full-text — automaticamente per Junk/Spam/Cestino alla prima registrazione, o manualmente tramite il menu contestuale della cartella. `role`: `spam`, `trash` o `manual`. |

### Segnali di sicurezza della cache e di perdita di dati

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | no | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | È stato emesso un `DELETE FROM messages` a livello di cartella. Ogni call site fornisce un motivo, in modo da distinguere una regressione che cancella una cache sana da un bump UIDVALIDITY legittimo. |
| `imap.stale_wipe_guard_tripped` | event | no | `folder_role`, `provider` | La protezione mass-delete ha rifiutato di svuotare la cache locale della cartella perché `mailbox.exists` è tornato non numerico. Un picco indica un problema di provider o di connessione, non una perdita di dati utente. |
| `db.shutdown_wal_checkpoint_ms` | histogram | no | `busy`, `reclaimed_kb_bucket`, `ok` | Durata del `PRAGMA wal_checkpoint(TRUNCATE)` eseguito prima dell'uscita, in modo che le scritture committed-ma-non-checkpointed sopravvivano al riavvio. |

### Limiti di spesa IA

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `db.ai_reserve_denied` | event | sì (finestra 10 s) | `reason` | Una riserva di budget IA è stata rifiutata prima che potesse verificarsi qualsiasi spesa -- il più delle volte perché il limite di spesa configurato è stato raggiunto. |
| `ai.request_budget.stopped` | event | no | `provider`, `steps` | Una richiesta di chat è stata interrotta in anticipo perché il costo accumulato ha raggiunto il tetto per richiesta configurato. `steps` è il numero di passaggi agentici completati prima dell'interruzione, mai il loro contenuto. |

### Gate stdio MCP (protezione renderer-verso-RCE)

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `mcp.stdio.connect_attempted` | event | no | `approved_source` | Il trasporto stdio MCP sta per essere avviato: emesso una volta per connect riuscito dopo aver passato i gate di approvazione e allowlist. |
| `mcp.stdio.connect_blocked` | event | no | `reason` | Connessione o salvataggio stdio rifiutato dal gate (`not_approved`, `unapproved_command`, `forbidden_field`, `forbidden_env_key`, `env_disabled`). |
| `mcp.stdio.approval_granted` | event | no | `source`, `scope` | L'utente ha concesso l'approvazione stdio MCP (abilitazione globale o per connessione); `source` distingue env vs native-confirm, `scope` distingue global vs per-connessione. |
| `mcp.stdio.env_sanitized_on_load` | event | no | `count_bucket` | La migrazione delle impostazioni ha rimosso le chiavi env loader-hook proibite dalle connessioni MCP persistite al caricamento. Al massimo una volta per avvio. |

### Audit delle azioni IA (barriera preview -> apply)

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ai.action.preview_created` | event | no | `kind` | Uno strumento MCP `*_preview` ha registrato un'azione mutante in attesa del clic Apply dell'utente. |
| `ai.action.applied` | event | no | `kind` | Uno strumento MCP `*_apply` ha eseguito con successo un'azione mutante confermata in precedenza. |
| `ai.action.rejected` | event | no | `kind`, `reason` | Una chiamata `*_apply` è stata rifiutata al gate di validazione -- il preview mancava o era scaduto, il token di conferma mancava, non corrispondeva o era scaduto, il tipo di azione non corrispondeva al preview, mancava il callback, oppure è stato raggiunto il limite di frequenza. |
| `ai.action.expired` | event | no | `kind` | Un'azione mutante in attesa è scaduta senza che l'utente cliccasse Apply (TTL). |
| `ai.action.apply_duration_ms` | histogram | no | `kind` | Durata di un apply riuscito: quanto è durata la mutazione sottostante (DB / IMAP / SMTP). |
| `ai.action.preview_skipped` | event | no | `kind`, `reason` | Uno strumento MCP `*_preview` ha rifiutato di registrare un'azione in attesa perché l'insieme di obiettivi risolto era vuoto (nessuna corrispondenza dopo la risoluzione della query). |
| `ai.action.batch_size` | event | no | `kind`, `accounts_count_bucket`, `emails_count_bucket`, `folders_count_bucket` | Registrato quando la registrazione di un preview copre un lotto di messaggi. Tutti e tre i conteggi sono intervalli approssimativi, mai numeri esatti. |

### Gate di egress dell'IA

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | no | `tool_name`, `account_id` | Una chiamata a uno strumento di egress (per esempio `WebSearch`, `WebFetch`, uno strumento MCP esterno generico) è stata rifiutata mentre i dati email dell'utente erano nello scope -- filtrata dal toolset SDK o fermata al gate runtime. |
| `ai.egress.allowed_once` | event | no | `tool_name`, `account_id` | L'utente ha concesso un consenso una tantum per l'egress e l'IA ne ha fatto uso. Aiuta a distinguere «gli utenti aggirano abitualmente» da «il gate tiene, i tentativi sono prevalentemente da injection». |
| `ai.egress.intercepted` | event | no | `tool_name`, `outcome`, `was_consented_for_turn` | Una chiamata a uno strumento internet (ricerca web, recupero web, strumento MCP esterno) è stata intercettata dalla finestra di conferma descritta in [Policy di egress IA](./ai-data#policy-di-egress-ia), registrando se è stata approvata o negata e se un consenso già dato per lo stesso turno di risposta la copriva già. Mai la query, l'URL o gli argomenti dello strumento -- questi vengono sottoposti solo a hash nel registro di audit IA locale. |

### Azioni nel pannello di audit della privacy IA

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ai.audit.export_requested` | event | no | `format` | Hai fatto clic su Esporta JSON o Esporta CSV nel pannello del registro di audit IA. |
| `ai.audit.entry_deleted` | event | no | `scope` | Hai eliminato in modo reversibile una voce del registro di audit, oppure le hai cancellate tutte in una volta. Le righe sottostanti non vengono rimosse, solo nascoste -- vedi [Il registro di audit](./ai-data#il-registro-di-audit). |

### Regole IA in background

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ai.rule.applied` | event | no | `action` | La pipeline di regole IA in background ha applicato automaticamente un'azione reversibile (archivia, sposta, segna come letto o segna con stella) a un messaggio. |
| `ai.rule.destructive_preview` | event | no | `action` | La pipeline di regole IA in background ha proposto un'azione distruttiva (cestina o segna come spam) ma l'ha registrata come preview in attesa invece di applicarla automaticamente. |

### Aggiornamenti automatici

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `update.check_triggered` | event | no | `source` | È stata avviata una verifica degli aggiornamenti, sia dal timer in background orario sia dal tuo clic in Impostazioni -> Informazioni. |
| `update.check_result` | event | no | `result`, `error_class` | Una verifica degli aggiornamenti è terminata: aggiornato, un aggiornamento è disponibile, oppure non è riuscita. |
| `update.download_started` | event | no | `source` | È iniziato un download di aggiornamento, automaticamente o dal tuo clic. |
| `update.download_completed` | event | no | — | Un download di aggiornamento è terminato con successo ed è pronto per l'installazione al prossimo riavvio. |
| `update.download_failed` | event | no | `error_class` | Un download di aggiornamento non si è completato (interruzione di rete, disco pieno, mancata corrispondenza della firma o simili). |
| `update.install_outcome` | event | no | `result`, `error_class` | Cosa è successo dopo aver fatto clic su Riavvia per installare. |

Nessuno di questi porta la stringa di versione della release coinvolta -- solo il risultato raggruppato -- quindi questa tabella non permette di sapere quanto un'installazione specifica sia rimasta indietro.

### Gate dei link esterni

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `links.external_open_suppressed` | event | sì (finestra 10 s) | `source` | Una richiesta di apertura di un link nel tuo browser predefinito è stata limitata dal gate di apertura dei link esterni. `source` identifica quale parte dell'app ha fatto la richiesta (per esempio una finestra di dialogo di aggiornamento o un link di cancellazione iscrizione), mai l'URL stesso. |

### Fallback dell'archivio dei segreti

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `secret_store.fallback_active` | event | no | `surface`, `platform` | Una lettura dall'archivio dei segreti del tuo sistema operativo (keytar / libsecret / Secret Service) è fallita -- questa installazione funziona senza un portachiavi accessibile. `surface` identifica quale tipo di lettura delle credenziali è fallita, mai la credenziale, l'account o il suo indirizzo email. |

### Archiviazione delle chiavi API IA

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ai.api_key_store_op` | event | sì (finestra 10 s) | `op`, `provider`, `outcome` | Una chiave API IA salvata è stata letta, scritta o eliminata dall'archivio dei segreti del tuo sistema operativo. `op` è `read`, `write` o `delete`. `provider` è `anthropic-api`, `openai-api` o `gemini-api` -- un abbonamento Claude non ha una chiave salvata e non compare mai qui. `outcome` è `found` o `absent` per una lettura (in questo momento la chiave c'è o non c'è), `ok` per una scrittura o eliminazione riuscita, oppure `store_error` quando non è stato possibile raggiungere l'archivio dei segreti stesso. Il valore della chiave non compare mai -- né come testo, né come lunghezza, né come hash. |

### Conferma della destinazione IA

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ai.destination_confirm` | event | no | `field`, `outcome` | L'esito del cancello di conferma della destinazione che protegge una modifica dell'indirizzo dell'endpoint IA o del proxy (vedi [Conferma di una nuova destinazione IA](../ai-assistant#conferma-di-una-nuova-destinazione-ia)). `field` è `endpoint` o `proxy`. `outcome` è `accepted`, `declined` (la modifica non è stata approvata — hai fatto clic su Annulla o premuto Esc, la finestra di conferma si è chiusa prima che tu rispondessi, oppure la finestra di dialogo stessa non è riuscita ad aprirsi), `blocked_invalid` (il nuovo indirizzo non era un URL http(s) utilizzabile, rifiutato senza mostrare alcuna finestra di dialogo), oppure `blocked_busy` (la modifica è arrivata mentre era già aperta un'altra conferma — in tutta l'app può essere aperta una sola finestra di dialogo alla volta, quindi questo può accadere anche per lo stesso campo). Un conteggio `declined` non è solo un conteggio di rifiuti deliberati — comprende anche una finestra di dialogo che non è riuscita ad aprirsi affatto. Né l'indirizzo né l'host vengono mai inclusi. |

### Prestazioni IPC

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | sì (finestra 10 s) | `channel`, `duration_bucket` | Il gestore IPC ha superato la soglia «lento». |

### Reattività dell'UI

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | sì (finestra 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | Il loop eventi del renderer è rimasto bloccato oltre la soglia di freeze. |
| `ui.freeze.main_ms` | histogram | sì (finestra 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | Il loop eventi del processo main è rimasto bloccato (misurato tramite `perf_hooks` delay). |

### Menu contestuale

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ui.context_menu_shown` | event | sì (finestra 10 s) | `context` | E stato mostrato il menu contestuale nativo (clic destro). `context` indica quale sezione e stata offerta: `link`, `editable` (campo di testo) o `selection` (testo selezionato non modificabile). |
| `ui.context_menu_link_action` | event | sì (finestra 10 s) | `action` | E stata attivata una delle due voci di link del menu contestuale. `action` e `open` (Apri il link nel browser) o `copy_address` (Copia indirizzo del link). Ne l'URL del link ne il suo testo visibile sono mai inclusi. |

## Span di prestazioni

Oltre agli eventi discreti e agli istogrammi sopra, MailCopilot cronometra un insieme fisso di operazioni come span di prestazioni di Sentry -- il meccanismo che Sentry usa per il tracciamento della latenza anziché per i contatori. Ogni valore di attributo qui sotto è un aggregato: un'enumerazione, un conteggio, una durata o un booleano. Nessuno di essi porta contenuto dei messaggi, un indirizzo, una query, un URL o un prompt.

### Sincronizzazione e consegna della posta

| Span | Tipo | Aggregato | Attributi | Scopo |
| --- | --- | --- | --- | --- |
| `imap.idle` | span | no | `folder_role`, `provider`, `exit_reason`, `duration_bucket` | Un ciclo IDLE: connessione, attesa di una notifica push, poi aggiornamento o uscita. |
| `imap.sync` | span | no | `folder_role`, `provider`, `changed_since_present`, `fetched_headers_bucket`, `skipped`, `errored` | Un passaggio di sincronizzazione delle intestazioni per una cartella, tramite CONDSTORE o un recupero completo. |
| `smtp.send` | span | no | `provider`, `size_bucket`, `has_attachments` | Un tentativo di invio SMTP. |

### Elaborazione in background

| Span | Tipo | Aggregato | Attributi | Scopo |
| --- | --- | --- | --- | --- |
| `body_indexer.batch` | span | no | `folder_role`, `batch_size_bucket`, `fetched_ok_bucket`, `failed_bucket` | Un lotto di messaggi elaborato all'interno di un ciclo dell'indicizzatore dei corpi. |
| `offline.replay` | span | no | `ops_count_bucket`, `failed_bucket`, `uidvalidity_mismatch` | Una riproduzione delle azioni offline in coda per un account al momento della riconnessione. |
| `search.fts` | span | no | `query_len_bucket`, `result_count_bucket` | Un invio di ricerca full-text al worker di ricerca. |
| `net.message_details` | span | no | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Il gestore del processo principale che risolve il contenuto completo di un messaggio, coprendo ogni percorso da un hit in memoria fino a un recupero IMAP fresco. |

### Latenza delle funzioni IA

| Span | Tipo | Aggregato | Attributi | Scopo |
| --- | --- | --- | --- | --- |
| `ai.chat` | span | no | `ai.provider`, `ai.model`, `ai.context_type`, `ai.has_history`, `ai.session_resumed`, `ai.tool_call_count`, `ai.tools_used`, `ai.aborted`, `ai.cost_usd` | Una richiesta di chat all'assistente IA, dall'apertura del flusso del provider fino al completamento o all'annullamento. `ai.context_type` e gli indicatori di cronologia/ripresa descrivono da dove è iniziata la conversazione e se ne proseguiva una precedente -- mai il suo contenuto. |
| `ai.thread_summary.generate` | span | no | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | Una generazione di riepilogo IA del thread. Si attiva solo con una chiamata reale al provider, mai con un hit di cache. |
| `ai.quick_action.rewrite` | span | no | `preset`, `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | Una riscrittura tramite le azioni rapide nella composizione. `preset` registra quale dei preset (Migliora / Accorcia / Formale / Correggi grammatica) hai scelto, mai il testo della tua bozza. |
| `ai.instant_reply.generate` | span | no | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `draft_count` | Una chiamata di generazione di risposta immediata. `draft_count` è quante opzioni di risposta sono state generate, mai il loro testo. |

### Database locale

| Span | Tipo | Aggregato | Attributi | Scopo |
| --- | --- | --- | --- | --- |
| `db.upsert_messages` | span | no | `row_count_bucket`, `folder_role` | Una transazione di upsert di messaggi in blocco. |
| `db.reconcile_uids` | span | no | `row_count_bucket`, `folder_role`, `uidvalidity_changed` | Un passaggio di riconciliazione che rimuove dalla cache locale i messaggi non più presenti sul server. |
| `db.search_messages` | span | no | `query_len_bucket`, `folder_role`, `result_count_bucket` | Un'invocazione di ricerca nella cache locale, qualunque sia il percorso di ricerca interno che l'ha servita. |

## Contatto

Domande o dubbi su cosa raccogliamo? Apri una issue su [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) o contatta il team direttamente tramite il modulo di feedback in Impostazioni -> Informazioni.
