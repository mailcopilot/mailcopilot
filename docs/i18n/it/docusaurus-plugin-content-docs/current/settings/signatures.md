---
sidebar_position: 3
title: Firme
---

# Firme

## Impostare una firma

Configura la tua firma in **Impostazioni > Firma**. La scheda «Firme» modifica la firma dell'**identita predefinita** dell'account selezionato. Se hai piu account, scegli l'account dal menu a discesa in alto; se l'account ha identita aggiuntive (indirizzi «From» alternativi), ognuna ha la propria firma -- vengono modificate in **Impostazioni > Identities**.

## Scrivere la firma

Inserisci il testo della firma nell'area di testo. Un formato comune include:

```
--
Mario Rossi
Sviluppatore software
ACME S.r.l.
mario.rossi@example.com
```

Il separatore `--` e il delimitatore standard per le firme email, riconosciuto dalla maggior parte dei client.

## Come funzionano le firme

- La firma viene **aggiunta automaticamente** ai nuovi messaggi quando apri la finestra di composizione.
- Le firme **non** vengono aggiunte a risposte e inoltri, per evitare duplicati.
- Se modifichi una bozza che ha gia una firma, quella firma viene conservata.
- L'identita predefinita di ciascun account puo avere una firma propria; le identita aggiuntive hanno anch'esse una firma propria, modificabile in **Impostazioni > Identities**.

## Rimuovere una firma

Per rimuovere una firma, svuota l'area di testo in **Impostazioni > Firma** e salva.

## Firme e identita

Le firme ora vivono per identita, non piu per account. La scheda **Firme** di questa pagina modifica la firma dell'identita predefinita dell'account. Se l'account ha identita aggiuntive (altri indirizzi «From» sullo stesso account, per esempio un alias personale o un alias di team), ognuna ha una firma propria -- modificale in **Impostazioni > Identities**. Vedi [Identita](./identities) per capire come funzionano le identita e come la finestra di composizione ne sceglie una in risposta o in un nuovo messaggio.
