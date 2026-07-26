---
sidebar_position: 3
title: Signatures
---

# Signatures

## Configuration

Ouvrez **Parametres > Signature** pour creer ou modifier votre signature. L'onglet « Signatures » modifie la signature de l'**identite par defaut** du compte selectionne. Si vous avez plusieurs comptes, choisissez le compte dans le menu deroulant en haut ; si le compte possede d'autres identites (adresses « From » alternatives), chacune a sa propre signature -- elles se modifient sous **Parametres > Identities**.

## Redaction de la signature

Saisissez le texte de votre signature dans la zone de texte. Un format courant inclut :

```
--
Jean Dupont
Ingenieur logiciel
ACME SARL
jean.dupont@example.com
```

Le separateur `--` est le delimiteur de signature standard reconnu par la plupart des clients de messagerie.

## Fonctionnement

- La signature est **automatiquement ajoutee** aux nouveaux messages.
- Elle n'est **pas ajoutee** aux reponses et transferts.
- L'identite par defaut de chaque compte peut avoir sa propre signature ; les identites supplementaires ont chacune leur signature, modifiable sous **Parametres > Identities**.

## Suppression

Videz le champ de texte dans **Parametres > Signature** et sauvegardez.

## Signatures et identites

Les signatures vivent desormais par identite, et non plus par compte. L'onglet **Signatures** sur cette page modifie la signature de l'identite par defaut du compte. Si vous avez des identites supplementaires (d'autres adresses « From » sur le meme compte, par exemple un alias personnel ou un alias d'equipe), chacune possede sa propre signature -- modifiez-les dans **Parametres > Identities**. Voir [Identites](./identities) pour le fonctionnement des identites et la facon dont la fenetre de redaction en choisit une lors d'une reponse ou d'un nouveau message.

