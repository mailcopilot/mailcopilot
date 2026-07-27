---
sidebar_position: 1
title: Parametres generaux
---

# Parametres generaux

## Theme

Choisissez entre les thèmes **Clair** et **Sombre**. L'interface se met à jour instantanément lors du changement. Lorsque le mode sombre est actif, les fenêtres s'ouvrent avec un arrière-plan sombre dès la première image — aucun flash blanc.

## Langue

6 langues disponibles : English, Francais, Deutsch, Espanol, Italiano, Russe. Le changement est instantane.

## Conservation des messages

Contrôle la durée de conservation des copies complètes des messages (contenu HTML, images intégrées et pièces jointes) sur le disque. Ouvrez **Paramètres > Général** et utilisez la liste déroulante **Conserver le contenu complet pendant** pour choisir une période. Les messages plus anciens restent consultables via leurs en-têtes et leur texte brut — seul le fichier `.eml` enrichi est supprimé à l'expiration.

| Option | Durée |
|--------|-------|
| 30 jours | ~1 mois |
| 90 jours | ~3 mois |
| 180 jours | ~6 mois |
| 1 an | 365 jours (par défaut) |
| Indéfiniment | Aucune purge automatique |

Lorsque vous réduisez la période de conservation, MailCopilot affiche un aperçu du nombre de messages qui seront supprimés du cache avant d'appliquer la modification. Les messages sur le serveur ne sont jamais modifiés — seule la copie locale est concernée.

## Application de messagerie par defaut

L'interrupteur determine si MailCopilot est enregistre aupres du systeme d'exploitation comme gestionnaire des liens `mailto:`. Lorsqu'il est active, cliquer sur un lien « envoyer un e-mail » dans votre navigateur, votre terminal ou une autre application de bureau ouvre la fenetre de redaction de MailCopilot avec le destinataire et les autres parametres (`to`, `cc`, `bcc`, `subject`, `body`) deja remplis.

L'enregistrement est explicite -- MailCopilot ne revendique le protocole que si vous activez ce reglage. Sous Linux l'enregistrement passe par la declaration `MimeType` du fichier desktop ; sous macOS par `open-url` ; sous Windows par l'entree de protocole sous `HKCR\mailto`. Vous pouvez revenir en arriere a tout moment en desactivant cet interrupteur ou en changeant le client e-mail par defaut dans les parametres du systeme.

Lorsque MailCopilot est lance une deuxieme fois -- par exemple en cliquant sur un lien `mailto:` alors que l'application est deja ouverte -- la fenetre existante est ramenee au premier plan plutot qu'une fenetre dupliquee ne s'ouvre, de sorte qu'une seule instance est toujours en cours d'execution.

## Confiance des certificats TLS

MailCopilot vérifie chaque certificat TLS présenté par vos serveurs de messagerie à la fois par rapport au jeu de certificats Mozilla intégré et par rapport au magasin de certificats de votre système d'exploitation. Faire confiance également au magasin système signifie que les logiciels de sécurité qui inspectent le trafic TLS (par exemple Kaspersky et des antivirus similaires) et les proxys d'entreprise ne perturbent plus la synchronisation du courrier sur Windows, macOS ou Linux -- MailCopilot reconnaît comme valides les certificats présentés par ces outils au lieu de rejeter la connexion. La vérification des certificats n'est jamais affaiblie pour autant : un certificat doit toujours être approuvé par l'une de ces deux sources, ou explicitement épinglé, pour être accepté. Si le magasin de certificats de votre système d'exploitation ne peut pas être lu, MailCopilot bascule sur le seul jeu Mozilla intégré plutôt que d'ignorer la vérification.

### Récupération après un changement de certificat

Si un serveur présente un jour un certificat qui ne peut pas être approuvé -- par exemple il ne correspond plus à un certificat précédemment accepté, ou un certificat auto-signé a changé après une rotation -- MailCopilot affiche la boîte de dialogue **« Le serveur a présenté un certificat différent »** directement dans la fenêtre principale, pas uniquement lors de la configuration du compte. Elle indique le serveur, l'émetteur et l'empreinte SHA-256 du nouveau certificat.

La confirmation se fait en deux étapes au maximum, pour que ce que vous approuvez corresponde toujours à ce qui est réellement affiché à l'écran :

- Si l'empreinte n'a pas encore été lue, le bouton principal affiche **« Lire le certificat »**. Cliquez dessus pour récupérer le certificat depuis le serveur ; ses détails remplacent alors l'espace réservé dans la boîte de dialogue.
- Une fois qu'une empreinte est affichée, le bouton indique **« Faire confiance et continuer »**. Cliquez dessus pour accepter exactement le certificat affiché.
- Si le certificat du serveur change à nouveau entre l'ouverture de la boîte de dialogue et la confirmation, MailCopilot refuse la confirmation devenue obsolète et relit le certificat pour afficher les nouveaux détails -- mais l'offre de confiance de cette boîte de dialogue était liée au certificat initialement affiché, et cette relecture ne la renouvelle pas : reconfirmer échouera donc de la même façon. Cliquez sur **« Annuler »** pour fermer cette boîte de dialogue, puis laissez MailCopilot retenter la connexion ; une nouvelle boîte de dialogue avec le certificat actuel apparaîtra, à confirmer. Rien n'est approuvé entre-temps.

Choisissez **« Annuler »** à tout moment pour conserver l'état précédent. Ce même serveur ne réaffichera pas cette boîte de dialogue plus d'une fois par minute. L'offre de confiance de la boîte de dialogue ne reste pas non plus ouverte indéfiniment -- si elle est restée sans réponse trop longtemps, la confirmer peut être refusé ; là aussi, annulez et attendez qu'une nouvelle boîte de dialogue apparaisse.

### Reconfirmer un serveur auto-signé épinglé après une mise à jour

L'épinglage de certificats est désormais strictement appliqué pour les certificats qui échouent à la vérification normale de la chaîne : auparavant, l'épinglage ne comparait les empreintes que pour les certificats dont la chaîne était déjà validée normalement, tandis que les certificats auto-signés et à autorité de certification privée -- le cas exact pour lequel l'épinglage existe -- contournaient entièrement la vérification de l'empreinte. Cette faille est désormais comblée. Si vous avez épinglé un serveur de messagerie auto-signé ou à autorité de certification privée avant ce changement, l'épinglage enregistré ne contient peut-être qu'une empreinte, sans le certificat nécessaire pour le vérifier réellement -- un tel serveur cessera de se connecter après la mise à jour, et MailCopilot affichera la boîte de dialogue de récupération de certificat décrite ci-dessus.

Pour corriger cela, reconfirmez le certificat via cette boîte de dialogue : si le bouton affiche **« Lire le certificat »**, cliquez dessus d'abord pour récupérer le certificat, puis cliquez sur **« Faire confiance et continuer »** ; si **« Faire confiance et continuer »** est déjà affiché, cliquez simplement dessus. Cela enregistre l'épinglage avec le certificat lui-même, et la synchronisation reprend automatiquement. Cette opération n'est nécessaire qu'une seule fois par serveur concerné. Ajouter ou modifier un épinglage manuellement dans les **Paramètres** ne peut pas résoudre cela à lui seul -- pour un certificat qui reste par ailleurs non approuvé (auto-signé, ou émis par une autorité de certification privée pas encore présente dans le magasin de votre système), seule la boîte de dialogue de récupération peut lui accorder sa confiance ; voir [Quand utiliser l'épinglage de certificats](#quand-utiliser-lépinglage-de-certificats) ci-dessous pour comprendre pourquoi.

### Notification d'inspection

Après la première synchronisation réussie d'un compte dans une session, MailCopilot vérifie une fois si sa connexion au serveur de messagerie est inspectée par un antivirus ou un proxy (le certificat n'est approuvé que via le magasin système) et, le cas échéant, affiche une notification du type « La connexion à `{host}` est inspectée. », en nommant l'émetteur lorsqu'il est connu. Cette vérification s'exécute au plus une fois par serveur pendant toute la durée de vie de votre profil, que l'inspection ait été détectée ou non -- donc si l'inspection est activée sur un serveur *après* que cette vérification unique s'est déjà déroulée sans rien trouver, MailCopilot ne s'en apercevra pas. La notification peut être fermée.

Les erreurs de certificat sont réessayées selon un intervalle long (6 heures) plutôt que l'intervalle court utilisé pour les échecs réseau ordinaires, car elles nécessitent votre décision et ne se résoudront pas d'elles-mêmes.

## Épinglage de certificats TLS

L'épinglage de certificats TLS ajoute une couche de sécurité supplémentaire pour vos connexions de messagerie. Il garantit que votre client ne se connecte qu'aux serveurs présentant un certificat spécifique, vous protégeant contre les attaques de type « homme du milieu ».

### Gestion des certificats épinglés

1. Ouvrez les **Paramètres** et allez dans la section **Comptes**.
2. Cliquez sur **Modifier** sur un compte pour ouvrir ses paramètres.
3. Faites défiler jusqu'à la section **Épinglage de certificats TLS**.

La section affiche un tableau des certificats épinglés avec leur hôte, port, empreinte et date d'ajout.

### Ajouter un épinglage

1. Cliquez sur **Add pin** (Ajouter un épinglage).
2. Saisissez l'**hôte** (par exemple, `imap.gmail.com`) et le **port** (par exemple, `993`).
3. Cliquez sur **Récupérer et épingler**. MailCopilot se connecte au serveur, récupère son certificat et vous montre l'empreinte.
4. Confirmez pour sauvegarder l'épinglage.

Un épinglage ajouté de cette façon ne fait que *restreindre* le certificat accepté pour un serveur déjà approuvé via le jeu Mozilla habituel ou le magasin de certificats de votre système -- il ne rend pas à lui seul digne de confiance un certificat auto-signé ou à autorité de certification privée par ailleurs non approuvé. Pour un serveur de messagerie auto-signé (ou à autorité de certification privée pas encore présente dans le magasin de votre système), ajouter un épinglage ici ne suffit pas pour se connecter ; il faut le confirmer via la boîte de dialogue de récupération de certificat décrite dans [Confiance des certificats TLS](#confiance-des-certificats-tls), le seul endroit où MailCopilot accorde sa confiance à un tel certificat.

### Supprimer un épinglage

Cliquez sur le bouton de suppression à côté d'un épinglage dans le tableau pour le supprimer. Cela ne fait que supprimer l'épinglage enregistré -- ensuite, MailCopilot acceptera tout certificat valide de ce serveur.

Ajouter un épinglage reconnecte automatiquement MailCopilot au serveur de messagerie pour que le changement prenne effet immédiatement. Supprimer un épinglage ne déclenche pas de reconnexion automatique -- le changement prend effet lors de la prochaine connexion de MailCopilot à ce serveur.

### Serveurs STARTTLS (ports 143 et 587)

Les serveurs accessibles via STARTTLS (typiquement le port IMAP 143 ou le port SMTP 587, où la connexion commence en clair puis passe en TLS) ne transmettent pas leur certificat au moment où MailCopilot le capture pour l'épinglage. Pour ces serveurs, seule l'empreinte est enregistrée, pas le certificat lui-même -- un serveur STARTTLS auto-signé ou à autorité de certification privée ne peut donc pas être rendu utilisable de cette façon ; utilisez le TLS implicite (typiquement le port 993 pour IMAP, 465 pour SMTP) si votre serveur le prend en charge.

### Quand utiliser l'épinglage de certificats

L'épinglage de certificats est particulièrement utile dans les environnements d'entreprise ou dans les situations où vous devez vérifier que vos connexions de messagerie vont bien vers les serveurs attendus. Pour la plupart des usages personnels, la vérification TLS par défaut est suffisante.
