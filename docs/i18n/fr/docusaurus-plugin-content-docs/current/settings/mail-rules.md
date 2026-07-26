---
sidebar_position: 5
title: Règles de messagerie
---

# Règles de messagerie

Les règles de messagerie vous permettent de trier et d'organiser automatiquement les e-mails entrants selon des conditions que vous définissez. Les règles sont évaluées à chaque réception de nouveaux messages.

## Créer une règle

1. Ouvrez **Paramètres > Règles**.
2. Cliquez sur **Ajouter une règle**.
3. Donnez un nom à votre règle.
4. Choisissez le compte auquel la règle s'applique (ou sélectionnez « Tous les comptes »).

### Conditions

Chaque règle comporte une ou plusieurs conditions. Toutes les conditions doivent correspondre pour que la règle se déclenche (logique ET). Si vous avez besoin d'une logique OU, créez des règles séparées.

Champs de condition disponibles :
- **De** — nom ou adresse de l'expéditeur.
- **À** — adresse du destinataire.
- **CC** — adresse en copie.
- **Objet** — l'objet de l'e-mail.
- **Contient une pièce jointe** — si l'e-mail a des pièces jointes.

Opérateurs disponibles :
- **contient** / **ne contient pas** — correspondance partielle.
- **est égal à** — correspondance exacte.
- **commence par** / **se termine par** — correspondance par préfixe ou suffixe.
- **correspond à l'expression régulière** — recherche avancée par motif à l'aide d'expressions régulières.

### Actions

Lorsqu'une règle correspond, une ou plusieurs actions sont effectuées :

- **Archiver** — déplacer vers le dossier Archive.
- **Mettre à la corbeille** — déplacer vers le dossier Corbeille.
- **Déplacer vers un dossier** — déplacer vers un dossier spécifique de votre choix.
- **Marquer comme lu** — marquer automatiquement l'e-mail comme lu.
- **Marquer d'une étoile** — signaler l'e-mail avec un drapeau.
- **Marquer comme spam** — déplacer vers le dossier Spam.

### Arrêter le traitement

Si vous activez **« Arrêter le traitement des règles suivantes »**, aucune règle supplémentaire ne sera évaluée après le déclenchement de celle-ci. Cela est utile lorsque vous avez une règle générale et que vous souhaitez éviter qu'elle ne remplace des règles plus spécifiques.

## Tester les règles

Avant d'enregistrer une règle, cliquez sur **« Tester sur les e-mails existants »** pour voir lesquels de vos e-mails existants correspondent aux conditions. Cela vous aide à vérifier que la règle fonctionne comme prévu avant de l'appliquer aux nouveaux messages.

## Appliquer aux e-mails existants

Cochez **« Appliquer aux e-mails existants dans la boîte de réception »** lors de l'enregistrement d'une règle pour l'appliquer immédiatement aux e-mails déjà présents dans votre boîte de réception.

## Priorité des règles

Les règles sont évaluées par ordre de priorité (nombre plus petit = priorité plus élevée). Vous pouvez ajuster la priorité lors de la modification d'une règle. Si deux règles ont la même priorité, elles sont évaluées dans l'ordre de création.

## Règles IA

Si vous avez configuré un fournisseur d'IA (voir [Assistant IA](../ai-assistant)), vous pouvez également créer des règles basées sur l'IA. Les règles IA traitent les e-mails qui ne correspondent à aucune règle statique.

### Comment fonctionnent les règles IA

1. Vous rédigez un prompt décrivant comment trier les e-mails (par exemple, « Archiver les newsletters, déplacer les e-mails de recruteurs dans le dossier Emploi »).
2. Vous choisissez les actions que l'IA est autorisée à effectuer.
3. Vous définissez une limite de budget journalier pour contrôler les coûts.
4. L'IA évalue les e-mails non traités par lots. Elle applique automatiquement uniquement les actions réversibles (archiver, déplacer, marquer comme lu, marquer d'une étoile) ; les actions de mise à la corbeille et de marquage comme spam sont enregistrées comme des aperçus en attente que vous devez appliquer vous-même.

Les actions des règles IA sont enregistrées afin que vous puissiez consulter quelle action a été appliquée ou proposée pour chaque e-mail.

### Les nouvelles règles IA démarrent désactivées

Une règle IA nouvellement créée est **désactivée par défaut**. Activez **« Activé »** sur la règle une fois que vous avez vérifié son prompt et les actions autorisées, pour commencer à l'appliquer au courrier entrant. Cela évite qu'une règle n'agisse sur votre boîte de réception avant que vous n'ayez confirmé qu'elle se comporte comme prévu.

### Limite de règles activées par compte

Vous pouvez activer au maximum **20 règles IA par compte** (les règles globales, qui s'appliquent à tous les comptes, comptent dans la limite de chaque compte). Si vous essayez d'activer une règle au-delà de cette limite, l'application affiche un message et la règle reste désactivée — désactivez d'abord une autre règle. Cette limite garantit que le tri automatique en arrière-plan reste rapide et prévisible : toutes les règles activées pour un compte sont évaluées ensemble en une seule passe.

### Les actions destructrices nécessitent une vérification

Les actions réversibles -- archiver, déplacer vers un dossier, marquer comme lu, marquer d'une étoile -- sont appliquées automatiquement lorsqu'une règle IA correspond. **Mettre à la corbeille** et **Marquer comme spam** ne sont jamais appliquées automatiquement : l'IA enregistre à la place l'action proposée comme une entrée en attente dans le journal des actions de la règle. Pour exécuter une action de mise à la corbeille ou de marquage comme spam proposée, vous devez ouvrir l'entrée et l'appliquer explicitement -- rien n'est supprimé ni marqué comme spam tant que vous ne l'avez pas fait. Cela empêche l'IA de supprimer définitivement des e-mails de votre boîte de réception sans votre confirmation.

### Les règles ne voient que leur propre compte

Une règle IA associée à un compte spécifique évalue et agit uniquement sur les e-mails de ce compte. Elle ne voit et n'affecte jamais les messages de vos autres comptes.
