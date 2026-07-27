---
sidebar_position: 2
title: Parametres de productivite
---

# Parametres de productivite

## Notifications de bureau

Activez ou desactivez les notifications systeme pour les nouveaux e-mails.

## IMAP IDLE

Connexion persistante pour recevoir les nouveaux messages instantanement.

## Intervalle de synchronisation

Choisissez la frequence de verification des nouveaux messages (1, 2, 5, 10, 15 ou 30 minutes). Avec IMAP IDLE active, cet intervalle sert uniquement de secours. Augmentez-le pour reduire la charge serveur.

## Synchronisation des brouillons

Sauvegarde automatique des brouillons dans le dossier Brouillons IMAP.

## Toujours charger les images externes

Desactive la banniere de confidentialite pour les images.

## Photos des expediteurs (Gravatar)

Lorsque cette option est activee (par defaut), MailCopilot affiche les photos de profil a cote des noms des expediteurs dans la liste des messages. Les photos sont chargees depuis [Gravatar](https://gravatar.com). Si un expediteur n'a pas de profil Gravatar, un cercle colore avec ses initiales est affiche a la place.

Desactivez cette option si vous preferez des avatars avec initiales uniquement ou pour eviter les requetes reseau.

## Mode sombre pour le contenu des e-mails

Avec le thème sombre, le contenu HTML des e-mails peut être difficile à lire car beaucoup d'e-mails sont conçus pour un fond blanc. Activez cette option (activée par défaut) pour inverser automatiquement les couleurs du contenu des e-mails en mode sombre et permettre une lecture confortable.

Les images, vidéos et autres médias conservent leurs couleurs d'origine — seuls le texte et l'arrière-plan sont inversés.

## Ordre de tri

Choisissez l'ordre de tri de la liste des messages :

- **Par date** (par defaut) -- les messages les plus recents en premier.
- **Par expediteur** -- par ordre alphabetique du nom de l'expediteur.
- **Par objet** -- par ordre alphabetique de l'objet.

## Avancement automatique

Choisissez ce qui se passe apres l'archivage, la suppression ou le report d'un message :

- **Ouvrir l'e-mail plus ancien** (par defaut) -- ouvre automatiquement le message suivant plus ancien.
- **Ouvrir l'e-mail plus recent** -- ouvre le message plus recent.
- **Retour a la liste** -- ferme le detail et revient a la liste.
- **Rester (ne rien faire)** -- garde la vue actuelle sans message actif.

Fonctionne particulierement bien avec [Envoyer et archiver](../usage/composing-emails#send--archive) pour une approche inbox-zero.

## Regroupement en conversations

Regroupe les messages lies en fils de discussion.

## Preselection de raccourcis

Choisissez entre les preselections **Gmail** et **Outlook**.

## Delai d'envoi

Ajoutez un delai (5, 10 ou 30 secondes) avant l'envoi effectif pour pouvoir annuler.

## Mode hors ligne

Telechargez les messages pour les lire sans connexion Internet. Le mode hors ligne est configure **par dossier** dans l'onglet [Dossiers](folders-settings#offline-mode) — vous pouvez l'activer pour la Boite de reception, les Envoyes ou tout autre dossier individuellement.

L'onglet Productivite contient uniquement la limite de taille globale :

- **Taille maximale des messages** — ignorer les messages plus grands que cette taille (0 = sans limite, en Ko).
- **Synchroniser maintenant** — declencher manuellement une synchronisation hors ligne pour tous les dossiers actives.

Lorsque vous ouvrez un message hors ligne, MailCopilot affiche les en-tetes mis en cache (objet, expediteur, date) et un indicateur signalant que le corps du message n'est pas disponible. Une fois la connexion retablie, le message complet se charge normalement.
