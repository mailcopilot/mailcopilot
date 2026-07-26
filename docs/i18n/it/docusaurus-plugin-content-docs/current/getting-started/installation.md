---
sidebar_position: 1
title: Installazione
---

# Installazione

## Scaricare MailCopilot

Visita [mailcopilot.io](https://mailcopilot.io) per scaricare l'ultima versione.

## Installazione su Linux

:::warning Ubuntu 23.10+ / 24.04 e altre distribuzioni recenti
Su Ubuntu 23.10 e versioni successive (inclusa 24.04 LTS), e su altre distribuzioni che includono lo stesso rafforzamento del kernel, **installa il pacchetto `.deb`** (o il `.rpm` su Fedora/openSUSE) anziche l'AppImage.

Questi kernel limitano per impostazione predefinita gli spazi dei nomi utente non privilegiati (`kernel.apparmor_restrict_unprivileged_userns=1`). MailCopilot e basato su Electron, il cui componente ausiliario `chrome-sandbox` necessita di questa capacita quando viene avviato da un AppImage — pertanto l'AppImage va in crash all'avvio con un segnale `SIGTRAP`. I pacchetti `.deb` e `.rpm` non hanno questo problema: i loro script di installazione configurano il componente ausiliario `chrome-sandbox` in modo appropriato — applicando il SUID-root (`chmod 4755`) dove gli spazi dei nomi utente non privilegiati sono limitati, oppure installando un profilo AppArmor sui sistemi Ubuntu piu recenti (24.04+).

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

L'AppImage e un unico file autonomo che non richiede installazione. Funziona bene sulle distribuzioni piu vecchie, ma consulta l'avviso sopra prima di usarlo su Ubuntu 23.10+ / 24.04.

1. Scarica il file `.AppImage` dal sito web.
2. Rendilo eseguibile:
   - Clic destro > **Proprieta** > **Permessi** > **Consenti l'esecuzione come programma**.
   - Oppure da terminale: `chmod +x mailcopilot-*.AppImage`
3. Fai doppio clic sull'AppImage per avviare MailCopilot.

Il runtime AppImage richiede FUSE. Sulle versioni recenti di Debian/Ubuntu installa il pacchetto `libfuse2t64` (nelle versioni piu vecchie si chiama `libfuse2`):

```bash
sudo apt install libfuse2t64
```

:::tip
Puoi spostare l'AppImage in qualsiasi posizione, ad esempio `~/Applications/`. L'applicazione e completamente autonoma.
:::

## Installazione su Windows

1. Scarica l'installatore `.exe` dal sito web.
2. Esegui l'installatore e segui le istruzioni. Puoi scegliere la directory di installazione.
3. Avvia MailCopilot dal menu Start o dal collegamento sul desktop.

## Primo avvio

Al primo avvio, apparira la procedura guidata di configurazione dell'account. L'applicazione ti guidera nella connessione del tuo primo account di posta elettronica.

Le password sono conservate in modo sicuro nel portachiavi di sistema (keytar) e non vengono mai scritte in file di configurazione in testo normale.

## Aggiornamenti automatici

MailCopilot controlla automaticamente gli aggiornamenti. Quando e disponibile una nuova versione, appare una notifica nell'applicazione. Puoi scaricare l'aggiornamento e riavviare con un clic.

:::note
Gli aggiornamenti automatici in-app sono disponibili solo quando MailCopilot e installato in una posizione scrivibile — ad esempio un AppImage memorizzato nella tua home directory. Quando installato tramite un pacchetto di sistema `.deb` o `.rpm`, la directory di installazione e in genere di proprieta di root e non e scrivibile dal tuo account utente, quindi MailCopilot disabilita automaticamente l'aggiornamento in-app. In tal caso, aggiorna tramite il gestore pacchetti (`apt`/`dnf`) o scaricando e reinstallando l'ultimo pacchetto dal sito web.
:::
