---
sidebar_position: 2
title: Lire les e-mails
---

# Lire les e-mails

## Afficher un message

Cliquez sur un message pour l'ouvrir dans le volet de lecture. Le corps du message est affiche dans un bac a sable securise.

Navigation clavier : **j**/**k** (suivant/precedent), **o** ou **Enter** (ouvrir), **u** (retour a la liste).

## En-têtes de destinataires

Le volet de lecture affiche les champs **To**, **Cc** et (pour les messages envoyés) **Bcc** au-dessus du corps du message. Lorsqu'un champ contient plus de trois adresses, MailCopilot masque le surplus : les trois premiers noms sont affichés en ligne, suivis d'un bouton **+N de plus**, où N est le nombre d'adresses masquées.

Cliquez sur **+N de plus** pour afficher la liste complète des destinataires sur plusieurs lignes. Cliquez à nouveau sur le bouton pour revenir à la vue résumée. Vous pouvez également appuyer sur **Esc** lorsque la liste est développée pour la réduire.

Survolez un nom de destinataire pour afficher une infobulle avec la chaîne complète `Nom <email@host>`. Les utilisateurs du clavier peuvent accéder à chaque puce de destinataire et au bouton **+N de plus** via la touche Tab ; **Entrée** ou **Espace** sur le bouton bascule l'état développé.

**Confidentialité Bcc :** la ligne Bcc n'est affichée que pour les messages que vous avez envoyés vous-même. Elle n'est jamais affichée pour les messages reçus, de sorte que les destinataires Bcc des messages entrants restent privés.

## Images externes

Par defaut, les images externes sont bloquees. Cliquez sur **Afficher les images** pour les charger pour un message specifique, ou activez **"Toujours charger les images externes"** dans **Parametres > Productivite**.

## Texte cité

Lorsque vous recevez une réponse ou un message transféré, MailCopilot réduit automatiquement l'historique cité afin que vous ne voyiez que le nouveau contenu. La partie citée est masquée derrière un widget **Afficher le texte cité** au bas du corps du message.

Cliquez sur **Afficher le texte cité** pour développer l'historique complet directement dans le message. Le repli des citations s'applique **uniquement aux e-mails HTML** : les blocs `<blockquote>` de premier niveau et imbriqués sont chacun repliés indépendamment grâce à un élément natif `<details>`/`<summary>` — aucun JavaScript n'est requis. MailCopilot détecte également les motifs d'attribution au style Outlook (`-----Original Message-----`, `On … wrote:`) lorsqu'ils précèdent immédiatement un bloc `<blockquote>`, et replie ces lignes d'attribution avec le bloc cité correspondant.

Les e-mails en texte brut affichent l'historique des citations tel quel, sans repli. Il s'agit d'une limitation connue, prévue pour être corrigée dans une prochaine version.

Si le message ne contient pas de texte cité, le widget n'apparaît pas.

## Fils de discussion

Lorsque le regroupement en conversations est activé (par défaut), les messages liés sont regroupés en fils. Dans la liste des messages, les fils comportant plus d'un message affichent un badge `+N` à côté de l'objet — il indique le nombre de messages supplémentaires dans le fil ; l'infobulle affiche le total. Cliquez sur le fil dans la liste des messages pour l'ouvrir dans le volet de lecture.

### Vue du fil — pile de cartes

Les fils comportant deux messages ou plus s'affichent sous la forme d'une pile verticale de cartes. Par défaut, les cartes sont ordonnées **du plus récent au plus ancien**. Le message le plus récent — le dernier reçu — est la carte active développée ; les messages plus anciens sont réduits en dessous.

- Les **cartes réduites** affichent l'avatar de l'expéditeur, son nom, une date intelligemment formatée et un court extrait de texte. Si le message n'a pas de texte prévisualisable, la carte affiche **« (aperçu indisponible) »**.
- Cliquez sur n'importe quelle carte réduite pour la développer. Cliquez à nouveau sur une carte développée pour la réduire. Un seul message peut être développé à la fois : ouvrir un autre message ferme le précédent.

Les fils à message unique et les comptes avec le regroupement désactivé continuent d'utiliser le visualisateur simple — la vue en pile n'apparaît qu'à partir de deux messages.

Désactivez cette option dans **Paramètres > Productivité > Regrouper les messages en conversations**.

### Ordre de conversation

Par défaut, le message le plus récent apparaît en haut de la pile de cartes, afin que vous voyiez immédiatement la dernière réponse — de la même façon que les nouveaux messages arrivent dans votre boîte de réception. Vous pouvez modifier cet ordre dans **Paramètres > Productivité > Ordre de conversation** :

- **Plus récent en premier** (par défaut) — le message le plus récent est en haut ; les messages plus anciens sont en dessous.
- **Plus ancien en premier** — les messages sont classés chronologiquement de haut en bas, le message le plus récent se trouvant au bas de la pile.

Ce paramètre s'applique à tous les fils dans le volet de lecture et prend effet immédiatement lors de la modification.

### Actions sur les fils

Lorsque vous consultez un fil comportant deux messages ou plus, la barre d'outils unique en haut du visualiseur de messages passe en mode fil. Il s'agit de la même barre d'outils que pour les messages individuels — ses boutons s'adaptent à la sémantique du fil :

- **Répondre** -- rédiger une réponse à l'expéditeur du message le plus récent du fil.
- **Répondre à tous** -- répondre à tous les participants du message le plus récent, en excluant l'adresse principale de votre compte.
- **Transférer** -- transférer le message le plus récent du fil à quelqu'un d'autre.
- **Archiver le fil** -- déplace l'ensemble du fil vers le dossier Archive. Désactivé si aucun dossier Archive n'est configuré.
- **Supprimer le fil** -- déplace l'ensemble du fil vers la Corbeille si le compte dispose d'un dossier Corbeille. Si le fil se trouve déjà dans la Corbeille, ou si le compte n'a pas de dossier Corbeille, MailCopilot demande une confirmation avant la suppression définitive.
- **Marquer le fil comme lu** -- marque tous les messages du fil comme lus. Ce bouton n'apparaît que lorsqu'au moins un message du fil est non lu ; il est masqué lorsque tous les messages sont déjà lus.
- **Reporter** -- masque temporairement **l'ensemble du fil** et ramène tous ses messages à l'heure choisie. La boîte de dialogue est ancrée sur le message le plus récent, mais tous les messages du fil sont reportés ensemble. Mêmes options que pour les messages individuels. Masqué dans le dossier Brouillons.
- **Spam** -- en mode fil, ouvre une boîte de dialogue de confirmation demandant si tous les messages du fil doivent être marqués comme spam. Annuler une marque « spam » est plus difficile qu'annuler un archivage ; cette confirmation supplémentaire est intentionnelle.
- **Étoiler, Épingler, Imprimer, Ouvrir dans une fenêtre, Ouvrir dans le compte** -- ces boutons agissent sur le message actuellement actif (développé) dans le fil, et non sur l'ensemble du fil.

Répondre, Répondre à tous et Transférer ciblent le message le plus récent du fil. Archiver le fil, Supprimer le fil, Marquer le fil comme lu et Reporter s'appliquent à tous les messages du fil en même temps.

### Resume IA du fil

Lorsque vous ouvrez un fil de **trois messages ou plus**, et que le resume IA du fil est active pour le compte, un resume genere par IA en une ligne apparait au-dessus de la pile de cartes. Cliquez dessus pour developper cinq puces reprenant les points cles de la conversation. Cliquez a nouveau sur la ligne de resume pour reduire les puces.

Le resume IA du fil est **desactive par defaut** et doit etre active **par compte** dans **Parametres > AI > Resume IA du fil**. Voir [Assistant IA](../ai-assistant#resume-ia-du-fil) pour savoir comment l'activer et ce qui est envoye a votre fournisseur IA.

Les fils plus courts (moins de trois messages) n'affichent jamais le bandeau de resume -- la pile est assez petite pour etre lue directement. Seul le fil que vous avez activement ouvert est resume ; MailCopilot ne resume jamais les fils en arriere-plan ni sur l'ensemble de votre boite de reception.

Une fois qu'un fil a ete resume, le rouvrir affiche le resume mis en cache instantanement -- MailCopilot ne le regenere pas tant que les messages du fil ne changent pas.

Si le budget IA quotidien a ete atteint, qu'aucun fournisseur IA n'est configure (ce qui inclut un **abonnement Claude** configure, non pris en charge pour le resume IA du fil), ou que le fournisseur renvoie une erreur temporaire, le bandeau affiche un message explicatif a la place du resume. Un bouton **Reessayer** apparait lorsque l'echec etait une erreur temporaire du fournisseur.

### Reponse instantanee

Lorsque la reponse instantanee est activee pour le compte, un bouton **Reponse instantanee** apparait sur la carte du message activement ouvert. Cliquez dessus pour que l'IA redige deux ou trois options de reponse courtes basees sur le contenu du message.

Cliquez sur une option pour l'ouvrir dans une **nouvelle fenetre de redaction**, prealablement remplie avec ce texte -- rien n'est envoye automatiquement, vous continuez a relire et a envoyer le message vous-meme.

La reponse instantanee est **desactivee par defaut** et doit etre activee **par compte** dans **Parametres > AI > Reponse instantanee**. Voir [Assistant IA](../ai-assistant#reponse-instantanee) pour savoir comment l'activer et ce qui est envoye a votre fournisseur IA.

## Pieces jointes

Lorsque le message actif contient des pièces jointes, celles-ci apparaissent au-dessus du corps du message. Pour chaque piece jointe sont affiches :

- Une **icone de type de fichier**, choisie a partir du type MIME, avec un repli sur l'extension du nom de fichier lorsque le type MIME est manquant, generique (`application/octet-stream`) ou non reconnu : PDF, image, archive, document, tableur, presentation, texte brut, message `.eml` integre, ou une icone de fichier generique lorsqu'aucune correspondance plus precise ne s'applique.
- Le **nom du fichier**.
- La **taille du fichier**.
- Un **badge « Aperçu disponible »** sur les pieces jointes que MailCopilot reconnait comme previsualisables. L'ensemble actuel couvre les images PNG, JPEG, GIF, WebP et les documents PDF -- le badge n'apparait que pour ces types et signale qu'une prise en charge de previsualisation est prevue ; l'action principale dans la ligne reste aujourd'hui le bouton de telechargement.

Cliquez sur le bouton de telechargement de la ligne d'une piece jointe pour la sauvegarder sur votre ordinateur. Le bouton de telechargement porte un libelle accessible explicite, de sorte que les lecteurs d'ecran annoncent l'action en meme temps que le nom du fichier.

## Liens dans les e-mails

MailCopilot verifie les liens pour votre securite : liens ne correspondant pas au texte affiche, liens HTTP non chiffres et domaines IDN/Punycode. Un dialogue de confirmation apparait pour les liens suspects.

## Actions sur les messages

Repondre (**r**), Repondre a tous (**a**), Transferer (**f**), Etoiler (**s**), Supprimer (**#** ou **Delete**), Archiver (**e**), Spam (**!**), Marquer lu/non-lu (**Shift+I**/**Shift+U**), Deplacer (**v**), Mise en veille -- masquer temporairement le message pour qu'il reapparaisse plus tard. Voir ci-dessous.
- **Épingler / Désépingler** -- épingler un message en haut de la liste. Les messages épinglés apparaissent toujours en premier, quel que soit l'ordre de tri (raccourci : **p**).
- **Ouvrir dans une fenêtre** -- ouvrir le message dans une fenêtre autonome séparée, afin de le lire côte à côte avec d'autres contenus.
- **Imprimer** -- imprimer l'e-mail actuel (raccourci : **Ctrl+P**).

## Ouvrir dans une fenêtre

L'action **Ouvrir dans une fenêtre** ouvre le message actuel dans une fenêtre autonome dédiée. C'est utile lorsque vous souhaitez lire un message ou agir dessus tout en gardant la fenêtre principale libre pour parcourir d'autres dossiers.

La fenêtre autonome est un espace de travail entièrement fonctionnel. Elle comprend une barre d'actions complète en haut avec tous les boutons nécessaires :

- **Répondre** -- rédiger une réponse à l'expéditeur.
- **Répondre à tous** -- répondre à tous les destinataires.
- **Transférer** -- transférer le message à un autre destinataire.
- **Archiver** -- déplacer le message vers le dossier Archive. Le bouton est désactivé si aucun dossier Archive n'est configuré pour le compte.
- **Supprimer** -- déplacer le message vers la Corbeille lorsque le compte dispose d'un dossier Corbeille. Si le compte n'a pas de dossier Corbeille, ou si le message se trouve déjà dans la Corbeille, MailCopilot demande une confirmation avant la suppression définitive.
- **Étoiler / Retirer l'étoile** -- basculer l'état « Étoilé » du message.
- **Marquer comme lu / non lu** -- basculer l'état de lecture.
- **Imprimer** -- imprimer le corps du message.

Lorsque vous cliquez sur **Archiver**, ou sur **Supprimer** pour un message pouvant être déplacé vers la Corbeille, la fenêtre autonome affiche une bannière d'annulation intégrée pendant 3 secondes avant que MailCopilot effectue le déplacement et ferme la fenêtre. Cliquez sur **Annuler** pour abandonner l'opération — le message reste en place et la fenêtre reste ouverte. Tant que la bannière d'annulation est visible, les boutons **Archiver** et **Supprimer** sont désactivés ; **Répondre**, **Répondre à tous**, **Transférer**, **Étoiler / Retirer l'étoile**, **Marquer comme lu / non lu** et **Imprimer** restent disponibles.

Si le compte n'a pas de dossier Corbeille, ou si le message se trouve déjà dans la Corbeille, **Supprimer** demande une confirmation avant la suppression définitive — aucune bannière d'annulation n'apparaît et l'action est irréversible.

La fenêtre autonome utilise les mêmes protections essentielles que le volet de lecture principal : HTML assaini dans une iframe isolée sans scripts, images distantes bloquées, et avertissements d'hameçonnage pour les liens.

## Mise en veille des messages

La mise en veille permet de masquer temporairement un message et de le faire reapparaitre au moment choisi, pour le traiter quand vous serez pret.

### Comment mettre en veille

Faites un clic droit sur un message dans la liste et choisissez **Mise en veille** dans le menu contextuel.

### Options de mise en veille

Choisissez parmi des horaires predéfinis ou definissez une date et une heure personnalisees :

- **Plus tard aujourd'hui** -- la prochaine demi-heure.
- **Demain matin (09h00)**.
- **La semaine prochaine (lundi 09h00)**.
- **Personnalise** -- choisissez une date et une heure futures.

### Le dossier En veille

Les messages en veille apparaissent dans le dossier **En veille** de la barre laterale. Lorsque l'heure de reveil arrive, le message redevient visible dans son dossier d'origine et vous recevez une notification.

Cliquez sur un message en veille pour l'ouvrir et le consulter sans annuler la mise en veille. Pour réactiver un message plus tôt, cliquez sur le bouton **Annuler** à côté de celui-ci.

## Lire plus tard

La fonction « Lire plus tard » vous permet de mettre des emails de côté pour une lecture ultérieure — idéal pour les newsletters, les documents de référence ou tout ce que vous souhaitez consulter plus tard.

### Comment ajouter à « Lire plus tard »

- Faites un clic droit sur un message et choisissez **Lire plus tard** dans le menu contextuel.
- Ou demandez à l'assistant IA de marquer un email pour lecture ultérieure.

### Le dossier « Lire plus tard »

Les messages marqués apparaissent dans le dossier **Lire plus tard** dans la barre latérale (icône de livre). Contrairement aux messages reportés, les emails « Lire plus tard » restent visibles dans leur dossier d'origine — le dossier est une vue supplémentaire, pas un filtre.

Cliquez sur un message dans le dossier « Lire plus tard » pour l'ouvrir et le consulter. Pour retirer un message de la liste, cliquez sur le bouton **Retirer de la liste** a cote de celui-ci.

Vous pouvez ouvrir le dossier « Lire plus tard » depuis la barre laterale.

## Quand un message ne peut pas se charger

Si MailCopilot ne parvient pas a recuperer le corps du message — par exemple parce que la connexion au serveur IMAP a expire (apres 10 secondes) — il affiche un ecran de remplacement plutot qu'une page blanche :

> « Le corps du message n'est pas disponible hors connexion. Seules les en-tetes sont mises en cache. »

Un bouton **Reessayer** apparait sous le message. Cliquez dessus pour tenter de recuperer le corps a nouveau. Si la connexion a ete retablie, le message se chargera normalement.

## Invitations à des réunions

Lorsqu'un message contient une invitation de calendrier (une pièce jointe `.ics` utilisant le protocole iTIP), MailCopilot affiche une carte **Invitation à une réunion** intégrée au-dessus du corps du message. Aucune application de calendrier externe ni service cloud n'est nécessaire.

La carte indique :

- **Titre de l'événement** — le résumé de la réunion.
- **Quand** — la date et l'heure de début.
- **Organisateur** — l'organisateur indiqué dans l'invitation calendrier (peut différer de l'expéditeur de l'email si l'invitation est envoyée pour le compte de quelqu'un d'autre).
- **Lieu** — la salle de réunion ou le lien de conférence, s'il est fourni.

Sous les détails de l'événement, trois boutons de réponse sont disponibles : **Accepter**, **Peut-être** et **Refuser**. En cliquant sur l'un d'eux, MailCopilot envoie un e-mail de réponse iTIP standard à l'organisateur via SMTP en utilisant les identifiants de votre compte. La carte se met alors à jour pour confirmer votre choix (par exemple, « Vous avez accepté cette invitation »). Si la réponse ne peut pas être envoyée, un message d'erreur s'affiche à la place.

Les boutons Accepter / Peut-être / Refuser n'apparaissent que pour les demandes de réunion actives (`METHOD:REQUEST`) où l'organisateur n'est pas vous. Les annulations, publications de flux calendrier, réponses et événements que vous organisez vous-même n'affichent pas de boutons RSVP — vous verrez à la place une mention « Annulé » ou « Action non requise ».

### Limitations dans cette version

- **Pas d'intégration au calendrier système.** MailCopilot n'ajoute pas l'événement à votre calendrier système (macOS Calendrier, GNOME Agenda, etc.). Cette fonctionnalité est prévue dans une prochaine version.
- **Événements récurrents.** Les réunions répétées sont affichées comme un événement unique ; le modèle de récurrence n'est pas affiché.
- **Contre-propositions.** Vous ne pouvez pas proposer un autre horaire — seuls Accepter, Peut-être ou Refuser sont disponibles.
- **Événements annulés.** Lorsque l'organisateur annule une réunion, la carte affiche « Cet événement a été annulé » et les boutons de réponse sont masqués.

## Annuler les actions

Dans les vues de dossier de compte, l'archivage, le signalement comme spam ou le deplacement vers la corbeille affiche une barre d'annulation avec un compte a rebours. Cliquez sur **Annuler** avant l'expiration. Les suppressions definitives et certaines actions dans la boite unifiee ou entre comptes n'affichent pas de barre d'annulation.
