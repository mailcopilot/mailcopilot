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

## Rapports d'erreurs anonymes

Lorsque cette option est activée, MailCopilot envoie des rapports de plantage anonymes pour aider les développeurs à trouver et corriger les bugs. Aucune donnée personnelle, contenu d'e-mail ou information de compte n'est collecté — seuls les détails techniques des erreurs sont transmis.

Ce paramètre est activé par défaut. Vous pouvez le désactiver à tout moment en décochant la case.

## Journalisation détaillée

Lorsque cette option est activée, MailCopilot écrit des journaux détaillés dans un fichier pour le dépannage. Ces journaux sont stockés localement sur votre ordinateur et ne sont jamais envoyés automatiquement.

La journalisation détaillée est désactivée par défaut. Activez-la uniquement lors de l'investigation d'un problème — cela peut légèrement affecter les performances.

## Signaler un bug

Cliquez sur le bouton **Signaler un bug** pour envoyer vos commentaires directement aux développeurs de MailCopilot. Décrivez le problème rencontré — cela nous aide à identifier et corriger les problèmes plus rapidement.

Vos commentaires sont envoyés de manière sécurisée via le même système anonyme de rapports d'erreurs. Si les rapports d'erreurs sont désactivés, vous verrez un lien vers le site web de MailCopilot où vous pouvez contacter le support.

Lorsque l'application rencontre une erreur inattendue, un formulaire de commentaires apparaîtra également sur l'écran d'erreur, vous permettant de décrire ce que vous faisiez avant l'erreur.
