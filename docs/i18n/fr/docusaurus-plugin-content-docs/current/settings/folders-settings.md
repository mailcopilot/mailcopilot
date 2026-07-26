---
sidebar_position: 4
title: Paramètres des dossiers
---

# Paramètres des dossiers

Ouvrez **Paramètres > Dossiers** pour configurer la gestion de vos dossiers de messagerie dans MailCopilot.

## Mappage des rôles de dossiers

MailCopilot a besoin de savoir quel dossier serveur correspond à chaque rôle spécial (Archive, Corbeille, Envoyés, Brouillons, Spam). La détection est automatique en fonction des attributs IMAP standards, mais vous pouvez modifier le mappage manuellement.

Pour chaque rôle, vous pouvez :
- Laisser **Auto** pour utiliser le dossier détecté automatiquement.
- Sélectionner un dossier spécifique dans la liste déroulante.
- Cliquer sur **Créer** pour créer le dossier standard sur le serveur s'il n'existe pas.

## Politique de synchronisation des dossiers

Sous le mappage des rôles, vous trouverez une configuration détaillée pour chaque dossier de votre compte :

### Visibilité

- **Afficher dans la barre latérale** -- affiche ou masque le dossier dans la barre latérale. Décochez pour masquer les dossiers rarement utilisés.

### Badges de non-lus

- **Inclure dans les badges de non-lus** -- indique si le nombre de messages non lus de ce dossier est pris en compte dans le badge total affiché dans l'application.

### Indexation pour la recherche

- **Inclure dans la recherche** -- indique si les corps des messages de ce dossier sont indexés pour la recherche en texte intégral. Lorsque désactivé, le dossier reste visible dans la liste des messages et ses en-têtes sont accessibles à la recherche, mais les requêtes `body:` ne renverront pas de résultats de ce dossier.

Les dossiers Indésirables, Spam et Corbeille sont exclus de l'indexation par défaut afin de ne pas encombrer les résultats de recherche et de réduire l'utilisation du disque. Vous pouvez activer l'indexation pour n'importe quel dossier si nécessaire.

### Mode de synchronisation des en-têtes

Contrôle la façon dont les en-têtes de messages sont synchronisés pour le dossier :

- **Tous les messages** -- synchroniser tous les en-têtes (recommandé pour la boîte de réception).
- **À l'ouverture** -- synchroniser les en-têtes uniquement lorsque vous accédez au dossier.
- **Par période** -- synchroniser les en-têtes des N derniers jours uniquement.

Pour cesser entièrement la synchronisation d'un dossier, masquez-le via l'option **Masquer de la barre latérale** du menu contextuel. Les dossiers masqués sont totalement exclus de la synchronisation des en-têtes, du stockage hors ligne et des badges.

### Mode hors ligne {#offline-mode}

Contrôle le téléchargement des corps de messages pour la lecture hors connexion :

- **Désactivé** -- ne pas télécharger les corps de messages.
- **Par période** -- télécharger les corps des N derniers jours.
- **Tous les messages** -- télécharger tous les corps de messages.

## Sélection de compte

Si vous avez plusieurs comptes, utilisez le sélecteur de compte en haut pour passer d'un compte à l'autre et configurer les dossiers de chacun séparément.
