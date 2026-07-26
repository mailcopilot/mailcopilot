---
sidebar_position: 4
title: Impostazioni delle cartelle
---

# Impostazioni delle cartelle

Apri **Impostazioni > Cartelle** per configurare come MailCopilot gestisce le tue cartelle di posta elettronica.

## Assegnazione dei ruoli delle cartelle

MailCopilot ha bisogno di sapere quale cartella del server corrisponde a ciascun ruolo speciale (Archivio, Cestino, Inviati, Bozze, Spam). Il rilevamento è automatico in base agli attributi IMAP standard, ma puoi modificare l'assegnazione manualmente.

Per ciascun ruolo, puoi:
- Lasciare **Auto** per usare la cartella rilevata automaticamente.
- Selezionare una cartella specifica dall'elenco a discesa.
- Fare clic su **Crea** per creare la cartella standard sul server se non esiste.

## Politica di sincronizzazione delle cartelle

Sotto l'assegnazione dei ruoli troverai una configurazione dettagliata per ogni cartella del tuo account:

### Visibilità

- **Mostra nella barra laterale** -- determina se la cartella appare nella barra laterale. Deseleziona per nascondere le cartelle usate raramente.

### Badge dei non letti

- **Includi nei badge dei non letti** -- determina se il conteggio dei messaggi non letti di questa cartella viene incluso nel badge totale dell'applicazione.

### Indicizzazione per la ricerca

- **Includi nella ricerca** -- determina se i corpi dei messaggi di questa cartella vengono indicizzati per la ricerca full-text. Quando disattivato, la cartella rimane visibile nell'elenco dei messaggi e le sue intestazioni sono ricercabili, ma le query `body:` non restituiranno risultati da essa.

Le cartelle Posta indesiderata, Spam e Cestino hanno l'indicizzazione di ricerca disattivata per impostazione predefinita, per evitare di appesantire i risultati di ricerca e ridurre l'utilizzo del disco. È possibile attivare l'indicizzazione per qualsiasi cartella se necessario.

### Modalità di sincronizzazione delle intestazioni

Controlla come vengono sincronizzate le intestazioni dei messaggi per la cartella:

- **Tutti i messaggi** -- sincronizza tutte le intestazioni (consigliato per la posta in arrivo).
- **All'apertura** -- sincronizza le intestazioni solo quando accedi alla cartella.
- **Per periodo** -- sincronizza le intestazioni degli ultimi N giorni.

Per interrompere completamente la sincronizzazione di una cartella, nascondila tramite **Nascondi dalla barra laterale** nel menu contestuale. Le cartelle nascoste sono completamente escluse dalla sincronizzazione delle intestazioni, dall'archiviazione offline e dai badge.

### Modalità offline {#offline-mode}

Controlla il download dei corpi dei messaggi per la lettura offline:

- **Disattivato** -- non scaricare i corpi dei messaggi.
- **Per periodo** -- scarica i corpi degli ultimi N giorni.
- **Tutti i messaggi** -- scarica tutti i corpi dei messaggi.

## Selezione dell'account

Se hai più account, usa il selettore in alto per passare da un account all'altro e configurare le cartelle di ciascuno separatamente.
