---
sidebar_position: 6
title: Informazioni
---

# Informazioni

La scheda **Informazioni** nelle Impostazioni mostra informazioni sulla vostra installazione di MailCopilot e fornisce controlli diagnostici e per gli aggiornamenti.

## Versione

Mostra la versione attuale di MailCopilot installata sul vostro computer.

## Link

- **Sito web** — apre il sito web di MailCopilot nel vostro browser.
- **Documentazione** — apre questo sito di documentazione.

## Informazioni di sistema

Il pannello **Informazioni di sistema** mostra dettagli tecnici sulla vostra installazione:

- **Versione dell'app** — la versione attuale di MailCopilot e il canale di rilascio (stable, nightly o dev).
- **Electron** — la versione dell'ambiente di esecuzione Electron utilizzato da MailCopilot.
- **Chromium** — la versione del motore Chromium integrato in Electron.
- **Node.js** — la versione di Node.js in esecuzione all'interno dell'applicazione.
- **Piattaforma** — il sistema operativo e l'architettura.
- **Percorso di installazione** — la directory in cui è installato MailCopilot. Se il percorso è contrassegnato come **sola lettura**, l'installazione è per tutto il sistema e gli aggiornamenti automatici richiedono privilegi di amministratore.

Queste informazioni sono utili per segnalare bug o verificare la compatibilità.

## Aggiornamenti

La sezione **Aggiornamenti** consente di controllare come MailCopilot si mantiene aggiornato.

### Scarica automaticamente gli aggiornamenti in background

Quando questa opzione è abilitata, MailCopilot scarica silenziosamente le nuove versioni man mano che diventano disponibili. Una volta completato il download, viene chiesto di riavviare l'applicazione per applicare l'aggiornamento. Non è richiesta alcuna azione fino a quando non si è pronti al riavvio.

Quando questa opzione è disabilitata, MailCopilot notifica che è disponibile un aggiornamento e mostra un pulsante **Scarica**. L'utente decide esattamente quando iniziare il download.

Questa impostazione è **disabilitata per impostazione predefinita** (richiede attivazione esplicita). Abilitatela per consentire a MailCopilot di scaricare gli aggiornamenti senza intervento manuale.

### Controlla aggiornamenti

Fate clic sul pulsante **Controlla aggiornamenti** per avviare manualmente una verifica in qualsiasi momento. Il pulsante e l'area di stato riflettono lo stato attuale del processo di aggiornamento:

- **inattivo** — il pulsante **Controlla aggiornamenti** è visibile e pronto all'uso.
- **Verifica…** — è in corso una verifica degli aggiornamenti; il pulsante è disabilitato fino al completamento.
- **Hai l'ultima versione** — nessun aggiornamento disponibile.
- **Aggiornamento disponibile: vX.Y.Z** — è stata rilevata una nuova versione; appare un pulsante **Scarica X.Y.Z** se l'installazione supporta l'auto-aggiornamento.
- **Download in corso… N %** — il file di aggiornamento è in fase di download; un indicatore di avanzamento mostra la percentuale.
- **Riavvia per installare** — il download è completo; fate clic per riavviare MailCopilot e applicare l'aggiornamento immediatamente.
- **Errore di rete — riprova quando sei online** — la verifica o il download non è riuscito a causa di un problema di rete.
- **Permesso negato — è richiesto un amministratore** — la directory di installazione non è scrivibile dall'utente corrente.
- **Aggiornamento non riuscito — vedi i log per i dettagli** — si è verificato un errore imprevisto; consultate la registrazione di debug per ulteriori informazioni.
- **Gli aggiornamenti sono disabilitati in questa build** — MailCopilot è in esecuzione in modalità sviluppo o non è pacchettizzato; gli aggiornamenti automatici non sono disponibili.

### Installazioni in sola lettura

Se MailCopilot è stato installato per tutto il sistema (ad esempio, tramite un gestore di pacchetti che colloca l'applicazione in una directory protetta), il **Percorso di installazione** nelle Informazioni di sistema è contrassegnato come **sola lettura**. In questo caso:

- La casella **Scarica automaticamente gli aggiornamenti in background** è visualizzata ma **disabilitata** (disattivata), con un tooltip che spiega che l'installazione è in sola lettura.
- Il pulsante **Controlla aggiornamenti** **rimane funzionante** — è ancora possibile verificare se è disponibile una nuova versione.
- I controlli **Scarica** e **Riavvia per installare** sono bloccati: non vengono visualizzati o non funzionano per le installazioni in sola lettura, poiché MailCopilot non può scrivere l'aggiornamento in una directory protetta.

Aggiornate l'applicazione tramite il gestore di pacchetti o con privilegi di amministratore.

## Rapporti di errore anonimi

Quando abilitato, MailCopilot invia rapporti di crash anonimi per aiutare gli sviluppatori a trovare e correggere i bug. Non vengono raccolti dati personali, contenuti delle email o informazioni sugli account — vengono trasmessi solo i dettagli tecnici degli errori.

Questa impostazione è abilitata per impostazione predefinita. Potete disabilitarla in qualsiasi momento deselezionando la casella.

## Registrazione di debug

Quando abilitata, MailCopilot scrive registri dettagliati in un file per la risoluzione dei problemi. Questi registri vengono archiviati localmente sul vostro computer e non vengono mai inviati automaticamente.

La registrazione di debug è disabilitata per impostazione predefinita. Abilitatela solo durante l'indagine di un problema — potrebbe influire leggermente sulle prestazioni.

## Segnala un bug

Fate clic sul pulsante **Segnala un bug** per inviare feedback direttamente agli sviluppatori di MailCopilot. Descrivete il problema riscontrato — questo ci aiuta a identificare e risolvere i problemi più rapidamente.

Il vostro feedback viene inviato in modo sicuro attraverso lo stesso sistema anonimo di segnalazione errori. Se la segnalazione errori è disattivata, vedrete un link al sito web di MailCopilot dove potete contattare il supporto.

Quando l'applicazione incontra un errore imprevisto, un modulo di feedback apparirà anche nella schermata di errore, permettendovi di descrivere cosa stavate facendo prima dell'errore.
