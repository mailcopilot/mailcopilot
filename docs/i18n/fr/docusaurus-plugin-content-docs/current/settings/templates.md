---
sidebar_position: 5
title: Modeles
---

# Modeles

L'onglet Modeles dans les Parametres vous permet de creer, modifier et supprimer des modeles de messages reutilisables.

## Creer un modele

1. Allez dans **Parametres > Modeles**.
2. Cliquez sur le bouton **Ajouter un modele**.
3. Remplissez les champs :
   - **Nom** -- un nom court pour identifier le modele (par exemple, "Suivi rapide").
   - **Objet** -- l'objet de l'e-mail, par exemple `Re: {subject}` (facultatif).
   - **Corps** -- le texte du message, par exemple `Bonjour {name}, merci de votre message…`
   - **Raccourci** -- un mot-cle court facultatif pour retrouver rapidement le modele.
4. Cliquez sur **Enregistrer**.

## Modifier un modele

Cliquez sur l'**icone de crayon** a cote d'un modele pour le modifier. Apres vos modifications, cliquez sur **Enregistrer** pour mettre a jour le modele.

## Supprimer un modele

Cliquez sur l'**icone de corbeille** a cote d'un modele pour le supprimer. Les modeles supprimes ne peuvent pas etre recuperes.

## Variables de modele

Vous pouvez utiliser des variables dans l'objet et le corps de votre modele. Ces variables sont automatiquement remplacees lorsque vous appliquez le modele dans la fenetre de redaction :

| Variable | Remplacee par |
|----------|---------------|
| `{name}` | Le nom du destinataire |
| `{email}` | L'adresse e-mail du destinataire |
| `{date}` | La date du jour |

### Exemple

**Corps du modele :**
```
Cher {name},

Merci pour votre e-mail. Je vais l'examiner et vous repondrai dans les meilleurs delais.

Cordialement
```

Lorsqu'il est applique a un message adresse a "Alice Smith", la variable `{name}` sera remplacee par "Alice Smith".

## Utiliser les modeles

Pour utiliser un modele lors de la redaction d'un message, consultez [Rediger des e-mails > Utiliser les modeles](../usage/composing-emails#utiliser-les-modeles).
