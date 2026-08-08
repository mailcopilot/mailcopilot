---
sidebar_position: 5
title: Règles de messagerie
---

# Règles de messagerie

Les règles de messagerie vous permettent de trier et d'organiser automatiquement les e-mails entrants selon des conditions que vous définissez. Les règles s'exécutent chaque fois que MailCopilot récupère le courrier sur le serveur, pas nécessairement au moment exact où un message y arrive.

## Créer une règle

1. Ouvrez **Paramètres > Règles**.
2. Cliquez sur **Ajouter une règle**.
3. Donnez un nom à votre règle.
4. Choisissez le compte auquel la règle s'applique (ou sélectionnez « Tous les comptes »).

### Conditions

Chaque règle comporte une ou plusieurs conditions. Toutes les conditions doivent correspondre pour que la règle se déclenche (logique ET). Si vous avez besoin d'une logique OU, créez des règles séparées.

Champs de condition disponibles :
- **Expéditeur** — comparé au nom d'affichage de l'expéditeur lorsque le message en a un, et à son adresse seulement en l'absence de nom d'affichage. Une règle ciblant une adresse peut cesser de se déclencher dès que cet expéditeur commence à utiliser un nom d'affichage — testez la règle après l'avoir configurée et surveillez si elle cesse de fonctionner.
- **Destinataire** — adresse du destinataire.
- **Cc** — présent dans l'éditeur de règles, mais MailCopilot ne stocke pas le champ Cc des e-mails mis en cache, donc chaque message apparaît avec un Cc vide aux yeux d'une règle. La condition se comporte alors de façon imprévisible plutôt que de simplement « ne pas fonctionner » : faire correspondre une adresse précise en Cc ne réussit jamais, mais un opérateur d'exclusion comme **ne contient pas**, ou une expression régulière qui correspond à une chaîne vide, correspond au contraire à **tous** les messages. N'utilisez pas de condition sur le Cc dans une règle qui met à la corbeille, marque comme spam ou déplace le courrier vers un autre dossier -- avec le mauvais opérateur, elle peut agir sur toute votre boîte de réception.
- **Objet** — l'objet de l'e-mail.
- **Contient une pièce jointe** — si l'e-mail a des pièces jointes.

Opérateurs disponibles :
- **contient** / **ne contient pas** — correspondance partielle.
- **est égal à** — correspondance exacte.
- **commence par** / **se termine par** — correspondance par préfixe ou suffixe.
- **correspond au regex** — recherche avancée par motif à l'aide d'expressions régulières.

### Actions

Lorsqu'une règle correspond, une ou plusieurs actions sont effectuées :

- **Archiver** — déplacer vers le dossier Archive.
- **Mettre à la corbeille** — déplacer vers le dossier Corbeille.
- **Déplacer vers le dossier** — déplacer vers un dossier spécifique de votre choix.
- **Marquer comme lu** — marquer automatiquement l'e-mail comme lu.
- **Marquer d'une étoile** — signaler l'e-mail avec un drapeau.
- **Marquer comme spam** — déplacer vers le dossier Spam.

### Arrêter le traitement

Si vous activez **« Arrêter le traitement des règles suivantes »**, aucune règle supplémentaire ne sera évaluée après le déclenchement de celle-ci. Cela est utile lorsque vous avez une règle générale et que vous souhaitez éviter qu'elle ne remplace des règles plus spécifiques.

## Tester les règles

Avant d'enregistrer une règle, cliquez sur **« Tester sur les e-mails existants »** pour prévisualiser lesquels de vos e-mails récents de la boîte de réception correspondraient aux conditions. L'aperçu vérifie jusqu'à 500 e-mails de la boîte de réception déjà téléchargés sur cet appareil et affiche jusqu'à 20 correspondances -- c'est une vérification rapide, pas une recherche exhaustive dans toute votre boîte de messagerie. Pour une règle limitée à un seul compte, ce sont vos e-mails les plus récents ; pour une règle portant sur tous les comptes, les 500 e-mails vérifiés proviennent de l'ensemble de vos comptes mais ne sont pas nécessairement les plus récents dans l'absolu. Les e-mails plus anciens et ceux pas encore téléchargés sur cet appareil ne sont pas inclus.

## Appliquer aux e-mails existants

Cochez **« Appliquer aux e-mails existants dans la boîte de réception »** lors de l'enregistrement d'une règle pour l'exécuter immédiatement sur les e-mails que vous avez déjà. Cela couvre jusqu'à 1 000 e-mails de la boîte de réception déjà téléchargés sur cet appareil -- pour une règle limitée à un seul compte, vos e-mails les plus récents de ce type ; pour une règle portant sur tous les comptes, jusqu'à 1 000 e-mails provenant de l'ensemble de vos comptes, pas nécessairement les plus récents dans l'absolu. Cela ne remonte pas plus loin dans votre historique de messagerie sur le serveur, et cela ne concerne que la boîte de réception, pas les autres dossiers. Si une action échoue, seule cette action est ignorée -- les autres actions de la même règle continuent de s'exécuter pour cet e-mail, et le reste de l'opération se termine quand même.

## Uniquement les nouveaux e-mails

Les règles s'appliquent à un nouvel e-mail dès qu'il arrive sur votre appareil, quel que soit le moyen par lequel il y est arrivé -- notification push, synchronisation périodique ou une page contenant des e-mails plus récents que ceux déjà vus. Le moyen par lequel un message arrivait pouvait auparavant faire qu'une règle le manque complètement ; cet écart est désormais comblé. En revanche, remonter dans l'historique en faisant défiler la liste ne fait pas passer ces anciens e-mails par les règles -- c'est voulu, il s'agit du même comportement « pas d'exploration de l'historique » décrit plus bas, pas d'un écart qui subsisterait.

Cette garantie pour les nouveaux e-mails n'est cependant pas absolue en toute circonstance : un e-mail dont l'action échoue trois fois de suite (par exemple à cause d'une connexion interrompue) est abandonné pour de bon -- MailCopilot le passe et poursuit dans ce dossier, si bien qu'un redémarrage ultérieur ne le fera pas réapparaître. Ce qu'un redémarrage réinitialise réellement, c'est un compteur qui n'a pas encore atteint trois : si l'application redémarre avant qu'un e-mail n'ait échoué trois fois de suite, le compte repart de zéro, si bien qu'une action qui échoue sans cesse pour une raison qui persiste peut bloquer indéfiniment le traitement d'un dossier, sans jamais réellement atteindre cette limite de trois tentatives.

Par ailleurs, les règles n'explorent jamais l'historique complet d'un dossier de leur propre initiative. Chaque dossier que MailCopilot connaît déjà au démarrage reçoit immédiatement un point de départ, avant même toute synchronisation -- un dossier vide reçoit un point de départ à zéro, si bien que son tout premier e-mail est évalué normalement ; un dossier qui contient déjà des e-mails en cache reçoit un point de départ situé après ces e-mails, de sorte que le courrier déjà présent n'est pas repris, mais que tout ce qui arrive ensuite l'est. Un dossier qui n'apparaît qu'après ce démarrage -- nouvellement créé ou nouvellement abonné -- est traité différemment : rien n'y est évalué tant que MailCopilot ne l'a pas synchronisé une première fois, et seuls les e-mails arrivant après cette première synchronisation comptent. Le même nouveau départ se produit si le serveur réinitialise un jour la numérotation des messages d'un dossier (rare, mais cela peut se produire après certaines migrations côté serveur). Utilisez **« Appliquer aux e-mails existants dans la boîte de réception »** (voir ci-dessus) si vous souhaitez qu'une règle évalue aussi les e-mails que vous avez déjà.

## Priorité des règles

Les règles sont évaluées par ordre de priorité (nombre plus petit = priorité plus élevée). La priorité est attribuée automatiquement à la création d'une règle -- il n'existe actuellement aucun moyen de la modifier depuis l'éditeur de règles. Si deux règles ont la même priorité, l'ordre dans lequel elles s'exécutent n'est pas défini.

## Règles IA

Si vous avez configuré un fournisseur d'IA (voir [Assistant IA](../ai-assistant)), vous pouvez également créer des règles basées sur l'IA. Les règles IA traitent les e-mails qui ne correspondent à aucune règle statique.

### Comment fonctionnent les règles IA

1. Vous rédigez un prompt décrivant comment trier les e-mails (par exemple, « Archiver les newsletters, déplacer les e-mails de recruteurs dans le dossier Emploi »).
2. Vous choisissez les actions que l'IA est autorisée à effectuer.
3. Vous définissez une limite de budget journalier pour contrôler les coûts.
4. L'IA évalue les e-mails non traités par lots. Elle applique automatiquement uniquement les actions réversibles (archiver, déplacer, marquer comme lu, marquer d'une étoile) ; les actions de mise à la corbeille et de marquage comme spam sont enregistrées comme des aperçus en attente que vous devez appliquer vous-même.

Les actions des règles IA sont enregistrées afin que vous puissiez consulter quelle action a été appliquée ou proposée pour chaque e-mail.

### Les nouvelles règles IA démarrent désactivées

Une règle IA nouvellement créée est **désactivée par défaut**. Activez **« Activée »** sur la règle une fois que vous avez vérifié son prompt et les actions autorisées, pour commencer à l'appliquer au courrier entrant. Cela évite qu'une règle n'agisse sur votre boîte de réception avant que vous n'ayez confirmé qu'elle se comporte comme prévu.

### Limite de règles activées par compte

Vous pouvez activer au maximum **20 règles IA par compte** (les règles globales, qui s'appliquent à tous les comptes, comptent dans la limite de chaque compte). Si vous essayez d'activer une règle au-delà de cette limite, l'application affiche un message et la règle reste désactivée — désactivez d'abord une autre règle. Cette limite garantit que le tri automatique en arrière-plan reste rapide et prévisible : toutes les règles activées pour un compte sont évaluées ensemble en une seule passe.

### Les actions destructrices nécessitent une vérification

Les actions réversibles -- archiver, déplacer vers un dossier, marquer comme lu, marquer d'une étoile -- sont appliquées automatiquement lorsqu'une règle IA correspond. **Mettre à la corbeille** et **Marquer comme spam** ne sont jamais appliquées automatiquement : l'IA enregistre à la place l'action proposée comme une entrée en attente dans le journal des actions de la règle. Pour exécuter une action de mise à la corbeille ou de marquage comme spam proposée, vous devez ouvrir l'entrée et l'appliquer explicitement -- rien n'est supprimé ni marqué comme spam tant que vous ne l'avez pas fait. Cela empêche l'IA de supprimer définitivement des e-mails de votre boîte de réception sans votre confirmation.

### Les règles ne voient que leur propre compte

Une règle IA associée à un compte spécifique évalue et agit uniquement sur les e-mails de ce compte. Elle ne voit et n'affecte jamais les messages de vos autres comptes.
