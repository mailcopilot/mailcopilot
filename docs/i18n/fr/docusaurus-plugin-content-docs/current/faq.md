---
sidebar_position: 7
title: FAQ
---

# Questions frequentes

## Qu'est-ce que MailCopilot ?

Un client de messagerie de bureau moderne connecte a vos comptes via IMAP et SMTP.

## Quelles plateformes sont prises en charge ?

**Linux** (AppImage). Windows et macOS sont prevus.

## Ou sont stockes mes mots de passe ?

Dans le trousseau systeme (keytar), jamais en texte brut.

## Quels fournisseurs sont compatibles ?

Tout fournisseur IMAP/SMTP : Gmail, Outlook, Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail (via Bridge), serveurs auto-heberges.

## Comment connecter Gmail ?

Cliquez sur **Se connecter avec Google** dans l'assistant.

## Puis-je utiliser plusieurs comptes ?

Oui, avec basculement dans la barre laterale ou la boite de reception unifiee.

## Le test de connexion affiche une erreur de certificat TLS. Que faire ?

MailCopilot verifie toujours les certificats TLS, en les comparant au jeu de certificats Mozilla integre et au magasin de certificats de votre systeme d'exploitation. Si votre serveur de messagerie utilise un certificat auto-signe ou personnalise, une invite de confiance apparaitra. Verifiez les details du certificat et acceptez-le si vous etes certain que le serveur est legitime. Si l'empreinte n'a pas encore ete lue, le bouton principal affiche d'abord **« Lire le certificat »** -- cliquez dessus, verifiez le resultat, puis cliquez sur **« Faire confiance et continuer »** pour confirmer.

## Mon antivirus ou mon proxy d'entreprise inspecte ma connexion de messagerie. MailCopilot fonctionnera-t-il quand meme ?

Oui. MailCopilot fait confiance au magasin de certificats de votre systeme d'exploitation en plus de son jeu de certificats integre, si bien que les logiciels de securite qui inspectent le trafic TLS (par exemple les antivirus avec inspection HTTPS) et les proxys d'entreprise ne perturbent plus la synchronisation du courrier. Apres la premiere synchronisation reussie de votre compte dans une session, MailCopilot verifie une fois cela et, le cas echeant, affiche une notification identifiant le logiciel ou le proxy responsable ; cette verification s'execute au plus une fois par serveur pendant toute la duree de vie de votre profil, donc une inspection activee sur un serveur apres que cette verification a deja eu lieu ne sera pas detectee. Si le certificat change ensuite pour un certificat qui ne peut plus etre approuve du tout (et non plus seulement via le magasin systeme), MailCopilot affiche une boite de dialogue de recuperation ou vous pouvez consulter les details du nouveau certificat et decider de lui faire confiance.

## Mon serveur de messagerie auto-signe a cesse de se connecter apres la mise a jour de MailCopilot. Pourquoi ?

L'epinglage de certificats ne comparait auparavant les empreintes que pour les certificats dont la chaine etait deja validee normalement ; les certificats auto-signes et a autorite de certification privee -- le cas exact pour lequel l'epinglage existe -- contournaient entierement cette verification d'empreinte. Cette faille est desormais comblee, ce qui est une amelioration de securite -- mais si vous avez epingle un serveur auto-signe ou a autorite de certification privee avant ce changement, l'epinglage enregistre peut ne pas inclure le certificat necessaire pour le verifier, et ce serveur ne se connectera plus. Ouvrez la boite de dialogue de recuperation de certificat qui apparait pour lui : si le bouton affiche **« Lire le certificat »**, cliquez dessus d'abord, puis cliquez sur **« Faire confiance et continuer »** ; si **« Faire confiance et continuer »** est deja affiche, cliquez simplement dessus. Cela enregistre l'epinglage avec le certificat lui-meme, et le compte se resynchronise automatiquement. Cette operation n'est necessaire qu'une seule fois par serveur concerne. Ajouter ou modifier un epinglage manuellement dans les Parametres ne corrige pas cela -- un epinglage manuel ne peut que restreindre la confiance pour un serveur qui a deja un certificat normal, publiquement approuve ; pour un certificat qui reste par ailleurs non approuve (auto-signe, ou d'une autorite de certification privee pas encore presente dans le magasin de votre systeme), seule la boite de dialogue de recuperation peut lui accorder sa confiance.

Si votre serveur utilise STARTTLS (typiquement le port IMAP 143 ou le port SMTP 587), MailCopilot ne peut pas capturer son certificat de cette facon -- seule l'empreinte est enregistree, si bien qu'un serveur STARTTLS auto-signe restera impossible a connecter. Utilisez plutot le TLS implicite (typiquement le port 993 pour IMAP, 465 pour SMTP) si votre serveur le prend en charge.

## Comment rechercher des messages ?

Cliquez sur la barre de recherche (ou appuyez sur **/***) et tapez votre requete.

Operateurs de recherche avances :

- `from:user@example.com` -- messages d'un expediteur specifique.
- `to:user@example.com` -- messages envoyes a un destinataire specifique.
- `subject:reunion` -- messages avec un mot dans le sujet.
- `has:attachment` -- messages avec pieces jointes.
- `is:unread` / `is:read` -- filtrer par statut de lecture.
- `is:starred` -- messages marques d'une etoile.
- `before:2026-01-01` / `after:2025-12-01` -- filtrer par date.
- `in:Sent` -- messages dans un dossier specifique.
- Negation avec `-` : `-from:spam@example.com`.
- Combiner avec `OR` ou `AND` (insensible a la casse) : `from:alice OR from:bob`.

## Comment annuler une suppression ?

Cliquez sur **Annuler** dans la barre d'annulation avant l'expiration du compte a rebours.

## L'assistant IA est-il obligatoire ?

Non, il est entierement optionnel.

## Ou puis-je voir ce que l'IA fait avec mes donnees ?

Ouvrez **Parametres → AI** et developpez la section **Confidentialite et audit**. Vous y trouverez un journal d'audit complet de chaque action IA : horodatage, fournisseur, modele, objectif, outil utilise, cout estime et resultat. Le nombre de tokens est enregistre si le fournisseur l'expose via le SDK ; sinon les colonnes affichent **n/d**. Vous pouvez egalement exporter le journal en JSON ou CSV.

Pour plus de details, consultez [Donnees IA et journal d'audit](./privacy/ai-data).

## Comment mettre a jour MailCopilot ?

Par defaut, MailCopilot ne telecharge **pas** les mises a jour automatiquement. Lorsqu'une nouvelle version est detectee, un bouton **Telecharger X.Y.Z** apparait dans **Parametres > A propos**. Cliquez dessus pour lancer le telechargement, puis cliquez sur **Redemarrer pour installer** une fois le telechargement termine.

Pour verifier manuellement a tout moment, ouvrez **Parametres > A propos** et cliquez sur **Rechercher les mises a jour**.

Pour activer le telechargement automatique en arriere-plan, ouvrez **Parametres > A propos** et cochez **Telecharger automatiquement les mises a jour en arriere-plan**. Lorsque cette option est activee, les nouvelles versions se telechargent silencieusement et vous etes invite a redemarrer lorsque la mise a jour est prete.

Si MailCopilot est installe pour l'ensemble du systeme (par exemple via un gestionnaire de paquets), la case de telechargement automatique est desactivee et les controles de telechargement et de redemarrage ne sont pas disponibles. Utilisez votre gestionnaire de paquets ou des privileges d'administrateur pour mettre a jour. Le bouton **Rechercher les mises a jour** fonctionne toujours dans ce mode.

## Puis-je desactiver les mises a jour automatiques ?

Le telechargement automatique en arriere-plan est desactive par defaut. Si vous avez active l'option **Telecharger automatiquement les mises a jour en arriere-plan** et souhaitez la desactiver, ouvrez **Parametres > A propos** et decochez cette option. MailCopilot vous notifiera toujours de la disponibilite d'une mise a jour, mais le telechargement ne commencera pas avant que vous ne cliquiez sur **Telecharger**.

## MailCopilot ne synchronise pas.

Verifiez IMAP IDLE dans les parametres, cliquez sur Synchroniser, verifiez votre connexion internet.
