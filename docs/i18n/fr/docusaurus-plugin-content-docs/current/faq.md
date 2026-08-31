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

MailCopilot verifie toujours les certificats TLS, en les comparant au jeu de certificats Mozilla integre et au magasin de certificats de votre systeme d'exploitation. Si votre serveur de messagerie utilise un certificat auto-signe ou personnalise, une invite de confiance apparaitra. Verifiez les details du certificat et acceptez-le si vous etes certain que le serveur est legitime. Si l'empreinte n'a pas encore ete lue, le bouton principal affiche d'abord **« Lire le certificat »** -- cliquez dessus, verifiez le resultat, puis cliquez sur **« Approuver et continuer »** pour confirmer.

## Mon antivirus ou mon proxy d'entreprise inspecte ma connexion de messagerie. MailCopilot fonctionnera-t-il quand meme ?

Oui. MailCopilot fait confiance au magasin de certificats de votre systeme d'exploitation en plus de son jeu de certificats integre, si bien que les logiciels de securite qui inspectent le trafic TLS (par exemple les antivirus avec inspection HTTPS) et les proxys d'entreprise ne perturbent plus la synchronisation du courrier. Apres la premiere synchronisation reussie de votre compte dans une session, MailCopilot verifie une fois cela et, le cas echeant, affiche une notification identifiant le logiciel ou le proxy responsable ; cette verification s'execute au plus une fois par serveur pendant toute la duree de vie de votre profil, donc une inspection activee sur un serveur apres que cette verification a deja eu lieu ne sera pas detectee. Si le certificat change ensuite pour un certificat qui ne peut plus etre approuve du tout (et non plus seulement via le magasin systeme), MailCopilot affiche une boite de dialogue de recuperation ou vous pouvez consulter les details du nouveau certificat et decider de lui faire confiance.

## Mon serveur de messagerie auto-signe a cesse de se connecter apres la mise a jour de MailCopilot. Pourquoi ?

L'epinglage de certificats ne comparait auparavant les empreintes que pour les certificats dont la chaine etait deja validee normalement ; les certificats auto-signes et a autorite de certification privee -- le cas exact pour lequel l'epinglage existe -- contournaient entierement cette verification d'empreinte. Cette faille est desormais comblee, ce qui est une amelioration de securite -- mais si vous avez epingle un serveur auto-signe ou a autorite de certification privee avant ce changement, l'epinglage enregistre peut ne pas inclure le certificat necessaire pour le verifier, et ce serveur ne se connectera plus. Ouvrez la boite de dialogue de recuperation de certificat qui apparait pour lui : si le bouton affiche **« Lire le certificat »**, cliquez dessus d'abord, puis cliquez sur **« Approuver et continuer »** ; si **« Approuver et continuer »** est deja affiche, cliquez simplement dessus. Cela enregistre l'epinglage avec le certificat lui-meme, et le compte se resynchronise automatiquement. Cette operation n'est necessaire qu'une seule fois par serveur concerne. Ajouter ou modifier un epinglage manuellement dans les Parametres ne corrige pas cela -- un epinglage manuel ne peut que restreindre la confiance pour un serveur qui a deja un certificat normal, publiquement approuve ; pour un certificat qui reste par ailleurs non approuve (auto-signe, ou d'une autorite de certification privee pas encore presente dans le magasin de votre systeme), seule la boite de dialogue de recuperation peut lui accorder sa confiance.

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

## Puis-je annuler une suppression ?

Dans la plupart des cas, oui. Apres une suppression, un archivage ou un signalement comme spam, une barre d'annulation apparait en bas de l'ecran. Cliquez sur **Annuler** avant l'expiration du compte a rebours pour annuler l'action. L'annulation depend des messages que l'action deplace reellement, pas des dossiers d'ou provenait votre selection d'origine : les messages deja presents dans le dossier cible, ou appartenant a un compte sans dossier pour ce role, sont mis de cote et traites separement. La barre d'annulation ne couvre jamais qu'un seul dossier source, elle n'apparait donc que lorsque tous les messages effectivement deplaces proviennent du dossier actuellement ouvert -- agir sur un seul message trouve via une recherche **Tous les dossiers**, par exemple, n'affiche pas de barre d'annulation si ce message se trouve dans un autre dossier. Une suppression peut etre mixte : les messages deja dans la Corbeille, ou appartenant a un compte sans dossier Corbeille, ne peuvent pas etre deplaces et sont supprimes definitivement, MailCopilot attendant votre confirmation avant de le faire -- mais si le reste de la meme suppression peut encore aller vers la Corbeille, cette partie recoit quand meme sa propre barre d'annulation. Les actions entre comptes, et toute action dont les messages deplaces s'etendent encore sur plusieurs dossiers source, par exemple une action groupee sur une selection issue d'une recherche **Tous les dossiers**, ne proposent pas non plus d'annulation. Pour plus de details, consultez [Annuler les actions](./usage/reading-emails#annuler-les-actions).

## L'assistant IA est-il obligatoire ?

Non, il est entierement optionnel.

## Ou puis-je voir ce que l'IA fait avec mes donnees ?

Ouvrez **Parametres → AI** et developpez la section **Confidentialité et audit**. Vous y trouverez un journal d'audit complet de chaque action IA : horodatage, fournisseur, modele, objectif, outil utilise, cout estime et resultat. Le nombre de tokens est enregistre si le fournisseur l'expose via le SDK ; sinon les colonnes affichent **n/d**. Vous pouvez egalement exporter le journal en JSON ou CSV.

Pour plus de details, consultez [Donnees IA et journal d'audit](./privacy/ai-data).

## Comment mettre a jour MailCopilot ?

Par defaut, MailCopilot ne telecharge **pas** les mises a jour automatiquement. Lorsqu'une nouvelle version est detectee, un bouton **Télécharger X.Y.Z** apparait dans **Paramètres > À propos**. Cliquez dessus pour lancer le telechargement, puis cliquez sur **Redémarrer pour installer** une fois le telechargement termine.

Pour verifier manuellement a tout moment, ouvrez **Paramètres > À propos** et cliquez sur **Rechercher les mises à jour**.

Pour activer le telechargement automatique en arriere-plan, ouvrez **Paramètres > À propos** et cochez **Télécharger automatiquement les mises à jour en arrière-plan**. Lorsque cette option est activee, les nouvelles versions se telechargent silencieusement et vous etes invite a redemarrer lorsque la mise a jour est prete.

MailCopilot peut normalement se mettre a jour lui-meme sur place sur toutes les plateformes qu'il prend en charge : une installation AppImage remplace le fichier `.AppImage` lui-meme, et une installation `.deb`/`.rpm`/pacman laisse le mecanisme de mise a jour tenter l'ecriture en demandant des privileges d'administrateur (`pkexec`/`sudo`), de la meme facon que `apt`/`dnf`/`pacman` -- le resultat final est decide par cette invite d'elevation de privileges et le gestionnaire de paquets, pas par MailCopilot.

La mise a jour automatique peut etre indisponible de deux facons differentes, et MailCopilot affiche des controles differents pour chacune :

- **La version n'est pas empaquetee** -- une version de developpement ou de CI. Il n'y a alors aucun mecanisme de mise a jour du tout : le bouton **Rechercher les mises à jour** et la zone d'etat n'apparaissent pas, et une note affiche a la place **« Les mises à jour sont désactivées dans cette version »**.
- **La version est empaquetee, mais la mise a jour automatique est bloquee** -- soit parce que MailCopilot n'a pas pu determiner le repertoire dans lequel il devrait ecrire la mise a jour sur place, soit parce que ce repertoire n'est pas accessible en ecriture par votre compte. Le premier cas se produit sous Linux lorsque l'application ne s'execute pas comme une AppImage montee (par exemple une AppImage extraite ou une build brute `linux-unpacked`) -- il n'y a alors aucun repertoire ou ecrire. Le second cas signifie que le repertoire contenant une AppImage en cours d'execution n'est pas accessible en ecriture (une installation `.deb`/`.rpm`/pacman n'est pas concernee, car celles-ci elevent leurs privileges a la place) ; sous Windows et macOS cela signifie que le repertoire contenant l'executable installe n'est pas accessible en ecriture. Dans les deux cas, un avertissement explique pourquoi, le bouton **Rechercher les mises à jour** continue de fonctionner, et la case de telechargement automatique reste disponible -- mais les controles Telecharger / Redemarrer sont masques.

## Puis-je desactiver les mises a jour automatiques ?

Le telechargement automatique en arriere-plan est desactive par defaut. Si vous avez active l'option **Télécharger automatiquement les mises à jour en arrière-plan** et souhaitez la desactiver, ouvrez **Paramètres > À propos** et decochez cette option. MailCopilot vous notifiera toujours de la disponibilite d'une mise a jour, mais le telechargement ne commencera pas avant que vous ne cliquiez sur **Télécharger**.

## MailCopilot ne synchronise pas.

Verifiez IMAP IDLE dans les parametres, cliquez sur Synchroniser, verifiez votre connexion internet.

## J'ai fermé la fenêtre et je ne trouve plus MailCopilot.

Avec **« Réduire dans la zone de notification à la fermeture »** activé, fermer la fenêtre la masque derrière l'icône de la zone de notification (à condition que MailCopilot ait pu créer l'icône) -- cliquez sur l'icône pour la faire revenir. Sur certains bureaux Linux, l'icône peut ne pas être dessinée du tout : il n'y a alors rien à cliquer.

Dans tous les cas, relancez simplement MailCopilot. S'il fonctionne encore avec une fenêtre masquée, il la ramène au premier plan au lieu d'ouvrir une seconde copie ; s'il avait déjà quitté, une nouvelle fenêtre s'ouvre.
