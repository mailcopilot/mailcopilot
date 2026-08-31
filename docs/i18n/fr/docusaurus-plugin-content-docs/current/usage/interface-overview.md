---
sidebar_position: 1
title: Apercu de l'interface
---

# Apercu de l'interface

MailCopilot dispose d'une interface epuree a trois colonnes pour une gestion efficace des e-mails.

## Barre laterale

La barre laterale a gauche contient : le selecteur de compte, la liste des dossiers avec badges de non-lus, les boutons Rediger, Synchroniser et Parametres, ainsi que la boite de reception unifiee pour les comptes multiples.

- **Travailler hors ligne** — active et désactive le mode hors ligne. En mode hors ligne, MailCopilot arrête toute activité réseau et fonctionne uniquement avec les données en cache. Vous pouvez lire les e-mails précédemment synchronisés, les marquer comme lus ou favoris, et parcourir les dossiers. Les modifications effectuées hors ligne seront synchronisées lorsque vous reviendrez en ligne. L'icône du bouton alterne entre Wi-Fi (en ligne) et Wi-Fi barré (hors ligne).
- **Inbox Zero** -- lorsque vous traitez des e-mails (archiver, supprimer, reporter, marquer comme spam ou déplacer dans un dossier) et que votre boîte de réception est vide, un message de félicitations « Inbox Zero ! » apparaît dans la zone de la liste des messages, accompagné du nombre d'e-mails traités aujourd'hui. Le compteur se réinitialise automatiquement à minuit et au redémarrage de l'application.

La barre laterale peut etre reduite en mode icones pour liberer de l'espace. Les icones reduites affichent des infobulles.

## Liste des messages

La colonne centrale affiche les messages du dossier selectionne : expediteur, objet, date, indicateurs de non-lu, etoile, pieces jointes et nombre de messages dans le fil. Pour un fil, la ligne est affichee comme non lue des qu'**un seul** message du fil actuellement affiche dans la liste est non lu, pas uniquement le plus recent. Voir [Fils de discussion](./reading-emails#fils-de-discussion).

En mode **Boite de reception unifiee**, l'adresse e-mail du compte apparait a cote du nom de l'expediteur pour identifier quel compte a recu le message.

Utilisez les boutons filtres pour afficher les messages Non-lus, Avec pieces jointes ou Etoiles. Cliquez sur un bouton pour activer le filtre, cliquez a nouveau pour le desactiver. Selectionner un autre bouton remplace le filtre actif.

Pour changer l'ordre de tri (date, expediteur, objet), allez dans **Parametres > Productivite > Sort emails by**.

### Menu contextuel des messages

Faites un clic droit sur n'importe quel message de la liste pour ouvrir le menu contextuel. Vous pouvez y effectuer rapidement les actions suivantes :

- **Reporter** le message
- **Archiver**
- **Supprimer**
- **Marquer comme lu / non lu**
- D'autres actions : **Lire plus tard**, **Epingler**, **Deplacer vers un dossier**, **Marquer comme spam**, **Repondre**, **Repondre a tous**, **Transferer**

Lorsque plusieurs messages sont selectionnes, le menu contextuel peut marquer lu/non-lu, deplacer, marquer comme spam, archiver ou supprimer tous les messages selectionnes en une seule fois. « Lire plus tard » et l'epinglage s'appliquent toujours uniquement au message sur lequel le menu a ete ouvert. Reporter s'applique a tout le fil quand le regroupement par conversation est active, sinon au seul message. Repondre, Repondre a tous et Transferer sont masques en mode de selection multiple.

### Selection des messages et barre d'actions

- Cliquez sur un message pour le selectionner et le lire.
- Maintenez **Shift** et cliquez pour selectionner une plage.
- Utilisez la touche **x** pour basculer la selection.
- Une barre d'actions est toujours visible au-dessus de la liste. Lorsque vous selectionnez un ou plusieurs messages, les boutons deviennent actifs : marquer lu/non-lu, marquer comme spam, archiver, supprimer et deplacer. Le deplacement est desactive dans la boite de reception unifiee. La barre fonctionne dans tous les autres modes.

## Volet de lecture

La colonne droite affiche le contenu du message selectionne : en-tetes, corps du message, pieces jointes et boutons d'action (repondre, transferer, supprimer, archiver, reporter, etc.). En mode fil, la barre d'outils devient consciente du fil : Repondre/Transferer ciblent le message le plus recent, Archiver et Supprimer agissent sur l'ensemble du fil. Voir [Lire les e-mails](./reading-emails#actions-sur-les-fils) pour plus de details.

## Colonnes redimensionnables

Faites glisser la bordure entre les colonnes pour ajuster leur largeur. Votre preference est sauvegardee entre les sessions.

## Selection et edition de texte

Faites un clic droit dans n'importe quel champ de texte -- la barre de recherche, un message en cours de redaction, l'invite de l'assistant IA, ou toute autre zone editable -- pour ouvrir un petit menu contextuel avec **Couper**, **Copier**, **Coller** et **Tout sélectionner**. Un clic droit sur du texte selectionne mais non editable (par exemple un passage surligne dans le corps d'un message) propose uniquement **Copier**.

Un clic droit sur un lien dans le corps d'un message ouvre un menu different avec des options pour ouvrir ou copier le lien ; voir [Clic droit sur un lien](./reading-emails#clic-droit-sur-un-lien).

## Barre d'etat

Une barre d'etat persistante longe le bas de la fenetre, similaire a celle de VS Code. Elle expose l'activite de fond qui n'etait auparavant visible que dans le panneau de recherche :

- **Indicateur de synchronisation** -- s'affiche lorsqu'un dossier est en cours de synchronisation avec le serveur IMAP, avec le compte, le nom du dossier, le nombre actuel de messages et un pourcentage le cas echeant.
- **Couverture des en-tetes** -- combien de dossiers ont termine leur synchronisation initiale d'en-tetes (par exemple, « En-tetes : 5/8 dossiers »).
- **Progression de l'indexation des corps** -- pourcentage des messages en cache dont le corps a ete indexe pour la recherche en texte integral.
- **Badge de resultats distants** -- lorsqu'une recherche renvoie des correspondances supplementaires depuis le serveur au-dela du cache local, un badge « +N depuis le serveur » apparait ici.

La barre d'etat reste visible tant que des taches de synchronisation ou d'indexation sont en cours, et pas seulement pendant une recherche. Quand il n'y a rien a signaler, elle se replie automatiquement. Le contenu se rafraichit en arriere-plan a peu pres toutes les 30 secondes. La barre est masquee a l'impression.

## Centre de notifications

Une icone de cloche dans l'en-tete de la liste des messages ouvre le centre de notifications. Il regroupe deux types de notifications :

- **Rappels de relance** -- lorsqu'une relance que vous avez programmee sur un message envoye arrive a echeance (voir [Rediger des e-mails](./composing-emails) pour les details).
- **Echecs d'envoi** -- lorsqu'un message dans la file d'envoi abandonne apres des erreurs de livraison permanentes (SMTP ou, pour les comptes Outlook, Microsoft Graph).

La cloche affiche un petit badge avec le nombre de notifications nouvelles. Cliquez sur la cloche pour ouvrir le panneau deroulant : vous pouvez y lire chaque notification, la marquer comme lue, marquer toutes les notifications comme lues d'un coup, ou supprimer des entrees individuellement. Les notifications sont stockees localement dans le cache SQLite, elles survivent donc aux redemarrages de l'application ; les entrees vieilles de plus de 30 jours sont purgees automatiquement.

Lorsque les notifications du systeme d'exploitation sont autorisees, les memes evenements declenchent egalement une notification native du bureau.

## Fenetre unique

MailCopilot impose une seule instance en cours d'execution par utilisateur. Si vous lancez l'application une deuxieme fois -- par exemple en cliquant sur un lien `mailto:` ou un autre raccourci du bureau -- la fenetre existante est ramenee au premier plan et mise au foyer au lieu d'ouvrir une fenetre dupliquee. Cela evite que deux copies paralleles ne se disputent les memes connexions IMAP et le cache local.

## Liens `mailto:` et client de messagerie par defaut

Vous pouvez enregistrer MailCopilot comme gestionnaire systeme des liens `mailto:`, de sorte que cliquer sur un lien « envoyer un e-mail » dans votre navigateur, votre terminal ou une autre application ouvre la fenetre de redaction de MailCopilot avec le destinataire et les autres parametres pre-remplis.

L'interrupteur pour enregistrer MailCopilot comme application de messagerie par defaut se trouve dans **Parametres > General**. Les parametres `mailto:` pris en charge incluent `to`, `cc`, `bcc`, `subject` et `body`.

## Travailler hors ligne

Le bouton « Travailler hors ligne » dans la barre laterale (icone Wi-Fi, barree quand le mode est actif) bascule le mode hors ligne. En hors ligne :

- Toute activite reseau s'arrete -- aucune connexion IMAP ou SMTP n'est ouverte.
- Vous pouvez toujours lire les messages deja synchronises, parcourir les dossiers, marquer les messages comme lus ou avec etoile, etc.
- Les messages sortants sont mis en file dans la boite d'envoi et expedies automatiquement quand vous repassez en ligne.
- Les operations de deplacement et de suppression creent des marqueurs locaux qui font disparaitre immediatement le message du dossier source au lieu de le laisser visible jusqu'a la reconnexion. Le deplacement reel cote serveur est rejoue lors du retour en ligne, et le marqueur local est reconcilie avec le resultat du serveur.
- Le comportement par dossier en mode hors ligne (faut-il telecharger les corps pour la lecture hors ligne, sur quelle plage de temps) se configure dans **Parametres > Dossiers** ; voir [Parametres des dossiers](../settings/folders-settings).

## Themes clair et sombre

Basculez entre les themes dans **Parametres > General > Theme**.
