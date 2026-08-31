---
sidebar_position: 2
title: Produttivita
---

# Impostazioni di produttivita

Notifiche desktop, IMAP IDLE, intervallo di sincronizzazione (1–30 min), sincronizzazione bozze, caricare sempre le immagini esterne, foto dei mittenti (Gravatar), ordine di ordinamento, raggruppamento in conversazioni, preset scorciatoie (Gmail/Outlook), ritardo di invio e modalita offline.

## Notifiche desktop

Attiva o disattiva le notifiche desktop per la nuova posta in arrivo. Se attiva, MailCopilot ti avvisa della nuova posta che arriva in una cartella conteggiata nel [badge dei non letti](general#badge-dei-non-letti) -- per impostazione predefinita la Posta in arrivo, più qualsiasi cartella che hai incluso esplicitamente nel badge -- e solo se quella cartella è impostata su sincronizzazione completa o periodica delle intestazioni. Inoltre, MailCopilot esclude per impostazione predefinita un insieme fisso di cartelle -- Cestino, Spam, Archivio e Bozze -- anche se ne hai incluso esplicitamente una nel badge; questo restringe ulteriormente le notifiche e non le amplia mai oltre la politica del badge. Le cartelle escluse dal badge, o sincronizzate solo su richiesta, non generano mai una notifica anche se vi arriva nuova posta.

Finché la finestra di MailCopilot è in primo piano, non viene mostrata alcuna notifica per la nuova posta: il badge e l'elenco messaggi si aggiornano normalmente, ma l'arrivo non viene interrotto da una notifica, dato che stai già guardando l'app. Se arrivano più messaggi in un breve intervallo di tempo mentre l'app è in background, MailCopilot mostra un'unica notifica per account (per esempio **«5 nuovi messaggi»**) invece di una notifica per messaggio -- se due account ricevono posta contemporaneamente, riceverai comunque due notifiche distinte; cliccando su una notifica si apre quel messaggio. Nelle build di macOS non firmate, il sistema operativo potrebbe non consentire affatto la visualizzazione delle notifiche.

## Modalita offline

Scarica i messaggi per leggerli senza connessione a Internet. La modalita offline viene configurata **per cartella** nella scheda [Cartelle](folders-settings#offline-mode) — puoi abilitarla per Posta in arrivo, Inviata o qualsiasi altra cartella individualmente.

La scheda Produttivita contiene solo il limite di dimensione globale:

- **Dimensione massima messaggio** — salta i messaggi piu grandi di questa dimensione (0 = nessun limite, in KB).
- **Sincronizza ora** — avvia manualmente una sincronizzazione offline per tutte le cartelle abilitate.

Quando apri un messaggio offline, MailCopilot mostra le intestazioni memorizzate nella cache (oggetto, mittente, data) e un indicatore che il corpo del messaggio non e disponibile. Una volta riconnesso, il messaggio completo si carica normalmente.

## Ordine di ordinamento

Scegli l'ordine di ordinamento dell'elenco messaggi:

- **Per data** (predefinito) -- i messaggi piu recenti per primi.
- **Per mittente** -- in ordine alfabetico per nome del mittente.
- **Per oggetto** -- in ordine alfabetico per oggetto.

## Avanzamento automatico

Scegli cosa succede dopo aver archiviato, eliminato o posticipato un messaggio:

- **Apri email piu vecchia** (predefinito) -- apre automaticamente il messaggio successivo piu vecchio.
- **Apri email piu recente** -- apre il messaggio piu recente successivo.
- **Torna alla lista** -- chiude i dettagli e torna all'elenco messaggi.
- **Resta (non fare nulla)** -- mantiene la vista corrente senza messaggio attivo.

Funziona particolarmente bene con [Invia e archivia](../usage/composing-emails#send--archive) per un flusso di lavoro inbox-zero.

## Foto dei mittenti (Gravatar)

Quando abilitato (impostazione predefinita), MailCopilot mostra le foto del profilo accanto ai nomi dei mittenti nell'elenco dei messaggi. Le foto vengono caricate da [Gravatar](https://gravatar.com). Se un mittente non ha un profilo Gravatar, viene mostrato un cerchio colorato con le sue iniziali.

Disattiva questa opzione se preferisci avatar con sole iniziali o se vuoi evitare richieste di rete durante la navigazione della posta.

## Modalità scura per il contenuto delle email

Con il tema scuro, il contenuto HTML delle email può essere difficile da leggere poiché molte email sono progettate per uno sfondo bianco. Attivare questa opzione (attivata per impostazione predefinita) per invertire automaticamente i colori del contenuto delle email in modalità scura e consentire una lettura confortevole.

Immagini, video e altri media mantengono i colori originali — vengono invertiti solo il testo e lo sfondo.
