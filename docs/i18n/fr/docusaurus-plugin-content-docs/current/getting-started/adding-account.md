---
sidebar_position: 2
title: Ajouter un compte
---

# Ajouter un compte de messagerie

MailCopilot prend en charge tout fournisseur de messagerie utilisant les protocoles standard IMAP et SMTP. Vous pouvez aussi vous connecter avec Google ou avec un compte Microsoft 365 / Outlook.com via OAuth — sans saisir de mot de passe.

## Assistant de configuration

Cliquez sur **Connecter un e-mail** (l'icone de courrier en bas de la barre laterale) pour ouvrir l'assistant de configuration.

### Etape 1 : Choisir votre fournisseur

L'assistant commence desormais par un selecteur explicite de fournisseur -- vous indiquez a MailCopilot quel fournisseur vous utilisez avant meme de saisir le moindre identifiant. Chaque fournisseur est presente sous la forme d'une carte avec son logo ou son icone :

- **Gmail** -- demarre directement le flux OAuth de Google. Une fenetre de navigateur s'ouvre, dans laquelle vous autorisez MailCopilot a acceder a votre compte Gmail ; aucun mot de passe a saisir.
- **Outlook / Microsoft 365** -- demarre le flux OAuth de Microsoft (Authorization Code avec PKCE) et se connecte via Microsoft Graph. Fonctionne pour les comptes personnels `@outlook.com` / `@hotmail.com` / `@live.com` ainsi que pour les comptes professionnels et scolaires Microsoft 365.
- **Generic IMAP/SMTP** -- pour tout autre fournisseur (Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail Bridge, messagerie d'entreprise, serveurs auto-heberges, etc.). Passe d'abord a une etape de confirmation avec un unique bouton **Compte IMAP/SMTP**, qui ouvre ensuite le formulaire de saisie des identifiants.

Vous pouvez naviguer entre les cartes avec les fleches du clavier et confirmer la selection avec **Entree** ou **Espace**. Apres avoir choisi un fournisseur, l'assistant deroule les etapes appropriees a celui-ci. Sur Generic IMAP/SMTP, le bouton **Retour** de l'etape de confirmation ramene au selecteur de fournisseur ; l'etape de saisie des identifiants possede aussi un bouton **Retour**, qui ramene a l'etape de confirmation (une etape a la fois). Les etapes de detection serveur et de configuration manuelle ne vont qu'en avant -- pour recommencer avec un autre fournisseur, annulez l'assistant et rouvrez-le.

Si vous voulez utiliser Outlook via Generic IMAP/SMTP plutot qu'OAuth, choisissez la carte Generic et connectez-vous avec un mot de passe d'application contre `outlook.office365.com` / `smtp.office365.com`.

### Etape 2 : Saisir vos identifiants (Generic IMAP/SMTP)

1. Saisissez votre **adresse e-mail** et votre **mot de passe**.
2. Indiquez un **nom d'affichage** (optionnel).
3. Entrez éventuellement une **adresse email (De)** -- cette adresse est utilisée dans le champ « De » des messages sortants. Si non renseignée, l'adresse de connexion SMTP est utilisée.
4. Si vos identifiants SMTP sont differents, cochez **"Le login/mot de passe SMTP est different"**.
5. Cliquez sur **Suivant**.

### Etape 3 : Detection du serveur

MailCopilot tente de detecter automatiquement les parametres de votre serveur a l'aide des protocoles standard de decouverte automatique. En cas de succes, les serveurs IMAP et SMTP detectes sont affiches dans des champs modifiables. Vous pouvez verifier et ajuster le nom d'affichage, l'adresse e-mail, les hotes de serveur, les ports et les parametres SSL avant de vous connecter.

- Cliquez sur **Connecter** pour tester la connexion et sauvegarder le compte.
- Si vous souhaitez un controle manuel complet sur tous les parametres (y compris des identifiants IMAP/SMTP separes), cliquez sur **Configuration manuelle**.

### Configuration manuelle

- **IMAP** : hote, port (generalement 993), SSL/TLS.
- **SMTP** : hote, port (generalement 465 ou 587), SSL/TLS.
- **Autoconfigurer** pour retenter la detection automatique.
- **Tester la connexion** pour verifier avant de sauvegarder.

## Compte Google (OAuth)

Choisissez la carte **Gmail** dans l'assistant. Une fenetre de navigateur s'ouvre pour autoriser MailCopilot. Une fois l'autorisation accordee, le compte est ajoute automatiquement avec les bons parametres IMAP et SMTP.

## Compte Microsoft 365 / Outlook (OAuth)

Choisissez la carte **Outlook / Microsoft 365** dans l'assistant. Une fenetre de navigateur s'ouvre sur la page de connexion Microsoft ; connectez-vous avec votre compte `@outlook.com`, `@hotmail.com`, `@live.com`, ou avec votre compte professionnel ou scolaire, et approuvez les autorisations demandees. Le client Microsoft fourni utilise le flux Authorization Code avec PKCE sans client secret -- aucun client secret ne quitte votre appareil. Les builds personnalises qui remplacent le client fourni en definissant **a la fois** `MAILCOPILOT_MS_CLIENT_ID` (votre propre enregistrement d'application Azure) et `MAILCOPILOT_MS_CLIENT_SECRET` (destine aux tenants ayant emis un client confidentiel) envoient bien ce secret au point de terminaison de jeton Microsoft via TLS. `MAILCOPILOT_MS_CLIENT_SECRET` seul (sans un client ID personnalise) est ignore. Une fois autorise, le compte est ajoute automatiquement.

Pour l'envoi de messages, MailCopilot utilise Microsoft Graph (`POST /me/sendMail`) sur les comptes Outlook, car Microsoft a desactive SMTP AUTH sur la plupart des comptes personnels Outlook.com crees depuis 2024. Le chemin d'envoi via Graph n'est pas affecte par cette politique. Les messages envoyes sont automatiquement sauvegardes dans votre dossier « Envoyes » par Microsoft.

Si votre compte Outlook cesse de fonctionner apres une longue periode hors ligne, le refresh token OAuth a peut-etre expire. Ouvrez **Parametres > Comptes**, modifiez le compte et utilisez le bouton de re-authentification Microsoft pour vous reconnecter.


## Verification du certificat TLS

MailCopilot verifie toujours les certificats TLS, en les comparant à la fois au jeu de certificats Mozilla intégré et au magasin de certificats de votre système d'exploitation (en basculant sur le seul jeu intégré si le magasin système ne peut pas être lu). Si votre serveur utilise un certificat auto-signe, une invite de confiance apparaitra : si l'empreinte n'a pas encore ete lue, le bouton indique d'abord **« Lire le certificat »** -- cliquez dessus, verifiez les details, puis confirmez avec **« Faire confiance et continuer »** ; si **« Faire confiance et continuer »** est deja affiche, cliquez simplement dessus. Les serveurs accessibles via STARTTLS (typiquement le port IMAP 143 ou le port SMTP 587) ne peuvent pas transmettre leur certificat a cette etape, seule l'empreinte est donc enregistree pour eux -- un serveur STARTTLS auto-signe ne peut pas etre rendu fiable de cette maniere ; utilisez plutot le TLS implicite (typiquement le port 993 ou 465) si votre serveur le prend en charge.

Lors de la connexion avec Google, si votre réseau utilise un proxy ou un antivirus qui remplace les certificats TLS par un certificat que votre système d'exploitation ne connaît pas encore, MailCopilot le détectera et proposera automatiquement d'accepter le certificat. Vous verrez les détails du certificat (hôte, émetteur, empreinte) et pourrez l'accepter ou le refuser. Le compte est enregistré dans tous les cas, et vous pouvez gérer les certificats plus tard dans les paramètres du compte. Si en revanche le certificat racine du proxy ou de l'antivirus est déjà installé dans le magasin de votre système d'exploitation, la connexion réussit sans aucune invite de confiance -- MailCopilot signale ce cas séparément par une notification informative (voir ci-dessous) plutôt que de vous demander d'accepter quoi que ce soit.

Faire confiance au magasin de certificats système signifie que la plupart des proxys d'entreprise et des antivirus qui inspectent le trafic TLS fonctionnent d'emblée, sans invite de confiance lors de la configuration. Après la première synchronisation réussie de votre compte dans une session, MailCopilot vérifie une fois si une connexion est ainsi inspectée et, le cas échéant, affiche une notification nommant le logiciel ou le proxy responsable ; cette vérification s'exécute au plus une fois par serveur pendant toute la durée de vie de votre profil, donc une inspection activée sur un serveur après cette vérification ne sera pas détectée. Si le certificat d'un serveur change ensuite pour un certificat qui ne peut pas être approuvé du tout, MailCopilot affichera à ce moment-là une boîte de dialogue de récupération dans la fenêtre principale -- voir [Confiance des certificats TLS](../settings/general#confiance-des-certificats-tls) pour plus de détails.

## Gestion de plusieurs comptes

Ajoutez autant de comptes que necessaire. Basculez entre eux via la barre laterale ou **Parametres > Comptes**.

## Personnalisation de l'avatar du compte

Chaque compte est affiché dans la barre latérale avec un avatar -- un cercle coloré avec des initiales. Vous pouvez personnaliser l'avatar dans **Paramètres > Comptes** en cliquant sur l'icône de palette à côté du compte.

### Modes d'affichage

- **Lettres** -- un cercle coloré avec 1--2 caractères (initiales). Vous pouvez saisir des initiales personnalisées si les automatiques ne conviennent pas.
- **Icône** -- un cercle coloré avec une icône de la collection (courrier, mallette, étoile, fusée, etc.).
- **Gravatar** -- charge votre photo de profil depuis [Gravatar](https://gravatar.com) en fonction de votre adresse e-mail. Si aucun Gravatar n'est trouvé, les lettres sont affichées.

### Changer la couleur

Cliquez sur une couleur dans la palette pour changer l'arrière-plan de l'avatar. La couleur est enregistrée et reste la même après le redémarrage.

### Info-bulle

Survolez un avatar dans la barre latérale pour voir le nom du compte et l'adresse e-mail.

## Fournisseurs compatibles

Gmail, Outlook, Yahoo, Fastmail, Yandex Mail, Mail.ru, ProtonMail (via Bridge), serveurs auto-heberges (Dovecot, Postfix, Zimbra, etc.).
