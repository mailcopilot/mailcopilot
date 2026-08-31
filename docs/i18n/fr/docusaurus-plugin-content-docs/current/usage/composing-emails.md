---
sidebar_position: 3
title: Rediger des e-mails
---

# Rediger des e-mails

## Nouveau message

Cliquez sur **Rediger** dans la barre laterale (ou touche **c**) pour ouvrir la fenetre de redaction dans une fenetre separee.

## Champs du message

- **De** -- selectionnez le compte d'envoi si vous en avez plusieurs, via le menu deroulant en haut. Si le compte choisi possede plusieurs **identites** (adresses « From » alternatives, par exemple un alias sur le meme compte Gmail ou Outlook), un selecteur d'identite supplementaire apparait juste sous le menu du compte et permet de choisir depuis quelle identite envoyer. Voir [Identites](../settings/identities) pour le fonctionnement des identites et des signatures par identite.
- **A** -- saisissez l'adresse du destinataire. Ajoutez plusieurs destinataires avec **Enter**, **Tab** ou **virgule**.
- **Cc / Cci** -- cliquez sur **Cc/Cci** pour afficher ces champs.
- **Objet** et **Corps du message**.

## Autocompletion des contacts

MailCopilot suggere des contacts bases sur votre correspondance precedente.

## Pieces jointes

Cliquez sur **Joindre** ou glissez-deposez des fichiers. Taille maximale : 25 Mo par fichier.

## Repondre et transferer

- **Repondre** (**r**) -- avec l'expediteur et le message cite.
- **Repondre a tous** (**a**) -- avec tous les destinataires.
- **Transferer** (**f**) -- avec le message cite et "Fwd:" dans l'objet.

## Brouillons et sauvegarde automatique

Les brouillons sont sauvegardes automatiquement en local et dans votre dossier Brouillons IMAP.

## Envoi

Cliquez sur le bouton **Envoyer** pour envoyer votre message. La fenêtre de rédaction se ferme immédiatement tandis que le message est envoyé en arrière-plan. En cas d'erreur (par exemple, un problème de connexion), vous recevrez une notification sur le bureau.

Si le message a été envoyé avec succès mais que MailCopilot n'a pas pu enregistrer une copie dans le dossier Envoyés (par exemple, si le serveur IMAP est temporairement indisponible), une notification apparaît : **Message envoyé, mais la copie n'a pas pu être enregistrée dans le dossier Envoyés**. Cliquez sur **Fermer** pour la fermer. Le message a bien été distribué au destinataire — seule la copie côté serveur n'a pas été sauvegardée.

## Envoyer et archiver {#send--archive}

Lorsque vous répondez à un e-mail, le menu déroulant du bouton **Envoyer** inclut l'option **Envoyer et archiver**. Cliquez sur la petite flèche **▾** à côté du bouton Envoyer, puis choisissez **Envoyer et archiver**. Cela envoie votre réponse et archive automatiquement l'e-mail original en une seule étape.

C'est particulièrement utile pour un workflow Inbox Zero — répondez et supprimez l'e-mail de votre boîte de réception sans clics supplémentaires.

## Envoi programmé

Vous pouvez programmer l'envoi d'un message à une heure ultérieure :

1. Cliquez sur la petite flèche **▾** à côté du bouton Envoyer pour ouvrir le menu déroulant.
2. Choisissez une heure prédéfinie :
   - **Plus tard aujourd'hui** — la prochaine demi-heure.
   - **Demain matin (09h00)**.
   - **Lundi matin (09h00)**.
   - **Choisir une date et heure** — sélectionnez une date et une heure personnalisées.
3. Le message sera mis en file d'attente et envoyé automatiquement à l'heure programmée.

Les messages programmés apparaissent dans le dossier **Boîte d'envoi**, où vous pouvez les modifier, reprogrammer, envoyer immédiatement ou annuler.

## Delai d'envoi

Activez un delai (5, 10 ou 30 secondes) dans **Parametres > Productivite > Delai d'envoi** pour pouvoir annuler un envoi.

## Utiliser les modeles

Les modeles vous permettent d'inserer rapidement des messages pre-rediges dans la fenetre de redaction, ce qui fait gagner du temps pour les messages que vous envoyez regulierement.

### Appliquer un modele

1. Ouvrez la fenetre de redaction.
2. Cliquez sur le bouton **Modeles** (icone de grille) dans la barre d'outils.
3. Selectionnez un modele dans le menu deroulant.
4. L'objet et le corps du modele sont inseres dans la fenetre de redaction.

### Variables de modele

Les modeles peuvent inclure des variables qui sont automatiquement remplacees lors de l'application :

- `{name}` -- le nom du destinataire (si disponible).
- `{email}` -- l'adresse e-mail du destinataire.
- `{date}` -- la date du jour.

Par exemple, un modele contenant "Cher `{name}`, ..." remplacera `{name}` par le nom reel du destinataire.

Pour creer et gerer vos modeles, allez dans **Parametres > Modeles**. Consultez la page [Parametres des modeles](../settings/templates) pour plus de details.

## Actions rapides de redaction

Une petite barre d'outils IA apparaît au-dessus du corps du message avec quatre boutons : **Améliorer**, **Raccourcir**, **Formel** et **Corriger la grammaire**. Cliquez sur l'un d'eux pour que l'IA réécrive le texte que vous avez écrit vous-même -- le message cité auquel vous répondez, tout en-tête de message transféré, et votre signature restent intacts, pour les réponses, les transferts et les signatures produits par MailCopilot lui-même, ainsi que pour les conventions de citation répandues des autres clients de messagerie. **Un brouillon rédigé dans un autre logiciel de messagerie peut citer dans un style que MailCopilot ne reconnaît pas -- sur un tel brouillon, aucune frontière n'est trouvée, l'ensemble du corps est considéré comme votre propre texte, et la citation est réécrite avec lui.** Pour la liste complète des styles de citation reconnus et non reconnus, voir [Actions rapides de rédaction](../ai-assistant#actions-rapides-de-redaction).

MailCopilot affiche un panneau « Vérifier la réécriture IA » : votre propre texte et la réécriture apparaissent ensemble comme un seul passage défilant, avec les modifications marquées directement dans le texte -- les mots supprimés barrés, les mots ajoutés surlignés -- accompagnés d'une liste des modifications individuelles ; des copies **Avant** / **Après** en texte brut restent accessibles en dépliant **Texte brut**. Choisissez **Remplacer** pour remplacer votre propre texte par la réécriture (le message cité et la signature en dessous restent inchangés, si une frontière a été trouvée -- voir ci-dessus), **Insérer au curseur** pour l'insérer à la position actuelle du curseur, ou **Annuler** pour rejeter la réécriture et laisser votre brouillon inchangé. Le corps du message n'est modifié que si vous choisissez **Remplacer** ou **Insérer au curseur** -- **Annuler** laisse le brouillon inchangé.

Les actions rapides nécessitent un fournisseur IA configuré (voir [Assistant IA](../ai-assistant)) et du texte écrit par vous, au-dessus de toute citation, à réécrire. Voir [Actions rapides de rédaction](../ai-assistant#actions-rapides-de-redaction) pour le comportement complet et les détails de confidentialité.

## Traduction du brouillon

Si la [traduction du brouillon](../ai-assistant#traduction-du-brouillon) est activée pour ce compte, une liste **Traduire le brouillon en** et un bouton **Traduire** apparaissent à côté de la barre d'outils IA ci-dessus. Choisissez une langue cible -- ou conservez la suggestion que MailCopilot a pu pré-remplir lorsque vous répondez, la langue détectée du message auquel vous répondez -- puis cliquez sur **Traduire**. Le résultat apparaît dans le même panneau « Vérifier la réécriture IA » utilisé ci-dessus, avec **Remplacer**, **Insérer au curseur** et **Annuler** ; rien n'est inséré dans votre brouillon de lui-même. Seul le texte que vous avez écrit vous-même est traduit -- le message cité, l'en-tête de transfert et la signature restent intacts, lorsqu'une frontière est trouvée : cela utilise la même détection que les actions rapides ci-dessus, donc un brouillon rédigé dans un autre logiciel de messagerie avec un style de citation non reconnu ne présente aucune frontière et est traduit dans son intégralité, citation comprise. La traduction du brouillon partage le même réglage de compte que la traduction du message côté lecture ; il n'y a rien de plus à activer. Voir [Traduction du brouillon](../ai-assistant#traduction-du-brouillon) pour le comportement complet et les détails de confidentialité.

## Avertissement d'envoi erroné

MailCopilot vous aide à éviter d'envoyer accidentellement des e-mails aux mauvaises personnes. Avant l'envoi, il vérifie la liste des destinataires et vous avertit dans deux situations :

- **Domaine externe** -- si la majorité des destinataires partagent un même domaine (par ex. @entreprise.com) et que vous avez ajouté quelqu'un d'un domaine différent et non approuvé, une boîte de dialogue de confirmation apparaît.
- **Nouveaux destinataires dans une réponse** -- lors d'une réponse, si vous avez ajouté des destinataires qui ne faisaient pas partie de la conversation d'origine, un avertissement s'affiche.

Vous pouvez ajouter des domaines de confiance (qui ne déclenchent pas d'avertissement) dans **Paramètres > Productivité > Domaines de confiance**.

## Signature

Si l'identite active (l'identite par defaut, sauf si vous en avez choisi une autre) possede une signature configuree dans **Parametres > Signatures** ou **Parametres > Identities**, elle est ajoutee automatiquement aux nouveaux messages. La signature n'est pas ajoutee aux reponses et transferts.

## Rappels de suivi

Les rappels de suivi vous aident à suivre les e-mails qui nécessitent une réponse. Si vous envoyez un message important et ne recevez pas de réponse, MailCopilot vous le rappellera.

### Configurer un rappel de suivi

1. Dans la fenêtre de rédaction, cochez la case **« Rappeler si pas de réponse »** en bas.
2. Choisissez une période de rappel : **2 jours**, **3 jours** ou **7 jours**.
3. Envoyez le message normalement.

Si aucune réponse n'est reçue dans le délai choisi, vous recevrez une notification de bureau vous rappelant de faire un suivi.

### Le dossier Suivis

Les suivis en attente apparaissent dans le dossier **Suivis** de la barre latérale (icône de cloche). Le badge du dossier indique le nombre de rappels en attente.

Chaque suivi affiche :
- L'adresse du destinataire.
- L'objet du message original.
- Le temps écoulé depuis le déclenchement du rappel.

### Rejeter un rappel

Lorsque vous n'avez plus besoin d'un rappel (par exemple, la personne a répondu en dehors de l'e-mail), cliquez sur le bouton **Rejeter** à côté du suivi pour le supprimer.
