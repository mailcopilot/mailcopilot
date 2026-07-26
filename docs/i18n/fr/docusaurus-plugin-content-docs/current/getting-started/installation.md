---
sidebar_position: 1
title: Installation
---

# Installation

## Telecharger MailCopilot

Rendez-vous sur [mailcopilot.io](https://mailcopilot.io) pour telecharger la derniere version de MailCopilot.

## Installation sur Linux

:::warning Ubuntu 23.10+ / 24.04 et autres distributions recentes
Sur Ubuntu 23.10 et versions ulterieures (y compris 24.04 LTS), ainsi que sur d'autres distributions integrant le meme durcissement du noyau, **installez le paquet `.deb`** (ou le `.rpm` sur Fedora/openSUSE) plutot que l'AppImage.

Ces noyaux restreignent par defaut les espaces de noms utilisateur non privilegies (`kernel.apparmor_restrict_unprivileged_userns=1`). MailCopilot est base sur Electron, dont le composant `chrome-sandbox` a besoin de cette capacite lors du lancement depuis un AppImage — ce qui provoque un plantage au demarrage avec un signal `SIGTRAP`. Les paquets `.deb` et `.rpm` ne presentent pas ce probleme : leurs scripts d'installation configurent le composant `chrome-sandbox` de maniere appropriee — en appliquant le SUID-root (`chmod 4755`) lorsque les espaces de noms utilisateur non privilegies sont restreints, ou en installant un profil AppArmor sur les systemes Ubuntu recents (24.04+).

Ne contournez **pas** ce probleme en lancant l'application avec `--no-sandbox` ou en desactivant globalement `apparmor_restrict_unprivileged_userns` — les deux affaiblissent la barriere de securite qui vous protege du contenu d'e-mails non fiables. Utilisez le `.deb` ou le `.rpm` a la place.
:::

### Deb (Debian, Ubuntu, Mint) — recommande

1. Telechargez le fichier `.deb` depuis le site web.
2. Installez-le en double-cliquant ou dans un terminal :
   ```bash
   sudo dpkg -i mailcopilot-*.deb
   ```
3. Lancez MailCopilot depuis le menu des applications.

### RPM (Fedora, openSUSE)

1. Telechargez le fichier `.rpm` depuis le site web.
2. Installez-le en double-cliquant ou dans un terminal :
   ```bash
   sudo rpm -i mailcopilot-*.rpm
   ```
3. Lancez MailCopilot depuis le menu des applications.

### AppImage

L'AppImage est un fichier unique autonome qui ne necessite pas d'installation. Il fonctionne bien sur les distributions plus anciennes, mais consultez l'avertissement ci-dessus avant de l'utiliser sur Ubuntu 23.10+ / 24.04.

1. Telechargez le fichier `.AppImage` depuis le site web.
2. Rendez le fichier executable :
   - Clic droit sur le fichier, selectionnez **Proprietes**, onglet **Permissions**, cochez **Autoriser l'execution du fichier comme un programme**.
   - Ou dans un terminal : `chmod +x mailcopilot-*.AppImage`
3. Double-cliquez sur l'AppImage pour lancer MailCopilot.

Le runtime AppImage necessite FUSE. Sur les versions recentes de Debian/Ubuntu, installez le paquet `libfuse2t64` (les versions plus anciennes l'appellent `libfuse2`) :

```bash
sudo apt install libfuse2t64
```

:::tip
Vous pouvez deplacer l'AppImage dans n'importe quel emplacement, par exemple `~/Applications/`. L'application est entierement autonome et ne necessite pas d'installation.
:::

## Installation sur Windows

1. Telechargez l'installateur `.exe` depuis le site web.
2. Executez l'installateur et suivez les instructions. Vous pouvez choisir le repertoire d'installation.
3. Lancez MailCopilot depuis le menu Demarrer ou le raccourci sur le bureau.

## Premier lancement

Au premier lancement, l'assistant de configuration de compte apparaitra. L'application vous guidera pour connecter votre premier compte de messagerie.

Vos mots de passe sont stockes en toute securite dans le trousseau systeme (via keytar) et ne sont jamais ecrits dans des fichiers de configuration en texte brut.

## Mises a jour automatiques

MailCopilot verifie automatiquement les mises a jour. Lorsqu'une nouvelle version est disponible, une notification apparait dans l'application. Vous pouvez telecharger la mise a jour et redemarrer en un clic.

:::note
Les mises a jour automatiques en application ne sont disponibles que lorsque MailCopilot est installe dans un emplacement accessible en ecriture — par exemple, un AppImage stocke dans votre repertoire personnel. Lorsqu'il est installe depuis un paquet systeme `.deb` ou `.rpm`, le repertoire d'installation appartient generalement a root et n'est pas accessible en ecriture par votre compte utilisateur ; MailCopilot desactive alors automatiquement le programme de mise a jour integre. Dans ce cas, effectuez les mises a jour via votre gestionnaire de paquets (`apt`/`dnf`) ou en telechargant et reinstallant le dernier paquet depuis le site web.
:::
