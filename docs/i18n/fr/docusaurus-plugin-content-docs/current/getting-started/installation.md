---
sidebar_position: 1
title: Installation
---

# Installation

## Télécharger MailCopilot

Rendez-vous sur [mailcopilot.io](https://mailcopilot.io) pour télécharger la dernière version de MailCopilot.

## Installation sur Linux

:::warning Ubuntu 23.10+ / 24.04 et autres distributions récentes
Sur Ubuntu 23.10 et versions ultérieures (y compris 24.04 LTS), ainsi que sur d'autres distributions intégrant le même durcissement du noyau, **installez le paquet `.deb`** (ou le `.rpm` sur Fedora/openSUSE) plutôt que l'AppImage.

Ces noyaux restreignent par défaut les espaces de noms utilisateur non privilégiés (`kernel.apparmor_restrict_unprivileged_userns=1`). MailCopilot est basé sur Electron, dont le composant `chrome-sandbox` a besoin de cette capacité lors du lancement depuis un AppImage — ce qui provoque un plantage au démarrage avec un signal `SIGTRAP`. Les paquets `.deb` et `.rpm` ne présentent pas ce problème : leurs scripts d'installation configurent le composant `chrome-sandbox` de manière appropriée — en appliquant le SUID-root (`chmod 4755`) lorsque les espaces de noms utilisateur non privilégiés sont restreints, ou en installant un profil AppArmor sur les systèmes Ubuntu récents (24.04+).

Ne contournez **pas** ce problème en lançant l'application avec `--no-sandbox` ou en désactivant globalement `apparmor_restrict_unprivileged_userns` — les deux affaiblissent la barrière de sécurité qui vous protège du contenu d'e-mails non fiables. Utilisez le `.deb` ou le `.rpm` à la place.
:::

### Deb (Debian, Ubuntu, Mint) — recommandé

1. Téléchargez le fichier `.deb` depuis le site web.
2. Installez-le en double-cliquant ou dans un terminal :
   ```bash
   sudo dpkg -i mailcopilot-*.deb
   ```
3. Lancez MailCopilot depuis le menu des applications.

### RPM (Fedora, openSUSE)

1. Téléchargez le fichier `.rpm` depuis le site web.
2. Installez-le en double-cliquant ou dans un terminal :
   ```bash
   sudo rpm -i mailcopilot-*.rpm
   ```
3. Lancez MailCopilot depuis le menu des applications.

### AppImage

L'AppImage est un fichier unique autonome qui ne nécessite pas d'installation. Il fonctionne bien sur les distributions plus anciennes, mais consultez l'avertissement ci-dessus avant de l'utiliser sur Ubuntu 23.10+ / 24.04.

1. Téléchargez le fichier `.AppImage` depuis le site web.
2. Rendez le fichier exécutable :
   - Clic droit sur le fichier, sélectionnez **Propriétés**, onglet **Permissions**, cochez **Autoriser l'exécution du fichier comme un programme**.
   - Ou dans un terminal : `chmod +x mailcopilot-*.AppImage`
3. Double-cliquez sur l'AppImage pour lancer MailCopilot.

Le runtime AppImage nécessite FUSE. Sur les versions récentes de Debian/Ubuntu, installez le paquet `libfuse2t64` (les versions plus anciennes l'appellent `libfuse2`) :

```bash
sudo apt install libfuse2t64
```

:::tip
Vous pouvez déplacer l'AppImage dans n'importe quel emplacement, par exemple `~/Applications/`. L'application est entièrement autonome et ne nécessite pas d'installation.
:::

## Installation sur Windows

1. Téléchargez l'installateur `.exe` depuis le site web.
2. Exécutez l'installateur et suivez les instructions. Vous pouvez choisir le répertoire d'installation.
3. Lancez MailCopilot depuis le menu Démarrer ou le raccourci sur le bureau.

## Premier lancement

Au premier lancement, vous verrez d'abord un écran de consentement intitulé **Envoyer des données de diagnostic ?**, demandant si MailCopilot peut envoyer des données de diagnostic et d'usage -- voir [Télémétrie](../privacy/telemetry) pour savoir exactement ce que cela signifie. Rien n'est envoyé avant que vous ne répondiez, et votre choix n'affecte ni la synchronisation du courrier ni l'assistant IA. Il change une chose dans Paramètres -> À propos : diagnostic désactivé, le formulaire de retour intégré est remplacé par un lien vers le site web de MailCopilot. Une fois que vous avez répondu, l'assistant de configuration de compte s'ouvre et vous guide pour connecter votre premier compte de messagerie.

Vos mots de passe sont stockés en toute sécurité dans le trousseau système (via keytar) et ne sont jamais écrits dans des fichiers de configuration en texte brut.

## Mises à jour automatiques

MailCopilot vérifie automatiquement les mises à jour. Lorsqu'une nouvelle version est disponible, une notification apparaît dans l'application. Vous pouvez télécharger la mise à jour et redémarrer en un clic.

:::note
Le mécanisme de mise à jour intégré de MailCopilot peut tenter de se mettre à jour sur place pour les installations AppImage, `.deb`/`.rpm`/pacman, ainsi que sous Windows et macOS. Pour une AppImage, MailCopilot remplace le fichier `.AppImage` lui-même, il doit donc être stocké quelque part accessible en écriture par votre compte utilisateur — par exemple votre répertoire personnel. Pour un paquet `.deb`/`.rpm`/pacman, le mécanisme de mise à jour demande des privilèges d'administrateur (`pkexec`/`sudo`) avant de tenter d'écrire la mise à jour, de la même façon que `apt`/`dnf`/`pacman` — le fait que le répertoire d'installation appartienne à root ne l'empêche donc pas, même si le résultat final dépend de cette invite d'élévation de privilèges et du gestionnaire de paquets, pas de MailCopilot. La mise à jour automatique n'est indisponible à l'avance que lorsque MailCopilot ne s'exécute pas sous l'une de ces formes packagées (par exemple une AppImage extraite ou un répertoire brut non empaqueté), ou lorsque le répertoire dans lequel MailCopilot devrait écrire n'est pas accessible en écriture — le répertoire propre à l'AppImage, ou, sous Windows et macOS, le répertoire contenant l'exécutable installé. Dans ces cas, effectuez les mises à jour via votre gestionnaire de paquets, avec des privilèges d'administrateur, ou en téléchargeant et réinstallant le dernier paquet depuis le site web.
:::
