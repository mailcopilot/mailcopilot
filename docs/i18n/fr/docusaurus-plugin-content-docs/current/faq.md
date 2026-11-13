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

Choisissez la carte **Gmail** dans l'assistant et suivez les étapes : activez la validation en deux étapes sur votre compte Google, créez un mot de passe d'application pour MailCopilot (instructions de Google : [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833)), puis saisissez votre adresse Gmail et le mot de passe d'application de 16 caractères -- pas votre mot de passe Google habituel. Les paramètres des serveurs (`imap.gmail.com` port 993, `smtp.gmail.com` port 465) sont renseignés automatiquement. Voir [Compte Gmail](./getting-started/adding-account#gmail-account) pour les étapes complètes.

## Pourquoi ne puis-je pas ajouter une nouvelle boîte Gmail avec la connexion Google ?

Google n'autorise une application qu'il n'a pas validée à connecter que 100 nouveaux utilisateurs au total, et cette limite ne peut pas être réinitialisée. La version officielle de MailCopilot ne connecte donc pas de nouvelles boîtes Gmail avec **Se connecter avec Google** : toute nouvelle boîte Gmail, y compris une deuxième boîte d'une personne qui utilise déjà MailCopilot, se connecte avec un mot de passe d'application (voir la question précédente). Les boîtes Gmail qui se connectent déjà avec Google continuent de fonctionner, et vous pouvez les reconnecter (par exemple après un jeton révoqué ou un changement de mot de passe) -- mais uniquement avec la même adresse Google. Si vous vous connectez avec un autre compte Google, MailCopilot refuse, ne modifie rien. L'autre compte conserve l'accès qu'il vient d'accorder ; retirez-le dans ce compte Google, sous l'accès des applications tierces. L'adresse d'une telle boîte ne peut pas être modifiée dans les paramètres du compte (les champs utilisateur IMAP et SMTP sont en lecture seule) ; pour la changer, reconnectez-vous avec le même compte Google. Si l'adresse Google de la boîte elle-même a changé (par exemple, le compte a été renommé ou déplacé vers un autre domaine), la reconnexion est refusée et rien n'est modifié : supprimez la boîte puis rajoutez-la avec un mot de passe d'application (le courrier mis en cache localement est téléchargé de nouveau). Une version compilée à partir des sources avec son propre client Google OAuth conserve la connexion Google pour les nouvelles boîtes ; une version sans aucun client Google OAuth n'affiche aucun bouton Google, et une boîte qui se connecte avec Google ne peut pas y être reconnectée. Outlook / Microsoft 365 n'est pas concerné.

## L'option des mots de passe d'application est absente. Que faire ? {#app-passwords-missing}

Google ne propose pas les mots de passe d'application pour tous les comptes. L'option peut être absente si le compte est géré par une organisation (demandez à son administrateur), s'il est protégé par le Programme de protection avancée ou s'il n'utilise que des clés de sécurité pour la validation en deux étapes. Il reste alors une seule possibilité : une version compilée à partir des sources avec votre propre client Google OAuth. Une application interne à une organisation est dispensée de la validation de Google, voir [l'explication de Google](https://support.google.com/cloud/answer/7454865).

## Puis-je utiliser plusieurs comptes ?

Oui, avec basculement dans la barre laterale ou la boite de reception unifiee.

## Le test de connexion affiche une erreur de certificat TLS. Que faire ?

MailCopilot verifie toujours les certificats TLS, en les comparant au jeu de certificats Mozilla integre et au magasin de certificats de votre systeme d'exploitation. Cette invite de confiance dans l'application n'existe que pour votre **serveur de réception (IMAP)**. Si ce serveur utilise un certificat auto-signé, ou un certificat délivré par une autorité de certification privée qui n'est pas déjà dans le magasin de confiance de votre système d'exploitation (par exemple une autorité de certification interne exploitée par une université ou une entreprise), une invite de confiance apparaîtra. Vérifiez les détails du certificat et acceptez-le si vous êtes certain que le serveur est légitime. Si l'empreinte n'a pas encore été lue, le bouton principal affiche d'abord **« Lire le certificat »** -- cliquez dessus, vérifiez le résultat, puis cliquez sur **« Approuver et continuer »** pour confirmer. La confiance ainsi accordée est liée à ce certificat précis et à l'adresse et au port spécifiques de ce serveur ; un autre serveur, même délivré par la même autorité de certification, n'est pas approuvé automatiquement, et un changement ultérieur du certificat de ce serveur exigera une nouvelle confirmation de la même façon. La ligne **« Détails »** de la boîte de dialogue indique, dans la langue de l'application, pourquoi le certificat n'a pas été accepté (par exemple parce qu'il a expiré, qu'il est auto-signé ou qu'il a été émis pour un autre nom de serveur).

Si l'erreur concerne plutôt votre **serveur d'envoi (SMTP)**, MailCopilot ne propose pas du tout cette invite de confiance -- un certificat auto-signé ou d'une autorité de certification privée côté SMTP n'a aucun remède depuis l'application. Le certificat doit être approuvé en dehors de MailCopilot : soit en le faisant approuver par votre système d'exploitation lui-même (MailCopilot a besoin d'un redémarrage pour en tenir compte), soit via la variable d'environnement `NODE_EXTRA_CA_CERTS` pour les configurations avancées.

## Mon antivirus ou mon proxy d'entreprise inspecte ma connexion de messagerie. MailCopilot fonctionnera-t-il quand meme ?

Oui. MailCopilot fait confiance au magasin de certificats de votre systeme d'exploitation en plus de son jeu de certificats integre, si bien que les logiciels de securite qui inspectent le trafic TLS (par exemple les antivirus avec inspection HTTPS) et les proxys d'entreprise ne perturbent plus la synchronisation du courrier. Apres la premiere synchronisation reussie de votre compte dans une session, MailCopilot verifie une fois cela et, le cas echeant, affiche une notification identifiant le logiciel ou le proxy responsable ; cette verification s'execute au plus une fois par serveur pendant toute la duree de vie de votre profil, donc une inspection activee sur un serveur apres que cette verification a deja eu lieu ne sera pas detectee. Si le certificat change ensuite pour un certificat qui ne peut plus etre approuve du tout (et non plus seulement via le magasin systeme), MailCopilot affiche une boite de dialogue de recuperation ou vous pouvez consulter les details du nouveau certificat et decider de lui faire confiance.

## Mon serveur de messagerie auto-signe a cesse de se connecter apres la mise a jour de MailCopilot. Pourquoi ?

L'epinglage de certificats ne comparait auparavant les empreintes que pour les certificats dont la chaine etait deja validee normalement ; les certificats auto-signes et a autorite de certification privee -- le cas exact pour lequel l'epinglage existe -- contournaient entierement cette verification d'empreinte. Cette faille est desormais comblee, ce qui est une amelioration de securite -- mais si vous avez epingle un serveur auto-signe ou a autorite de certification privee avant ce changement, l'epinglage enregistre peut ne pas inclure le certificat necessaire pour le verifier, et ce serveur ne se connectera plus. Pour votre **serveur de reception (IMAP)**, ouvrez la boite de dialogue de recuperation de certificat qui apparait pour lui : si le bouton affiche **« Lire le certificat »**, cliquez dessus d'abord, puis cliquez sur **« Approuver et continuer »** ; si **« Approuver et continuer »** est deja affiche, cliquez simplement dessus. Cela enregistre l'epinglage avec le certificat lui-meme, et le compte se resynchronise automatiquement. Cette operation n'est necessaire qu'une seule fois par serveur concerne. Ajouter ou modifier un epinglage manuellement dans les Parametres ne corrige pas cela -- un epinglage manuel ne peut que restreindre la confiance pour un serveur qui a deja un certificat normal, publiquement approuve ; pour un certificat qui reste par ailleurs non approuve (auto-signe, ou d'une autorite de certification privee pas encore presente dans le magasin de votre systeme), seule la boite de dialogue de recuperation peut lui accorder sa confiance. Si vous ajoutez ensuite un epinglage par empreinte pour ce meme serveur et qu'il ne correspond pas au certificat deja confirme la, il est refuse de la meme facon -- MailCopilot rouvre la boite de dialogue de recuperation au lieu de l'utiliser. Pour votre **serveur d'envoi (SMTP)**, il n'existe aucune boite de dialogue de recuperation -- un serveur SMTP auto-signe ou a autorite de certification privee tombe en panne de cette facon le reste tant que le certificat n'est pas approuve en dehors de MailCopilot : soit le certificat racine de son autorite de certification est approuve directement par le systeme d'exploitation, soit via la variable d'environnement `NODE_EXTRA_CA_CERTS` pour les configurations avancees.

Si votre serveur utilise STARTTLS (typiquement le port IMAP 143 ou le port SMTP 587), MailCopilot ne peut pas capturer son certificat de cette facon -- seule l'empreinte est enregistree, si bien qu'un serveur STARTTLS auto-signe restera impossible a connecter. Utilisez plutot le TLS implicite (typiquement le port 993 pour IMAP, 465 pour SMTP) si votre serveur le prend en charge.

## La connexion indique que le serveur ne propose pas de connexion chiffrée (STARTTLS). Que signifie cela ?

Votre compte est configuré sans **SSL/TLS** immédiat (typiquement le port IMAP 143 ou le port SMTP 587) ; MailCopilot attend donc que le serveur bascule la connexion en mode chiffré via STARTTLS avant l'envoi de tout mot de passe ou message. Ce serveur n'a ni proposé ni accepté cette bascule : MailCopilot a refusé de continuer et n'a envoyé ni mot de passe ni message. Il n'existe volontairement aucune option « autoriser sans chiffrement ». Vérifiez le port et la case **SSL/TLS** dans **Settings > Accounts** (typiquement le port IMAP 993 et le port SMTP 465 avec **SSL/TLS** coché) ou contactez votre fournisseur de messagerie. Voir [Connexion chiffrée obligatoire (STARTTLS)](./getting-started/adding-account#connexion-chiffrée-obligatoire-starttls).

## L'envoi échoue et le message indique que le réseau ou un VPN bloque peut-être les ports de courrier sortant. Que faire ?

Ce message apparaît lorsque MailCopilot n'a pas pu joindre votre serveur d'envoi du tout : la connexion a échoué avant la réponse du serveur, ce qui indique généralement un port bloqué, un VPN ou un réseau inaccessible. Ces envois sont réessayés automatiquement avec des délais croissants ; s'ils échouent définitivement, vous voyez cette indication au lieu d'une erreur technique brute. Vérifiez votre connexion Internet, désactivez ou reconfigurez le VPN, assurez-vous que votre réseau ou pare-feu autorise les connexions sortantes vers le port de votre serveur de messagerie (typiquement 465 ou 587), puis réessayez l'envoi.

Le même message apparaît lorsque vous ajoutez un compte ou testez sa connexion et qu'un serveur accepte la connexion sans jamais répondre : le test de connexion du serveur de réception (IMAP) comme celui du serveur d'envoi (SMTP) se termine alors par ce message, au lieu d'une erreur technique brute. Le conseil est le même : vérifiez votre connexion Internet, désactivez ou reconfigurez le VPN et assurez-vous que votre réseau autorise les connexions sortantes vers les ports de votre serveur de messagerie.

## L'envoi échoue et le message indique qu'on ne sait pas s'il a été envoyé. Que faire ?

Ce message apparaît lorsque la connexion à votre serveur d'envoi s'est interrompue après que le serveur a été joint, mais avant qu'il ait confirmé l'envoi, par exemple à cause d'un délai dépassé, d'une réinitialisation de la connexion ou d'une fermeture silencieuse de la connexion par le serveur. Il apparaît aussi lorsque MailCopilot a été fermé ou s'est arrêté pendant l'envoi d'un message. Dans les deux cas, MailCopilot ne peut pas savoir si le serveur a accepté le message ; il ne réessaie donc **pas** l'envoi automatiquement, car une nouvelle tentative pourrait livrer le message deux fois. Le message passe à l'état d'échec et y reste, y compris après le démarrage suivant. Ne vous fiez pas au dossier Envoyés : MailCopilot n'y enregistre sa copie qu'après un envoi confirmé, si bien que la copie est généralement absente même si le message est bien parti. Demandez au destinataire ou consultez les messages envoyés dans l'interface de votre fournisseur de messagerie pour savoir s'il est arrivé. Sinon, ouvrez la **Outbox** et utilisez **Send now** (ou modifiez d'abord le message) pour le renvoyer manuellement. Le message renvoyé porte le même Message-ID que la première tentative, ce qui permet aux logiciels de messagerie qui détectent les doublons de le reconnaître comme le même message. Les échecs avant la réponse du serveur (port bloqué, VPN, réseau inaccessible) sont toujours réessayés automatiquement avec des délais croissants. Les refus avec un code de réponse 4xx sont aussi réessayés. Les refus 5xx ne le sont pas et affichent la raison donnée par le serveur lui-même.

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

Indépendamment des téléchargements, MailCopilot recherche les nouvelles versions en arrière-plan au démarrage, puis environ une fois par heure. Pour qu'il ne lance plus de nouvelles vérifications de lui-même, ouvrez **Paramètres > À propos** et décochez **Rechercher les mises à jour en arrière-plan**. Le changement prend effet immédiatement, sans redémarrage. Le bouton **Rechercher les mises à jour** continue de fonctionner. Lorsque la vérification en arrière-plan est désactivée, MailCopilot ne lance ni nouvelle vérification automatique ni nouveau téléchargement automatique, même si **Télécharger automatiquement les mises à jour en arrière-plan** est coché ; une vérification ou un téléchargement déjà en cours au moment où vous désactivez l'option peut tout de même se terminer.

## MailCopilot ne synchronise pas.

Verifiez IMAP IDLE dans les parametres, cliquez sur Synchroniser, verifiez votre connexion internet.

## J'ai fermé la fenêtre et je ne trouve plus MailCopilot.

Avec **« Réduire dans la zone de notification à la fermeture »** activé, fermer la fenêtre la masque derrière l'icône de la zone de notification (à condition que MailCopilot ait pu créer l'icône) -- cliquez sur l'icône pour la faire revenir. Sur certains bureaux Linux, l'icône peut ne pas être dessinée du tout : il n'y a alors rien à cliquer.

Dans tous les cas, relancez simplement MailCopilot. S'il fonctionne encore avec une fenêtre masquée, il la ramène au premier plan au lieu d'ouvrir une seconde copie ; s'il avait déjà quitté, une nouvelle fenêtre s'ouvre.
