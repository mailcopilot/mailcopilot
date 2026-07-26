---
sidebar_position: 4
title: Identities
---

# Identità

Un singolo account di posta può avere più **identità**, cioè indirizzi «From» alternativi da cui inviare i messaggi. Questo è utile per account Gmail o Microsoft 365 nei quali, oltre all'indirizzo principale, esistono alias (un alias personale, un alias di team, un vecchio indirizzo «vanity») e si desidera che ciascuno abbia un proprio nome visualizzato, una propria firma e proprie regole di Bcc senza dover registrare ogni alias come account IMAP separato.

## Cosa contiene un'identità

Ogni identità comprende:

- Un **nome visualizzato**: ciò che il destinatario vede nell'intestazione «From».
- Un **indirizzo email**: l'indirizzo effettivamente usato nel campo «From». L'account sottostante deve essere autorizzato a inviare da tale indirizzo.
- Una **firma** facoltativa: sostituisce la firma a livello di account quando questa identità è selezionata. Vedi [Firme](./signatures) per il comportamento delle firme nelle risposte e negli inoltri.
- Un **Bcc predefinito** facoltativo: viene aggiunto automaticamente al campo Bcc ogni volta che questa identità è selezionata nella finestra di composizione.
- Un **flag di identità predefinita**: esattamente un'identità per account è la principale. L'identità predefinita viene usata quando nessuna regola più specifica si applica.

Ogni account ha sempre almeno un'identità. Al primo accesso, MailCopilot crea un'unica identità predefinita partendo da nome account, email e firma esistente.

## Gestire le identità

Apri **Impostazioni > Identities** e scegli l'account dal menu a discesa in alto. La scheda mostra l'elenco delle identità di quell'account con i comandi per:

- **Aggiungere** una nuova identità. Compila nome visualizzato, email, firma e Bcc predefinito; segnala se vuoi impostarla come predefinita.
- **Modificare** un'identità esistente per cambiare qualunque campo.
- **Imposta come predefinita**: promuovere un'identità a principale. Solo un'identità per volta può essere quella predefinita.
- **Eliminare** un'identità. L'identità predefinita non può essere eliminata; promuovi prima un'altra identità a predefinita.

## Scegliere un'identità in fase di composizione

La finestra di composizione include un selettore d'identità subito sotto il menu a discesa dell'account «From». Per impostazione predefinita, MailCopilot sceglie un'identità per te con il seguente ordine:

1. **Risposte e inoltri**: confronto con gli indirizzi From, To e Cc del messaggio originale. Vince la prima identità la cui email compare in qualsiasi punto di quella lista, in modo che la risposta parta dallo stesso indirizzo a cui hai ricevuto originariamente il messaggio. Il confronto è case-insensitive sull'intera email; catene di alias e varianti con plus-addressing non sono riconosciute e ricadono sull'identità predefinita.
2. **Nuovi messaggi**: viene selezionata l'identità predefinita dell'account.

Puoi sempre forzare la scelta aprendo il menu a discesa e selezionando un'altra identità. Il cambio di identità aggiorna l'intestazione «From». La firma viene sostituita solo se il corpo è vuoto o contiene unicamente un blocco firma dopo il separatore standard `\n\n--\n` -- il testo che hai digitato sopra il separatore non viene mai sovrascritto. Il campo Bcc viene sostituito solo se è vuoto o coincide ancora con il Bcc predefinito dell'identità precedentemente selezionata, perciò un Bcc digitato a mano sopravvive al cambio di identità.

## Rapporto con le firme

Le firme ora vivono **per identità**, non più per account. La scheda **Impostazioni > Firme** modifica la firma dell'identità predefinita dell'account selezionato; le identità non predefinite si modificano in **Impostazioni > Identities**. Gli account creati prima del rilascio multi-identità conservano la loro vecchia firma per account: MailCopilot la legge tramite un'identità predefinita sintetizzata, quindi nulla si rompe. La nuova lista di identità viene scritta su disco al successivo salvataggio dell'account (per esempio quando modifichi un qualsiasi campo dell'account).

## Invio e tracciamento

L'identità attiva nella finestra di composizione al momento dell'invio è quella che compare nel messaggio uscente effettivo:

- L'intestazione «From» di SMTP o Microsoft Graph porta l'email e il nome visualizzato dell'identità.
- Gli invii pianificati ricordano l'identità scelta al momento della pianificazione: un messaggio pianificato dal tuo alias parte da quell'alias anche quando il timer scatta.
