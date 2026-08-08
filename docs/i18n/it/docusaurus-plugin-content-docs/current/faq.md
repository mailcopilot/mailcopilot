---
sidebar_position: 7
title: FAQ
---

# Domande frequenti

## Cos'e MailCopilot?

Un moderno client di posta desktop con supporto IMAP/SMTP, progettato per velocita e privacy.

## Quali piattaforme sono supportate?

**Linux** (AppImage). Windows e macOS sono previsti.

## Dove vengono conservate le password?

Nel portachiavi di sistema (keytar), mai in testo semplice.

## Quali provider sono compatibili?

Qualsiasi provider IMAP/SMTP: Gmail, Outlook, Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail (tramite Bridge), server propri.

## Posso usare piu account?

Si, con cambio nella barra laterale o nella posta in arrivo unificata.

## Il test di connessione mostra un errore di certificato TLS. Cosa devo fare?

MailCopilot verifica sempre i certificati TLS, confrontandoli sia con il pacchetto di certificati Mozilla integrato sia con l'archivio dei certificati del tuo sistema operativo. Se il tuo server di posta usa un certificato autofirmato o personalizzato, apparira una richiesta di fiducia. Controlla i dettagli del certificato e accettalo se sei sicuro che il server sia legittimo. Se l'impronta digitale non e ancora stata letta, il pulsante principale mostra prima **"Leggi il certificato"** -- clicca, controlla il risultato, poi clicca su **"Considera attendibile e continua"** per confermare.

## Il mio antivirus o il proxy aziendale ispeziona la mia connessione di posta. MailCopilot funzionera comunque?

Si. MailCopilot si affida all'archivio dei certificati del tuo sistema operativo oltre al suo pacchetto di certificati integrato, quindi i software di sicurezza che ispezionano il traffico TLS (per esempio antivirus con scansione HTTPS) e i proxy aziendali non interrompono piu la sincronizzazione della posta. Dopo la prima sincronizzazione riuscita del tuo account in una sessione, MailCopilot verifica questo una volta e, se lo trova, mostra un avviso che identifica il software o il proxy responsabile; questa verifica viene eseguita al massimo una volta per server per l'intera durata del tuo profilo, quindi un'ispezione attivata su un server dopo che questa verifica e gia stata eseguita non verra rilevata. Se il certificato cambia in seguito in uno di cui non ci si puo piu fidare del tutto (e non solo tramite l'archivio di sistema), MailCopilot mostra una finestra di dialogo di ripristino dove puoi controllare i dettagli del nuovo certificato e decidere se fidarti.

## Il mio server di posta autofirmato ha smesso di connettersi dopo l'aggiornamento di MailCopilot. Perche?

Il pinning dei certificati in passato confrontava le impronte digitali solo per i certificati la cui catena era gia verificata normalmente; i certificati autofirmati e con autorita di certificazione privata -- il caso esatto per cui il pinning esiste -- aggiravano del tutto questa verifica dell'impronta digitale. Questa lacuna e ora colmata, il che e un miglioramento della sicurezza -- ma se hai pinnato un server autofirmato o con autorita di certificazione privata prima di questa modifica, il pin salvato potrebbe non includere il certificato necessario per verificarlo, e quel server ora smettera di connettersi. Apri la finestra di dialogo di ripristino del certificato che appare per lui: se il pulsante mostra **"Leggi il certificato"**, clicca prima su quello, poi su **"Considera attendibile e continua"**; se e gia mostrato **"Considera attendibile e continua"**, clicca solo su quello. Questo salva il pin insieme al certificato stesso, e l'account si risincronizza automaticamente. Devi farlo solo una volta per ogni server interessato. Aggiungere o modificare un pin manualmente nelle Impostazioni non risolve il problema -- un pin manuale puo solo restringere l'attendibilita per un server che ha gia un certificato normale e pubblicamente attendibile; per un certificato altrimenti non attendibile (autofirmato, o di un'autorita di certificazione privata non ancora presente nell'archivio del tuo sistema operativo), solo la finestra di dialogo di ripristino puo concedergli attendibilita.

Se il tuo server usa STARTTLS (tipicamente la porta IMAP 143 o la porta SMTP 587), MailCopilot non puo catturare il suo certificato in questo modo -- viene salvata solo l'impronta digitale, quindi un server STARTTLS autofirmato restera non connettibile. Usa invece il TLS implicito (tipicamente la porta 993 per IMAP, 465 per SMTP) se il tuo server lo supporta.

## Come cerco i messaggi?

Clicca sulla barra di ricerca (o premi **/***) e digita la tua ricerca.

Operatori di ricerca avanzata:

- `from:user@example.com` -- messaggi da un mittente specifico.
- `to:user@example.com` -- messaggi inviati a un destinatario specifico.
- `subject:riunione` -- messaggi con una parola nell'oggetto.
- `has:attachment` -- messaggi con allegati.
- `is:unread` / `is:read` -- filtrare per stato di lettura.
- `is:starred` -- messaggi con stella.
- `before:2026-01-01` / `after:2025-12-01` -- filtrare per data.
- `in:Sent` -- messaggi in una cartella specifica.
- Negazione con `-`: `-from:spam@example.com`.
- Combinare con `OR` o `AND` (senza distinzione tra maiuscole e minuscole): `from:alice OR from:bob`.

## L'assistente IA e obbligatorio?

No, e completamente opzionale.

## Dove posso vedere cosa fa l'IA con i miei dati?

Aprite **Impostazioni → IA** e espandete la sezione **Privacy e audit**. Li troverete un registro di audit completo di ogni azione IA: data e ora, provider, modello, obiettivo, strumento utilizzato, costo stimato e esito. Il conteggio dei token viene registrato se il provider lo espone tramite SDK; altrimenti le colonne mostrano **n/d**. Potete anche esportare il registro in formato JSON o CSV.

Per maggiori dettagli, consultate [Dati IA e registro di audit](./privacy/ai-data).

## Come aggiornare MailCopilot?

Per impostazione predefinita, MailCopilot **non** scarica gli aggiornamenti automaticamente. Quando viene rilevata una nuova versione, in **Impostazioni > Informazioni** appare un pulsante **Scarica X.Y.Z**. Fate clic su di esso per avviare il download, poi fate clic su **Riavvia per installare** quando il download e completato.

Per una verifica manuale in qualsiasi momento, aprite **Impostazioni > Informazioni** e fate clic su **Controlla aggiornamenti**.

Per attivare il download automatico in background, aprite **Impostazioni > Informazioni** e selezionate **Scarica automaticamente gli aggiornamenti in background**. Quando attivata, le nuove versioni vengono scaricate silenziosamente e viene chiesto di riavviare quando l'aggiornamento e pronto.

MailCopilot normalmente puo aggiornarsi da solo su ogni piattaforma supportata: un'installazione AppImage sostituisce il file `.AppImage` stesso, e un'installazione `.deb`/`.rpm`/pacman lascia che il meccanismo di aggiornamento tenti la scrittura richiedendo privilegi di amministratore (`pkexec`/`sudo`), esattamente come farebbero `apt`/`dnf`/`pacman` -- il risultato effettivo lo decidono quella richiesta di elevazione dei privilegi e il gestore di pacchetti, non MailCopilot.

L'auto-aggiornamento puo non essere disponibile in due modi diversi, e MailCopilot mostra controlli diversi per ciascuno:

- **La build non e pacchettizzata** -- una build di sviluppo o CI. In questo caso non esiste alcun meccanismo di aggiornamento: il pulsante **Controlla aggiornamenti** e l'area di stato non compaiono, e al loro posto viene mostrato l'avviso **"Gli aggiornamenti sono disabilitati in questa build"**.
- **La build e pacchettizzata, ma l'auto-aggiornamento e bloccato** -- o perche MailCopilot non e riuscito a determinare la cartella in cui dovrebbe scrivere l'aggiornamento sul posto, o perche quella cartella non e scrivibile dal vostro account. Il primo caso si verifica su Linux quando l'app non e in esecuzione come un'AppImage montata (per esempio un'AppImage estratta o una build grezza `linux-unpacked`) -- in quel caso non c'e nessuna cartella in cui scrivere. Il secondo caso significa che la cartella di un'AppImage in esecuzione non e scrivibile (un'installazione `.deb`/`.rpm`/pacman non e interessata, perche queste elevano i privilegi al posto vostro); su Windows e macOS significa che la cartella che contiene l'eseguibile installato non e scrivibile. In entrambi i casi compare un avviso che spiega il motivo, il pulsante **Controlla aggiornamenti** continua a funzionare, e la casella di download automatico resta disponibile -- ma i controlli di download e riavvio sono nascosti.

## Posso disabilitare gli aggiornamenti automatici?

Il download automatico in background e disabilitato per impostazione predefinita. Se avete attivato l'opzione **Scarica automaticamente gli aggiornamenti in background** e desiderate disattivarla, aprite **Impostazioni > Informazioni** e deselezionatela. MailCopilot continuera a notificarvi quando e disponibile un aggiornamento, ma il download non iniziera fino a quando non fate clic su **Scarica**.

## MailCopilot non sincronizza.

Verifica IMAP IDLE nelle impostazioni, clicca su Sincronizza e controlla la tua connessione internet.
