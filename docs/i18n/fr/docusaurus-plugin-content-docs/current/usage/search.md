---
sidebar_position: 5
---

# Recherche

MailCopilot offre des fonctionnalités de recherche puissantes pour trouver n'importe quel e-mail dans tous vos comptes et dossiers.

## Recherche simple

Saisissez du texte dans la barre de recherche en haut de la liste des messages. Les résultats apparaissent instantanément.

## Portée de la recherche

Lors de la recherche, vous pouvez choisir la portée via les boutons sous la barre de recherche :

- **Dossier actuel** — rechercher uniquement dans le dossier affiché.
- **Tous les dossiers** — rechercher dans tous les dossiers du compte actuel.
- **Tous les comptes** — rechercher dans tous les comptes et dossiers connectés.

## Opérateurs de recherche

Utilisez des opérateurs pour des recherches précises :

| Opérateur | Description | Exemple |
|-----------|-------------|---------|
| `from:` | Par expéditeur | `from:alice@example.com` |
| `to:` | Par destinataire | `to:bob@example.com` |
| `subject:` | Par sujet | `subject:réunion` |
| `body:` | Par contenu | `body:facture` |
| `filename:` | Par nom de pièce jointe | `filename:rapport.pdf` |
| `is:unread` | Non lus | `is:unread` |
| `is:starred` | Marqués | `is:starred` |
| `has:attachment` | Avec pièces jointes | `has:attachment` |
| `before:` | Avant une date | `before:2026-01-01` |
| `after:` | Après une date | `after:2025-12-01` |

Combinez les opérateurs avec du texte libre : `from:alice subject:rapport is:unread`.

Utilisez `-` pour exclure : `-from:spam@example.com`.

## Complétude de la recherche

MailCopilot recherche dans votre cache local d'e-mails. L'indicateur de complétude sous la barre de recherche affiche :

- **Couverture des en-têtes** — combien de dossiers sont synchronisés (ex. « En-têtes : 5/8 dossiers synchronisés »).
- **Indexation du texte** — pourcentage de messages avec le texte indexé pour les recherches `body:`.

Les dossiers standard (Boîte de réception, Envoyés, Archive, Brouillons) sont entièrement indexés par défaut. Les dossiers Indésirables, Spam et Corbeille sont exclus de l'indexation en texte intégral par défaut afin de garder des résultats propres et de réduire l'utilisation du disque. Vous pouvez modifier le paramètre d'indexation de n'importe quel dossier via le clic droit dans la barre latérale ou dans **Paramètres > Dossiers**.

## Recherche assistée par le serveur

Lors de la recherche dans un dossier spécifique, MailCopilot peut également interroger le serveur IMAP. Les résultats du serveur sont marqués d'un badge « +N du serveur ».

## Classement par pertinence

Les résultats sont classés par pertinence. Les correspondances dans le sujet sont mieux classées que celles dans le corps du message.
