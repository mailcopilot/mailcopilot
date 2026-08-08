---
sidebar_position: 6
title: À propos
---

# À propos

L'onglet **À propos** dans les Paramètres affiche des informations sur votre installation de MailCopilot et fournit des contrôles de diagnostic et de mise à jour.

## Version

Affiche la version actuelle de MailCopilot installée sur votre ordinateur.

## Liens

- **Site web** — ouvre le site web de MailCopilot dans votre navigateur.
- **Documentation** — ouvre ce site de documentation.

## Informations système

Le panneau **Informations système** affiche des détails techniques sur votre installation :

- **Version de l'application** — la version actuelle de MailCopilot et le canal de publication (stable, nightly ou dev).
- **Electron** — la version de l'environnement d'exécution Electron utilisé par MailCopilot.
- **Chromium** — la version du moteur Chromium intégré à Electron.
- **Node.js** — la version de Node.js utilisée à l'intérieur de l'application.
- **Plateforme** — le système d'exploitation et l'architecture.
- **Chemin d'installation** — le chemin de l'exécutable actuellement en cours d'exécution (`process.execPath`). Sous Windows et macOS, c'est l'emplacement réel d'installation de MailCopilot. Sur une AppImage, `execPath` pointe vers un emplacement temporaire `/tmp/.mount_*` créé pendant que l'application est ouverte, et non vers l'emplacement du fichier `.AppImage` lui-même — l'indicateur **lecture seule** reflète l'accessibilité en écriture du dossier réel du fichier AppImage, pas celle du chemin affiché ici. Cet indicateur n'apparaît jamais pour les installations `.deb`/`.rpm`/pacman, qui écrivent les mises à jour avec des privilèges d'administrateur au lieu de dépendre des droits sur le dossier.

Ces informations sont utiles lors du signalement de bugs ou de la vérification de la compatibilité.

## Mises à jour

La section **Mises à jour** vous permet de contrôler la façon dont MailCopilot se met à jour.

### Télécharger automatiquement les mises à jour en arrière-plan

Lorsque cette option est activée, MailCopilot télécharge silencieusement les nouvelles versions au fur et à mesure de leur disponibilité. Une fois le téléchargement terminé, vous êtes invité à redémarrer l'application pour appliquer la mise à jour. Aucune action n'est nécessaire jusqu'à ce que vous soyez prêt à redémarrer.

Lorsque cette option est désactivée, MailCopilot vous informe qu'une mise à jour est disponible et affiche un bouton **Télécharger**. Vous choisissez exactement quand le téléchargement commence.

Ce paramètre est **désactivé par défaut** (activation volontaire requise). Activez-le pour que MailCopilot télécharge les mises à jour sans intervention manuelle.

### Rechercher les mises à jour

Cliquez sur le bouton **Rechercher les mises à jour** pour déclencher manuellement une vérification à tout moment. Le bouton et la zone d'état reflètent l'état actuel du processus de mise à jour :

- **inactif** — le bouton **Rechercher les mises à jour** est visible et prêt à être utilisé.
- **Vérification…** — une vérification des mises à jour est en cours ; le bouton est désactivé jusqu'à la fin de la vérification.
- **Vous avez la dernière version** — aucune mise à jour n'est disponible.
- **disponible** — une nouvelle version a été détectée : une indication **(dernière version disponible : X.Y.Z)** apparaît à côté de la version ci-dessus, et — si l'installation prend en charge la mise à jour automatique — un bouton **Télécharger X.Y.Z** apparaît ici.
- **Téléchargement… N %** — le fichier de mise à jour est en cours de téléchargement ; un indicateur de progression affiche le pourcentage.
- **Redémarrer pour installer** — le téléchargement est terminé ; cliquez pour redémarrer MailCopilot et appliquer la mise à jour immédiatement.
- **Erreur réseau — réessayez quand vous serez en ligne** — la vérification ou le téléchargement a échoué en raison d'un problème réseau.
- **Permission refusée — administrateur requis** — le mécanisme de mise à jour ou le système d'exploitation a refusé l'accès. Sur les installations qui utilisent des privilèges d'administrateur (`.deb`/`.rpm`/pacman), cela signifie généralement que l'étape d'élévation de privilèges ou l'étape d'installation du paquet a échoué, et non qu'un dossier n'est pas accessible en écriture.
- **Échec de la mise à jour — voir les journaux pour les détails** — une erreur inattendue s'est produite ; consultez la journalisation détaillée pour plus d'informations.
- **Les mises à jour sont désactivées dans cette version** — MailCopilot s'exécute en mode développement ou non packagé ; les mises à jour automatiques ne sont pas disponibles.

### Quand la mise à jour automatique n'est pas disponible

MailCopilot peut normalement se mettre à jour lui-même sur toutes les plateformes qu'il prend en charge : une installation AppImage remplace le fichier `.AppImage` lui-même, et une installation `.deb`/`.rpm`/pacman laisse le mécanisme de mise à jour tenter l'écriture en demandant des privilèges d'administrateur (`pkexec`/`sudo`), de la même façon que `apt`/`dnf`/`pacman`. Le résultat final sur ces installations Linux packagées est décidé par l'invite d'élévation de privilèges et le gestionnaire de paquets, pas par MailCopilot — un échec à ce stade affiche une boîte de dialogue **Update installation failed** (« Échec de l'installation de la mise à jour ») proposant un lien vers la page de téléchargement, et non silencieusement.

MailCopilot ne décide à l'avance que la mise à jour automatique est indisponible que dans deux situations :

- **La version n'est pas packagée** — une version de développement ou de CI. Il n'y a alors aucun mécanisme de mise à jour du tout : le bouton **Rechercher les mises à jour** et la zone d'état n'apparaissent pas, et une note affiche à la place **« Les mises à jour sont désactivées dans cette version »**.
- **La version est packagée, mais MailCopilot a une raison précise de penser que l'écriture échouerait**, ce qui se produit lorsque :
  - la version Linux n'est ni une AppImage ni un paquet système pris en charge — par exemple une AppImage extraite ou un répertoire `linux-unpacked` brut, ou
  - le répertoire dans lequel MailCopilot devrait écrire n'est pas accessible en écriture par votre compte utilisateur. Sur une AppImage, il s'agit du répertoire contenant le fichier `.AppImage` ; sous Windows et macOS, il s'agit du répertoire contenant l'exécutable installé. Cette vérification ne s'applique pas aux installations `.deb`/`.rpm`/pacman, car le mécanisme de mise à jour élève ses privilèges à leur place.

Dans le second cas, la vérification des mises à jour continue de fonctionner normalement — seule l'écriture de la mise à jour sur place est affectée :

- Le bouton **Rechercher les mises à jour** reste disponible et fonctionne — vous pouvez toujours vérifier si une nouvelle version existe.
- La case **Télécharger automatiquement les mises à jour en arrière-plan** reste disponible et continue d'enregistrer votre préférence, mais rien ne se télécharge automatiquement tant que la mise à jour automatique n'est pas possible.
- Un avertissement apparaît à côté de la case pour expliquer pourquoi — par exemple : « Cette version ne peut pas se remplacer sur place (elle ne s'exécute ni comme AppImage ni comme paquet système). Téléchargez la nouvelle version manuellement depuis le site. » ou « Le dossier contenant l'application n'est pas accessible en écriture, la mise à jour ne peut donc pas être installée sur place. Téléchargez la nouvelle version manuellement ou déplacez l'application dans un dossier vous appartenant. » Si MailCopilot ne peut pas déterminer la raison précise, un avertissement neutre apparaît à la place : « Cette installation ne peut pas se mettre à jour automatiquement. Téléchargez la nouvelle version manuellement depuis le site. »
- Les contrôles **Télécharger** et **Redémarrer pour installer** n'apparaissent pas, car MailCopilot n'a aucun moyen d'écrire la mise à jour lui-même.

Cette vérification s'exécute une seule fois, au démarrage de MailCopilot. Si vous déplacez le fichier AppImage vers un emplacement accessible en écriture ou changez les permissions du dossier d'installation, quittez et relancez MailCopilot pour que le changement prenne effet — une instance déjà en cours d'exécution conserve son verdict d'origine.

Mettez à jour l'application via votre gestionnaire de paquets, avec des privilèges d'administrateur, ou en téléchargeant manuellement la nouvelle version depuis le site web.

## Diagnostics et données d'usage

Lorsque cette option est activée, MailCopilot envoie des rapports de plantage, des mesures de performance, des événements d'utilisation (quelles fonctionnalités sont utilisées, quel fournisseur et quel modèle d'IA, le coût estimé d'une requête) et un identifiant aléatoire d'installation qui relie vos sessions. Le contenu des messages et le texte de vos recherches ne sont jamais inclus ; les adresses, les objets et les noms de dossiers sont entièrement exclus partout où le diagnostic utilise une liste fermée de champs (comme dans le diagnostic de la copie envoyée), et rattrapés ailleurs par un nettoyage au mieux des formes reconnaissables d'adresses et de chemins -- un filet de sécurité, pas une garantie. Le formulaire de retour ci-dessous est le seul endroit où une adresse est envoyée volontairement, afin qu'on puisse vous répondre ; partout ailleurs, une adresse n'est que nettoyée si elle est reconnue, jamais garantie absente -- et, comme il inclut cet identifiant d'installation, ces données ne sont pas totalement anonymes. Consultez [Télémétrie](../privacy/telemetry) pour la liste complète de ce qui est envoyé et de ce qui ne l'est jamais.

Ce paramètre reflète la réponse que vous avez donnée sur l'écran de consentement affiché au premier démarrage de MailCopilot, et il est **désactivé par défaut** — rien n'est envoyé tant que vous n'avez pas donné votre consentement actif. Vous pouvez modifier votre décision à tout moment en cochant ou décochant la case.

Si MailCopilot n'a aucune trace d'une réponse à la question de consentement initiale — par exemple, juste après que la liste des données collectées a changé et qu'une nouvelle demande devient nécessaire — la case est affichée décochée et désactivée ici, avec une note indiquant que le diagnostic reste désactivé tant que vous n'avez pas répondu sur l'écran de consentement au prochain démarrage.

## Journalisation détaillée

Lorsque cette option est activée, MailCopilot écrit des journaux détaillés dans un fichier pour le dépannage. Ces journaux sont stockés localement sur votre ordinateur et ne sont jamais envoyés automatiquement.

La journalisation détaillée est désactivée par défaut. Activez-la uniquement lors de l'investigation d'un problème — cela peut légèrement affecter les performances.

## Signaler un bug

Cliquez sur le bouton **Signaler un bug** pour envoyer vos commentaires directement aux développeurs de MailCopilot. Décrivez le problème rencontré — cela nous aide à identifier et corriger les problèmes plus rapidement.

Vos commentaires sont envoyés de manière sécurisée via ce même système de diagnostics décrit ci-dessus. Si les rapports d'erreurs sont désactivés, vous verrez un lien vers le site web de MailCopilot où vous pouvez contacter le support.

Lorsque l'application rencontre une erreur inattendue, un formulaire de commentaires apparaîtra également sur l'écran d'erreur, vous permettant de décrire ce que vous faisiez avant l'erreur.
