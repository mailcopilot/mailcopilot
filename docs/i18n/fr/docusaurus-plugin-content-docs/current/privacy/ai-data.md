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

Les [actions rapides de rédaction](../ai-assistant#actions-rapides-de-redaction) réécrivent le texte que vous avez écrit vous-même (Améliorer / Raccourcir / Formel / Corriger la grammaire) dans la fenêtre de rédaction. Elles suivent les mêmes protections que le reste de l'assistant IA :

- **Seul votre propre texte quitte l'appareil, pour les brouillons rédigés par MailCopilot.** MailCopilot sépare votre propre texte du message cité, de l'en-tête de message transféré et de la signature avant d'envoyer quoi que ce soit, de sorte que seul votre propre texte parvient au fournisseur IA et que seul votre propre texte est jamais remplacé. Cette séparation est fiable pour les réponses, les transferts et les signatures produits par MailCopilot lui-même, ainsi que pour les conventions répandues des autres clients -- citations préfixées par `>` (y compris une citation imbriquée `>>` ou indentée par des espaces), bandeau de transfert en tirets, séparateur de signature `--` ou `-- `. **Un brouillon rédigé dans un autre logiciel de messagerie peut citer dans un style que MailCopilot ne reconnaît pas** -- un préfixe `|`, une simple indentation sans `>`, un bloc d'en-têtes `From:` / `Sent:` / `To:` / `Subject:` sans encadrement, du texte brut converti depuis une citation HTML, un séparateur de soulignés façon Outlook, ou « Begin forwarded message: » sans bandeau en tirets. Sur un tel brouillon, aucune frontière n'est trouvée, l'ensemble du corps est considéré comme votre propre texte, et la citation part avec lui. Votre relecture reste en travers de tout changement : la réécriture n'est jamais montrée autrement que comme une comparaison avant/après. Voir [Actions rapides de rédaction](../ai-assistant#actions-rapides-de-redaction) pour savoir comment cette séparation est détectée.
- **Aucune substitution silencieuse.** Une réécriture n'est affichée que comme une comparaison avant/après. Le corps de votre brouillon n'est modifié qu'après avoir explicitement cliqué sur **Remplacer** ou **Insérer au curseur** -- cliquer sur **Annuler**, ou fermer la comparaison, laisse votre brouillon inchangé et rien d'autre n'est envoyé.
- **Aucune troncature silencieuse.** Si votre propre texte dépasse 8 000 caractères, MailCopilot refuse la réécriture au lieu d'en envoyer et d'en remplacer seulement une partie.
- **Protection contre les modifications concurrentes.** Si vous continuez à taper pendant qu'une réécriture est en cours, **Remplacer** est désactivé une fois la réécriture revenue, afin qu'elle ne puisse pas écraser le texte que vous avez tapé entre-temps ; **Insérer au curseur** reste disponible.
- **Contenu encapsulé.** Votre propre texte est encapsulé avec des marqueurs de limite `wrapUntrusted()` avant d'atteindre le fournisseur IA, la même protection décrite dans [Protection contre l'injection de prompt](#protection-contre-linjection-de-prompt) ci-dessous -- cela protège également contre du texte que vous auriez collé depuis une source non fiable.
- **Generations auditees.** Chaque reecriture ecrit une entree dans le [journal d'audit IA](#le-journal-daudit) avec `goal` defini sur `quick_action` ; le preset precis utilise (Ameliorer / Raccourcir / Formel / Corriger la grammaire) est enregistre dans le span de telemetrie, pas dans l'entree d'audit.
- **Selection du fournisseur.** Les actions rapides utilisent votre **fournisseur configure par cle API** (Anthropic, compatible OpenAI, ou Google Gemini). Il n'y a pas de reglage marche/arret dedie : les actions rapides sont disponibles des qu'un fournisseur adapte est configure et que le brouillon contient du texte a reecrire.
- **Sensible au budget.** Si le budget IA quotidien a ete atteint, la reecriture est refusee proprement -- voir [Actions rapides de redaction](../ai-assistant#actions-rapides-de-redaction) pour ce que vous voyez dans ce cas.
- **La telemetrie ne contient aucun contenu de message.** L'evenement d'usage pseudonyme enregistre pour chaque reecriture ne porte que le preset utilise, l'identifiant du fournisseur, si le modele s'est execute localement, les nombres de tokens, la latence et une classe d'erreur agregee -- jamais le texte du brouillon lui-meme.

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
- **Projection en texte brut.** Le fournisseur ne voit et ne renvoie jamais que du texte brut : la traduction est generee a partir de la version texte du message, jamais du balisage HTML, meme pour un message HTML.
- **Texte uniquement depuis le cache.** Le texte du message provient du cache local de MailCopilot par compte, dossier et UID du message -- jamais de ce qui se trouve affiche dans la fenetre au moment donne.
- **Contenu encapsule.** Le texte du message est encapsule avec des marqueurs de limite `wrapUntrusted()` avant d'atteindre le fournisseur IA, la meme protection decrite dans [Protection contre l'injection de prompt](#protection-contre-linjection-de-prompt) ci-dessous.
- **Mis en cache, non renvoye.** Une traduction deja produite pour un message, une langue cible et une version du contrat de traduction (fournisseur, modele et forme du prompt) est servie depuis un cache local lors des ouvertures suivantes -- aucune requete n'atteint le fournisseur une seconde fois pour le meme message, la meme langue et le meme contrat. Les entrees du cache n'ont pas de duree d'expiration propre : un changement ulterieur de la maniere dont MailCopilot produit les traductions est range sous une nouvelle cle plutot que de faire passer le resultat d'un ancien contrat pour actuel. Elles sont plafonnees a 500 par compte, et sont supprimees avec le compte.
- **Generations auditees.** Chaque fois qu'une traduction est reellement generee (et non servie depuis le cache), une entree est ecrite dans le [journal d'audit IA](#le-journal-daudit). Un resultat en cache n'ecrit aucune entree.
- **Selection du fournisseur.** La traduction du message utilise votre **fournisseur configure par cle API** (Anthropic, compatible OpenAI, ou Google Gemini).
- **Sensible au budget.** Si le budget IA quotidien a ete atteint, la traduction est refusee proprement -- voir [Traduction du message](../ai-assistant#traduction-du-message) pour ce que vous voyez dans ce cas.
- **La telemetrie ne contient aucun contenu de message.** L'evenement d'usage pseudonyme enregistre pour chaque appel au fournisseur ne porte que l'identifiant du fournisseur, si le modele s'est execute localement, les nombres de tokens, la latence, une classe d'erreur agregee, si une langue source a pu etre etiquetee (jamais laquelle), le code de la langue cible choisie, et si le resultat provient du cache -- jamais le texte du message, la traduction, le sujet, les adresses, le nom du dossier, ou la langue source elle-meme.

## Traduction du brouillon

[La traduction du brouillon](../ai-assistant#traduction-du-brouillon) est le pendant, côté rédaction, de la traduction du message : elle traduit le texte que vous avez écrit vous-même dans une langue de votre choix, depuis la fenêtre de rédaction. Elle partage le même réglage d'activation que la traduction du message et suit les mêmes protections, plus celles, propres à la rédaction, déjà utilisées par les actions rapides de rédaction :

- **Désactivée par défaut, par compte -- pas de réglage séparé.** La traduction du brouillon est contrôlée par le même interrupteur **Parametres > AI > Traduction IA** que la traduction du message ; il n'y a rien de plus à activer.
- **Uniquement à la demande.** Un fournisseur n'est appelé que lorsque vous cliquez sur **Traduire**. Ouvrir la fenêtre de rédaction, voir apparaître une langue cible suggérée dans la liste, ou changer la valeur de la liste n'appelle jamais un fournisseur par lui-même.
- **Seul votre propre texte quitte l'appareil, lorsqu'une frontière est trouvée.** La traduction du brouillon réutilise la même frontière de texte propre que les actions rapides de rédaction : le message cité, l'en-tête de transfert et la signature sont exclus de ce qui est envoyé et de ce qui est jamais remplacé, pour les réponses, les transferts et les signatures produits par MailCopilot lui-même, ainsi que pour les conventions répandues des autres clients. Sur un brouillon qui cite dans un style que MailCopilot ne reconnaît pas, aucune frontière n'est trouvée et l'ensemble du corps -- citation comprise -- est envoyé au fournisseur IA et peut être remplacé. Voir [Actions rapides de rédaction](#actions-rapides-de-redaction) ci-dessus pour savoir comment cette frontière est détectée et la liste complète des styles de citation qu'elle manque.
- **Pas de substitution silencieuse.** La traduction n'est jamais montrée autrement que comme une comparaison avant/après, dans le même panneau de relecture que les actions rapides de rédaction. Le corps de votre brouillon ne change qu'après que vous ayez explicitement cliqué sur **Remplacer** ou **Insérer au curseur**.
- **Pas de cache.** Contrairement à la traduction du message, un brouillon traduit n'est pas conservé : un brouillon est censé continuer de changer entre les requêtes, si bien qu'un cache durable ne ferait que garder de l'écriture non envoyée, sans jamais être réutilisé.
- **Contenu encapsulé.** Votre propre texte est encapsulé avec des marqueurs de limite `wrapUntrusted()` avant d'atteindre le fournisseur IA, la même protection décrite dans [Protection contre l'injection de prompt](#protection-contre-linjection-de-prompt) ci-dessous.
- **Générations auditées.** Chaque traduction écrit une entrée dans le [journal d'audit IA](#le-journal-daudit).
- **Choix du fournisseur.** La traduction du brouillon utilise votre **fournisseur configuré par clé API** (Anthropic, compatible OpenAI, ou Google Gemini).
- **Sensible au budget.** Si le budget IA quotidien a été atteint, la traduction est refusée proprement -- voir [Traduction du brouillon](../ai-assistant#traduction-du-brouillon) pour ce que vous voyez dans ce cas.
- **La langue suggérée n'est qu'une suggestion.** Lorsque vous répondez, MailCopilot peut pré-remplir la liste de langue cible à partir de la langue du message auquel vous répondez, détectée localement sur votre appareil. Elle ne démarre jamais de traduction par elle-même, et elle n'est jamais rapportée : aucun champ de télémétrie n'enregistre quelle langue a été suggérée, ni si la langue que vous avez choisie provient de cette suggestion.
- **La télémétrie ne contient aucun contenu de message.** L'événement d'usage pseudonyme enregistré pour chaque traduction ne porte que l'identifiant du fournisseur, si le modèle a tourné localement, le nombre de tokens, la latence, une classe d'erreur regroupée, et le code de la langue cible que vous avez choisie -- jamais le texte du brouillon, la traduction, les destinataires, l'objet, ou la langue suggérée.

## Politique d'egress IA

MailCopilot intercepte chaque appel d'outil internet sortant que l'IA souhaite effectuer -- recherche web, recuperation de pages web et appels d'outils MCP externes -- et met l'IA en pause pour vous demander votre approbation avant l'execution de l'appel. Cela empeche un e-mail malveillant d'exfiltrer silencieusement vos donnees via une attaque par injection de prompt.

### Fonctionnement

Lorsque l'IA souhaite utiliser un outil internet (par exemple, effectuer une recherche web), MailCopilot met la reponse en pause et affiche une fenetre de confirmation integree dans le panneau IA avec le message **«L'IA veut accéder à Internet»**. La fenetre affiche :

- Le type d'action -- «Recherche web :», «Récupération d'URL :» ou «Appel d'outil externe»
- La requete, l'URL ou le nom de l'outil externe demande par l'IA (si disponible)
- Les boutons **Autoriser** et **Refuser**

Cliquez sur **Autoriser** pour permettre a l'IA de continuer, ou sur **Refuser** pour refuser. Votre decision s'applique a l'integralite du tour de reponse en cours -- si l'IA effectue plusieurs appels d'outils internet dans une meme reponse, vous n'etes consulte qu'une seule fois. Cliquer sur **Autoriser** accorde l'acces a tous les appels restants de ce tour.

Si vous ne repondez pas dans les 30 secondes, MailCopilot refuse automatiquement l'appel de l'outil.

### Icone de bouclier

Une icone de bouclier est affichee dans l'en-tete du panneau IA lorsque l'interception d'egress est active. En la survolant, le message suivant s'affiche : «L'accès web de l'IA est intercepté — chaque appel sortant nécessite votre approbation». Cette icone confirme que l'intercepteur est en fonctionnement et qu'aucun appel internet ne peut contourner votre approbation.

### Parametres de politique

Vous pouvez ajuster la politique d'egress dans **Parametres → AI** (sous le controle **Accès web de l'IA**). Ce parametre controle quand l'IA peut utiliser les outils internet. Avec **Refuser par défaut** ou **Demander à chaque tour**, MailCopilot demande une confirmation au premier appel d'outil internet de chaque tour de reponse. Avec **Toujours autoriser**, la demande est ignoree -- les outils internet s'executent sans confirmation :

- **Refuser par défaut (recommandé)** -- intercepte tous les appels d'outils internet ; vous approuvez ou refusez chaque tour via la fenetre de confirmation.
- **Demander à chaque tour** -- meme comportement que le refus par defaut : consentement explicite par tour via la fenetre de confirmation.
- **Toujours autoriser** -- l'IA peut librement appeler des outils web. Avertissement : l'IA peut envoyer le contenu des e-mails a des services externes.

### Journal d'audit

Chaque appel d'outil internet intercepte cree une ligne dans le journal d'audit ; les appels refuses incrementent la colonne **Bloque**, tandis que les appels approuves sont enregistres avec **Bloque** = 0. Chaque entree est egalement comptee dans l'evenement de telemetrie `ai.egress.intercepted` avec des tags indiquant le nom de l'outil, le resultat (autorise ou refuse) et si le consentement pour ce tour etait deja en vigueur. Pour les details de requete ou d'URL, le journal ne stocke qu'un hachage SHA-256 tronque aux 16 premiers caracteres hexadecimaux ; les requetes et URL brutes ne sont jamais ecrites sur le disque.

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
