---
sidebar_position: 3
title: Foto dei mittenti (Gravatar)
---

# Foto dei mittenti (Gravatar)

L'opzione **Mostra le foto dei mittenti (Gravatar)** è disattivata sulle nuove installazioni. Finché lo è, MailCopilot non invia alcuna richiesta a gravatar.com.

Un'installazione aggiornata da una versione precedente alla 1.27.2 mantiene l'impostazione salvata. Le versioni più vecchie attivavano l'opzione per impostazione predefinita e scrivevano quel valore nelle impostazioni, quindi per la maggior parte delle installazioni esistenti è attiva. Se non la vuoi, disattivala come descritto sotto.

## Cosa viene inviato quando l'opzione è attiva

Per ogni indirizzo di mittente mostrato nell'elenco dei messaggi, l'app chiede una foto a `www.gravatar.com`. La richiesta parte direttamente dal tuo computer verso Gravatar. Nessun server di MailCopilot vi partecipa e non passa dal proxy usato per le immagini remote nei messaggi.

Gravatar riceve:

- l'hash SHA-256 dell'indirizzo del mittente (senza spazi, in minuscolo). Chiunque conosca un indirizzo può calcolarne l'hash e associarlo alla richiesta;
- il tuo indirizzo IP e l'ora della richiesta;
- le intestazioni abituali di una richiesta del browser, tra cui uno User-Agent con nome e versione dell'applicazione.

La richiesta non contiene l'intestazione Referer. Gravatar non riceve il testo dei messaggi né gli oggetti. Gli indirizzi dei tuoi account e delle tue identità vengono saltati nell'elenco dei messaggi, quindi da lì i loro hash non vengono inviati.

L'app ricorda in memoria quali mittenti non hanno una foto. Le foto restituite da Gravatar vengono anche salvate nella cache HTTP di Chromium, nella cartella dati dell'applicazione sul tuo disco, come qualsiasi immagine caricata dall'applicazione. Disattivare l'opzione non svuota questa cache.

## Dove modificarla

Impostazioni > Produttività > **Mostra le foto dei mittenti (Gravatar)**.

## L'avatar del tuo account

La modalità avatar **Gravatar** di un account (Impostazioni > Account) è una scelta separata. Selezionandola, la stessa richiesta viene fatta per l'indirizzo di quell'account. Le altre modalità non fanno richieste.
