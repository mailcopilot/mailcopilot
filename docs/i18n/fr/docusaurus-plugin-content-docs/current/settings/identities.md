---
sidebar_position: 4
title: Identities
---

# Identités

Un même compte de messagerie peut posséder plusieurs **identités** — c'est-à-dire des adresses « From » alternatives depuis lesquelles vous envoyez vos messages. C'est utile pour les comptes Gmail ou Microsoft 365 qui disposent d'une adresse principale et de plusieurs alias (un alias personnel, un alias d'équipe, une ancienne adresse) et pour lesquels vous souhaitez attribuer à chacun son propre nom d'affichage, sa signature et ses règles de Bcc, sans avoir à enregistrer chaque alias comme un compte IMAP distinct.

## Composition d'une identité

Chaque identité contient :

- Un **nom d'affichage** — ce que voit le destinataire dans l'en-tête « From ».
- Une **adresse e-mail** — l'adresse réellement utilisée dans le champ « From ». Le compte sous-jacent doit être autorisé à envoyer depuis cette adresse.
- Une **signature** facultative — remplace la signature du compte lorsque l'identité est sélectionnée. Voir [Signatures](./signatures) pour le comportement des signatures dans les réponses et transferts.
- Un **Bcc par défaut** facultatif — ajouté automatiquement au champ Bcc chaque fois que l'identité est choisie dans la fenêtre de rédaction.
- Un **indicateur « par défaut »** — exactement une identité par compte est marquée comme principale. L'identité par défaut est utilisée quand aucune règle plus spécifique ne s'applique.

Chaque compte possède toujours au moins une identité. Lors de la première connexion, MailCopilot crée une unique identité par défaut à partir du nom du compte, de son email et de la signature existante.

## Gestion des identités

Ouvrez **Paramètres > Identities** et choisissez le compte dans le menu déroulant en haut. L'onglet affiche la liste des identités de ce compte, avec des actions pour :

- **Ajouter** une nouvelle identité. Renseignez le nom d'affichage, l'email, la signature et le Bcc par défaut ; cochez « par défaut » si nécessaire.
- **Modifier** une identité existante pour changer n'importe quel champ.
- **Définir comme défaut** — promouvoir une identité au rang de principale. Une seule identité peut être par défaut à la fois.
- **Supprimer** une identité. L'identité par défaut ne peut pas être supprimée ; promouvez d'abord une autre identité.

## Choisir une identité lors de la rédaction

La fenêtre de rédaction comporte un sélecteur d'identité juste sous le menu déroulant du compte « From ». Par défaut, MailCopilot choisit une identité pour vous selon l'ordre suivant :

1. **Réponses et transferts** — comparaison avec les adresses From, To et Cc du message d'origine. La première identité dont l'email apparaît dans cette liste l'emporte, pour que votre réponse parte depuis l'adresse à laquelle vous avez initialement reçu le message. La comparaison est insensible à la casse sur l'email complet ; les chaînes d'alias et les variantes avec adresse plus (« plus-addressing ») ne sont pas reconnues et retombent sur l'identité par défaut.
2. **Nouveaux messages** — l'identité par défaut du compte est sélectionnée.

Vous pouvez à tout moment outrepasser ce choix en ouvrant le menu déroulant et en sélectionnant une autre identité. Changer d'identité met à jour l'en-tête « From ». La signature n'est remplacée que lorsque le corps est vide ou ne contient qu'un bloc de signature après le séparateur standard `\n\n--\n` — le texte que vous avez tapé au-dessus du séparateur n'est jamais écrasé. Le champ Bcc n'est remplacé que lorsqu'il est vide ou égal au Bcc par défaut de l'identité précédemment sélectionnée, donc un Bcc tapé manuellement survit aux changements d'identité.

## Lien avec les signatures

Les signatures vivent désormais **par identité**, non plus par compte. L'onglet **Paramètres > Signatures** modifie la signature de l'identité par défaut du compte sélectionné ; les autres identités se modifient dans **Paramètres > Identities**. Les comptes créés avant le déploiement multi-identités conservent leur ancienne signature par compte : MailCopilot la lit via une identité par défaut synthétisée, donc rien ne se casse. La nouvelle liste d'identités est écrite sur disque la prochaine fois que le compte est sauvegardé (par exemple lorsque vous modifiez n'importe quel champ du compte).

## Envoi et audit

L'identité active dans la fenêtre de rédaction au moment de l'envoi est celle qui apparaît dans le message sortant réel :

- L'en-tête « From » SMTP ou Microsoft Graph porte l'email et le nom d'affichage de l'identité.
- Les envois programmés mémorisent l'identité choisie au moment de la planification : un message planifié depuis votre alias partira bien depuis cet alias quand le minuteur se déclenchera.
