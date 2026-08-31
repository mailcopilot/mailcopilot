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

## Vérification orthographique

La vérification orthographique est **désactivée par défaut**. L'activer télécharge un fichier de dictionnaire depuis un serveur externe (celui de Google), et MailCopilot demande d'abord votre accord -- à chaque nouvelle langue ajoutée. C'est volontaire : MailCopilot n'active jamais une langue que vous n'avez pas approuvée. Le téléchargement lui-même est effectué par le moteur de navigateur intégré à l'application (Chromium), qui contacte le serveur de Google -- MailCopilot ne peut pas annuler une requête déjà commencée. Si un téléchargement démarre malgré tout pour une langue que vous n'avez pas approuvée, MailCopilot le remarque et désactive à nouveau la vérification orthographique plutôt que de la laisser activée sans que vous le sachiez.

Activez **« Vérifier l’orthographe pendant la saisie »** pour activer la vérification. Les mots mal orthographiés sont alors soulignés partout où vous pouvez taper du texte -- dans la rédaction d'un message, les champs des paramètres, etc.

### Choisir les dictionnaires

Une fois la vérification orthographique activée, utilisez **« Dictionnaires »** pour ajouter une ou plusieurs langues. La liste des langues disponibles provient du moteur de vérification orthographique lui-même, pas d'une liste figée intégrée à MailCopilot -- ce que vous voyez dépend de ce que cette version de l'application peut réellement proposer. Vous pouvez ajouter plusieurs langues à la fois ; elles sont toutes vérifiées simultanément. Chaque langue ajoutée peut être retirée avec son bouton **« Retirer »**. Si « Vérifier l’orthographe pendant la saisie » est activé mais qu'aucun dictionnaire n'est choisi, la vérification reste en pratique désactivée -- un dictionnaire est obligatoire.

Le nombre de dictionnaires actifs en même temps est plafonné ; la limite actuelle est indiquée à côté du sélecteur.

### Autorisation de téléchargement

La première fois que vous ajoutez une langue qui n'a pas encore été approuvée, MailCopilot affiche une boîte de dialogue demandant s'il faut télécharger le dictionnaire de cette langue, et nomme le serveur externe d'où provient le fichier. Rien de ce que vous tapez n'est jamais envoyé nulle part -- la vérification a toujours lieu sur votre ordinateur ; seul le fichier de dictionnaire lui-même est téléchargé.

- Choisir **« Télécharger »** approuve la langue : MailCopilot mémorise cette approbation et laisse le téléchargement se dérouler. L'approbation reste valable pour cette langue par la suite -- si le dictionnaire doit être téléchargé à nouveau plus tard (par exemple après avoir réactivé une langue déjà approuvée), cela se fait sans nouvelle question.
- Choisir **« Annuler »** (ou fermer la boîte de dialogue) revient à refuser : cette langue n'est **pas** activée, mais la décision n'est pas mémorisée comme un refus permanent -- vous pouvez ajouter la même langue plus tard et on vous le redemandera simplement. Les autres modifications faites lors du même enregistrement sont tout de même appliquées : refuser un téléchargement de dictionnaire ne bloque jamais le reste de vos changements.

### macOS

Sur macOS, la vérification orthographique est gérée par le système d'exploitation, pas par MailCopilot. Il n'y a ni sélecteur de dictionnaires ni boîte de dialogue d'autorisation de téléchargement sur macOS, car macOS ne télécharge rien et ignore toute liste de langues que MailCopilot pourrait lui envoyer -- les paramètres l'expliquent et n'affichent que l'interrupteur marche/arrêt. Pour changer les langues vérifiées par macOS, allez dans Réglages Système → Clavier → Saisie de texte.

### Corriger un mot mal orthographié

Faites un clic droit sur un mot souligné comme mal orthographié pour voir une courte liste de remplacements suggérés, ainsi qu'un élément **« Ajouter au dictionnaire »**. Cliquer sur une suggestion remplace le mot ; **« Ajouter au dictionnaire »** ajoute le mot à votre dictionnaire personnel pour qu'il ne soit plus signalé. Il n'existe actuellement aucun moyen de consulter ou de supprimer les mots ajoutés à votre dictionnaire personnel depuis MailCopilot.

## Icône dans la zone de notification et fonctionnement en arrière-plan

MailCopilot peut afficher une icône dans la zone de notification de votre système. **« Afficher l'icône dans la zone de notification »** est activé par défaut ; son menu propose **« Ouvrir MailCopilot »**, **« Nouveau message »**, **« Relever le courrier »** et **« Quitter »**, et tant que l'icône existe, la survoler affiche le nombre de messages non lus dans son infobulle -- jusqu'à 999, puis **« 999+ »**.

### Réduire dans la zone de notification à la fermeture

Activez **« Réduire dans la zone de notification à la fermeture »** (désactivé par défaut) pour que MailCopilot continue de fonctionner lorsque vous fermez la fenêtre principale au lieu de quitter -- le courrier continue de se synchroniser en arrière-plan et les notifications de nouveau courrier continuent d'arriver. Pour rouvrir la fenêtre, cliquez sur l'icône (ou son élément de menu **« Ouvrir MailCopilot »**) ; utilisez **« Quitter »** dans le menu de l'icône pour réellement fermer l'application.

Choisir **« Quitter »** ne retire pas immédiatement l'icône de la zone de notification. Avant de réellement se fermer, MailCopilot effectue un point de contrôle de sa base de données locale -- d'où ce court délai, normalement bien moins d'une seconde. Pendant cette fermeture, l'infobulle de l'icône affiche **« Fermeture… »**, et son menu affiche une seule ligne inactive **« Fermeture… »** à la place des options habituelles, pour que vous puissiez voir que l'application est en train de se fermer plutôt que de croire que Quitter n'a fait que retirer l'icône. Si un message était encore en cours d'envoi au moment de quitter, il n'est pas perdu : MailCopilot envoie via une file d'attente locale, si bien qu'un envoi inachevé reste simplement dans la file et repart au prochain lancement de MailCopilot.

Ce réglage dépend du fait que l'icône ait pu être créée, pas de savoir si quelque chose l'affiche : sous Linux, MailCopilot crée l'icône même quand aucun hôte de zone de notification ne l'accepte, donc **« Réduire dans la zone de notification à la fermeture »** fonctionne dès que l'objet icône existe -- que votre bureau l'affiche réellement ou non. Le réglage n'a d'effet nul que si MailCopilot n'a pas pu créer l'icône du tout (image d'icône vide ou illisible, ou une plateforme qui refuse de la construire).

MailCopilot ne vérifie pas, avant de masquer la fenêtre, si votre bureau affiche réellement l'icône -- c'est une décision du bureau, pas de MailCopilot ; une note sous le réglage le signale pour Linux. Si l'icône n'est jamais affichée, il n'y a rien sur quoi cliquer, mais le masquage reste de toute façon réversible : relancer MailCopilot ramène la fenêtre masquée au premier plan, que l'icône fonctionne, s'affiche mal ou ne soit jamais apparue.

Si les notifications sont activées, la première fois qu'une fermeture masque la fenêtre dans la zone de notification au cours d'une session, MailCopilot affiche une brève notification unique confirmant qu'il continue de fonctionner en arrière-plan et que cliquer sur l'icône ramène la fenêtre.

Si vous fermez un jour MailCopilot en pensant qu'il restera dans la zone de notification et que vous ne le retrouvez pas ensuite, consultez [J'ai fermé la fenêtre et je ne trouve plus MailCopilot](../faq#jai-fermé-la-fenêtre-et-je-ne-trouve-plus-mailcopilot) dans la FAQ.

### Badge de messages non lus

Tant que vous avez des messages non lus, MailCopilot affiche un badge sur l'icône de l'application -- un badge numérique sur le dock (macOS) ou le lanceur Unity (Linux), et un point sur le bouton de la barre des tâches (Windows) ; le nombre lui-même (jusqu'à 999, puis **« 999+ »**) est disponible dans l'infobulle de l'icône de la zone de notification tant que celle-ci existe. Le badge respecte les mêmes dossiers que vous avez exclus du décompte des non-lus dans les [paramètres des dossiers](folders-settings#badges-de-non-lus).

### Lancement à l'ouverture de session

Activez **« Lancer à l'ouverture de session »** (désactivé par défaut) pour que MailCopilot démarre automatiquement lorsque vous ouvrez une session sur votre ordinateur. Sous Windows et macOS, cela enregistre MailCopilot comme élément de démarrage auprès du système d'exploitation ; sous Linux, cela crée une entrée de démarrage automatique (un fichier `.desktop`) afin que votre environnement de bureau démarre MailCopilot à l'ouverture de session.

Le bouton enregistre ce que vous avez demandé ; une note apparaît en dessous chaque fois que le résultat réel ne correspond pas à cette demande. Si cette plateforme ou cette version ne peut pas du tout enregistrer le démarrage automatique, MailCopilot vous indique que le réglage reste sans effet ici. Si l'activation a échoué, une note explique que le démarrage automatique n'a pas pu être enregistré et qu'une nouvelle tentative aura lieu au prochain enregistrement. Si la désactivation a échoué, MailCopilot vous indique que l'application se lancera tout de même à l'ouverture de session et que la suppression sera retentée automatiquement au prochain enregistrement -- pour que vous ne pensiez jamais que le démarrage automatique est désactivé alors qu'il ne l'est pas.

## Confiance des certificats TLS

MailCopilot vérifie chaque certificat TLS présenté par vos serveurs de messagerie à la fois par rapport au jeu de certificats Mozilla intégré et par rapport au magasin de certificats de votre système d'exploitation. Faire confiance également au magasin système signifie que les logiciels de sécurité qui inspectent le trafic TLS (par exemple Kaspersky et des antivirus similaires) et les proxys d'entreprise ne perturbent plus la synchronisation du courrier sur Windows, macOS ou Linux -- MailCopilot reconnaît comme valides les certificats présentés par ces outils au lieu de rejeter la connexion. La vérification des certificats n'est jamais affaiblie pour autant : un certificat doit toujours être approuvé par l'une de ces deux sources, ou explicitement épinglé, pour être accepté. Si le magasin de certificats de votre système d'exploitation ne peut pas être lu, MailCopilot bascule sur le seul jeu Mozilla intégré plutôt que d'ignorer la vérification.

### Récupération après un changement de certificat

Si un serveur présente un jour un certificat qui ne peut pas être approuvé -- par exemple il ne correspond plus à un certificat précédemment accepté, ou un certificat auto-signé a changé après une rotation -- MailCopilot affiche la boîte de dialogue **« Le serveur a présenté un certificat différent »** directement dans la fenêtre principale, pas uniquement lors de la configuration du compte. Elle indique le serveur, l'émetteur et l'empreinte SHA-256 du nouveau certificat.

La confirmation se fait en deux étapes au maximum, pour que ce que vous approuvez corresponde toujours à ce qui est réellement affiché à l'écran :

- Si l'empreinte n'a pas encore été lue, le bouton principal affiche **« Lire le certificat »**. Cliquez dessus pour récupérer le certificat depuis le serveur ; ses détails remplacent alors l'espace réservé dans la boîte de dialogue.
- Une fois qu'une empreinte est affichée, le bouton indique **« Approuver et continuer »**. Cliquez dessus pour accepter exactement le certificat affiché.
- Si le certificat du serveur change à nouveau entre l'ouverture de la boîte de dialogue et la confirmation, MailCopilot refuse la confirmation devenue obsolète et relit le certificat pour afficher les nouveaux détails -- mais l'offre de confiance de cette boîte de dialogue était liée au certificat initialement affiché, et cette relecture ne la renouvelle pas : reconfirmer échouera donc de la même façon. Cliquez sur **« Annuler »** pour fermer cette boîte de dialogue, puis laissez MailCopilot retenter la connexion ; une nouvelle boîte de dialogue avec le certificat actuel apparaîtra, à confirmer. Rien n'est approuvé entre-temps.

Choisissez **« Annuler »** à tout moment pour conserver l'état précédent. Ce même serveur ne réaffichera pas cette boîte de dialogue plus d'une fois par minute. L'offre de confiance de la boîte de dialogue ne reste pas non plus ouverte indéfiniment -- si elle est restée sans réponse trop longtemps, la confirmer peut être refusé ; là aussi, annulez et attendez qu'une nouvelle boîte de dialogue apparaisse.

### Reconfirmer un serveur auto-signé épinglé après une mise à jour

L'épinglage de certificats est désormais strictement appliqué pour les certificats qui échouent à la vérification normale de la chaîne : auparavant, l'épinglage ne comparait les empreintes que pour les certificats dont la chaîne était déjà validée normalement, tandis que les certificats auto-signés et à autorité de certification privée -- le cas exact pour lequel l'épinglage existe -- contournaient entièrement la vérification de l'empreinte. Cette faille est désormais comblée. Si vous avez épinglé un serveur de messagerie auto-signé ou à autorité de certification privée avant ce changement, l'épinglage enregistré ne contient peut-être qu'une empreinte, sans le certificat nécessaire pour le vérifier réellement -- un tel serveur cessera de se connecter après la mise à jour, et MailCopilot affichera la boîte de dialogue de récupération de certificat décrite ci-dessus.

Pour corriger cela, reconfirmez le certificat via cette boîte de dialogue : si le bouton affiche **« Lire le certificat »**, cliquez dessus d'abord pour récupérer le certificat, puis cliquez sur **« Approuver et continuer »** ; si **« Approuver et continuer »** est déjà affiché, cliquez simplement dessus. Cela enregistre l'épinglage avec le certificat lui-même, et la synchronisation reprend automatiquement. Cette opération n'est nécessaire qu'une seule fois par serveur concerné. Ajouter ou modifier un épinglage manuellement dans les **Paramètres** ne peut pas résoudre cela à lui seul -- pour un certificat qui reste par ailleurs non approuvé (auto-signé, ou émis par une autorité de certification privée pas encore présente dans le magasin de votre système), seule la boîte de dialogue de récupération peut lui accorder sa confiance ; voir [Quand utiliser l'épinglage de certificats](#quand-utiliser-lépinglage-de-certificats) ci-dessous pour comprendre pourquoi.

### Notification d'inspection

Après la première synchronisation réussie d'un compte dans une session, MailCopilot vérifie une fois si sa connexion au serveur de messagerie est inspectée par un antivirus ou un proxy (le certificat n'est approuvé que via le magasin système) et, le cas échéant, affiche une notification du type « La connexion à `{{host}}` est inspectée. », en nommant l'émetteur lorsqu'il est connu. Cette vérification s'exécute au plus une fois par serveur pendant toute la durée de vie de votre profil, que l'inspection ait été détectée ou non -- donc si l'inspection est activée sur un serveur *après* que cette vérification unique s'est déjà déroulée sans rien trouver, MailCopilot ne s'en apercevra pas. La notification peut être fermée.

Les erreurs de certificat sont réessayées selon un intervalle long (6 heures) plutôt que l'intervalle court utilisé pour les échecs réseau ordinaires, car elles nécessitent votre décision et ne se résoudront pas d'elles-mêmes.

## Épinglage de certificats TLS

L'épinglage de certificats TLS ajoute une couche de sécurité supplémentaire pour vos connexions de messagerie. Il garantit que votre client ne se connecte qu'aux serveurs présentant un certificat spécifique, vous protégeant contre les attaques de type « homme du milieu ».

### Gestion des certificats épinglés

1. Ouvrez les **Paramètres** et allez dans la section **Comptes**.
2. Cliquez sur **Modifier** sur un compte pour ouvrir ses paramètres.
3. Faites défiler jusqu'à la section **Épinglage de certificats TLS**.

La section affiche un tableau des certificats épinglés avec leur hôte, port, empreinte et date d'ajout.

### Ajouter un épinglage

1. Cliquez sur **Ajouter un pin**.
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
