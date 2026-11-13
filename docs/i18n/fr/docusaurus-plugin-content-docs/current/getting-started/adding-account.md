---
sidebar_position: 2
title: Ajouter un compte
---

# Ajouter un compte de messagerie

MailCopilot prend en charge tout fournisseur de messagerie utilisant les protocoles standard IMAP et SMTP. Gmail se connecte avec un mot de passe d'application (voir [Compte Gmail](#gmail-account)), et un compte Microsoft 365 / Outlook.com peut se connecter via OAuth — sans saisir de mot de passe.

## Assistant de configuration

Cliquez sur **Connecter un e-mail** (l'icone de courrier en bas de la barre laterale) pour ouvrir l'assistant de configuration.

### Etape 1 : Choisir votre fournisseur

L'assistant commence desormais par un selecteur explicite de fournisseur -- vous indiquez a MailCopilot quel fournisseur vous utilisez avant meme de saisir le moindre identifiant. Chaque fournisseur est presente sous la forme d'une carte avec son logo ou son icone :

- **Gmail** -- mène aux étapes du mot de passe d'application (la carte indique « Connexion avec un mot de passe d'application ») : vous activez la validation en deux étapes, créez un mot de passe d'application dans votre compte Google et le saisissez avec votre adresse Gmail. Voir [Compte Gmail](#gmail-account) ci-dessous. Dans une version compilée à partir des sources avec son propre client Google OAuth, la carte indique plutôt « Connexion via Google OAuth » et lance directement la connexion Google.
- **Outlook / Microsoft 365** -- demarre le flux OAuth de Microsoft (Authorization Code avec PKCE) et se connecte via Microsoft Graph. Fonctionne pour les comptes personnels `@outlook.com` / `@hotmail.com` / `@live.com` ainsi que pour les comptes professionnels et scolaires Microsoft 365.
- **Generic IMAP/SMTP** -- pour tout autre fournisseur (Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail Bridge, messagerie d'entreprise, serveurs auto-heberges, etc.). Passe d'abord a une etape de confirmation avec un unique bouton **Compte IMAP/SMTP**, qui ouvre ensuite le formulaire de saisie des identifiants.

Vous pouvez naviguer entre les cartes avec les fleches du clavier et confirmer la selection avec **Entree** ou **Espace**. Apres avoir choisi un fournisseur, l'assistant deroule les etapes appropriees a celui-ci. Sur Generic IMAP/SMTP, le bouton **Retour** de l'etape de confirmation ramene au selecteur de fournisseur ; l'etape de saisie des identifiants possede aussi un bouton **Retour**, qui ramene a l'etape de confirmation (une etape a la fois). Les etapes de detection serveur et de configuration manuelle ne vont qu'en avant -- pour recommencer avec un autre fournisseur, annulez l'assistant et rouvrez-le.

Si vous voulez utiliser Outlook via Generic IMAP/SMTP plutot qu'OAuth, choisissez la carte Generic et connectez-vous avec un mot de passe d'application contre `outlook.office365.com` / `smtp.office365.com`.

### Etape 2 : Saisir vos identifiants (Generic IMAP/SMTP)

Un nouveau compte Gmail arrive sur ce même formulaire après l'étape du mot de passe d'application (voir [Compte Gmail](#gmail-account)).

1. Saisissez votre **adresse e-mail** et votre **mot de passe**.
2. Indiquez un **nom d'affichage** (optionnel).
3. Entrez éventuellement une **adresse email (De)** -- cette adresse est utilisée dans le champ « De » des messages sortants. Si non renseignée, l'adresse de connexion SMTP est utilisée.
4. Si vos identifiants SMTP sont differents, cochez **"Le login/mot de passe SMTP est different"**.
5. Cliquez sur **Suivant**.

### Etape 3 : Detection du serveur

MailCopilot tente de detecter automatiquement les parametres de votre serveur a l'aide des protocoles standard de decouverte automatique. En cas de succes, les serveurs IMAP et SMTP detectes sont affiches dans des champs modifiables. Vous pouvez verifier et ajuster le nom d'affichage, l'adresse e-mail, les hotes de serveur, les ports et les parametres SSL avant de vous connecter.

- Cliquez sur **Connecter** pour tester la connexion et sauvegarder le compte.
- Si un serveur accepte la connexion mais ne répond jamais (en général un réseau ou un VPN qui bloque les ports de messagerie), le test échoue avec le message « Impossible de joindre le serveur de messagerie avant sa réponse. Cela signifie souvent que le réseau ou un VPN bloque les ports de courrier sortant. Vérifiez votre connexion ou votre VPN, puis réessayez. » La même phrase s'affiche pour le serveur de réception (IMAP) et pour le serveur d'envoi (SMTP).
- Une fois le compte sauvegardé, il apparaît aussitôt dans la fenêtre principale. S'il s'agit de votre premier compte, la fenêtre principale l'ouvre d'elle-même -- aucun redémarrage ni rechargement n'est nécessaire.
- Si vous souhaitez un controle manuel complet sur tous les parametres (y compris des identifiants IMAP/SMTP separes), cliquez sur **Configuration manuelle**.

### Configuration manuelle

- **IMAP** : hote, port (generalement 993), SSL/TLS.
- **SMTP** : hote, port (generalement 465 ou 587), SSL/TLS.
- **Autoconfigurer** pour retenter la detection automatique.
- **Tester la connexion** pour verifier avant de sauvegarder.

## Compte Gmail {#gmail-account}

Gmail se connecte via les protocoles standard IMAP et SMTP. Google n'autorise une application qu'il n'a pas validée à connecter que 100 nouveaux utilisateurs au total, et cette limite ne peut pas être réinitialisée ; la version officielle de MailCopilot ne connecte donc pas de **nouvelles** boîtes Gmail avec **Se connecter avec Google**. Une nouvelle boîte se connecte avec un mot de passe d'application. Cela inclut une deuxième boîte Gmail d'une personne qui utilise déjà MailCopilot avec la connexion Google : c'est aussi une nouvelle boîte.

### Connecter une nouvelle boîte Gmail avec un mot de passe d'application

Choisissez la carte **Gmail** dans l'assistant. L'assistant ouvre **Connecter Gmail avec un mot de passe d'application** avec les étapes ci-dessous et trois boutons : **Retour** (revient au sélecteur de fournisseur), **Ouvrir les instructions de Google** et **Suivant**.

1. Activez la validation en deux étapes sur votre compte Google : les mots de passe d'application l'exigent.
2. Créez un mot de passe d'application pour MailCopilot dans votre compte Google. Les instructions officielles de Google se trouvent sur [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833) ; le bouton **Ouvrir les instructions de Google** ouvre cette page dans votre navigateur.
3. Cliquez sur **Suivant**, puis saisissez votre adresse Gmail et le mot de passe d'application de 16 caractères (pas votre mot de passe Google habituel).

Les paramètres des serveurs sont renseignés automatiquement : IMAP `imap.gmail.com` sur le port 993 et SMTP `smtp.gmail.com` sur le port 465. Vérifiez-les à l'étape de détection, puis cliquez sur **Connecter**.

### Boîtes qui se connectent déjà avec Google

Les boîtes Gmail connectées avec la connexion Google continuent de fonctionner, et vous pouvez les reconnecter -- par exemple après avoir révoqué l'accès ou changé votre mot de passe Google -- dans **Parametres > Comptes** avec le bouton **Reconnecter Google**. Une reconnexion ne fonctionne qu'avec la même adresse Google que celle de la boîte. Si vous vous connectez avec un autre compte Google, MailCopilot refuse : « Ce compte Google n'est pas (l'adresse de la boîte) ; la boîte n'a pas été modifiée. Connectez-vous avec la même adresse que celle que vous reconnectez. » -- et rien n'est modifié. L'autre compte conserve l'accès qu'il vient d'accorder à MailCopilot ; retirez-le dans ce compte Google, sous l'accès des applications tierces.

L'adresse d'une boîte qui se connecte avec Google (ou avec toute autre connexion OAuth) ne peut plus être modifiée dans les paramètres du compte : les champs utilisateur IMAP et SMTP sont en lecture seule pour une telle boîte. Pour changer l'adresse, reconnectez-vous avec le même compte Google. Si l'adresse Google de la boîte elle-même a changé (par exemple, le compte a été renommé ou déplacé vers un autre domaine), la reconnexion est refusée et rien n'est modifié ; la solution est de supprimer la boîte puis de la rajouter avec un mot de passe d'application (le courrier mis en cache localement est téléchargé de nouveau).

### Si l'option des mots de passe d'application est absente

Google ne propose pas les mots de passe d'application pour tous les comptes. L'option peut être absente si le compte est géré par une organisation (demandez à son administrateur), s'il est protégé par le Programme de protection avancée ou s'il n'utilise que des clés de sécurité pour la validation en deux étapes. Il reste alors une seule possibilité : une version compilée à partir des sources avec votre propre client Google OAuth ; une application interne à une organisation est dispensée de la validation de Google (voir [l'explication de Google](https://support.google.com/cloud/answer/7454865)). Voir aussi la [FAQ](../faq#app-passwords-missing).

### Versions avec leur propre client Google

Une version compilée à partir des sources avec son propre client Google OAuth conserve la connexion Google pour les nouvelles boîtes : les versions auto-compilées l'ont par défaut, la carte Gmail indique « Connexion via Google OAuth », et la choisir ouvre le flux dans le navigateur décrit plus bas. Une version sans aucun client Google OAuth n'affiche aucun bouton Google ; pour une boîte qui se connecte avec Google, **Parametres > Comptes** indique alors que la boîte se connecte avec Google mais que cette version n'a pas de client Google OAuth, et qu'elle ne peut donc pas y être reconnectée. Outlook / Microsoft 365 n'est pas concerné.

### Progression de la connexion Google

L'étape de progression décrite ci-dessous apparaît dans les versions qui proposent la connexion Google pour les nouvelles boîtes.


Pendant la connexion, l'assistant remplace la liste des fournisseurs par une etape de progression indiquant ce qu'il attend : votre autorisation dans le navigateur, puis l'obtention de l'acces, la verification du serveur de messagerie et du serveur d'envoi, et l'enregistrement du compte. Deux etapes sont limitees dans le temps : l'attente de votre autorisation dans le navigateur (trois minutes) et les verifications de serveur (30 secondes pour la reception, 15 pour l'envoi, avec une nouvelle tentative). Le reste ne l'est pas ; le reste depend du fournisseur et de votre reseau, l'etape indique donc ce qui se passe et non le temps restant. Si le compte n'a pas encore de nom et que le fournisseur en fournit un exploitable, il est repris du profil ; un nom que vous avez modifie n'est jamais ecrase lors d'une reautorisation ulterieure. Si la connexion echoue avant l'enregistrement du compte, l'assistant revient a la liste des fournisseurs pour vous permettre de reessayer. Fermer la fenetre n'annule pas une connexion deja engagee : elle se poursuit en arriere-plan et peut tout de meme creer le compte, donc recommencer a ce moment-la risque de laisser un doublon. Cette etape concerne l'ajout d'un compte : la reautorisation d'un compte existant depuis ses parametres affiche seulement un indicateur sur le bouton.

## Compte Microsoft 365 / Outlook (OAuth)

Choisissez la carte **Outlook / Microsoft 365** dans l'assistant. Une fenetre de navigateur s'ouvre sur la page de connexion Microsoft ; connectez-vous avec votre compte `@outlook.com`, `@hotmail.com`, `@live.com`, ou avec votre compte professionnel ou scolaire, et approuvez les autorisations demandees. Le client Microsoft fourni utilise le flux Authorization Code avec PKCE sans client secret -- aucun client secret ne quitte votre appareil. Les builds personnalises qui remplacent le client fourni en definissant **a la fois** `MAILCOPILOT_MS_CLIENT_ID` (votre propre enregistrement d'application Azure) et `MAILCOPILOT_MS_CLIENT_SECRET` (destine aux tenants ayant emis un client confidentiel) envoient bien ce secret au point de terminaison de jeton Microsoft via TLS. `MAILCOPILOT_MS_CLIENT_SECRET` seul (sans un client ID personnalise) est ignore. Une fois autorise, le compte est ajoute automatiquement.

Le meme ecran d'attente apparait ici que pour Gmail, avec les memes etapes et les memes reserves : l'attente dans le navigateur et les verifications de serveur sont limitees dans le temps, le reste ne l'est pas, et fermer la fenetre n'annule pas une connexion en cours. Contrairement a Gmail, il n'y a pas de nouvelle tentative pour le serveur d'envoi. Votre nom est repris du profil Microsoft si le compte n'en a pas et que le profil en fournit un exploitable ; un nom que vous avez modifie n'est jamais ecrase lors d'une reautorisation ulterieure. La demande de confiance au certificat decrite plus bas pour Google apparait aussi sur ce chemin, apres l'enregistrement du compte.

Pour l'envoi de messages, MailCopilot utilise Microsoft Graph (`POST /me/sendMail`) sur les comptes Outlook, car Microsoft a desactive SMTP AUTH sur la plupart des comptes personnels Outlook.com crees depuis 2024. Le chemin d'envoi via Graph n'est pas affecte par cette politique. Les messages envoyes sont automatiquement sauvegardes dans votre dossier « Envoyes » par Microsoft.

Si votre compte Outlook cesse de fonctionner apres une longue periode hors ligne, le refresh token OAuth a peut-etre expire. Un refresh token OAuth absent du stockage sécurisé déclenche la [notification de connexion expirée](#notification-de-connexion-expirée) immédiatement, aussi bien pour Google que pour Outlook. Si un jeton enregistré est rejeté, le refus d'authentification IMAP qui en résulte suit le déroulement ordinaire d'un échec de connexion ; réautorisez le compte depuis **Parametres > Comptes** en utilisant le bouton de re-authentification Microsoft.


## Verification du certificat TLS

MailCopilot verifie toujours les certificats TLS, en les comparant à la fois au jeu de certificats Mozilla intégré et au magasin de certificats de votre système d'exploitation (en basculant sur le seul jeu intégré si le magasin système ne peut pas être lu). L'invite de confiance dans l'application décrite dans cette section n'existe que pour votre **serveur de réception (IMAP)**. Si ce serveur utilise un certificat auto-signé, ou un certificat délivré par une autorité de certification privée qui n'est pas déjà dans le magasin de confiance de votre système d'exploitation -- par exemple une autorité de certification interne exploitée par une université ou une entreprise --, une invite de confiance apparaîtra : si l'empreinte n'a pas encore été lue, le bouton indique d'abord **« Lire le certificat »** -- cliquez dessus, vérifiez les détails, puis confirmez avec **« Approuver et continuer »** ; si **« Approuver et continuer »** est déjà affiché, cliquez simplement dessus. La confiance ainsi accordée est liée à ce certificat précis et à l'adresse et au port spécifiques de ce serveur -- un autre serveur délivré par la même autorité de certification n'est pas approuvé automatiquement, et si le certificat de ce serveur change à nouveau, il faudra confirmer le nouveau de la même façon. Vous pouvez aussi, à titre d'alternative, installer le certificat racine de l'autorité de certification dans le magasin de confiance de votre système d'exploitation ; MailCopilot ne lit ce magasin qu'une fois -- la première fois qu'il en a besoin -- et conserve cet instantané jusqu'au prochain redémarrage, donc cette alternative nécessite de redémarrer MailCopilot pour prendre effet, alors que confirmer l'invite de confiance décrite ici ne le nécessite pas. Les serveurs accessibles via STARTTLS (typiquement le port IMAP 143 ou le port SMTP 587) ne peuvent pas transmettre leur certificat a cette etape, seule l'empreinte est donc enregistree pour eux -- un serveur STARTTLS auto-signe ne peut pas etre rendu fiable de cette maniere ; utilisez plutot le TLS implicite (typiquement le port 993 ou 465) si votre serveur le prend en charge.

La ligne **« Détails »** de l'invite de confiance indique, dans la langue de l'application, pourquoi le certificat a été refusé -- par exemple parce qu'il est auto-signé ou expiré ; la liste complète des raisons figure dans [Confiance des certificats TLS](../settings/general#confiance-des-certificats-tls).

Votre **serveur d'envoi (SMTP)** n'a aujourd'hui aucune invite de confiance équivalente. S'il présente un certificat auto-signé ou un certificat d'une autorité de certification privée qui n'est pas déjà dans le magasin de confiance de votre système d'exploitation, le test de connexion pour ce serveur échouera simplement -- il n'existe aucun remède depuis l'application. Le certificat doit être approuvé en dehors de MailCopilot, soit en installant le certificat racine de cette autorité de certification dans le magasin de confiance de votre système d'exploitation (redémarrez ensuite MailCopilot pour que cela prenne effet), soit via la variable d'environnement `NODE_EXTRA_CA_CERTS` pour les configurations avancées.

Lors de la connexion avec Google, si votre réseau utilise un proxy ou un antivirus qui remplace les certificats TLS par un certificat que votre système d'exploitation ne connaît pas encore, MailCopilot le détectera et proposera automatiquement d'accepter le certificat. Vous verrez les détails du certificat (hôte, émetteur, empreinte) et pourrez l'accepter ou le refuser. Le compte est enregistré dans tous les cas, et vous pouvez gérer les certificats plus tard dans les paramètres du compte. Si en revanche le certificat racine du proxy ou de l'antivirus est déjà installé dans le magasin de votre système d'exploitation, la connexion réussit sans aucune invite de confiance -- MailCopilot signale ce cas séparément par une notification informative (voir ci-dessous) plutôt que de vous demander d'accepter quoi que ce soit.

Faire confiance au magasin de certificats système signifie que la plupart des proxys d'entreprise et des antivirus qui inspectent le trafic TLS fonctionnent d'emblée, sans invite de confiance lors de la configuration. Après la première synchronisation réussie de votre compte dans une session, MailCopilot vérifie une fois si une connexion est ainsi inspectée et, le cas échéant, affiche une notification nommant le logiciel ou le proxy responsable ; cette vérification s'exécute au plus une fois par serveur pendant toute la durée de vie de votre profil, donc une inspection activée sur un serveur après cette vérification ne sera pas détectée. Si le certificat d'un serveur change ensuite pour un certificat qui ne peut pas être approuvé du tout, MailCopilot affichera à ce moment-là une boîte de dialogue de récupération dans la fenêtre principale -- voir [Confiance des certificats TLS](../settings/general#confiance-des-certificats-tls) pour plus de détails.

Pour les connexions à vos serveurs de réception (IMAP) et d'envoi (SMTP) et au fournisseur d'IA, MailCopilot ne fait par ailleurs plus confiance aux certificats dont la chaîne aboutit à trois racines d'autorités de certification liées à un incident de compromission de certificats intermédiaires -- `emSign ECC Root CA - G3`, `emSign Root TLS CA - G3` et `AAA Certificate Services` -- même si votre système d'exploitation leur fait encore confiance. Un serveur dont le certificat aboutit à l'une d'elles est traité comme n'importe quel certificat non approuvé : pour votre serveur de réception (IMAP), l'invite de confiance décrite ci-dessus apparaît (pour votre serveur d'envoi, il n'y a pas d'invite, comme expliqué plus haut). Un certificat que vous avez déjà confirmé dans cette invite continue de fonctionner.

## Connexion chiffrée obligatoire (STARTTLS)

Lorsque la case **SSL/TLS** du serveur de réception ou d'envoi est décochée -- typiquement le port IMAP 143 ou le port SMTP 587, où la connexion démarre en clair puis passe en mode chiffré via STARTTLS -- MailCopilot exige que le serveur effectue cette bascule avant d'envoyer votre mot de passe ou le moindre message. Si le serveur ne propose pas STARTTLS ou ne l'accepte pas, la connexion est refusée et le test de connexion (ou la synchronisation ou l'envoi échoué) affiche : « Le serveur ne propose pas de connexion chiffrée (STARTTLS) : MailCopilot n'a envoyé ni mot de passe ni message. Vérifiez le port et les paramètres de sécurité, ou contactez votre fournisseur de messagerie. » Il n'existe volontairement aucune option pour continuer sans chiffrement. Pour corriger, vérifiez le port et la case **SSL/TLS** (typiquement le port IMAP 993 et le port SMTP 465 avec **SSL/TLS** coché) ou demandez à votre fournisseur de messagerie quels paramètres son serveur attend. Les connexions en **SSL/TLS** ne sont pas concernées.

## Gestion de plusieurs comptes

Ajoutez autant de comptes que necessaire. Basculez entre eux via la barre laterale ou **Parametres > Comptes**.

## Notification de connexion expirée

Si les identifiants d'un compte cessent de fonctionner -- par exemple un mot de passe IMAP modifié ailleurs, ou aucun mot de passe ni autorisation OAuth enregistré pour ce compte -- MailCopilot ne se contente plus d'échouer silencieusement en arrière-plan. Une notification discrète apparaît au-dessus de la liste des messages : par exemple, « Compte de messagerie » ne reçoit plus de courrier : la connexion a expiré. Reconnectez-vous pour reprendre la synchronisation. Pour un échec de connexion ordinaire survenu lors d'opérations courantes, la notification n'apparaît qu'après deux échecs consécutifs pour le même compte. Deux situations ignorent ce seuil et affichent la notification immédiatement. La première est un compte sans aucun identifiant enregistré, puisqu'il n'y a rien à retenter. La seconde est une connexion que le serveur de messagerie refuse lorsque MailCopilot démarre la surveillance de messagerie en arrière-plan (IMAP IDLE) pour ce compte : une tentative de connexion complète refusée par le serveur est un verdict définitif sur vos identifiants enregistrés, pas simplement une opération qui n'a pas fonctionné, donc il n'y a aucune raison d'attendre un second échec -- et une boîte dont les dossiers sont tous réglés sur mise à jour manuelle pourrait ne pas bénéficier d'une seconde synchronisation en arrière-plan pour échouer une deuxième fois. Cliquez sur **Se reconnecter** pour accéder directement aux paramètres de ce compte, où vous pouvez ressaisir votre mot de passe ou réautoriser la connexion OAuth.

Cette notification n'apparaît que pour les échecs de connexion (authentification) signalés par le serveur de messagerie lui-même -- une coupure réseau temporaire ou un problème de certificat ne la déclenche pas, car chacun de ces cas dispose déjà de son propre indicateur (voir [Vérification du certificat TLS](#verification-du-certificat-tls) ci-dessus). Un refresh token OAuth absent du stockage sécurisé déclenche la notification immédiatement, aussi bien pour Google que pour Outlook. Si un jeton enregistré est rejeté, le refus d'authentification IMAP qui en résulte suit le déroulement ordinaire d'un échec de connexion ; le cas échéant, réautorisez le compte manuellement depuis **Parametres > Comptes**. Elle disparaît automatiquement dès que la moindre opération sur ce compte réussit -- pas seulement une synchronisation en arrière-plan, mais aussi l'ouverture d'un message, le déplacement de courrier ou une recherche -- si bien qu'un compte dont tous les dossiers sont réglés sur mise à jour manuelle voit aussi la notification disparaître dès que vous l'utilisez. Il n'y a rien à fermer manuellement. Cet état n'est pas conservé entre les redémarrages -- si MailCopilot est fermé pendant qu'un compte est signalé, la notification ne réapparaît qu'après que le même type d'échec se reproduise suite au prochain démarrage.

## Personnalisation de l'avatar du compte

Chaque compte est affiché dans la barre latérale avec un avatar -- un cercle coloré avec des initiales. Vous pouvez personnaliser l'avatar dans **Paramètres > Comptes** en cliquant sur l'icône de palette à côté du compte.

### Modes d'affichage

- **Lettres**: un cercle coloré avec 1 ou 2 caractères (initiales). Vous pouvez saisir des initiales personnalisées si les automatiques ne conviennent pas.
- **Icône**: un cercle coloré avec une icône de la collection (courrier, mallette, étoile, fusée, etc.).
- **Gravatar**: charge votre photo de profil depuis [Gravatar](https://gravatar.com) en fonction de votre adresse e-mail. Si aucun Gravatar n'est trouvé, les lettres sont affichées. Gravatar reçoit alors le hachage SHA-256 de votre adresse et voit votre adresse IP ; voir [Photos des expéditeurs (Gravatar)](../privacy/sender-photos.md).

### Changer la couleur

Cliquez sur une couleur dans la palette pour changer l'arrière-plan de l'avatar. La couleur est enregistrée et reste la même après le redémarrage.

### Info-bulle

Survolez un avatar dans la barre latérale pour voir le nom du compte et l'adresse e-mail.

## Fournisseurs compatibles

Gmail (avec un mot de passe d'application ; les boîtes qui se connectent déjà avec Google continuent de fonctionner), Outlook, Yahoo, Fastmail, Yandex Mail, Mail.ru, ProtonMail (via Bridge), serveurs auto-hébergés (Dovecot, Postfix, Zimbra, etc.).
