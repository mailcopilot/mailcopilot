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
- **Chemin d'installation** — le répertoire dans lequel MailCopilot est installé. Si le chemin est marqué comme **lecture seule**, l'installation est effectuée pour l'ensemble du système et les mises à jour automatiques nécessitent des privilèges d'administrateur.

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
- **Mise à jour disponible : vX.Y.Z** — une nouvelle version a été détectée ; un bouton **Télécharger X.Y.Z** apparaît si l'installation prend en charge la mise à jour automatique.
- **Téléchargement… N %** — le fichier de mise à jour est en cours de téléchargement ; un indicateur de progression affiche le pourcentage.
- **Redémarrer pour installer** — le téléchargement est terminé ; cliquez pour redémarrer MailCopilot et appliquer la mise à jour immédiatement.
- **Erreur réseau — réessayez quand vous serez en ligne** — la vérification ou le téléchargement a échoué en raison d'un problème réseau.
- **Permission refusée — administrateur requis** — le répertoire d'installation n'est pas accessible en écriture par l'utilisateur actuel.
- **Échec de la mise à jour — voir les journaux pour les détails** — une erreur inattendue s'est produite ; consultez la journalisation détaillée pour plus d'informations.
- **Les mises à jour sont désactivées dans cette version** — MailCopilot s'exécute en mode développement ou non packagé ; les mises à jour automatiques ne sont pas disponibles.

### Installations en lecture seule

Si MailCopilot a été installé pour l'ensemble du système (par exemple, via un gestionnaire de paquets qui place l'application dans un répertoire protégé), le **Chemin d'installation** dans les Informations système est marqué comme **lecture seule**. Dans ce cas :

- La case **Télécharger automatiquement les mises à jour en arrière-plan** est affichée mais **désactivée** (grisée), avec une infobulle expliquant que l'installation est en lecture seule.
- Le bouton **Rechercher les mises à jour** **reste fonctionnel** — vous pouvez toujours vérifier si une nouvelle version est disponible.
- Les contrôles **Télécharger** et **Redémarrer pour installer** sont bloqués : ils n'apparaissent pas ou ne fonctionnent pas pour les installations en lecture seule, car MailCopilot ne peut pas écrire la mise à jour dans un répertoire protégé.

Mettez à jour l'application via votre gestionnaire de paquets ou avec des privilèges d'administrateur.

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
