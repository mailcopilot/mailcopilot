---
sidebar_position: 1
title: Politique de confidentialité
---

# Politique de confidentialité

**Date d'effet :** 13 février 2026
**Dernière mise à jour :** 13 février 2026

## 1. Introduction

MailCopilot (« l'Application », « nous », « notre ») est un client de messagerie de bureau pour Windows, macOS et Linux. La présente Politique de confidentialité décrit comment nous collectons, utilisons, stockons et protégeons vos données personnelles lorsque vous utilisez l'Application.

En utilisant MailCopilot, vous acceptez les pratiques décrites dans cette Politique de confidentialité. Si vous n'êtes pas d'accord, veuillez ne pas utiliser l'Application.

## 2. Données que nous collectons

### 2.1 Identifiants de compte de messagerie

- **Adresse e-mail** — nécessaire pour se connecter à votre serveur de messagerie.
- **Mot de passe** (IMAP/SMTP) — si vous utilisez l'authentification par mot de passe.
- **Jetons OAuth** (jeton d'accès, jeton de rafraîchissement) — si vous utilisez Google OAuth 2.0 ou un autre fournisseur OAuth.

### 2.2 Données de messagerie

Lorsque vous connectez votre compte, l'Application télécharge et met en cache :

- Les en-têtes des e-mails (objet, expéditeur, destinataires, date).
- Le corps des e-mails (texte et HTML).
- Les métadonnées des pièces jointes (noms de fichiers et types ; les pièces jointes elles-mêmes ne sont pas mises en cache par défaut).
- Les indicateurs des e-mails (lu/non lu, signalé).
- Les identifiants de messages (Message-ID, In-Reply-To, References) pour le regroupement en conversations.

### 2.3 Informations de contact

- Adresses e-mail et noms des personnes avec lesquelles vous correspondez.
- Fréquence d'utilisation et date de dernière interaction pour les suggestions de saisie automatique.

### 2.4 Structure des dossiers

- Liste des dossiers de messagerie, leurs noms et attributs d'utilisation spéciale (Boîte de réception, Envoyés, Brouillons, Corbeille, Courrier indésirable, Archives).
- Préférences par dossier (visibilité, paramètres de badges, mode de synchronisation).

### 2.5 Paramètres de l'application

- Langue, thème, préférences AI et autres options de configuration.
- Adresse e-mail personnalisée pour l'en-tête « De » (si configurée).
- Signatures d'e-mails.

### 2.6 Rapports d'erreurs

- Si les rapports d'erreurs Sentry sont actifs, nous collectons des **rapports de plantage anonymes** (traces de pile, version de l'application, environnement d'exploitation). **Aucune donnée personnelle** (contenu des e-mails, adresses, mots de passe ou jetons) n'est incluse dans les rapports d'erreurs (`sendDefaultPii: false`).

## 3. Comment nous stockons vos données

**Toutes les données utilisateur sont stockées localement sur votre ordinateur.** MailCopilot n'exploite aucun serveur cloud pour stocker vos e-mails, contacts ou paramètres.

| Données | Méthode de stockage |
|---|---|
| Mots de passe et clés API | Stockage sécurisé au niveau du système d'exploitation (keytar) : Windows DPAPI, macOS Keychain, Linux Secret Service |
| Cache des e-mails et contacts | Base de données SQLite locale (`~/.mailcopilot/cache.db`) |
| Paramètres et configuration des comptes | Fichier JSON local (electron-store) |
| Jetons OAuth | Stockage local chiffré via electron-store |

Vous pouvez supprimer toutes les données locales à tout moment en supprimant le répertoire `~/.mailcopilot/` (ou le répertoire de données configuré via `MAILCOPILOT_DATA_DIR`).

## 4. Comment nous utilisons vos données

Nous utilisons vos données **uniquement** pour fournir les fonctionnalités principales de l'Application :

- **Connexion à votre serveur de messagerie** via IMAP/SMTP pour envoyer, recevoir et gérer vos e-mails.
- **Mise en cache locale des e-mails** pour un accès plus rapide et une lecture hors ligne.
- **Saisie automatique** des adresses de destinataires basée sur votre historique de contacts.
- **Affichage de la structure des dossiers** et du nombre de messages non lus.
- **Fonctionnalités de l'assistant AI** (optionnelles) — voir Section 5.

Nous n'utilisons **pas** vos données pour :

- La publicité, le marketing ou le ciblage publicitaire.
- La vente ou le partage avec des courtiers en données.
- La création de profils utilisateurs pour des tiers.
- L'évaluation de crédit ou les analyses financières.
- La surveillance ou le suivi.
- L'entraînement de modèles AI/ML à usage général.

## 5. Assistant AI et fournisseurs AI tiers

MailCopilot propose un assistant AI optionnel qui peut vous aider à rédiger des réponses, résumer des e-mails et effectuer des actions sur votre messagerie.

### 5.1 Consentement explicite requis

L'assistant AI est **désactivé par défaut**. Avant que toute donnée de messagerie ne soit envoyée à un fournisseur AI, vous devez :

1. Activer l'assistant AI dans les Paramètres.
2. Consentir explicitement au partage de données de messagerie avec le fournisseur AI sélectionné (paramètre `aiPrivacyConsent`).

### 5.2 Quelles données sont envoyées aux fournisseurs AI

Lorsque vous utilisez l'assistant AI, les données suivantes peuvent être envoyées au fournisseur sélectionné :

- Le contenu du ou des e-mail(s) sur lesquels vous travaillez (objet, corps, expéditeur, destinataires).
- Vos instructions ou questions adressées à l'AI.

Les données sont envoyées **uniquement à votre demande explicite** — jamais automatiquement ni en arrière-plan.

### 5.3 Fournisseurs AI pris en charge

| Fournisseur | Service |
|---|---|
| Anthropic | Claude API (api.anthropic.com) |
| OpenAI | GPT API (api.openai.com) |
| Google | Gemini API |
| Claude Code | Outil CLI local (abonnement) |

Chaque fournisseur dispose de sa propre politique de confidentialité. Nous vous encourageons à consulter la politique de confidentialité du fournisseur que vous avez choisi :

- [Politique de confidentialité d'Anthropic](https://www.anthropic.com/privacy)
- [Politique de confidentialité d'OpenAI](https://openai.com/privacy)
- [Politique de confidentialité de Google](https://policies.google.com/privacy)

### 5.4 Contrôle du budget AI

Vous pouvez définir des limites de dépenses quotidiennes et mensuelles pour l'utilisation de l'AI dans les Paramètres.

## 6. Services API Google — Divulgation d'utilisation limitée {#google-limited-use}

L'utilisation et le transfert par MailCopilot à toute autre application des informations reçues des API Google seront conformes à la [Politique relative aux données utilisateur des services API Google](https://developers.google.com/terms/api-services-user-data-policy), y compris les exigences d'utilisation limitée.

Plus précisément :

1. **Nous n'utilisons les données utilisateur Google que pour fournir et améliorer les fonctionnalités visibles** et apparentes dans l'interface de l'Application (lecture, envoi, organisation des e-mails).
2. **Nous ne transférons pas les données utilisateur Google à des tiers**, sauf :
   - Lorsque cela est nécessaire pour fournir ou améliorer des fonctionnalités visibles par l'utilisateur (par exemple, envoi du contenu d'un e-mail à un fournisseur AI **uniquement avec votre consentement explicite**).
   - Lorsque cela est nécessaire pour se conformer à la législation applicable.
   - Dans le cadre d'une fusion, acquisition ou vente d'actifs, avec notification de l'utilisateur.
3. **Nous n'utilisons pas les données utilisateur Google à des fins publicitaires**, y compris le reciblage, la publicité personnalisée ou la publicité basée sur les centres d'intérêt.
4. **Nous n'autorisons pas la lecture des données utilisateur Google par des personnes**, sauf si :
   - Nous avons votre consentement explicite (par exemple, assistance technique à votre demande).
   - Cela est nécessaire à des fins de sécurité (par exemple, enquête sur un abus).
   - Cela est nécessaire pour se conformer à la législation applicable.
   - Les données sont agrégées et anonymisées pour les opérations internes.
5. **Nous n'utilisons pas les données utilisateur Google pour entraîner des modèles AI/ML à usage général.** Lorsque vous choisissez d'utiliser l'assistant AI, le contenu de vos e-mails est envoyé au fournisseur AI sélectionné uniquement pour générer une réponse à votre intention — et non pour l'entraînement de modèles.

## 7. Google OAuth 2.0

Lorsque vous connectez un compte Gmail, MailCopilot utilise Google OAuth 2.0 avec PKCE (RFC 7636) pour obtenir l'accès. Nous demandons les autorisations suivantes :

| Autorisation | Objectif |
|---|---|
| `https://mail.google.com/` | Accès IMAP/SMTP pour lire, envoyer et gérer vos e-mails |
| `openid` | Vérifier votre identité |
| `email` | Récupérer votre adresse e-mail |
| `profile` | Récupérer votre nom d'affichage |

Les jetons OAuth sont stockés localement sur votre appareil (voir Section 3). Nous ne transmettons jamais vos jetons à un serveur que nous exploitons.

## 8. Partage des données

Nous ne partageons **pas** vos données personnelles avec des tiers, sauf dans les circonstances limitées suivantes :

- **Fournisseurs AI** — uniquement avec votre consentement explicite, comme décrit dans la Section 5.
- **Sentry** — rapports de plantage anonymes uniquement, sans données personnelles (voir Section 2.6).
- **Votre fournisseur de messagerie** — via les protocoles standard IMAP/SMTP pour fournir les fonctionnalités de messagerie.

Nous ne vendons, ne louons et n'échangeons pas vos données personnelles.

## 9. Conservation et suppression des données

- **Cache des e-mails** : Stocké localement tant que vous utilisez l'Application. Vous pouvez vider le cache à tout moment depuis les Paramètres ou en supprimant le répertoire de données.
- **Identifiants** : Stockés dans le stockage sécurisé du système d'exploitation jusqu'à ce que vous supprimiez le compte de MailCopilot.
- **Paramètres** : Stockés localement jusqu'à ce que vous désinstalliez l'Application ou supprimiez les fichiers de configuration.

Étant donné que toutes les données sont stockées localement, la désinstallation de l'Application et la suppression du répertoire `~/.mailcopilot/` suppriment définitivement toutes les données.

## 10. Vos droits

Vous avez un contrôle total sur vos données :

- **Accès** : Toutes vos données sont stockées localement sur votre appareil — vous pouvez y accéder à tout moment.
- **Suppression** : Supprimez n'importe quel compte de MailCopilot pour effacer ses données en cache, ou supprimez l'intégralité du répertoire de données.
- **Révoquer l'accès OAuth** : Vous pouvez révoquer l'accès de MailCopilot à votre compte Google à tout moment via les [Autorisations du compte Google](https://myaccount.google.com/permissions).
- **Désactiver l'AI** : Vous pouvez désactiver l'assistant AI à tout moment dans les Paramètres.
- **Exportation** : Vos e-mails restent sur votre serveur de messagerie et sont accessibles depuis n'importe quel client de messagerie.

## 11. Sécurité

Nous mettons en œuvre les mesures de sécurité suivantes :

- **Stockage chiffré** : Les mots de passe et les clés API sont stockés dans le stockage sécurisé du système d'exploitation (keytar).
- **TLS 1.2+** : Toutes les connexions aux serveurs de messagerie sont chiffrées.
- **Vérification des certificats TLS** : Les certificats sont vérifiés par rapport au jeu de certificats Mozilla intégré et au magasin de certificats de votre système d'exploitation (avec repli sur le seul jeu intégré si le magasin système est indisponible) ; les connexions aux serveurs présentant des certificats non fiables sont bloquées jusqu'à ce que vous choisissiez explicitement de leur faire confiance.
- **Épinglage de certificats TLS** : Vérification optionnelle de l'empreinte SHA-256 des certificats pour prévenir les attaques de type MITM ; strictement appliquée à chaque connexion à un serveur épinglé.
- **Isolation par sandbox** : Le processus de rendu s'exécute dans un environnement isolé sans accès direct au système d'exploitation.
- **Validation IPC** : Toutes les communications inter-processus sont validées à l'aide de schémas Zod.
- **PKCE** : Le flux OAuth 2.0 utilise la méthode Proof Key for Code Exchange (RFC 7636).

## 12. Mises à jour automatiques

MailCopilot vérifie périodiquement la disponibilité de mises à jour. Les métadonnées de mise à jour (numéro de version, empreinte du fichier) sont téléchargées depuis notre dépôt de versions. **Aucune donnée personnelle n'est envoyée** lors de la vérification des mises à jour. Vous pouvez désactiver la vérification automatique des mises à jour dans les Paramètres.

## 13. Confidentialité des enfants

MailCopilot ne s'adresse pas aux enfants de moins de 16 ans. Nous ne collectons pas sciemment de données personnelles auprès d'enfants.

## 14. Modifications de cette politique

Nous pouvons mettre à jour cette Politique de confidentialité de temps à autre. Les modifications seront publiées sur cette page avec une date de « Dernière mise à jour » actualisée. Nous vous encourageons à consulter régulièrement cette politique.

## 15. Nous contacter

Si vous avez des questions concernant cette Politique de confidentialité, veuillez nous contacter :

- **E-mail** : privacy@mailcopilot.io
- **Site web** : [mailcopilot.io](https://mailcopilot.io)
