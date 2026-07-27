---
title: Telemetry
sidebar_position: 2
---

# Telemetria

MailCopilot raccoglie una piccola quantita di dati anonimi diagnostici e d'uso quando attivi **Invia diagnostica e dati d'uso anonimi** in Impostazioni -> Informazioni. Questa pagina documenta esattamente cosa viene raccolto e -- altrettanto importante -- cosa non viene mai raccolto.

## Cosa non raccogliamo mai

In nessuna circostanza MailCopilot trasmette:

- Il testo dei tuoi messaggi (oggetto, corpo, allegati, bozze)
- I tuoi indirizzi email o quelli dei tuoi contatti
- Nomi o percorsi delle cartelle sul tuo server IMAP
- Nomi dei file degli allegati
- Il testo delle tue ricerche
- Il contenuto delle conversazioni o della memoria dell'assistente IA
- Hostname dei server, porte o credenziali

## Come vengono instradati i dati

Tutta la telemetria viene inviata a [Sentry](https://sentry.io), la nostra piattaforma di monitoraggio errori e prestazioni. Quando disattivi l'interruttore in Impostazioni, la pipeline viene completamente bypassata: non viene inviato nulla. Se attivi il logging di debug, gli stessi eventi compaiono anche nel tuo `main.log` locale, cosi puoi ispezionare esattamente cosa verrebbe trasmesso.

### Identificatore di installazione anonimo

Al primo avvio, MailCopilot genera un UUID casuale e lo memorizza nel file di configurazione locale. Questo UUID non lascia mai il tuo dispositivo. Cio che viene trasmesso al suo posto e un hash SHA-256, troncato a 16 caratteri esadecimali, che chiamiamo `install_id_hash`. Viene allegato a ogni evento di telemetria come Sentry user id, in modo da poter rispondere a domande come «quante installazioni distinte stanno usando la versione X» oppure «il crash Y interessa 1 utente o 100». L'hash e:

- **Anonimo**: non e derivato da, ne correlato a, un'email di account, un'impronta del dispositivo, un indirizzo IP o un identificatore hardware.
- **Stabile tra le release**: la stessa installazione mantiene lo stesso hash dopo un aggiornamento automatico, in modo che le metriche di retention sopravvivano ai cambi di versione.
- **Non reversibile**: dal nostro lato non esiste alcuna corrispondenza che riporti dall'hash all'UUID o al tuo dispositivo.
- **Eliminato quando disattivi la telemetria**: spostare l'interruttore di Impostazioni su off cancella immediatamente l'identificatore dal client Sentry e ferma ogni ulteriore trasmissione.

Usiamo questo identificatore come uno strumento di analytics web userebbe un visitor id anonimo: ci permette di contare *installazioni distinte* invece dei *totale eventi*. Questa differenza e proprio il motivo per cui la telemetria e utile: senza, una sola installazione molto attiva sembrerebbe uguale a cento installazioni tranquille.

## Eventi

### Ciclo di vita dell'app

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | no | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Una volta all'avvio dell'app. Porta `install_id_hash` per DAU/MAU. |
| `app.session_ended` | histogram | no | `reason`, `install_id_hash` | Una volta alla chiusura regolare. value_ms = durata della sessione. |
| `app.updated` | event | no | `from_version`, `to_version` | Una volta dopo che un auto-update installa una nuova versione. |
| `app.startup_ms` | histogram | no | `accounts_count` | Tempo da `app.whenReady` alla prima `BrowserWindow` visibile. |

### Riepilogo d'uso

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | no | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | Bitmap a fine sessione: quali funzionalita sono state usate almeno una volta. |

### Onboarding

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | no | `first_run` | L'utente ha aperto il flusso di aggiunta account. |
| `onboarding.method_selected` | event | no | `method` | L'utente ha scelto OAuth o IMAP/SMTP manuale. |
| `onboarding.autoconfig_result` | event | no | `success`, `provider` | Sondaggio di autoconfigurazione completato: i parametri IMAP/SMTP sono stati trovati? |
| `onboarding.connection_test_result` | event | no | `kind`, `success`, `failure_kind` | Test di connettivita IMAP o SMTP completato. |
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
| `send_queue.sent` | histogram | no | `scheduled` | Tempo dall'inserimento in coda alla consegna riuscita: SMTP per la maggior parte degli account, Microsoft Graph per Outlook (value_ms). |
| `send_queue.failed` | event | no | `failure_kind` | Tentativo di invio fallito in modo permanente (la coda si arrende). Copre sia SMTP sia Microsoft Graph. |
| `send_queue.retried` | event | no | `attempt_number` | Errore di invio transitorio: messaggio rischedulato. Copre sia SMTP sia Microsoft Graph. |

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
| `followup.created` | event | no | `duration_days_bucket` | Un promemoria di follow-up e stato collegato a un messaggio in uscita. |

### Ricerca

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | no | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | Latenza end-to-end della ricerca FTS (lato main, prima del merge con i risultati remoti). Verra sostituito da `search.completed` in PR 2. |
| `search.error` | event | no | `scope`, `kind` | Il gestore della ricerca ha sollevato un'eccezione: annullamento dell'utente o errore reale. |

### Indicizzatore dei corpi

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | no | `indexed`, `folders_scanned` | Un tick completo dell'indicizzatore su tutte le cartelle. |
| `body_indexer.coverage_pct` | gauge | no | `total_messages`, `indexed_messages` | Frazione dei messaggi in cache con `body_text` indicizzato. |
| `body_indexer.backlog` | gauge | no | -- | Numero assoluto di messaggi in cache ancora privi di `body_text`. |
| `body_indexer.folder_error` | event | no | `folder_role`, `error_streak`, `backoff_ms` | L'indicizzatore ha incontrato una serie di errori su una cartella ed e andato in backoff. |

### Manutenzione dell'indice full-text

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `fts.optimize.duration_ms` | histogram | no | `segments_before`, `segments_after`, `reduction` | Passaggio FTS5 optimize: durata e numero di segmenti prima/dopo. |
| `fts.optimize.failed` | event | no | `reason` | FTS5 optimize ha sollevato un errore. |

### Sincronizzazione delle intestazioni

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | no | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Esecuzione completa di `syncFolderHeaders`: separa upsert dal resto per il profiling. |
| `sync.headers.coalesced` | event | no | `folder_role` | Un tentativo duplicato di `syncFolderHeaders` si e attaccato a un'esecuzione in corso. |

### Strumentazione dell'apertura dei messaggi

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | no | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Latenza end-to-end dell'apertura di un messaggio, osservata lato renderer (dal clic al rendering del corpo). Il tag `cache_hit_level` indica quale livello di cache ha servito il corpo: `memory`, `db`, `eml`, `imap` o `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | no | `cache_hit_level` | Tempo wall del gestore IPC `net:messageDetails` nel processo principale. Isola la latenza lato server dal rumore del round-trip renderer verso main. Un campione per ramo terminale (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | no | `requester`, `wait_ms_bucket` | Tempo di attesa per acquisire una connessione dal pool IMAP per account. Emesso solo quando l'attesa supera 500 ms, in modo che le dashboard catturino la coda lunga senza il rumore delle acquisizioni veloci. |

### Refresh dei token OAuth IMAP

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | no | `provider` | Refresh del token OAuth innescato da un fallimento di autenticazione IMAP (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | no | `provider` | Refresh riuscito: il retry IMAP usera il token aggiornato. |
| `imap.auth_refresh_failure` | event | no | `provider`, `reason` | Refresh fallito: l'errore di autenticazione originale viene propagato al chiamante. |
| `imap.auth_refresh_suppressed` | event | no | `reason` | Il cooldown per account ha soppresso un tentativo di refresh per evitare raffiche di richieste a `/token` quando un refresh token e stato revocato. |
| `imap.idle_auth_refreshed` | event | no | `provider` | Il loop IDLE si e ripreso da un fallimento di autenticazione a meta ciclo tramite un refresh in-loop: la consegna push e proseguita senza il backoff di 60 min. |
| `imap.auth_refresh_exhausted` | event | no | `provider`, `consecutive` | Il loop IDLE ha attivato lo storm-brake: N refresh consecutivi sono andati a buon fine lato provider ma IMAP ha continuato a rifiutare i token aggiornati, quindi si torna al backoff di autenticazione ordinario. |

### Conservazione della cache

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | no | `count_bucket`, `freed_bytes_bucket` | La pulizia di conservazione ha eliminato file `.eml` piu vecchi del limite configurato. Conteggi e dimensioni sono trasmessi solo come intervalli — nessun percorso o numero esatto viene inviato. |
| `cache.folder_index_disabled` | event | no | `count`, `role` | Una cartella e stata esclusa dalla ricerca full-text — automaticamente per Junk/Spam/Cestino alla prima registrazione, o manualmente tramite il menu contestuale della cartella. `role`: `spam`, `trash` o `manual`. |

### Segnali di sicurezza della cache e di perdita di dati

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | no | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | E stato emesso un `DELETE FROM messages` a livello di cartella. Ogni call site fornisce un motivo, in modo da distinguere una regressione che cancella una cache sana da un bump UIDVALIDITY legittimo. |
| `imap.stale_wipe_guard_tripped` | event | no | `folder_role`, `provider` | La protezione mass-delete ha rifiutato di svuotare la cache locale della cartella perche `mailbox.exists` e tornato non numerico. Un picco indica un problema di provider o di connessione, non una perdita di dati utente. |
| `db.shutdown_wal_checkpoint_ms` | histogram | no | `busy`, `reclaimed_kb_bucket`, `ok` | Durata del `PRAGMA wal_checkpoint(TRUNCATE)` eseguito prima dell'uscita, in modo che le scritture committed-ma-non-checkpointed sopravvivano al riavvio. |

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
| `ai.action.rejected` | event | no | `kind`, `reason` | Una chiamata `*_apply` e stata rifiutata al gate di validazione (preview mancante/scaduto, token mancante o non corrispondente, kind mismatch, callback mancante o rate limit). |
| `ai.action.expired` | event | no | `kind` | Un'azione mutante in attesa e scaduta senza che l'utente cliccasse Apply (TTL). |
| `ai.action.apply_duration_ms` | histogram | no | `kind` | Durata di un apply riuscito: quanto e durata la mutazione sottostante (DB / IMAP / SMTP). |

### Gate di egress dell'IA

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | no | `tool_name`, `account_id` | Una chiamata a uno strumento di egress (per esempio `WebSearch`, `WebFetch`, uno strumento MCP esterno generico) e stata rifiutata mentre i dati email dell'utente erano nello scope -- filtrata dal toolset SDK o fermata al gate runtime. |
| `ai.egress.allowed_once` | event | no | `tool_name`, `account_id` | L'utente ha concesso un consenso una tantum per l'egress e l'IA ne ha fatto uso. Aiuta a distinguere «gli utenti aggirano abitualmente» da «il gate tiene, i tentativi sono prevalentemente da injection». |

### Prestazioni IPC

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | si (finestra 10 s) | `channel`, `duration_bucket` | Il gestore IPC ha superato la soglia «lento». |

### Reattivita dell'UI

| Evento | Tipo | Aggregato | Tag | Scopo |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | si (finestra 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | Il loop eventi del renderer e rimasto bloccato oltre la soglia di freeze. |
| `ui.freeze.main_ms` | histogram | si (finestra 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | Il loop eventi del processo main e rimasto bloccato (misurato tramite `perf_hooks` delay). |

## Contatto

Domande o dubbi su cosa raccogliamo? Apri una issue su [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) o contatta il team direttamente tramite il modulo di feedback in Impostazioni -> Informazioni.
