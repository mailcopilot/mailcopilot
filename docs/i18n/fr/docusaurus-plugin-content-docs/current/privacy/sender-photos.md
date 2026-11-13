---
sidebar_position: 3
title: Photos des expéditeurs (Gravatar)
---

# Photos des expéditeurs (Gravatar)

L'option **Afficher les photos des expéditeurs (Gravatar)** est désactivée sur les nouvelles installations. Tant qu'elle l'est, MailCopilot n'envoie aucune requête à gravatar.com.

Une installation mise à jour depuis une version antérieure à 1.27.2 conserve le réglage enregistré. Les anciennes versions activaient l'option par défaut et écrivaient cette valeur dans les paramètres : pour la plupart des installations existantes, elle est donc activée. Si vous n'en voulez pas, désactivez-la comme indiqué plus bas.

## Ce qui est envoyé lorsque l'option est activée

Pour chaque adresse d'expéditeur affichée dans la liste des messages, l'application demande une photo à `www.gravatar.com`. La requête part directement de votre ordinateur vers Gravatar. Aucun serveur exploité par MailCopilot n'y participe, et elle ne passe pas par le proxy utilisé pour les images distantes des messages.

Gravatar reçoit :

- le hachage SHA-256 de l'adresse de l'expéditeur (sans espaces, en minuscules). Quiconque connaît une adresse peut calculer son hachage et le rapprocher de la requête ;
- votre adresse IP et l'heure de la requête ;
- les en-têtes habituels d'une requête de navigateur, dont un User-Agent contenant le nom et la version de l'application.

La requête ne contient pas d'en-tête Referer. Gravatar ne reçoit ni le texte des messages ni leurs objets. Les adresses de vos propres comptes et identités sont ignorées dans la liste des messages : leurs hachages n'y sont pas envoyés.

L'application garde en mémoire les expéditeurs sans photo. Les photos renvoyées par Gravatar sont aussi stockées dans le cache HTTP de Chromium, dans le dossier de données de l'application sur votre disque, comme toute image chargée par l'application. Désactiver l'option ne vide pas ce cache.

## Où modifier l'option

Paramètres > Productivité > **Afficher les photos des expéditeurs (Gravatar)**.

## L'avatar de votre propre compte

Le mode d'avatar **Gravatar** d'un compte (Paramètres > Comptes) est un choix distinct. Lorsque vous le sélectionnez, le même type de requête est envoyé pour l'adresse de ce compte. Les autres modes n'envoient aucune requête.
