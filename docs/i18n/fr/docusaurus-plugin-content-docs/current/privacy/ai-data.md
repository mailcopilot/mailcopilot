---
sidebar_position: 1
title: AI Data & Audit Log
---

# Donnees IA et journal d'audit

Cette page explique quelles donnees l'assistant IA traite, comment MailCopilot enregistre ce traitement dans un journal d'audit local, et quels controles vous disposez sur ces donnees.

## Ce que l'assistant IA envoie aux fournisseurs

Lorsque vous utilisez l'assistant IA, MailCopilot transmet les elements suivants a votre fournisseur IA :

- Le contenu de l'e-mail ou du fil de conversation que vous consultez actuellement (objet, corps, expediteur, destinataires).
- Les pieces jointes que vous demandez explicitement a l'assistant de lire.
- Vos notes de memoire IA (si la fonctionnalite Memoire est configuree).
- Le texte de votre message a l'assistant dans le chat.

**Ce qui n'est jamais envoye :**

- Les e-mails ou dossiers que vous n'avez pas ouverts ni mentionnes dans la session en cours.
- Vos identifiants IMAP/SMTP ou la configuration du serveur.
- Les mots de passe de vos comptes de messagerie.
- Les donnees de comptes que vous n'avez pas explicitement utilises dans la requete IA en cours.

L'assistant IA est entierement optionnel. Si vous ne configurez pas de fournisseur, aucune donnee d'e-mail n'est transmise a un service externe.

Le chargement de la liste de modèles dans **Parametres > AI** envoie une requête au point de terminaison du fournisseur avec votre clé API enregistrée, avec les mêmes réglages de proxy et de confiance des certificats que le chat. La requête ne contient aucun contenu d'e-mail. MailCopilot lit la clé dans le magasin de clés du système, dans son processus principal.

La liste ci-dessus décrit le panneau IA. Les fonctions d'IA qui s'exécutent en dehors de lui ont leurs propres flux de données, décrits dans les sections suivantes.

Les liens vers des messages dans une réponse, et la liste **Sources** placée dessous, ne sont marqués comme confirmés que pour les messages réellement transmis à l'assistant dans la conversation ; un lien vers tout autre message est affiché en texte simple avec la mention **non confirmé**. Confirmé signifie seulement que le message a été transmis à l'assistant, pas que la réponse le reprend correctement. Voir [Sources et liens non confirmés](../ai-assistant#sources-et-liens-non-confirmés).

## Les quatre autorisations IA par boîte

Quatre fonctions d'IA exigent votre consentement séparé, accordé par boîte dans le tableau **Fonctions d'IA par boîte** de **Réglages > IA** : le [Résumé IA du fil](#resume-ia-du-fil), la [Réponse instantanée](#reponse-instantanee), la [Relecture IA](#ai-proofread) et la [Traduction IA](#traduction-du-message) (une seule autorisation partagée par la traduction du message et celle du brouillon). Les quatre sont désactivées par défaut. Chaque colonne du tableau est une finalité distincte : il y a une case par boîte et par fonction, une case dans l'en-tête d'une colonne agit sur cette seule fonction pour toutes les boîtes, et aucun contrôle n'active tout partout. Retirer un consentement coûte un clic, comme pour l'accorder, et prend effet dès la requête suivante. Chaque autorisation figure toujours dans le tableau, qu'elle soit activée ou non. Dans l'application, les contrôles d'AI Proofread et de la traduction du brouillon restent visibles lorsque leur consentement est désactivé -- grisés, avec une indication de l'endroit où les activer ; cliquer sur l'un d'eux n'envoie rien, et le processus principal refuse aussi la requête de son côté. Les contrôles du Résumé IA du fil, de la Réponse instantanée et de la traduction du message ne sont pas affichés tant que leur consentement est désactivé. Voir [Fonctions d'IA par boîte](../ai-assistant#fonctions-dia-par-boîte).

## Resume IA du fil

Le [Resume IA du fil](../ai-assistant#resume-ia-du-fil) est une fonctionnalite distincte et optionnelle qui genere un court resume d'un fil ouvert. Elle suit les memes protections que le reste de l'assistant IA :

- **Desactive par defaut, par compte.** Rien n'est envoye pour resume tant que vous n'avez pas active **Parametres > AI > Resume IA du fil** pour ce compte specifique.
- **Contenu encapsule.** Chaque message inclus dans la requete de resume est encapsule avec des marqueurs de limite `wrapUntrusted()` avant d'atteindre le fournisseur IA, la meme protection decrite plus bas dans [Protection contre l'injection de prompt](#protection-contre-linjection-de-prompt).
- **Generations auditees.** Chaque fois qu'un resume est reellement genere (et non servi depuis le cache), une entree est ecrite dans le [journal d'audit IA](#le-journal-daudit) avec l'objectif correspondant a l'action de resume. Rouvrir un fil deja resume lit le resultat mis en cache et ne cree pas de nouvelle entree d'audit ni ne recontacte le fournisseur IA.
- **Cache limite au compte.** Un resume genere est mis en cache et recherche par compte : la cle de cache combine votre compte avec l'identite du fil, si bien qu'un resume mis en cache pour un compte n'est jamais reutilise ni expose pour un autre compte.
- **Sensible au budget.** Si le budget IA quotidien a ete atteint, le resume est refuse proprement plutot que d'etre genere -- voir [Resume IA du fil](../ai-assistant#resume-ia-du-fil) pour ce que vous voyez dans ce cas.
- **Selection du fournisseur.** Le resume IA du fil utilise votre **fournisseur configure par cle API** (Anthropic, compatible OpenAI, ou Google Gemini). Il est concu pour privilegier un modele local, sur l'appareil, une fois la prise en charge des modeles locaux disponible, afin que le contenu du fil n'ait pas besoin de quitter votre machine -- cette prise en charge n'est pas encore disponible, donc aujourd'hui il utilise toujours votre fournisseur distant par cle API configure.
- **La telemetrie ne contient aucun contenu de message.** L'evenement d'usage pseudonyme enregistre pour chaque generation ne porte que l'identifiant du fournisseur, si le modele s'est execute localement, les nombres de jetons en entree/sortie, la latence et une classe d'erreur agregee -- jamais le sujet, le corps ou les adresses des participants du fil.

## Actions rapides de redaction

Les [actions rapides de rédaction](../ai-assistant#actions-rapides-de-redaction) réécrivent le texte que vous avez écrit vous-même (Améliorer / Raccourcir / Formel) dans la fenêtre de rédaction. Elles suivent les mêmes protections que le reste de l'assistant IA :

- **Seul votre propre texte quitte l'appareil, pour les brouillons rédigés par MailCopilot.** MailCopilot sépare votre propre texte du message cité, de l'en-tête de message transféré et de la signature avant d'envoyer quoi que ce soit, de sorte que seul votre propre texte parvient au fournisseur IA et que seul votre propre texte est jamais remplacé. Cette séparation est fiable pour les réponses, les transferts et les signatures produits par MailCopilot lui-même, ainsi que pour les conventions répandues des autres clients -- citations préfixées par `>` (y compris une citation imbriquée `>>` ou indentée par des espaces), bandeau de transfert en tirets, séparateur de signature `--` ou `-- `. **Un brouillon rédigé dans un autre logiciel de messagerie peut citer dans un style que MailCopilot ne reconnaît pas** -- un préfixe `|`, une simple indentation sans `>`, un bloc d'en-têtes `From:` / `Sent:` / `To:` / `Subject:` sans encadrement, du texte brut converti depuis une citation HTML, un séparateur de soulignés façon Outlook, ou « Begin forwarded message: » sans bandeau en tirets. Sur un tel brouillon, aucune frontière n'est trouvée, l'ensemble du corps est considéré comme votre propre texte, et la citation part avec lui. Votre relecture reste en travers de tout changement : la réécriture n'est jamais montrée autrement que comme une comparaison avant/après. Voir [Actions rapides de rédaction](../ai-assistant#actions-rapides-de-redaction) pour savoir comment cette séparation est détectée.
- **Aucune substitution silencieuse.** Une réécriture n'est affichée que comme une comparaison avant/après. Le corps de votre brouillon n'est modifié qu'après avoir explicitement cliqué sur **Remplacer** ou **Ajouter sous mon texte** -- cliquer sur **Annuler**, ou fermer la comparaison, laisse votre brouillon inchangé et rien d'autre n'est envoyé.
- **Aucune troncature silencieuse.** Si votre propre texte dépasse 8 000 caractères, MailCopilot refuse la réécriture au lieu d'en envoyer et d'en remplacer seulement une partie.
- **Protection contre les modifications concurrentes.** Si vous continuez à taper pendant qu'une réécriture est en cours, **Remplacer** est désactivé une fois la réécriture revenue, afin qu'elle ne puisse pas écraser le texte que vous avez tapé entre-temps ; **Ajouter sous mon texte** reste disponible.
- **Contenu encapsulé.** Votre propre texte est encapsulé avec des marqueurs de limite `wrapUntrusted()` avant d'atteindre le fournisseur IA, la même protection décrite dans [Protection contre l'injection de prompt](#protection-contre-linjection-de-prompt) ci-dessous -- cela protège également contre du texte que vous auriez collé depuis une source non fiable.
- **Generations auditees.** Chaque reecriture ecrit une entree dans le [journal d'audit IA](#le-journal-daudit) avec `goal` defini sur `quick_action` ; le preset precis utilise est enregistre dans le span de telemetrie, pas dans l'entree d'audit.
- **Selection du fournisseur.** Les actions rapides utilisent votre **fournisseur configure par cle API** (Anthropic, compatible OpenAI, ou Google Gemini). Il n'y a pas de reglage marche/arret dedie : les actions rapides sont disponibles des qu'un fournisseur adapte est configure et que le brouillon contient du texte a reecrire.
- **Sensible au budget.** Si le budget IA quotidien a ete atteint, la reecriture est refusee proprement -- voir [Actions rapides de redaction](../ai-assistant#actions-rapides-de-redaction) pour ce que vous voyez dans ce cas.
- **La telemetrie ne contient aucun contenu de message.** L'evenement d'usage pseudonyme enregistre pour chaque reecriture ne porte que le preset utilise, l'identifiant du fournisseur, si le modele s'est execute localement, les nombres de tokens, la latence et une classe d'erreur agregee -- jamais le texte du brouillon lui-meme.

## AI Proofread

[AI Proofread](../ai-assistant#ai-proofread) vérifie le texte que vous avez écrit vous-même et liste les corrections suggérées une par une, au lieu de réécrire tout le texte comme les presets ci-dessus. Elle suit les mêmes protections que le reste de l'assistant IA :

- **Désactivée par défaut, par compte.** Rien n'est envoyé pour vérification tant que vous n'avez pas activé **AI Proofread** pour cette boîte spécifique dans le tableau [Fonctions d'IA par boîte](../ai-assistant#fonctions-dia-par-boîte). **Contrairement à la plupart des autres autorisations IA, le bouton n'est pas masqué pour autant** -- il reste visible, dans un état visiblement verrouillé, avec une infobulle au survol indiquant où l'activer. Cliquer dessus alors qu'il est verrouillé n'envoie rien ; MailCopilot refuse également, indépendamment, sur la connexion au fournisseur IA si le réglage est désactivé, si bien que l'autorisation est vérifiée deux fois, pas seulement par la couleur grisée du bouton.
- **Seul votre propre texte quitte l'appareil, pour les brouillons rédigés par MailCopilot.** La même frontière de texte propre que celle des actions rapides de rédaction s'applique ici : le message cité, l'en-tête de transfert et la signature sont exclus de ce qui est vérifié. Voir [Actions rapides de rédaction](#actions-rapides-de-redaction) ci-dessus pour savoir comment cette frontière est détectée et où elle peut échouer.
- **Aucune substitution silencieuse.** Les suggestions ne sont montrées que sous forme de liste que vous acceptez individuellement ; le brouillon ne change qu'après avoir explicitement cliqué sur **Accept** (ou **Accept all**), puis sur **Apply selected**.
- **Contenu encapsulé.** Votre propre texte est encapsulé avec des marqueurs de limite `wrapUntrusted()` avant d'atteindre le fournisseur IA, la même protection décrite dans [Protection contre l'injection de prompt](#protection-contre-linjection-de-prompt) ci-dessous.
- **Générations auditées.** Chaque vérification écrit une entrée dans le [journal d'audit IA](#le-journal-daudit).
- **Sélection du fournisseur.** AI Proofread utilise votre **fournisseur configuré par clé API** (Anthropic, compatible OpenAI, ou Google Gemini).
- **Sensible au budget.** Si le budget IA quotidien a été atteint, la vérification est refusée proprement -- voir [AI Proofread](../ai-assistant#ai-proofread) pour ce que vous voyez dans ce cas.
- **La télémétrie ne contient aucun contenu de message.** L'événement d'usage pseudonyme enregistré pour chaque vérification ne porte que l'identifiant du fournisseur, si le modèle s'est exécuté localement, les nombres de tokens, la latence et une classe d'erreur agrégée -- jamais le texte du brouillon ni les suggestions elles-mêmes.

## Reponse instantanee

La [reponse instantanee](../ai-assistant#reponse-instantanee) est une fonctionnalite distincte et optionnelle qui redige deux ou trois options de reponse courtes pour le message que vous avez ouvert. Elle suit les memes protections que le reste de l'assistant IA, plus une protection supplementaire specifique a la maniere dont elle recupere le corps de l'e-mail :

- **Desactivee par defaut, par compte.** Rien n'est envoye pour redaction tant que vous n'avez pas active **Parametres > AI > Reponse instantanee** pour ce compte specifique. Lorsqu'elle est desactivee, le bouton Reponse instantanee ne s'affiche pas et aucune requete n'est envoyee.
- **Corps uniquement depuis le cache.** La reponse instantanee resout le corps de l'e-mail source depuis le cache local de MailCopilot par compte, dossier et UID du message -- elle ne fait jamais confiance a un texte de corps qui pourrait etre fourni par la fenetre elle-meme, ce qui ecarte une classe d'attaques par empoisonnement de cache ou une vue manipulee pourrait sinon influencer ce qui est envoye au fournisseur IA.
- **Contenu encapsule.** Le corps de l'e-mail source est encapsule avec des marqueurs de limite `wrapUntrusted()` avant d'atteindre le fournisseur IA, la meme protection decrite dans [Protection contre l'injection de prompt](#protection-contre-linjection-de-prompt) ci-dessous.
- **Jamais d'envoi automatique.** Choisir une option redigee ne fait que preremplir une **nouvelle** fenetre de redaction. Rien n'est envoye tant que vous n'avez pas explicitement relu le brouillon et clique vous-meme sur Envoyer.
- **Generations auditees.** Chaque fois que des brouillons sont reellement generes, une entree est ecrite dans le [journal d'audit IA](#le-journal-daudit) avec l'objectif correspondant a l'action de reponse instantanee.
- **Selection du fournisseur.** La reponse instantanee utilise votre **fournisseur configure par cle API** (Anthropic, compatible OpenAI, ou Google Gemini).
- **Sensible au budget.** Si le budget IA quotidien a ete atteint, la redaction est refusee proprement -- voir [Reponse instantanee](../ai-assistant#reponse-instantanee) pour ce que vous voyez dans ce cas.
- **La telemetrie ne contient aucun contenu de message.** L'evenement d'usage pseudonyme enregistre pour chaque generation ne porte que l'identifiant du fournisseur, si le modele s'est execute localement, les nombres de tokens, la latence et une classe d'erreur agregee -- jamais le sujet, le corps de l'e-mail, les adresses de l'expediteur ou du destinataire, ou le texte de la reponse redigee.

## Traduction du message

La [traduction du message](../ai-assistant#traduction-du-message) est une fonctionnalite distincte et optionnelle qui traduit le message que vous lisez dans la langue de votre choix. Elle suit les memes protections que le reste de l'assistant IA :

- **Desactivee par defaut, par compte.** Rien n'est envoye pour traduction tant que vous n'avez pas active **Parametres > AI > Traduction IA** pour ce compte specifique. Lorsqu'elle est desactivee, le bouton Traduire ne s'affiche pas et aucune requete n'est envoyee.
- **Uniquement a la demande.** Un fournisseur n'est appele que lorsque vous cliquez sur **Traduire** -- il n'y a pas de traduction automatique a l'ouverture d'un message.
- **Texte brut.** Le fournisseur ne voit et ne renvoie que du texte brut, jamais de balisage HTML, même pour un message HTML. La mise en forme et les images ne sont pas traduites.
- **Les messages longs sont envoyés en plusieurs requêtes.** Un message de plus de 3000 caractères est découpé en morceaux de 3000 caractères au plus (aux sauts de paragraphe, puis aux fins de phrase, puis aux espaces), et chaque morceau est envoyé dans sa propre requête, trois à la fois. Chaque requête est facturée à votre fournisseur. Si un morceau échoue ou revient tronqué, rien n'est affiché et rien n'est mis en cache. Un message de plus de 60 000 caractères (jusqu’à environ 40 requêtes dans le pire cas) est refusé. La traduction du brouillon n'est pas découpée et garde sa limite de 3000 caractères. Les morceaux déjà traduits sont gardés dans la mémoire de l’application pendant une heure au plus : après un échec, une nouvelle tentative n’envoie que les morceaux manquants. Quitter le message n’arrête pas une traduction commencée : elle va jusqu’au bout, est enregistrée dans le cache et se trouve prête à votre retour. Désactiver la traduction pour la boîte l’arrête. Les morceaux sont traduits sans le texte voisin ; les termes et les formules d’adresse peuvent donc différer d’une partie à l’autre d’un long message. Un morceau sans lettre (chiffres, lignes de séparation) reste tel quel. Les morceaux conservés n’existent que dans la mémoire de l’application et sont supprimés avec le compte.
- **Texte uniquement depuis le cache.** Le texte du message provient du cache local de MailCopilot par compte, dossier et UID du message -- jamais de ce qui se trouve affiche dans la fenetre au moment donne.
- **Contenu encapsule.** Le texte du message est encapsule avec des marqueurs de limite `wrapUntrusted()` avant d'atteindre le fournisseur IA, la meme protection decrite dans [Protection contre l'injection de prompt](#protection-contre-linjection-de-prompt) ci-dessous.
- **Mis en cache, non renvoye.** Une traduction deja produite pour un message, une langue cible et une version du contrat de traduction (fournisseur, modele et forme du prompt) est servie depuis un cache local lors des ouvertures suivantes -- aucune requete n'atteint le fournisseur une seconde fois pour le meme message, la meme langue et le meme contrat. Les entrees du cache n'ont pas de duree d'expiration propre : un changement ulterieur de la maniere dont MailCopilot produit les traductions est range sous une nouvelle cle plutot que de faire passer le resultat d'un ancien contrat pour actuel. Elles sont plafonnees a 200 par compte, et sont supprimees avec le compte. La traduction d'un message long est mise en cache en entier, sous le message entier.
- **Requêtes auditées.** Chaque requête envoyée au fournisseur (et non servie depuis le cache) écrit une entrée dans le [journal d'audit IA](#le-journal-daudit) ; un message long envoyé en plusieurs requêtes écrit donc plusieurs entrées. Un résultat en cache n'écrit aucune entrée.
- **Selection du fournisseur.** La traduction du message utilise votre **fournisseur configure par cle API** (Anthropic, compatible OpenAI, ou Google Gemini).
- **Sensible au budget.** Si le budget IA quotidien a ete atteint, la traduction est refusee proprement -- voir [Traduction du message](../ai-assistant#traduction-du-message) pour ce que vous voyez dans ce cas.
- **La telemetrie ne contient aucun contenu de message.** L'evenement d'usage pseudonyme enregistre pour chaque appel au fournisseur ne porte que l'identifiant du fournisseur, si le modele s'est execute localement, les nombres de tokens, la latence, une classe d'erreur agregee, si une langue source a pu etre etiquetee (jamais laquelle), le code de la langue cible choisie, et si le resultat provient du cache -- jamais le texte du message, la traduction, le sujet, les adresses, le nom du dossier, ou la langue source elle-meme.

## Traduction du brouillon

[La traduction du brouillon](../ai-assistant#traduction-du-brouillon) est le pendant, côté rédaction, de la traduction du message : elle traduit le texte que vous avez écrit vous-même dans une langue de votre choix, depuis la fenêtre de rédaction. Elle partage le même réglage d'activation que la traduction du message et suit les mêmes protections, plus celles, propres à la rédaction, déjà utilisées par les actions rapides de rédaction :

- **Désactivée par défaut, par compte -- pas de réglage séparé.** La traduction du brouillon est contrôlée par la même autorisation **AI Translate** que la traduction du message, activée par boîte dans le tableau [Fonctions d'IA par boîte](../ai-assistant#fonctions-dia-par-boîte) ; il n'y a rien de plus à activer. **Contrairement à la plupart des autres autorisations IA, la liste et le bouton ne sont pas masqués pour autant** -- ils restent visibles, le bouton dans un état visiblement verrouillé, avec une infobulle au survol indiquant où l'activer. Cliquer sur le bouton alors qu'il est verrouillé n'envoie rien ; MailCopilot refuse également, indépendamment, sur la connexion au fournisseur IA si le réglage est désactivé.
- **Uniquement à la demande.** Un fournisseur n'est appelé que lorsque vous cliquez sur **Traduire**. Ouvrir la fenêtre de rédaction, voir apparaître une langue cible suggérée dans la liste, ou changer la valeur de la liste n'appelle jamais un fournisseur par lui-même.
- **Seul votre propre texte quitte l'appareil, lorsqu'une frontière est trouvée.** La traduction du brouillon réutilise la même frontière de texte propre que les actions rapides de rédaction : le message cité, l'en-tête de transfert et la signature sont exclus de ce qui est envoyé et de ce qui est jamais remplacé, pour les réponses, les transferts et les signatures produits par MailCopilot lui-même, ainsi que pour les conventions répandues des autres clients. Sur un brouillon qui cite dans un style que MailCopilot ne reconnaît pas, aucune frontière n'est trouvée et l'ensemble du corps -- citation comprise -- est envoyé au fournisseur IA et peut être remplacé. Voir [Actions rapides de rédaction](#actions-rapides-de-redaction) ci-dessus pour savoir comment cette frontière est détectée et la liste complète des styles de citation qu'elle manque.
- **Pas de substitution silencieuse.** La traduction n'est jamais montrée autrement que comme une comparaison avant/après, dans le même panneau de relecture que les actions rapides de rédaction. Le corps de votre brouillon ne change qu'après que vous ayez explicitement cliqué sur **Remplacer** ou **Ajouter sous mon texte**.
- **Pas de cache.** Contrairement à la traduction du message, un brouillon traduit n'est pas conservé : un brouillon est censé continuer de changer entre les requêtes, si bien qu'un cache durable ne ferait que garder de l'écriture non envoyée, sans jamais être réutilisé.
- **Contenu encapsulé.** Votre propre texte est encapsulé avec des marqueurs de limite `wrapUntrusted()` avant d'atteindre le fournisseur IA, la même protection décrite dans [Protection contre l'injection de prompt](#protection-contre-linjection-de-prompt) ci-dessous.
- **Générations auditées.** Chaque traduction écrit une entrée dans le [journal d'audit IA](#le-journal-daudit).
- **Choix du fournisseur.** La traduction du brouillon utilise votre **fournisseur configuré par clé API** (Anthropic, compatible OpenAI, ou Google Gemini).
- **Sensible au budget.** Si le budget IA quotidien a été atteint, la traduction est refusée proprement -- voir [Traduction du brouillon](../ai-assistant#traduction-du-brouillon) pour ce que vous voyez dans ce cas.
- **La langue suggérée n'est qu'une suggestion.** Lorsque vous répondez, MailCopilot peut pré-remplir la liste de langue cible à partir de la langue du message auquel vous répondez, détectée localement sur votre appareil. Elle ne démarre jamais de traduction par elle-même, et elle n'est jamais rapportée : aucun champ de télémétrie n'enregistre quelle langue a été suggérée, ni si la langue que vous avez choisie provient de cette suggestion.
- **La télémétrie ne contient aucun contenu de message.** L'événement d'usage pseudonyme enregistré pour chaque traduction ne porte que l'identifiant du fournisseur, si le modèle a tourné localement, le nombre de tokens, la latence, une classe d'erreur regroupée, et le code de la langue cible que vous avez choisie -- jamais le texte du brouillon, la traduction, les destinataires, l'objet, ou la langue suggérée.

## Politique d'egress IA

Le parametre **Accès web de l'IA** de MailCopilot (**Parametres → AI**) controle deux types differents d'acces sortant que l'assistant peut effectuer : les appels a vos propres serveurs MCP externes connectes, et -- uniquement lorsque vous utilisez le fournisseur **Anthropic** -- les outils integres de recherche web et de recuperation de pages de l'assistant. Cela empeche un e-mail malveillant d'exfiltrer silencieusement vos donnees via une attaque par injection de prompt.

### Fonctionnement (appels d'outils MCP externes)

Lorsque l'IA souhaite appeler un outil sur l'un de vos serveurs MCP externes connectes, MailCopilot met la reponse en pause et affiche une fenetre de confirmation integree dans le panneau IA avec le message **«L'IA veut accéder à Internet»**. La fenetre affiche :

- Le type d'action et, si disponible, le nom de l'outil externe
- Les boutons **Autoriser** et **Refuser**

Cliquez sur **Autoriser** pour permettre a l'IA de continuer, ou sur **Refuser** pour refuser. Votre decision s'applique a l'integralite du tour de reponse en cours -- si l'IA effectue plusieurs appels d'outils externes dans une meme reponse, vous n'etes consulte qu'une seule fois. Cliquer sur **Autoriser** accorde l'acces a tous les appels restants de ce tour.

Si vous ne repondez pas dans les 30 secondes, MailCopilot refuse automatiquement l'appel de l'outil. Cette fenetre de confirmation s'applique quel que soit le fournisseur d'IA que vous utilisez, chaque fois que l'assistant contacte un serveur MCP externe.

### Recherche web integree d'Anthropic

Lorsque vous utilisez le fournisseur **Anthropic** (Claude), l'assistant dispose egalement d'une capacite integree de recherche web et de recuperation de pages qui s'execute sur les propres serveurs d'Anthropic dans le cadre de la generation de la reponse. Comme cela se produit en dehors de MailCopilot, il n'y a aucune possibilite de mettre la reponse en pause et d'afficher une fenetre de confirmation pour ces appels. A la place, le fait que ces outils soient proposes ou non a l'assistant est decide au prealable par votre parametre **Accès web de l'IA**, avant l'envoi de votre message :

- **Toujours autoriser** -- l'assistant peut rechercher sur le web et recuperer des pages librement.
- **Refuser par défaut** ou **Demander à chaque tour** -- les outils integres de recherche web et de recuperation de pages ne sont pas du tout proposes a l'assistant, qui ne peut donc pas rechercher sur le web de lui-meme. Passez a **Toujours autoriser** si vous le souhaitez.

Cette capacite est specifique au fournisseur Anthropic. Avec les fournisseurs compatibles OpenAI et Google Gemini, l'assistant n'accede a internet que via vos serveurs MCP externes connectes, comme decrit ci-dessus.

### Parametres de politique

Vous pouvez ajuster la politique dans **Parametres → AI**, sous **Accès web de l'IA** :

- **Refuser par défaut (recommandé)** -- les appels d'outils MCP externes sont interceptes et exigent votre confirmation a chaque fois ; la recherche web / recuperation de pages integree d'Anthropic n'est pas proposee a l'assistant.
- **Demander à chaque tour** -- meme comportement que **Refuser par défaut**.
- **Toujours autoriser** -- les appels d'outils MCP externes s'executent sans confirmation, et la recherche web / recuperation de pages integree d'Anthropic est disponible. Avertissement : l'IA peut envoyer le contenu des e-mails a des services externes.

### Journal d'audit

Chaque appel d'outil MCP externe intercepte est enregistre dans la colonne **Bloque** de la ligne d'audit de cette requete -- les appels refuses augmentent le compteur, tandis qu'une requete entierement approuvee garde **Bloque** a 0. Chaque interception est egalement comptee dans l'evenement de telemetrie `ai.egress.intercepted` avec des tags indiquant le nom de l'outil, le resultat (autorise ou refuse) et si le consentement pour ce tour etait deja en vigueur. Pour les details de requete ou d'URL, le journal ne stocke qu'un hachage SHA-256 tronque aux 16 premiers caracteres hexadecimaux ; les requetes et URL brutes ne sont jamais ecrites sur le disque. Les appels integres de recherche web et de recuperation de pages d'Anthropic ne sont pas interceptes : ils n'augmentent jamais **Bloque** et n'emettent jamais `ai.egress.intercepted`. Chaque appel de ce type est tout de meme ecrit dans le journal d'audit comme une entree distincte, avec le meme hachage SHA-256 tronque de la requete ou de l'URL que celui decrit ci-dessus -- jamais le texte brut. Cette entree prouve que l'appel sortant a eu lieu et permet de remarquer les repetitions ; elle ne dit pas ce qui a ete envoye. La requete brute n'est pas conservee volontairement : le risque ici est une fuite via la requete elle-meme, et l'ecrire telle quelle creerait simplement une seconde copie de cette fuite.

## Le journal d'audit

MailCopilot maintient un journal d'audit local de chaque action IA. Le journal est stocke dans votre base de donnees locale sur votre appareil et n'est jamais transmis a MailCopilot ni a des tiers.

### Ce que chaque entree enregistre

| Champ | Description |
|-------|-------------|
| **Horodatage** | Date et heure exactes de l'action. |
| **Fournisseur** | Une etiquette d'attribution pour l'entree, generalement votre fournisseur IA configure (par ex., Anthropic, OpenAI, Google). Elle peut aussi designer un client externe connecte via le [Serveur MCP](../ai-assistant#serveur-mcp) (`mcp-export`), et les entrees plus anciennes peuvent conserver un identifiant de fournisseur que cette version de MailCopilot ne propose plus comme methode de connexion. |
| **Modele** | La version specifique du modele qui a traite la requete. |
| **Objectif** | Une breve description de ce qui a ete demande a l'assistant. |
| **Outil** | L'outil MCP appele, le cas echeant (par ex., `send_email`, `mail_action`, `move_email`). |
| **Tokens entree / sortie** | Nombre de tokens d'entree et de sortie pour cette action. Les valeurs sont enregistrees si le fournisseur les expose via le SDK ; sinon les colonnes affichent **n/d**. |
| **Cout (USD)** | Cout estime selon la tarification publiee du fournisseur, ou **n/d** lorsque cette entree n'a aucun cout par requete nomme -- soit parce que le fournisseur n'en a pas communique, soit parce que l'entree elle-meme ne porte jamais de cout par appel (par exemple un appel d'outil internet intercepte, ou une action effectuee via une session MCP exportee). **n/d** ne signifie pas ici que la requete a echappe aux limites de depenses : le resume IA du fil, les actions rapides de redaction et la reponse instantanee comptent tous dans le Budget quotidien / mensuel, quoi que montre cette colonne. Le cout est le signal principal pour le suivi des depenses. |
| **Encapsule** | Nombre d'invocations du marqueur `wrapUntrusted()`. Chaque invocation signifie qu'un bloc de contenu d'e-mail a ete isole avant d'etre transmis a l'IA pour prevenir l'injection de prompt. |
| **Bloque** | Nombre de tentatives d'egress sortant bloquees par la politique de securite pendant cette action. |
| **Resultat** | Resultat de l'action : **OK** (termine avec succes), **Erreur** (echec) ou **Annule** (interrompu par vous ou le systeme). |

### Immuabilite et conservation

Les nouvelles entrees sont toujours ajoutees. Toutes les colonnes a l'exception de `deleted_at` sont immuables apres l'insertion — les enregistrements existants ne sont jamais modifies une fois ecrits. L'application ne peut donc pas modifier les entrees passees (seulement les supprimer temporairement ou les laisser supprimer par la limite de rotation). La suppression temporaire d'une entree (voir ci-dessous) definit l'horodatage `deleted_at` et masque l'entree de la vue, mais toutes les autres colonnes restent inchangees.

Le journal est limite a **10 000 entrees**. Lorsqu'une nouvelle entree est ajoutee et que le total depasse cette limite, les lignes les plus anciennes sont automatiquement supprimees pour maintenir le journal dans cette limite. Les entrees anterieures aux 10 000 plus recentes sont definitivement supprimees de la base de donnees locale. Si vous avez besoin d'un enregistrement permanent, exportez regulierement le journal via les boutons **Exporter JSON** ou **Exporter CSV** avant que les entrees ne soient eliminees.

### Acceder au journal d'audit

Ouvrez **Parametres → AI** et developpez la section **Confidentialite et audit**. Le journal est pagine et trie du plus recent au plus ancien.

### Exporter

Cliquez sur **Exporter JSON** ou **Exporter CSV** pour telecharger le journal d'audit actuellement visible (lignes actives dans la limite de rotation de 10 000 entrees ; les entrees supprimees temporairement et celles eliminees par rotation sont exclues). L'export inclut tous les champs listes ci-dessus pour chaque entree incluse. L'export CSV utilise le format RFC 4180 avec des separateurs de lignes CRLF et un echappement correct (les champs contenant des virgules, des guillemets ou des sauts de ligne sont echappes). Le fichier CSV est compatible avec Excel, Numbers et LibreOffice. Vous pouvez l'utiliser pour :

- Verifier l'activite IA a tout moment.
- Repondre aux demandes d'acces aux donnees personnelles en vertu du RGPD ou de reglementations similaires.
- Conserver une copie hors ligne pour vos propres archives.

### Supprimer des entrees

**Suppression temporaire par ligne** -- cliquez sur l'icone de suppression d'une entree du journal pour la masquer de la vue. L'horodatage `deleted_at` de l'entree est defini et elle disparait de la liste et des agregats, mais les donnees sous-jacentes sont conservees pour preserver l'integrite de l'audit.

**Tout effacer** -- marque toutes les entrees d'audit comme supprimees temporairement (definit `deleted_at` pour chaque enregistrement). Avant d'executer cette action, MailCopilot affiche une boite de dialogue de confirmation native du systeme d'exploitation avec le titre "Clear AI audit log" et les boutons **Cancel** et **Delete All**. Les entrees sont masquees de la liste, des agregats et des exports. Notez que la limite automatique de 10 000 lignes (voir ci-dessus) supprime physiquement les lignes les plus anciennes au fil du temps ; les entrees supprimees temporairement sont comptabilisees dans cette limite et seront finalement purgees definitivement par la rotation.

## Agregats de tokens et de couts

Le haut du panneau Confidentialite et audit affiche les totaux de tokens et de couts par fournisseur. Selectionnez une periode -- **Aujourd'hui**, **7 derniers jours** ou **30 derniers jours** -- pour filtrer les agregats. Ce sont des fenetres glissantes, pas une semaine ou un mois calendaire. Ces totaux sont calcules a partir du journal d'audit local et ne sont jamais envoyes a un serveur.

## Protection contre l'injection de prompt

Chaque bloc de contenu d'e-mail transmis a l'IA est encapsule avec des marqueurs de limite `wrapUntrusted()`. Ces marqueurs instruisent l'IA de traiter le contenu inclus comme des donnees utilisateur non fiables -- et non comme des instructions -- afin qu'un e-mail malveillant ne puisse pas detourner le comportement de l'assistant. La colonne **Encapsule** dans le journal d'audit vous permet de voir exactement combien de fois cette protection a ete appliquee dans chaque requete. Le compteur est precis : si le meme e-mail est recupere plusieurs fois au cours d'une meme requete (par exemple, lorsque l'IA y revient lors d'une tache en plusieurs etapes), chaque recuperation est comptee separement, de sorte que le total reflète precisement le nombre reel de lectures d'e-mails.

## Voir aussi

- [Assistant IA](../ai-assistant) -- guide complet pour utiliser l'assistant IA.
- [Telemetrie](./telemetry) -- donnees de diagnostic pseudonymes collectees par MailCopilot (separees du journal d'audit IA).
