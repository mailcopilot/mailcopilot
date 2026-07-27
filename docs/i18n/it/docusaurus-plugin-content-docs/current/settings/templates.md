---
sidebar_position: 5
title: Modelli
---

# Modelli

La scheda Modelli nelle Impostazioni ti permette di creare, modificare ed eliminare modelli di messaggio riutilizzabili.

## Creare un modello

1. Vai su **Impostazioni > Modelli**.
2. Clicca sul pulsante **Aggiungi modello**.
3. Compila i campi:
   - **Nome** -- un nome breve per identificare il modello (ad es. "Risposta rapida").
   - **Oggetto** -- l'oggetto dell'email, ad es. `Re: {subject}` (facoltativo).
   - **Corpo** -- il testo del messaggio, ad es. `Ciao {name}, grazie per avermi contattato…`
   - **Scorciatoia** -- una parola chiave breve opzionale per trovare rapidamente il modello.
4. Clicca su **Salva**.

## Modificare un modello

Clicca sull'**icona della matita** accanto a un modello per modificarlo. Dopo aver apportato le modifiche, clicca su **Salva** per aggiornare il modello.

## Eliminare un modello

Clicca sull'**icona del cestino** accanto a un modello per eliminarlo. I modelli eliminati non possono essere recuperati.

## Variabili dei modelli

Puoi utilizzare variabili nell'oggetto e nel corpo del modello. Queste variabili vengono sostituite automaticamente quando applichi il modello nella finestra di composizione:

| Variabile | Sostituita con |
|-----------|----------------|
| `{name}` | Il nome del destinatario |
| `{email}` | L'indirizzo email del destinatario |
| `{date}` | La data odierna |

### Esempio

**Corpo del modello:**
```
Gentile {name},

Grazie per la tua email. La esaminero e ti rispondero al piu presto.

Cordiali saluti
```

Quando applicato a un messaggio indirizzato a "Alice Rossi", la variabile `{name}` verra sostituita con "Alice Rossi".

## Utilizzare i modelli

Per utilizzare un modello durante la composizione di un messaggio, consulta [Comporre email > Utilizzare i modelli](../usage/composing-emails#utilizzare-i-modelli).
