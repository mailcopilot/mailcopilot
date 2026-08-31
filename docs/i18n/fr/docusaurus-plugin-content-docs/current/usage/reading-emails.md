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

### Statut non lu d'une ligne de fil

Une ligne de fil dans la liste des messages est affichée comme non lue (en gras) dès qu'**un seul** message à l'intérieur du fil actuellement affiché dans la liste est non lu — pas uniquement le plus récent. Ainsi, un message non lu enfoui au milieu d'une conversation n'est jamais invisible dans la liste, même si le message le plus récent de ce même fil a déjà été lu.

Cliquer sur un fil non lu ouvre le **plus ancien message non lu** du fil en tant que carte active développée. Si tous les messages du fil ont déjà été lus, cliquer dessus ouvre plutôt le message principal du fil — avec le tri par date, actif par défaut, il s'agit du message le plus récent.

Ouvrir un message de cette façon ne marque pas le reste du fil comme lu. Marquer tous les messages d'un fil comme lus reste une action distincte et explicite -- voir **Marquer le fil comme lu** dans [Actions sur les fils](#actions-sur-les-fils) ci-dessous.

### Vue du fil — pile de cartes

Les fils comportant deux messages ou plus s'affichent sous la forme d'une pile verticale de cartes. Par défaut, les cartes sont ordonnées **du plus récent au plus ancien**. La carte active développée est celle du message que vous avez ouvert — le plus ancien message non lu si le fil en contient, sinon le message principal du fil ; les autres restent réduites.

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
- **Supprimer le fil** -- décidé dossier par dossier : tout message pouvant encore être déplacé vers la Corbeille y est déplacé immédiatement. Tout message déjà dans la Corbeille, ou appartenant à un compte sans dossier Corbeille, est au contraire couvert par une boîte de dialogue de confirmation avant la suppression définitive. Un fil confiné à un seul dossier emprunte donc exactement l'un de ces deux chemins, comme auparavant ; un fil dont les messages s'étendent sur plusieurs dossiers (par exemple une réponse déjà classée dans la Corbeille aux côtés du reste de la conversation) peut emprunter les deux à la fois -- les messages déplaçables sont déplacés, et la boîte de dialogue de confirmation ne couvre que ce qu'il reste.
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

Si le budget IA quotidien a ete atteint, qu'aucun fournisseur IA n'est configure, ou que le fournisseur renvoie une erreur temporaire, le bandeau affiche un message explicatif a la place du resume. Un bouton **Reessayer** apparait lorsque l'echec etait une erreur temporaire du fournisseur.

### Reponse instantanee

Lorsque la reponse instantanee est activee pour le compte, un bouton **Reponse instantanee** apparait sur la carte du message activement ouvert. Cliquez dessus pour que l'IA redige deux ou trois options de reponse courtes basees sur le contenu du message.

Cliquez sur une option pour l'ouvrir dans une **nouvelle fenetre de redaction**, prealablement remplie avec ce texte -- rien n'est envoye automatiquement, vous continuez a relire et a envoyer le message vous-meme.

La reponse instantanee est **desactivee par defaut** et doit etre activee **par compte** dans **Parametres > AI > Reponse instantanee**. Voir [Assistant IA](../ai-assistant#reponse-instantanee) pour savoir comment l'activer et ce qui est envoye a votre fournisseur IA.

## Traduction du message

MailCopilot peut traduire le message que vous lisez dans la langue de votre choix.

La traduction du message est **desactivee par defaut** et doit etre activee **par compte** dans **Parametres > AI > Traduction IA** (cochez « Autoriser la traduction des messages reçus et de vos propres brouillons par l’IA »). Le meme parametre active aussi la [traduction du brouillon](../ai-assistant#traduction-du-brouillon) dans la fenetre de redaction. Voir [Assistant IA](../ai-assistant#traduction-du-message) pour savoir comment l'activer et ce qui est envoye a votre fournisseur IA.

### Comment l'utiliser

Cliquez sur **Traduire** au-dessus du corps du message, puis choisissez une langue cible dans la liste **Traduire en**. MailCopilot n'appelle votre fournisseur IA configure qu'a ce moment precis -- il n'y a pas de traduction automatique a l'ouverture d'un message, donc ouvrir un e-mail dans une langue etrangere ne consomme jamais votre budget IA de lui-meme.

Une fois la traduction affichee, un bouton bascule **Afficher l'original** / **Afficher la traduction** au-dessus du corps du message vous permet de revenir en arriere a tout moment. Le message enregistre lui-meme n'est jamais modifie -- la traduction n'est qu'une vue superposee.

**Les messages HTML sont traduits a partir de leur version texte.** La traduction est toujours affichee en texte brut, meme pour un message HTML -- la mise en forme, la mise en page et les images integrees n'en font pas partie. Une legende au-dessus du texte traduit le precise explicitement : « La traduction est faite a partir de la version texte du message : sa mise en forme et ses images n'en font donc pas partie. »

### Langue source detectee

Avant de traduire, MailCopilot essaie d'identifier la langue d'origine du message sur votre appareil et, quand cela reussit, la nomme dans une legende au-dessus de la traduction (par exemple : « Traduction automatique de l'anglais vers le francais. L'original est a un clic. »). La detection est locale et sert uniquement d'etiquette -- elle ne decide jamais si le message peut etre traduit.

La legende peut etre corrigee dans les deux cas, pas seulement quand la detection echoue. Si la langue ne peut pas etre identifiee avec une confiance suffisante, MailCopilot traduit quand meme et n'affiche simplement aucune legende, proposant un selecteur **Langue de ce message** (texte d'aide : **Choisissez une langue**) pour la nommer vous-meme. Si une legende EST affichee mais nomme la mauvaise langue -- la detection locale peut confondre avec assurance des langues proches -- un lien **Ce n'est pas la bonne langue ?** a cote ouvre le meme selecteur. Dans les deux cas, nommer la langue est facultatif et se contente de mettre a jour la legende de la traduction deja affichee, en cache, sans nouvel appel au fournisseur.

### Cache de traduction

La traduction d'un message dans une langue donnee est mise en cache localement sur votre appareil, indexee par le contenu meme du message, la langue cible et la version du contrat de traduction (fournisseur, modele et forme du prompt) qui l'a produite -- rouvrir le meme message et choisir a nouveau la meme langue reutilise la traduction en cache au lieu de rappeler le fournisseur, et un changement ulterieur de la maniere dont MailCopilot produit les traductions est range sous une nouvelle cle plutot que de faire passer le resultat d'un ancien contrat pour actuel. Le cache n'a toujours pas de duree d'expiration propre -- c'est le plafond ci-dessous qui fait vieillir les entrees a sa place. Chaque compte conserve ses 500 traductions les plus recentes ; une fois cette limite atteinte, les traductions les plus anciennes de ce compte sont supprimees pour faire de la place aux nouvelles. Supprimer un compte supprime aussi ses traductions mises en cache.

### Si la traduction n'est pas disponible

MailCopilot indique la raison precise pour laquelle la traduction n'a pas pu etre produite, plutot que d'afficher une erreur generique :

- La traduction est desactivee pour ce compte.
- Aucun fournisseur IA n'est encore configure.
- Le fournisseur IA n'a pas renvoye de traduction et n'en a pas indique la raison.
- La traduction ne tient pas dans la limite de reponse du fournisseur IA : elle est revenue tronquee et n'est pas affichee.
- Le texte du message n'est pas encore telecharge.
- Le message est trop long pour etre traduit en une seule fois, et il n'y a aucun moyen d'en traduire seulement une partie -- le message entier compte dans la limite, y compris les echanges anterieurs qui y seraient cites.
- Le budget IA de cette periode est epuise.

**Un bouton Reessayer n'apparait que la ou reessayer peut changer le resultat.** Chaque clic est une nouvelle requete facturee a votre fournisseur IA, donc MailCopilot ne propose pas ce bouton pour un refus qui se reproduirait a l'identique : la traduction butant sur la limite de reponse du fournisseur, le message trop long pour etre traduit du tout, ou la traduction desactivee pour ce compte. Pour les autres raisons -- le fournisseur ayant echoue sans explication, le message encore en telechargement, aucun fournisseur configure, ou le budget epuise -- **Reessayer** est affiche, car corriger la cause, ou simplement attendre, peut faire reussir la tentative suivante. A partir de la deuxieme tentative, le refus porte la mention **Tentative 2** (et ainsi de suite), pour qu'une nouvelle tentative qui ne change rien a l'ecran ne soit pas confondue avec un clic qui n'a pas fonctionne.

## Pieces jointes

Lorsque le message actif contient des pièces jointes, celles-ci apparaissent au-dessus du corps du message. Pour chaque piece jointe sont affiches :

- Une **icone de type de fichier**, choisie a partir du type MIME, avec un repli sur l'extension du nom de fichier lorsque le type MIME est manquant, generique (`application/octet-stream`) ou non reconnu : PDF, image, archive, document, tableur, presentation, texte brut, message `.eml` integre, ou une icone de fichier generique lorsqu'aucune correspondance plus precise ne s'applique.
- Le **nom du fichier**.
- La **taille du fichier**.

Les images de mise en page que le corps du message affiche deja en ligne -- par exemple un logo dans une signature HTML -- ne sont jamais retirees de la liste. MailCopilot ne peut pas etablir de maniere fiable, depuis l'exterieur du navigateur, si une partie donnee a reellement fini par etre visible a l'ecran -- c'est la mise en page, le CSS et le choix au sein d'une image adaptative qui en decident --, donc plutot que de deviner, il garde chaque partie accessible : les pieces jointes reelles (les fichiers reellement joints par l'expediteur) sont listees en premier, et les images en ligne que le corps a affichees sont releguees a la fin de la liste, derriere le meme interrupteur d'expansion decrit plus bas.

Un interrupteur d'expansion apparait des qu'il y a plus a montrer que ce qui tient replie -- plus de quatre pieces jointes reelles, ou toute image en ligne releguee, meme s'il y a quatre pieces jointes reelles ou moins. Cliquez sur **Afficher plus (N)**, ou N ne compte que les elements actuellement non visibles, pour tout reveler, et sur **Reduire** pour reduire a nouveau la liste.

Cliquez sur le bouton de telechargement de la ligne d'une piece jointe pour la sauvegarder sur votre ordinateur. Le bouton de telechargement porte un libelle accessible explicite, de sorte que les lecteurs d'ecran annoncent l'action en meme temps que le nom du fichier.

## Liens dans les e-mails

MailCopilot verifie les liens pour votre securite : liens ne correspondant pas au texte affiche, liens HTTP non chiffres et domaines IDN/Punycode. Un dialogue de confirmation apparait pour les liens suspects.

### Clic droit sur un lien

Faites un clic droit sur un lien dans le corps d'un message pour ouvrir un petit menu contextuel avec :

- **Ouvrir le lien dans le navigateur** -- ouvre le lien de la meme maniere qu'un clic, avec les memes verifications de securite que ci-dessus (avertissements de domaine incoherent et de HTTP, signalement IDN/punycode). Cet element n'apparait que dans la fenetre principale et dans la fenetre de message autonome (voir [Ouvrir dans une fenêtre](#ouvrir-dans-une-fenêtre)) -- il n'est pas propose dans les fenetres Parametres, Nouveau message ou Compte, qui n'affichent aucun lien d'e-mail.
- **Copier l’adresse du lien** -- copie la destination reelle du lien dans le presse-papiers, et non son texte visible, et jamais la forme de routage interne que MailCopilot utilise pour afficher le lien. Pour une adresse web (`http:`/`https:`) avec un nom de domaine internationalise, l'adresse est copiee sous sa forme punycode (ASCII) -- la forme que votre navigateur utilisera reellement -- plutot que sous sa forme Unicode, afin qu'une adresse copiee ne puisse pas dissimuler un domaine ressemblant derriere des caracteres lisibles. Pour une adresse `mailto:`, un domaine internationalise est encode en pourcentage a la place, car les clients de messagerie ne le resolvent pas comme un hote punycode. Les identifiants integres dans un lien (`https://user:pass@host/…`) sont copies tels quels, sans etre retires -- si vous collez un tel lien ailleurs, les identifiants l'accompagnent.

Aucun de ces elements n'apparait pour les liens qui ne commencent pas par `http:`, `https:` ou `mailto:` (par exemple un lien `javascript:` ou `data:` integre dans un message), ni pour une adresse de lien de plus de 8192 caracteres.

## Actions sur les messages

Repondre (**r**), Repondre a tous (**a**), Transferer (**f**), Etoiler (**s**), Supprimer (**#** ou **Delete**), Archiver (**e**), Spam (**!**), Marquer lu/non-lu (**Shift+I**/**Shift+U**), Deplacer (**v**) -- glisser-deposer un message sur un dossier dans la barre laterale fonctionne de la meme maniere : chaque message sort de son propre dossier source, donc glisser depuis un resultat de recherche **Tous les dossiers**, ou depuis une conversation dont les messages se trouvent dans des dossiers differents, deplace chaque message depuis l'endroit ou il se trouve reellement. Mise en veille -- masquer temporairement le message pour qu'il reapparaisse plus tard. Voir ci-dessous.
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

## Messages très volumineux

MailCopilot se protège contre le courrier anormalement volumineux, mais la protection qui s'applique dépend précisément de la façon dont le message est ouvert.

**La limite stricte de 100 Mo protège toute lecture complète d'un message.** Chaque fois que MailCopilot doit lire le contenu brut d'un message dans son intégralité -- que vous ouvriez une copie déjà stockée sur votre appareil, ou que MailCopilot télécharge un message en entier pour le garder disponible hors ligne -- un message de plus de 100 Mo (taille brute, telle que stockée sur le serveur) n'est pas du tout analysé. Cela couvre le corps du message, ses pièces jointes et toute invitation de calendrier intégrée. Ouvrir un tel message affiche une carte de remplacement construite à partir des informations d'en-tête disponibles -- expéditeur, objet et date quand elles sont connues -- accompagnée d'une mention indiquant que le message dépasse la limite de 100 Mo, sans taille exacte ; si le téléchargement lui-même a été refusé en cours de route, ces informations proviennent de votre liste de messages déjà synchronisée plutôt que du message lui-même, et peuvent être incomplètes. Il n'y a délibérément pas d'option « ouvrir quand même » : il s'agit d'une protection contre les plantages par manque de mémoire et contre le courrier pathologique ou malveillant, pas d'une taille que vous êtes censé rencontrer en usage normal. La plupart des fournisseurs de messagerie grand public rejettent les messages d'environ 20 à 50 Mo avant même qu'ils n'atteignent votre boîte de réception, si bien qu'atteindre cette limite devrait être extrêmement rare -- sans être impossible : certains systèmes de messagerie professionnels (par exemple Microsoft 365 avec une limite d'organisation relevée) peuvent laisser passer des messages plus volumineux. Le message lui-même reste intact sur le serveur -- vous pouvez l'ouvrir dans une autre application de messagerie.

**La limite « début affiché » de 1 Mo s'applique chaque fois que MailCopilot lit un message par le chemin de lecture complète utilisé pour l'accès hors ligne.** Cela inclut les messages ouverts à partir d'une copie déjà stockée sur votre appareil, ainsi que la toute première ouverture d'un message dans un dossier où l'accès hors ligne est activé, lorsque MailCopilot télécharge le message en entier pour l'afficher -- même si les limites de votre cache empêchent ensuite d'enregistrer cette copie sur le disque. C'est le cas normal pour votre boîte de réception, qui garde par défaut les messages récents disponibles hors ligne, ainsi que pour tout autre dossier pour lequel vous avez activé l'accès hors ligne (**Paramètres > Dossiers**, voir [Mode hors ligne](../settings/folders-settings#offline-mode)). Pour ceux-ci, si le corps décodé dépasse 1 Mo, seul le début est affiché : un bandeau sous le texte indique « Seul le début de ce message est affiché. » Un bouton **Afficher le message entier** apparaît à côté. Les pièces jointes restent listées en entier même dans la vue tronquée. Cliquez sur le bouton pour relire le message avec une limite plus haute, mais toujours finie (8 Mo) -- MailCopilot ne le fait que lorsque vous le demandez explicitement. Si même la limite relevée ne suffit pas à afficher le message entier, le bandeau reste affiché mais le bouton est remplacé par une note indiquant que c'est tout ce que MailCopilot peut afficher.

**Les messages ouverts directement depuis le serveur ne sont pas concernés par la limite de 1 Mo / 8 Mo ci-dessus.** Les dossiers pour lesquels l'accès hors ligne est désactivé -- ce qui est le cas par défaut pour tous les dossiers autres que la boîte de réception -- récupèrent le texte d'un message directement depuis le serveur à chaque ouverture, sans d'abord télécharger et stocker le message en entier. Cette récupération a ses propres limites de taille, distinctes, sur chaque partie récupérée, bien en dessous de la limite stricte de 100 Mo. L'ouverture d'un message très volumineux de cette façon n'affiche ni la carte de remplacement ni le bandeau « début affiché » -- MailCopilot peut simplement afficher moins d'un très gros message, sans le signaler.

## Quand un message ne peut pas se charger

Si MailCopilot ne parvient pas a recuperer le corps du message, il affiche un ecran de remplacement plutot qu'une page blanche. Il y a trois raisons distinctes a cela, et MailCopilot les differencie au lieu d'afficher le meme message dans tous les cas. La regle qu'il suit : l'ecran de remplacement n'enonce que ce que MailCopilot sait reellement, et ne nomme pas une cause qu'il ne fait que supposer :

**Vous avez demande a travailler hors ligne.** Le mode « Travailler hors ligne » est active, le serveur n'a donc jamais ete contacte et le corps du message n'a jamais ete telecharge ; seuls ses en-tetes sont dans le cache local :

> « Le contenu du message n'est pas disponible hors ligne. Seuls les en-têtes sont mis en cache. »

**La requete a manque de temps.** MailCopilot laisse 10 secondes a la recuperation du corps du message avant d'abandonner. Ce budget est un chronometre, pas un diagnostic : il expire sans avoir appris pourquoi la recuperation etait lente. Le plus souvent, c'est un travail en arriere-plan — synchronisation d'autres dossiers, indexation des corps de messages pour la recherche — qui occupe la connexion au serveur de messagerie au moment ou vous ouvrez le message, mais un serveur lent, une mauvaise connexion ou un message tres volumineux produisent exactement le meme resultat. Le message existe presque certainement sur le serveur ; MailCopilot n'a simplement pas eu le temps de l'atteindre :

> « Le message n'a pas pu être chargé dans le temps imparti. Cela peut arriver lorsque des tâches en arrière-plan occupent la connexion, lorsque le serveur est lent ou lorsque le message est très volumineux. Vous pouvez réessayer. »

**Le chargement a echoue.** MailCopilot a tente de charger le contenu du message et ne l'a finalement pas obtenu. Cela couvre aussi bien une coupure reseau qu'un mot de passe que le serveur n'accepte plus, un certificat inattendu ou une boite aux lettres qui n'existe plus — et cela couvre egalement ce qui se passe *apres* l'arrivee du message, par exemple un disque plein au moment de l'enregistrer dans le cache local. MailCopilot ne devine deliberement pas laquelle de ces causes s'applique, car l'ecran de remplacement se tromperait plus souvent qu'il ne tomberait juste ; pour la meme raison, il n'accuse pas le serveur de messagerie, qui n'y est pour rien dans le cas du disque plein. La ou la cause *est* connue, elle est nommee par l'element d'interface qui, lui, en est sur : le bandeau **Se reconnecter** au-dessus de la liste des messages lorsque vos identifiants ont cesse de fonctionner, ou la boite de dialogue de securite de la connexion lorsque le certificat du serveur n'a pas pu etre approuve.

> « MailCopilot n'a pas pu charger le contenu de ce message — seuls ses en-têtes sont affichés. Vous pouvez réessayer. »

Un bouton **Réessayer** apparait sous l'ecran de remplacement dans les trois cas, aussi bien dans la fenetre principale que dans une fenetre de message separee. Cliquez dessus pour tenter de recuperer le corps a nouveau : en cas d'expiration du delai, un second essai suffit generalement une fois le travail en arriere-plan termine. Si le mode hors ligne est active ou si vos identifiants ont expire, reessayer continuera de produire le meme ecran tant que vous n'aurez pas desactive le mode hors ligne ou reouvert une session.

## Invitations à des réunions

Lorsqu'un message contient une invitation de calendrier (une pièce jointe `.ics` utilisant le protocole iTIP), MailCopilot affiche une carte **Invitation à une réunion** intégrée au-dessus du corps du message. Aucune application de calendrier externe ni service cloud n'est nécessaire.

La carte indique :

- **Titre de l'événement** — le résumé de la réunion.
- **Quand** — la date et l'heure de début. Dans la plupart des cas, l'heure est convertie et affichée dans le fuseau horaire de votre appareil, quel que soit le fuseau horaire utilisé par l'organisateur pour envoyer l'invitation ; si le fuseau horaire de l'invitation diffère du vôtre, une légende apparaît en dessous pour indiquer le fuseau horaire d'origine de l'organisateur, afin que vous puissiez voir en un coup d'œil qu'une conversion a eu lieu. La conversion n'est pas possible dans deux cas, et dans les deux l'heure d'origine de l'organisateur est affichée telle qu'envoyée : lorsque l'invitation indique un fuseau horaire que MailCopilot ne peut pas résoudre (certaines invitations Outlook/Exchange utilisent un nom de fuseau horaire au format Windows plutôt qu'un nom standard) — ici la légende apparaît quand même et indique de quel fuseau horaire il s'agit ; et lorsque l'invitation ne comporte aucune information de fuseau horaire et aucun décalage UTC explicite — ici il n'y a rien à indiquer dans une légende, donc aucune n'apparaît, et l'heure affichée n'est que les chiffres bruts de l'organisateur, sans indication du fuseau horaire auquel ils se rapportent.
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

Dans les vues de dossier de compte, l'archivage, le signalement comme spam ou le déplacement vers la corbeille affiche une barre d'annulation avec un compte à rebours. Cliquez sur **Annuler** avant l'expiration. Ce qui détermine l'éligibilité, ce sont les messages que l'action déplace réellement, pas les dossiers d'où provenait votre sélection d'origine : les messages déjà présents dans le dossier cible, ou appartenant à un compte sans dossier pour ce rôle, sont mis de côté et traités séparément plutôt que déplacés. La barre d'annulation ne couvre jamais qu'un seul dossier source, elle n'apparaît donc que lorsque tous les messages effectivement déplacés proviennent du dossier actuellement ouvert. Une suppression peut être mixte : les messages qui vont vers la Corbeille reçoivent une barre d'annulation s'ils remplissent cette condition, tandis que les messages déjà dans la Corbeille, ou appartenant à un compte sans dossier Corbeille, sont supprimés définitivement -- MailCopilot demande une confirmation avant de le faire, et attend votre réponse plutôt que d'agir immédiatement. Les actions entre comptes, et toute action dont les messages déplacés s'étendent encore sur plusieurs dossiers source -- par exemple une action groupée effectuée sur une sélection issue d'une recherche **Tous les dossiers** -- n'affichent pas de barre d'annulation : cette partie de l'action a quand même lieu immédiatement, dossier par dossier, elle ne peut simplement plus être annulée en une seule étape.
