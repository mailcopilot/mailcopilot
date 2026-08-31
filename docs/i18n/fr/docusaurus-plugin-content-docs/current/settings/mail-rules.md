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
- **Expéditeur — adresse** — comparé uniquement à l'adresse e-mail de l'expéditeur. Si une règle qui déplace, archive, supprime un e-mail ou le marque comme spam filtre sur l'expéditeur, c'est le seul champ d'expéditeur que MailCopilot l'autorise à utiliser -- voir ci-dessous.
- **Expéditeur — nom affiché** — comparé uniquement au nom d'affichage de l'expéditeur, le texte libre qui apparaît à côté de l'adresse (par exemple « Jean Dupont » dans `Jean Dupont <jean@example.com>`). Limite connue : si le nom d'affichage enregistré d'un expéditeur est textuellement identique à sa propre adresse, MailCopilot considère que cet expéditeur n'a aucun nom d'affichage, et cette condition ne correspondra donc pas -- comparez plutôt avec **Expéditeur — adresse** pour cet expéditeur. MailCopilot ne laisse pas ce champ piloter une règle qui déplace, archive, supprime un e-mail ou le marque comme spam -- voir ci-dessous.
- **Expéditeur — nom ou adresse (obsolète)** — le champ combiné d'origine : il correspond si le nom d'affichage *ou* l'adresse correspond (**ne contient pas** fait exception -- voir ci-dessous). Son comportement de correspondance a changé lorsque le champ ci-dessus a été scindé en **Expéditeur — adresse** et **Expéditeur — nom affiché** : il comparait auparavant une seule valeur -- le nom d'affichage, en se rabattant sur l'adresse seulement quand l'expéditeur n'avait pas de nom d'affichage défini -- si bien qu'une règle sur ce champ ne correspondait jamais par adresse pour un expéditeur ayant une signature. Il compare désormais toujours les deux valeurs ensemble, donc une règle déjà configurée sur ce champ peut se mettre à correspondre à des messages auxquels elle ne correspondait pas avant (et, pour **ne contient pas**, peut cesser d'exclure des messages qu'elle excluait auparavant). Si vous avez des règles existantes sur ce champ, vérifiez ce à quoi elles correspondent désormais, en particulier celles qui déplacent, suppriment ou marquent le courrier comme spam. Il n'est plus proposé pour les nouvelles conditions -- voir « Champ obsolète » ci-dessous. **Ne contient pas** sur ce champ fait exception : comme cela signifie « ne doit correspondre à aucun des deux », le texte doit être absent à la fois du nom d'affichage et de l'adresse. Ainsi, une règle « ne contient pas example.com » ne correspondra pas à un message dont le nom d'affichage contient ce texte, même si son adresse ne le contient pas.
- **Destinataire** — adresse du destinataire.
- **Cc** — n'est plus proposé lorsque vous ajoutez une nouvelle condition. MailCopilot ne stocke pas le champ Cc des e-mails mis en cache, donc une condition sur ce champ ne pouvait en réalité jamais être vérifiée, et selon l'opérateur elle se comportait de façon imprévisible plutôt que de simplement « ne pas fonctionner » : faire correspondre une adresse précise en Cc ne réussissait jamais, mais un opérateur d'exclusion comme **ne contient pas**, ou une expression régulière qui correspond à une chaîne vide, correspondait au contraire à **tous** les messages -- une règle censée cibler une poignée de messages pouvait vider toute une boîte de réception. Si une règle que vous avez configurée avant ce changement comporte encore une condition sur le Cc, elle continue d'apparaître dans l'éditeur de règles avec un avertissement indiquant que la condition ne peut jamais être satisfaite, si bien que la règle ne correspond plus à rien et ne s'exécute plus -- mais la règle elle-même reste dans votre liste, inchangée, jusqu'à ce que vous l'ouvriez pour la modifier, et la liste des règles elle-même la marque d'un badge **« Non appliquée »**, afin que vous n'ayez pas besoin d'ouvrir la règle pour vous en rendre compte (voir « Règles marquées comme non appliquées » ci-dessous). L'ouvrir dans l'éditeur et l'enregistrer est refusé, tout comme activer **« Appliquer aux e-mails existants dans la boîte de réception »** pour elle, tant que vous n'avez pas supprimé la condition sur le Cc ou ne l'avez pas remplacée par un champ pris en charge. Vous n'êtes pas bloqué pour autant : la case à cocher à côté de la règle dans la liste continue de l'activer ou de la désactiver, et la supprimer depuis la liste fonctionne toujours aussi.
- **Objet** — l'objet de l'e-mail.
- **Contient une pièce jointe** — si l'e-mail a des pièces jointes.

Opérateurs disponibles :
- **contient** / **ne contient pas** — correspondance partielle.
- **est égal à** — correspondance exacte.
- **commence par** / **se termine par** — correspondance par préfixe ou suffixe.
- **correspond au regex** — recherche avancée par motif à l'aide d'expressions régulières.

### Le nom affiché peut être falsifié

Un expéditeur contrôle entièrement son propre nom affiché -- c'est un texte libre qu'il définit lui-même, et non quelque chose que le serveur de messagerie vérifie. Cela signifie qu'un expéditeur peut définir son nom affiché pour qu'il se lise exactement comme une adresse, par exemple `user@example.com`, quelle que soit l'adresse réellement indiquée dans l'en-tête `From:` du message. Une règle telle que « Expéditeur — nom affiché est égal à user@example.com » correspond à ce nom affiché en lui-même, indépendamment de l'adresse -- tout comme la même condition sur **Expéditeur — nom ou adresse (obsolète)**, puisque ce champ vérifie lui aussi le nom affiché.

L'adresse et le nom affiché sont stockés et comparés séparément, donc le texte qu'un expéditeur saisit dans le nom affiché n'est jamais lu comme une adresse -- mais cela ne rend pas l'adresse fiable pour autant : l'expéditeur rédige l'en-tête `From:` en entier, adresse comprise, elle est donc tout aussi falsifiable (voir ci-dessous). Ce que cette séparation vous apporte est plus restreint : si une règle qui déplace, archive, supprime un e-mail ou le marque comme spam filtre sur l'expéditeur, et que ce filtre porte sur **Expéditeur — nom affiché** ou sur le champ obsolète, MailCopilot la refuse -- une règle combinant l'un de ces champs avec **Mettre à la corbeille**, **Marquer comme spam**, **Archiver** ou **Déplacer vers le dossier** ne peut pas être enregistrée. Il s'agit uniquement du champ utilisé par une condition sur l'*expéditeur* ; une règle qui effectue l'une de ces actions sans filtrer du tout sur l'expéditeur -- par objet, destinataire ou pièce jointe, par exemple -- n'est pas concernée. Si une règle existante a déjà cette combinaison -- datant d'avant cette restriction --, l'ouvrir dans l'éditeur et l'enregistrer est refusé, tout comme lancer **« Appliquer aux e-mails existants dans la boîte de réception »** sur elle ; le message nomme le champ et l'action à l'origine du refus et vous oriente à la place vers **Expéditeur — adresse**. Tant que vous n'avez pas corrigé cela, cette règle cesse elle aussi de correspondre aux nouveaux e-mails -- mais pas discrètement : la liste des règles la marque d'un badge **« Non appliquée »**, afin que vous n'ayez pas besoin de l'ouvrir pour vous en rendre compte (voir « Règles marquées comme non appliquées » ci-dessous). **Cela dit, vous n'êtes pas bloqué : la case à cocher à côté de la règle dans la liste continue de l'activer ou de la désactiver, quel que soit le refus -- c'est le moyen le plus rapide d'arrêter une règle que vous ne pouvez pas enregistrer autrement.** Supprimer la règle depuis la liste fonctionne aussi toujours. La restriction elle-même ne concerne pas **Marquer comme lu** ni **Marquer d'une étoile** : ni l'un ni l'autre ne peut détruire ou masquer un e-mail, donc un expéditeur falsifié qui déclenche l'une de ces actions ne vous coûte rien d'irréversible, et les deux champs peuvent toujours les piloter.

Il vaut la peine de préciser ce que **Expéditeur — adresse** prouve et ne prouve pas, puisque c'est le champ vers lequel cette restriction vous oriente : ce n'est pas une garantie que le message provient réellement de cette adresse. Elle est lue directement dans l'en-tête `From:` du message, et MailCopilot ne vérifie pas cet en-tête de façon cryptographique -- le contrôler via des signatures DKIM ou DMARC est un travail distinct, pas encore mis en œuvre -- donc un message peut toujours revendiquer n'importe quelle adresse à cet endroit, tout aussi librement qu'un nom affiché. Ce que la correspondance sur ce champ vous apporte est plus restreint mais bien réel : comme l'adresse et le nom affiché sont des champs distincts, un nom affiché qu'un expéditeur a saisi pour ressembler à une adresse n'est jamais comparé comme une adresse -- un nom affiché falsifié peut donc satisfaire une condition sur **Expéditeur — nom affiché**, mais ne peut pas, à lui seul, satisfaire une condition sur **Expéditeur — adresse**. Considérez une correspondance sur **Expéditeur — adresse** comme « cette adresse a été déclarée dans le message », pas comme une identité vérifiée.

### Champ obsolète

**Expéditeur — nom ou adresse (obsolète)** est le champ « Expéditeur » d'origine, non divisé, conservé pour les règles configurées avec lui avant la scission décrite ci-dessus. Vous pouvez toujours ouvrir et modifier une règle qui l'utilise, mais son comportement de correspondance a changé depuis -- voir la remarque dans « Conditions » ci-dessus -- il vaut donc la peine de vérifier ce à quoi correspond désormais une règle existante sur ce champ, en particulier celles qui déplacent, suppriment, archivent le courrier ou le marquent comme spam (pourquoi cette combinaison est refusée -- voir « Le nom affiché peut être falsifié » ci-dessus).

Le point important est une porte à sens unique dans l'éditeur de règles : le champ obsolète n'apparaît dans le menu déroulant des champs de condition que tant qu'une condition y est encore réglée. Dès que vous basculez cette condition vers un autre champ (y compris en la basculant puis en revenant), l'option obsolète disparaît du menu et il n'y a plus moyen de la sélectionner à nouveau via l'interface -- il faudrait alors recréer la condition sur **Expéditeur — adresse** ou **Expéditeur — nom affiché**. Décidez avant de basculer, pas après.

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

## Règles marquées comme non appliquées

Si les conditions ou les actions d'une règle ne peuvent pas justifier de manière fiable ce qu'elle fait, MailCopilot refuse de l'exécuter -- et la signale dans la liste des règles au lieu de la laisser silencieusement inactive. Le badge apparaît à la place du résumé habituel « N conditions, M actions » pour cette règle, qu'elle soit activée ou désactivée, afin que vous n'ayez pas besoin d'ouvrir une règle pour découvrir qu'elle ne s'exécute pas réellement.

- **« Non applicable »** -- la règle elle-même ne peut pas être lue : certaines de ses conditions ou actions comportent des éléments manquants dont MailCopilot a besoin pour l'exécuter, le plus souvent parce que ce qui l'a créée (par exemple un assistant IA à qui l'on a demandé de configurer une règle) ne l'a pas écrite correctement jusqu'au bout. Ouvrir la règle affiche le même message, et ses listes de conditions et d'actions apparaissent vides dans l'éditeur -- il n'y a rien à corriger, seulement à reconstruire depuis le début.
- **« Non appliquée »** -- la règle est lisible, mais MailCopilot ne peut pas justifier de l'exécuter telle qu'elle est écrite. Cela couvre les deux situations décrites plus haut : une condition qui porte sur un champ que MailCopilot ne stocke pas pour le courrier en cache (comme le **Cc**), qui ne peut donc jamais être réellement vérifiée ; ou une action destructrice -- **Mettre à la corbeille**, **Marquer comme spam**, **Archiver** ou **Déplacer vers le dossier** -- conditionnée par le nom affiché de l'expéditeur (**Expéditeur — nom affiché** ou le champ obsolète **Expéditeur — nom ou adresse**), que l'expéditeur peut définir à sa guise, si bien qu'il ne peut pas justifier l'action (voir « Le nom affiché peut être falsifié » ci-dessus).

Si une règle relève des deux verdicts, **« Non applicable »** a la priorité -- les badges n'apparaissent jamais ensemble, seule l'étiquette de règle illisible est affichée.

Survoler l'un ou l'autre badge avec le pointeur affiche la raison du refus en une ligne dans une info-bulle ; atteindre le badge au clavier ne fait pas apparaître cette info-bulle. Pour **« Non appliquée »**, la raison fait aussi partie de ce qu'un lecteur d'écran annonce pour le badge, et le badge lui-même est un bouton : cliquer dessus ouvre la règle dans l'éditeur afin que vous puissiez corriger la condition ou l'action qui en est la cause. **« Non applicable »** n'est qu'une étiquette, pas un bouton : il n'y a rien à vous montrer dans l'éditeur, alors ouvrez une telle règle avec le bouton de modification (crayon) sur sa ligne. Une règle dans l'un ou l'autre de ces états reste dans votre liste inchangée jusqu'à ce que vous la corrigiez -- la case à cocher à côté d'elle continue de l'activer ou de la désactiver, et la supprimer de la liste fonctionne toujours, mais la règle elle-même ne fait rien tant qu'elle est marquée ainsi.

## Tester les règles

Avant d'enregistrer une règle, cliquez sur **« Tester sur les e-mails existants »** pour prévisualiser lesquels de vos e-mails récents de la boîte de réception correspondraient aux conditions. L'aperçu vérifie jusqu'à 500 e-mails de la boîte de réception déjà téléchargés sur cet appareil et affiche jusqu'à 20 correspondances -- c'est une vérification rapide, pas une recherche exhaustive dans toute votre boîte de messagerie. Pour une règle limitée à un seul compte, ce sont vos e-mails les plus récents ; pour une règle portant sur tous les comptes, les 500 e-mails vérifiés proviennent de l'ensemble de vos comptes mais ne sont pas nécessairement les plus récents dans l'absolu. Les e-mails plus anciens et ceux pas encore téléchargés sur cet appareil ne sont pas inclus.

## Appliquer aux e-mails existants

Cochez **« Appliquer aux e-mails existants dans la boîte de réception »** lors de l'enregistrement d'une règle pour l'exécuter immédiatement sur les e-mails que vous avez déjà. Cela couvre jusqu'à 1 000 e-mails de la boîte de réception déjà téléchargés sur cet appareil -- pour une règle limitée à un seul compte, vos e-mails les plus récents de ce type ; pour une règle portant sur tous les comptes, jusqu'à 1 000 e-mails provenant de l'ensemble de vos comptes, pas nécessairement les plus récents dans l'absolu. Cela ne remonte pas plus loin dans votre historique de messagerie sur le serveur, et cela ne concerne que la boîte de réception, pas les autres dossiers. Si une action échoue, seule cette action est ignorée -- les autres actions de la même règle continuent de s'exécuter pour cet e-mail, et le reste de l'opération se termine quand même. Une règle comportant une condition que MailCopilot ne peut pas vérifier, ou dans laquelle le nom affiché (ou le champ obsolète) conditionne une action de déplacement ou destructrice, est refusée ici aussi -- voir « Conditions » ci-dessus.

## Uniquement les nouveaux e-mails

Les règles s'appliquent à un nouvel e-mail dès qu'il arrive sur votre appareil, quel que soit le moyen par lequel il y est arrivé -- notification push, synchronisation périodique ou une page contenant des e-mails plus récents que ceux déjà vus. Le moyen par lequel un message arrivait pouvait auparavant faire qu'une règle le manque complètement ; cet écart est désormais comblé. En revanche, remonter dans l'historique en faisant défiler la liste ne fait pas passer ces anciens e-mails par les règles -- c'est voulu, il s'agit du même comportement « pas d'exploration de l'historique » décrit plus bas, pas d'un écart qui subsisterait.

Cette garantie pour les nouveaux e-mails n'est cependant pas absolue en toute circonstance : un e-mail dont l'action échoue trois fois de suite (par exemple à cause d'une connexion interrompue) est abandonné pour de bon -- MailCopilot le passe et poursuit dans ce dossier, si bien qu'un redémarrage ultérieur ne le fera pas réapparaître. Ce qu'un redémarrage réinitialise réellement, c'est un compteur qui n'a pas encore atteint trois : si l'application redémarre avant qu'un e-mail n'ait échoué trois fois de suite, le compte repart de zéro, si bien qu'une action qui échoue sans cesse pour une raison qui persiste peut bloquer indéfiniment le traitement d'un dossier, sans jamais réellement atteindre cette limite de trois tentatives.

Par ailleurs, les règles n'explorent jamais l'historique complet d'un dossier de leur propre initiative. Chaque dossier que MailCopilot connaît déjà au démarrage reçoit immédiatement un point de départ, avant même toute synchronisation -- un dossier vide reçoit un point de départ à zéro, si bien que son tout premier e-mail est évalué normalement ; un dossier qui contient déjà des e-mails en cache reçoit un point de départ situé après ces e-mails, de sorte que le courrier déjà présent n'est pas repris, mais que tout ce qui arrive ensuite l'est. Un dossier qui n'apparaît qu'après ce démarrage -- nouvellement créé ou nouvellement abonné -- est traité différemment : rien n'y est évalué tant que MailCopilot ne l'a pas synchronisé une première fois, et seuls les e-mails arrivant après cette première synchronisation comptent. Le même nouveau départ se produit si le serveur réinitialise un jour la numérotation des messages d'un dossier (rare, mais cela peut se produire après certaines migrations côté serveur). Utilisez **« Appliquer aux e-mails existants dans la boîte de réception »** (voir ci-dessus) si vous souhaitez qu'une règle évalue aussi les e-mails que vous avez déjà.

## Priorité des règles

Les règles sont évaluées par ordre de priorité (nombre plus petit = priorité plus élevée). La priorité est attribuée automatiquement à la création d'une règle -- il n'existe actuellement aucun moyen de la modifier depuis l'éditeur de règles. Si deux règles ont la même priorité, l'ordre dans lequel elles s'exécutent n'est pas défini.

## Règles IA

Si vous avez configuré un fournisseur d'IA (voir [Assistant IA](../ai-assistant)), vous pouvez également créer des règles basées sur l'IA. Les règles IA traitent les e-mails qui ne correspondent à aucune règle statique.

C'est différent du fait de demander à l'assistant, dans le chat, de créer ou modifier une règle pour vous. Dans ce cas, l'assistant crée ou modifie une règle **statique** -- celle décrite plus haut, avec ses propres conditions et actions -- et toutes les restrictions décrites plus haut s'y appliquent intégralement : il ne peut pas créer de condition sur le Cc, puisque MailCopilot ne le stocke pas ; il ne peut pas conditionner une règle qui déplace, met à la corbeille, archive ou marque du courrier comme spam sur le nom affiché de l'expéditeur, seulement sur **Expéditeur — adresse** ; et s'il renvoie une règle que MailCopilot ne peut pas appliquer pour une autre raison, la règle n'est pas enregistrée -- demandez-lui de réessayer, ou construisez la règle vous-même dans l'éditeur. Une **règle IA**, dont il est question dans le reste de cette section, est une tout autre chose : au lieu de conditions, c'est un prompt qui décrit ce que vous voulez avec vos propres mots, plus une liste d'actions que vous autorisez l'IA à effectuer.

### Comment fonctionnent les règles IA

1. Vous rédigez un prompt décrivant comment trier les e-mails (par exemple, « Archiver les newsletters, déplacer les e-mails de recruteurs dans le dossier Emploi »).
2. Vous choisissez les actions que l'IA est autorisée à effectuer.
3. Vous définissez une limite de budget journalier pour contrôler les coûts.
4. L'IA évalue les e-mails non traités par lots. Elle applique automatiquement les actions réversibles (archiver, déplacer, marquer comme lu, marquer d'une étoile) ; pour **Mettre à la corbeille** ou **Marquer comme spam**, elle ne touche pas du tout à l'e-mail -- elle enregistre l'action proposée comme entrée de journal à la place.

Les actions des règles IA sont enregistrées afin que vous puissiez consulter quelle action a été appliquée ou proposée pour chaque e-mail.

Une règle IA n'a pas de conditions à restreindre, donc les règles sur le Cc et sur l'adresse de l'expéditeur décrites plus haut pour les règles statiques ne s'y appliquent pas -- il n'y a rien qui ressemble à une condition auquel elles pourraient s'appliquer. Sa protection fonctionne autrement : vous choisissez vous-même quelles actions elle a le droit d'effectuer (voir plus bas) ; parmi celles-ci, toutes s'appliquent automatiquement sauf **Mettre à la corbeille** et **Marquer comme spam** -- voir « Les actions destructrices nécessitent une vérification » plus bas pour ce qui se passe avec ces deux-là.

### Les nouvelles règles IA démarrent désactivées

Une règle IA nouvellement créée est **désactivée par défaut**. Activez **« Activée »** sur la règle une fois que vous avez vérifié son prompt et les actions autorisées, pour commencer à l'appliquer au courrier entrant. Cela évite qu'une règle n'agisse sur votre boîte de réception avant que vous n'ayez confirmé qu'elle se comporte comme prévu.

### Limite de règles activées par compte

Vous pouvez activer au maximum **20 règles IA par compte** (les règles globales, qui s'appliquent à tous les comptes, comptent dans la limite de chaque compte). Si vous essayez d'activer une règle au-delà de cette limite, l'application affiche un message et la règle reste désactivée — désactivez d'abord une autre règle. Cette limite garantit que le tri automatique en arrière-plan reste rapide et prévisible : toutes les règles activées pour un compte sont évaluées ensemble en une seule passe.

### Les actions destructrices nécessitent une vérification

Les actions réversibles -- archiver, déplacer vers un dossier, marquer comme lu, marquer d'une étoile -- sont appliquées automatiquement lorsqu'une règle IA correspond. **Mettre à la corbeille** et **Marquer comme spam** ne sont jamais appliquées automatiquement : l'e-mail n'est pas touché, et l'IA enregistre à la place l'action proposée comme une entrée dans le journal des actions de la règle, si bien que rien n'est supprimé ni marqué comme spam sur la seule décision d'une règle IA. Il n'y a pas de bouton pour exécuter une proposition consignée -- si vous êtes d'accord avec elle, agissez vous-même sur cet e-mail de la façon habituelle (depuis la liste des messages ou son menu contextuel).

### Les règles ne voient que leur propre compte

Une règle IA associée à un compte spécifique évalue et agit uniquement sur les e-mails de ce compte. Elle ne voit et n'affecte jamais les messages de vos autres comptes.
