---
sidebar_position: 1
title: Installazione
---

# Installazione

## Scaricare MailCopilot

Visita [mailcopilot.io](https://mailcopilot.io) per scaricare l'ultima versione.

## Installazione su Linux

:::warning Ubuntu 23.10+ / 24.04 e altre distribuzioni recenti
Su Ubuntu 23.10 e versioni successive (inclusa 24.04 LTS), e su altre distribuzioni che includono lo stesso rafforzamento del kernel, **installa il pacchetto `.deb`** (o il `.rpm` su Fedora/openSUSE) anziché l'AppImage.

Questi kernel limitano per impostazione predefinita gli spazi dei nomi utente non privilegiati (`kernel.apparmor_restrict_unprivileged_userns=1`). MailCopilot è basato su Electron, il cui componente ausiliario `chrome-sandbox` necessita di questa capacità quando viene avviato da un AppImage — pertanto l'AppImage va in crash all'avvio con un segnale `SIGTRAP`. I pacchetti `.deb` e `.rpm` non hanno questo problema: i loro script di installazione configurano il componente ausiliario `chrome-sandbox` in modo appropriato — applicando il SUID-root (`chmod 4755`) dove gli spazi dei nomi utente non privilegiati sono limitati, oppure installando un profilo AppArmor sui sistemi Ubuntu più recenti (24.04+).

**Non** aggirare questo problema avviando con `--no-sandbox` o disabilitando globalmente `apparmor_restrict_unprivileged_userns` — entrambe le soluzioni indeboliscono il confine di sicurezza che protegge dall'eventuale contenuto email non attendibile. Utilizzare invece il `.deb` o il `.rpm`.
:::

### Deb (Debian, Ubuntu, Mint) — consigliato

1. Scarica il file `.deb` dal sito web.
2. Installalo con doppio clic o da terminale:
   ```bash
   sudo dpkg -i mailcopilot-*.deb
   ```
3. Avvia MailCopilot dal menu delle applicazioni.

### RPM (Fedora, openSUSE)

1. Scarica il file `.rpm` dal sito web.
2. Installalo con doppio clic o da terminale:
   ```bash
   sudo rpm -i mailcopilot-*.rpm
   ```
3. Avvia MailCopilot dal menu delle applicazioni.

### AppImage

L'AppImage è un unico file autonomo che non richiede installazione. Funziona bene sulle distribuzioni più vecchie, ma consulta l'avviso sopra prima di usarlo su Ubuntu 23.10+ / 24.04.

1. Scarica il file `.AppImage` dal sito web.
2. Rendilo eseguibile:
   - Clic destro > **Proprietà** > **Permessi** > **Consenti l'esecuzione come programma**.
   - Oppure da terminale: `chmod +x mailcopilot-*.AppImage`
3. Fai doppio clic sull'AppImage per avviare MailCopilot.

Il runtime AppImage richiede FUSE. Sulle versioni recenti di Debian/Ubuntu installa il pacchetto `libfuse2t64` (nelle versioni più vecchie si chiama `libfuse2`):

```bash
sudo apt install libfuse2t64
```

:::tip
Puoi spostare l'AppImage in qualsiasi posizione, ad esempio `~/Applications/`. L'applicazione è completamente autonoma.
:::

## Installazione su Windows

1. Scarica l'installatore `.exe` dal sito web.
2. Esegui l'installatore e segui le istruzioni. Puoi scegliere la directory di installazione.
3. Avvia MailCopilot dal menu Start o dal collegamento sul desktop.

## Primo avvio

Al primo avvio vedrai prima una schermata di consenso intitolata **Inviare dati diagnostici?**, che chiede se MailCopilot può inviare dati diagnostici e d'uso -- vedi [Telemetria](../privacy/telemetry) per sapere esattamente cosa significa. Non viene inviato nulla finché non rispondi, e la tua scelta non influisce sulla sincronizzazione della posta né sull'assistente IA. Cambia una cosa in Impostazioni -> Informazioni: con la diagnostica disattivata, il modulo di feedback integrato viene sostituito da un link al sito web di MailCopilot. Dopo la risposta si apre la procedura guidata di configurazione dell'account, che ti guiderà nella connessione del tuo primo account di posta elettronica.

Le password sono conservate in modo sicuro nel portachiavi di sistema (keytar) e non vengono mai scritte in file di configurazione in testo normale.

## Aggiornamenti automatici

MailCopilot controlla automaticamente gli aggiornamenti. Quando è disponibile una nuova versione, appare una notifica nell'applicazione. Puoi scaricare l'aggiornamento e riavviare con un clic.

:::note
Il meccanismo di aggiornamento integrato di MailCopilot può tentare di aggiornarsi da solo per le installazioni AppImage, `.deb`/`.rpm`/pacman, e anche su Windows e macOS. Per un'AppImage, MailCopilot sostituisce il file `.AppImage` stesso, quindi deve trovarsi in un punto scrivibile dal tuo account utente — ad esempio la tua home directory. Per un pacchetto `.deb`/`.rpm`/pacman, il meccanismo di aggiornamento richiede privilegi di amministratore (`pkexec`/`sudo`) prima di tentare di scrivere l'aggiornamento, esattamente come farebbero `apt`/`dnf`/`pacman` — quindi il fatto che la directory di installazione sia di proprietà di root non è un ostacolo, anche se il risultato finale dipende da quella richiesta di elevazione dei privilegi e dal gestore di pacchetti, non da MailCopilot. L'auto-aggiornamento non è disponibile in anticipo se non quando MailCopilot non è in esecuzione in una di queste forme pacchettizzate (ad esempio un'AppImage estratta o una cartella grezza non pacchettizzata), oppure quando la cartella in cui MailCopilot dovrebbe scrivere non è scrivibile — la cartella propria dell'AppImage, oppure su Windows e macOS la cartella che contiene l'eseguibile installato. In tal caso, aggiorna tramite il gestore pacchetti, con privilegi di amministratore, o scaricando e reinstallando l'ultimo pacchetto dal sito web.
:::
