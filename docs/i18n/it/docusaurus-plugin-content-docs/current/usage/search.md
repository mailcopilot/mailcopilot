---
sidebar_position: 5
---

# Ricerca

MailCopilot offre potenti funzionalità di ricerca per trovare qualsiasi email in tutti i tuoi account e cartelle.

## Ricerca semplice

Digita nella barra di ricerca in cima alla lista dei messaggi. I risultati appaiono istantaneamente.

## Ambito di ricerca

Durante la ricerca, puoi scegliere l'ambito tramite i pulsanti sotto la barra di ricerca:

- **Cartella corrente** — cerca solo nella cartella visualizzata.
- **Tutte le cartelle** — cerca in tutte le cartelle dell'account corrente.
- **Tutti gli account** — cerca in tutti gli account e cartelle collegati.

## Operatori di ricerca

Usa gli operatori per ricerche precise:

| Operatore | Descrizione | Esempio |
|-----------|-------------|---------|
| `from:` | Per mittente | `from:alice@example.com` |
| `to:` | Per destinatario | `to:bob@example.com` |
| `subject:` | Per oggetto | `subject:riunione` |
| `body:` | Per contenuto | `body:fattura` |
| `filename:` | Per nome allegato | `filename:rapporto.pdf` |
| `is:unread` | Non letti | `is:unread` |
| `is:starred` | Contrassegnati | `is:starred` |
| `has:attachment` | Con allegati | `has:attachment` |
| `before:` | Prima di una data | `before:2026-01-01` |
| `after:` | Dopo una data | `after:2025-12-01` |

Combina operatori con testo libero: `from:alice subject:rapporto is:unread`.

Usa `-` per escludere: `-from:spam@example.com`.

## Completezza della ricerca

MailCopilot cerca nella cache locale delle email. L'indicatore di completezza mostra:

- **Copertura intestazioni** — quante cartelle sono sincronizzate (es. «Intestazioni: 5/8 cartelle sincronizzate»).
- **Indicizzazione testo** — percentuale di messaggi con testo indicizzato per ricerche `body:`.

Le cartelle standard (Posta in arrivo, Inviati, Archivio, Bozze) sono completamente indicizzate per impostazione predefinita. Le cartelle Posta indesiderata, Spam e Cestino sono escluse dall'indicizzazione full-text per impostazione predefinita, per mantenere i risultati di ricerca ordinati e ridurre l'utilizzo del disco. È possibile modificare l'impostazione di indicizzazione di qualsiasi cartella tramite il clic destro nella barra laterale o in **Impostazioni > Cartelle**.

## Ricerca assistita dal server

Quando cerchi in una cartella specifica, MailCopilot può anche interrogare il server IMAP. I risultati dal server sono contrassegnati con «+N dal server».

## Classificazione per rilevanza

I risultati sono classificati per rilevanza. Le corrispondenze nell'oggetto sono classificate più in alto rispetto a quelle nel corpo del messaggio.
