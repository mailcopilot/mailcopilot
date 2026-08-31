---
title: Telemetry
sidebar_position: 2
---

# Télémétrie

{/*
  MAINTAINED BY HAND. There is no generator for this page.

  A script used to claim that role (scripts/gen-telemetry-docs.mjs). It knew
  14 of the 29 event domains, silently dropped 57 of 95 events, rewrote the
  file by full overwrite, and still exited 0 reporting the full count. It has
  been deleted (BACKLOG.md 2.130). Edit this page, and its five translations,
  by hand.

  Completeness is enforced from the other side instead:
  scripts/check-telemetry-docs.mjs requires every telemetry name registered in
  electron/metricsSchema.ts to appear in this page AND in all five
  translations. It runs in CI as part of npm run check:telemetry, and fails
  closed — a name it cannot find, a schema block it cannot parse, or a
  disclosure file it cannot read all turn the build red.
*/}

MailCopilot peut envoyer une petite quantité de données diagnostiques et d'usage -- mais seulement après que vous ayez donné votre accord actif. Elles ne contiennent jamais le contenu de votre courrier, mais elles comportent un identifiant aléatoire de cette installation : les données ne sont donc **pas totalement anonymes** -- voir [Identifiant d'installation](#identifiant-dinstallation) ci-dessous pour savoir exactement ce que cet identifiant permet et ne permet pas de savoir. Cette page documente exactement ce qui est collecté et -- aussi important -- ce qui ne l'est jamais.

## Consentement au premier lancement

Au premier lancement de MailCopilot, avant que l'assistant de configuration de compte ne s'ouvre, vous voyez un écran de consentement intitulé **Envoyer des données de diagnostic ?**. Il liste ce qui serait envoyé si vous l'autorisez et ce qui n'est jamais envoyé, et propose deux boutons de même taille : **Autoriser** et **Ne pas autoriser**. Aucun des deux n'est présélectionné ni mis en avant, et il n'y a aucune case à cocher précochée -- vous devez faire un choix actif.

Plusieurs conséquences en découlent :

- **Rien n'est collecté avant votre réponse, pas seulement rien envoyé.** Les compteurs et tampons qui sous-tendent le diagnostic et l'usage ne s'ouvrent pas tant que le consentement est en attente -- MailCopilot n'accumule pas silencieusement un arriéré pour le transmettre d'un coup dès que vous l'autorisez. Ce qui s'est passé avant votre réponse a simplement disparu ; au moment où vous l'autorisez, le comptage repart de zéro à partir de cet instant (une mesure de durée de session, par exemple, commence à compter à partir du moment du consentement, pas du lancement de l'application).
- **Fermer l'écran ou appuyer sur Échap équivaut à "Ne pas autoriser".** Il n'existe aucun moyen de fermer l'écran en se retrouvant considéré comme ayant consenti.
- **Votre décision est mémorisée avec la version de cette divulgation.** MailCopilot ne réaffiche l'écran que si la liste de ce qui est collecté s'élargit réellement -- une nouvelle catégorie de données, une nouvelle destination, ou une portée plus large qu'auparavant. Les mises à jour ordinaires de l'application, les ajustements de formulation et les corrections de bugs ne déclenchent jamais une nouvelle demande.
- **Si vous aviez déjà désactivé le diagnostic** dans Paramètres -> À propos avant l'existence de cet écran, ce refus est respecté et vous n'êtes pas sollicité à nouveau. Pour tous les autres, le diagnostic est désactivé automatiquement, et la question est posée une fois au prochain démarrage.
- **Vous pouvez changer d'avis à tout moment** dans **Paramètres -> À propos**. Tant que vous n'avez pas répondu à la question initiale, l'interrupteur y est affiché éteint et désactivé, avec une note expliquant qu'il ne prendra effet qu'une fois que vous aurez répondu sur l'écran de consentement.

## Ce que nous envoyons

Si vous l'autorisez, MailCopilot envoie :

- **Les erreurs et les plantages** -- le type d'erreur et la pile d'appels indiquant l'endroit du code concerné. Certains chemins d'échec passent déjà par un ensemble fermé de champs structurels qui exclut entièrement le texte brut d'un serveur tiers -- par exemple, lorsque l'enregistrement d'une copie d'un message envoyé dans votre dossier Envoyés échoue, le diagnostic porte le rôle du dossier (`sent`, jamais son nom), un hachage SHA-256 salé de l'identifiant du message, tronqué à 12 caractères hexadécimaux (jamais l'identifiant lui-même -- c'est une étiquette pseudonyme, pas une anonymisation : quiconque possède un identifiant de message candidat peut confirmer une correspondance en recalculant le hachage), la longueur de la réponse du serveur et un ensemble fermé de codes de protocole (comme `AUTHENTICATIONFAILED` ou `OVERQUOTA`). D'autres rapports d'erreur, pas encore convertis à cette forme structurée, peuvent encore transmettre du texte brut d'un serveur tiers, rattrapé seulement par le nettoyage des adresses et des chemins décrit plus bas -- pas une garantie structurelle -- voir [Comment les adresses et les chemins sont nettoyés](#comment-les-adresses-et-les-chemins-sont-nettoyés).
- **Les versions** -- la version de MailCopilot, votre système d'exploitation et sa version.
- **La performance** -- la durée des opérations comme la synchronisation du courrier, la recherche, l'envoi et les requêtes à l'IA.
- **L'utilisation des fonctionnalités** -- les fonctionnalités que vous avez utilisées lors d'une session et à quelle fréquence (recherche, rédaction de messages, IA, règles, modèles, report et plus), ainsi que, lorsque vous utilisez l'assistant IA, le fournisseur et le modèle qui ont traité la requête et le coût estimé de cette requête. Voir [Journal d'usage de l'IA](#journal-dusage-de-lia) ci-dessous pour les champs spécifiques à l'IA.
- **L'activité du coffre de clés IA** -- les actions sur le coffre où sont conservées vos clés API d'IA : quel fournisseur, si la clé était en cours de lecture, d'enregistrement ou de suppression, et comment cela s'est passé, y compris si une clé y a été trouvée. La valeur de la clé elle-même n'est jamais envoyée -- ni comme texte, ni comme longueur, ni comme hachage.
- **Le contexte de configuration** -- le nombre de comptes que vous avez connectés, le type de service de messagerie de chacun (par exemple Gmail ou Outlook), la façon dont vous vous êtes connecté (OAuth ou mot de passe), la langue de votre interface et votre thème.
- **L'identifiant d'installation** -- un identifiant aléatoire créé au premier lancement, décrit en détail ci-dessous. Il relie entre elles les données de vos différentes sessions -- c'est précisément la raison pour laquelle les données ne sont pas totalement anonymes.

## Ce que nous ne collectons jamais

MailCopilot ne conçoit aucun chemin de code pour envoyer ce qui suit. Pour les métriques typées et le diagnostic d'échec de la copie envoyée, c'est une garantie absolue, appliquée par un ensemble fermé de champs structurels que le code a le droit de remplir. Tous les autres rapports de diagnostic reposent d'abord sur le fait que le point d'envoi ne place pas le contenu à cet endroit, avec en soutien un filtre basé sur la forme qui rattrape, en deuxième rideau, des formes reconnaissables d'adresses et de chemins -- pas un filtre universel du contenu. Voir [Comment les adresses et les chemins sont nettoyés](#comment-les-adresses-et-les-chemins-sont-nettoyés) ci-dessous pour savoir exactement ce que ce deuxième rideau attrape et n'attrape pas.

- Le contenu de vos messages (objet, corps, pièces jointes, brouillons)
- Vos adresses e-mail ni celles de vos contacts -- le formulaire de retour dans Paramètres -> À propos est le seul endroit où une adresse est envoyée volontairement, quand vous y saisissez vous-même la vôtre afin de recevoir une réponse.
- Les noms ou chemins de vos dossiers sur votre serveur IMAP -- seul le type général de dossier (par exemple Boîte de réception, Envoyés ou Corbeille) apparaît jamais dans les données, jamais le nom que vous lui avez donné
- Les noms de fichiers de pièces jointes
- Ce que vous saisissez dans la recherche -- seuls la longueur de la requête et le nombre de résultats sont comptés, jamais le texte lui-même
- Le contenu des conversations ou de la mémoire de l'assistant IA
- Les hôtes, ports ou identifiants de vos serveurs
- Votre adresse IP en tant que donnée que nous attachons -- chaque événement indique explicitement à Sentry de ne pas en enregistrer une. La connexion réseau elle-même expose inévitablement votre IP à tout ce qu'elle traverse en chemin ; ce qu'un serveur destinataire, un proxy ou ses propres journaux en font relève de la configuration de cette infrastructure, pas de quelque chose que la charge utile de MailCopilot contrôle.
- Le nom de votre compte système d'exploitation dans les rapports de diagnostic que nous construisons -- les lacunes documentées sont décrites dans [Comment les adresses et les chemins sont nettoyés](#comment-les-adresses-et-les-chemins-sont-nettoyés)

## Comment les données sont acheminées

Toute la télémétrie est envoyée à [Sentry](https://sentry.io), notre plateforme de monitoring d'erreurs et de performance, et seulement après que vous l'ayez autorisé sur l'écran de consentement (ou plus tard, en activant l'interrupteur dans Paramètres -> À propos). Lorsque le diagnostic est désactivé -- que ce soit parce que vous avez refusé, que vous n'avez pas encore répondu, ou que vous avez désactivé l'interrupteur ensuite -- le pipeline est entièrement contourné et rien n'est envoyé. Si vous activez la journalisation de debogage, les mêmes événements apparaissent aussi dans votre `main.log` local pour que vous puissiez vérifier exactement ce qui serait transmis.

### Identifiant d'installation

Au premier démarrage, MailCopilot génère un UUID aléatoire et le stocke dans le fichier de configuration local. Ce UUID ne quitte jamais votre appareil. À la place, ce qui est transmis est un hash SHA-256 -- tronqué à 16 caractères hexadécimaux -- que nous appelons `install_id_hash`. Il est attaché à chaque événement de télémétrie en tant que Sentry user id, sur chaque événement et chaque transaction, pas seulement ceux au niveau de la session, pour que nous puissions répondre à des questions du type « combien d'installations distinctes utilisent la version X » ou « le crash Y affecte-t-il 1 ou 100 utilisateurs ». Ce hash est :

- **Pseudonyme, non identifiant, mais pas non plus dissociable** -- il n'est dérivé d'aucune adresse e-mail de compte, empreinte d'appareil, adresse IP ou identifiant matériel, et il n'existe aucune correspondance de notre côté qui le ramène à l'UUID ou à votre appareil. Il s'agit en revanche, délibérément, d'un identifiant stable propre à cette installation : il relie en un même fil chaque événement et chaque transaction que cette installation envoie jamais -- et, comme tout identifiant pseudonyme remis à un tiers, il pourrait en principe être recoupé avec d'autres données dont disposent Sentry ou nous-mêmes. C'est la raison pour laquelle l'écran de consentement qualifie les données de « pas totalement anonymes » plutôt que d'anonymes.
- **Stable entre versions** -- la même installation conserve le même hash après une mise à jour automatique, de sorte que les métriques de rétention survivent aux changements de version.
- **Supprimé quand vous désactivez la télémétrie** -- basculer l'interrupteur sur off efface immédiatement l'identifiant côté client Sentry et arrête toute transmission ultérieure.

Nous utilisons cet identifiant comme un outil d'analyse web utiliserait un identifiant de visiteur : il nous permet de compter des installations *distinctes* plutôt que des *événements totaux*. Cette différence est la raison même pour laquelle la télémétrie est utile -- sans elle, une installation bruyante ressemblerait à cent installations calmes.

### Comment les adresses et les chemins sont nettoyés

Deux filtres basés sur la forme s'exécutent sur chaque événement sortant et chaque entrée de journal structurée, dans les deux processus -- principal et renderer --, comme dernière étape avant la transmission -- à une exception près : l'enveloppe du formulaire de retour, dont l'adresse a été saisie par vous exprès pour que nous puissions répondre, est délibérément exclue du filtre d'adresses. Ce sont un filet de sécurité pour un contenu qui n'aurait jamais dû arriver jusque-là, pas le mécanisme principal -- le mécanisme principal est que les tags des métriques typées sont d'emblée des énumérations fermées et des champs structurels, si bien qu'il n'y a là rien de libre à nettoyer.

- **Le texte en forme d'e-mail** est remplacé par `<email>`. Le motif reconnaît la forme pratique et courante d'une adresse (lettres, chiffres et un petit ensemble de signes de ponctuation avant le `@`, un domaine avec point après) -- pas la grammaire e-mail formelle complète. Une exclusion délibérée : `root@localhost` et les adresses similaires sans domaine à point sont laissées telles quelles, pour qu'un texte ordinaire mentionnant un paquet comme `@types/node` ne soit pas dénaturé. Une partie locale construite avec une ponctuation inhabituelle peut laisser un fragment de tête après la suppression de son `@domaine.tld`.
- **Les chemins vers le répertoire personnel** (`/home/<nom>/...`, `/Users/<nom>/...`, `C:\Users\<nom>\...`) ont leur segment de nom de compte remplacé par `<user>`. Le seul cas résiduel documenté : un nom de compte contenant un espace, tout en fin de chemin, sans guillemet fermant ni séparateur après lui, peut laisser son second mot (`C:\Users\Jean Dupont` en fin de ligne garde « Dupont »). Le processus principal substitue en plus votre chemin de répertoire personnel littéral partout où il apparaît mot pour mot -- ce que le renderer, dans son bac à sable, ne peut pas faire.
- Les deux filtres parcourent un ensemble connu et borné de champs d'événement (texte de la pile d'appels, messages, données de requête, breadcrumbs et similaires), plus un parcours borné en profondeur et en taille des conteneurs libres (au maximum 4 niveaux de profondeur et 500 nœuds visités, chaque élément de conteneur et chaque clé d'objet comptant dans ce budget, pas seulement les chaînes réellement réécrites) -- pas un balayage illimité de tout l'événement, donc un contenu au-delà de cette limite n'est pas visité. Un champ n'est délibérément pas touché : le nom d'hôte de la machine que le SDK Sentry lui-même attache à chaque événement (`server_name`), car sur macOS et Windows il est souvent dérivé du nom du compte et aucune règle de nettoyage ne peut distinguer cela de façon fiable d'un nom d'hôte sans rapport.
- Une fuite dans une forme qu'aucun des deux filtres ne reconnaît -- un nom de dossier, une ligne d'objet, du texte libre du serveur -- n'est pas rattrapée ici. C'est pourquoi les tableaux de métriques ci-dessous, et le diagnostic d'échec de la copie envoyée, sont construits à partir de champs structurels fermés plutôt que de reposer sur le nettoyage de texte libre.

### Journal d'usage de l'IA

Chaque fois que vous envoyez un message à l'assistant IA, MailCopilot enregistre une entrée de journal structurée une fois la requête terminée, en plus du booléen de synthèse d'usage évoqué plus haut. Cette entrée porte : le **fournisseur IA** (le fournisseur de votre clé API), le **modèle** qui a traité la requête, le **nombre total d'appels d'outils** et les **noms des outils qu'il a appelés** (par exemple `send_email` ou `mail_action`, jamais les arguments qui leur ont été passés), si la requête a été annulée ou a échoué, et le **coût estimé** de la requête en USD lorsque le fournisseur expose ses tarifs. Rien de tout cela n'inclut le texte de votre requête, la réponse de l'IA ou du contenu d'e-mail -- pour le détail complet de ce que l'assistant IA lui-même envoie aux fournisseurs (un sujet distinct et beaucoup plus vaste, à ne pas confondre avec cette entrée de journal structurée), voir [Données IA et journal d'audit](./ai-data). Les mesures de latence propres à chaque fonctionnalité IA portent leurs propres champs agrégés (type de contexte de la conversation, présence ou non d'un historique, nombres de tokens, préréglage de réécriture utilisé, nombre de brouillons de réponse générés et similaires) -- voir [Spans de performance](#spans-de-performance) ci-dessous.

## Événements

### Cycle de vie de l'application

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | non | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Une fois au démarrage. Porte `install_id_hash` pour DAU/MAU. |
| `app.session_ended` | histogram | non | `reason`, `install_id_hash` | Une fois à l'arrêt normal. value_ms = durée de la session. |
| `app.updated` | event | non | `from_version`, `to_version` | Une fois après l'installation d'une nouvelle version par auto-update. |
| `app.startup_ms` | histogram | non | `accounts_count` | Temps entre `app.whenReady` et la première `BrowserWindow` visible. |
| `window.rescued` | event | non | `windows_moved`, `pass` | Une passe de sauvetage a ramené dans l'écran au moins une fenêtre qui en était sortie, après un changement de configuration d'affichage (branchement d'un moniteur, changement de résolution, sortie de veille). |
| `tray.created` | event | non | `outcome`, `platform` | Résultat d'une tentative de création de l'objet icône de la zone de notification (au démarrage ou lors de sa réactivation dans les paramètres) — `outcome` vaut `created` ou `failed`. Un résultat `failed` est un échec de notre côté (image d'icône vide ou illisible, erreur lors de la construction) et ne dit rien de votre bureau : MailCopilot ne vérifie pas si le bureau affiche réellement l'icône. La raison de l'échec n'est pas distinguée. |
| `tray.menu_action` | event | non | `action` | Quelle entrée du menu de la zone de notification a été utilisée (ouvrir / nouveau message / relever le courrier / quitter) — un clic direct sur l'icône sous Linux et Windows est lui aussi enregistré comme `open` (macOS n'enregistre pas de gestionnaire de clic sur l'icône, puisque cliquer dessus y ouvre directement le menu). |
| `notification.shown` | event | oui (fenêtre 10 s) | `batched` | Une notification de nouveau courrier a été affichée ; `batched` indique si une notification couvrait plusieurs messages. Ni compte, ni dossier, ni objet, ni expéditeur. |
| `notification.suppressed` | event | oui (fenêtre 10 s) | `reason` | Une notification de nouveau courrier a été décidée mais pas affichée, parce que vous regardiez déjà l'application. |
| `notification.clicked` | event | oui (fenêtre 10 s) | — | Une notification de nouveau courrier a été cliquée. Aucun identifiant. |
| `badge.updated` | event | oui (fenêtre 10 s) | `has_unread` | Le total non lu du badge / de l'infobulle a changé. Uniquement s'il y a du non-lu — jamais le nombre. |

### Consentement à la télémétrie

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `telemetry.consent_granted` | event | non | `version` | Se déclenche uniquement lorsque vous appuyez sur Autoriser sur l'écran de consentement, avec la version de la liste que vous avez vue. Un refus ne déclenche aucun événement -- mesurer un « non » serait en soi la transmission que le refus vise à empêcher. Réactiver l'interrupteur dans Paramètres -> À propos après l'avoir désactivé ne déclenche pas non plus cet événement -- seule une réponse sur l'écran de consentement le fait. |

### Synthèse d'usage

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | non | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | Bitmap de fin de session : quelles fonctionnalités ont été utilisées au moins une fois ? |

### Mise en route

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | non | `first_run` | L'utilisateur a ouvert l'assistant d'ajout de compte. |
| `onboarding.method_selected` | event | non | `method` | Choix entre OAuth et IMAP/SMTP manuel. |
| `onboarding.autoconfig_result` | event | non | `success`, `provider` | Sondage de l'autoconfiguration terminé -- les paramètres IMAP/SMTP ont-ils été trouvés ? |
| `onboarding.connection_test_result` | event | non | `kind`, `success`, `failure_kind` | Test de connectivité IMAP ou SMTP terminé. |
| `onboarding.google_oauth_result` | event | non | `success`, `failure_kind` | Le flux Google OAuth2 s'est terminé. |
| `onboarding.account_saved` | event | non | `provider`, `auth_type` | Identifiants du compte écrits dans keytar/electron-store. |
| `onboarding.first_headers_sync_completed` | histogram | non | `provider`, `folder_count_bucket` | Temps entre `account_saved` et la fin de la première synchro d'en-têtes (value_ms). |
| `onboarding.first_message_opened` | event | non | `time_since_sync_bucket` | L'utilisateur a ouvert son premier message après la connexion. |

### Rédaction

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `compose.opened` | event | non | `source`, `has_draft` | Fenêtre de rédaction ouverte ; suit le point d'entrée. |

### File d'envoi

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `send_queue.enqueued` | event | non | `scheduled`, `send_and_archive`, `has_attachments`, `body_size_bucket` | Message sortant ajouté à `send_queue` (immédiat ou planifié). |
| `send_queue.sent` | histogram | non | `scheduled` | Temps entre l'ajout en file et la livraison SMTP réussie (value_ms). |
| `send_queue.failed` | event | non | `failure_kind` | Tentative d'envoi SMTP définitivement échouée (la file a abandonné). |
| `send_queue.retried` | event | non | `attempt_number` | Erreur d'envoi SMTP transitoire -- message reprogrammé. |
| `send_queue.append_failed` | event | non | `reason`, `provider_id` | La livraison SMTP a réussi, mais l'enregistrement d'une copie du message dans le dossier Envoyés via IMAP a échoué. Voir le diagnostic de la copie envoyée décrit plus haut sous « Ce que nous envoyons ». |

### Avertissements de mauvais destinataire

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `misdirection.prompted` | event | non | `kind` | La fenêtre de rédaction a affiché le dialogue d'avertissement. |
| `misdirection.outcome` | event | non | `outcome`, `kind` | L'utilisateur a répondu à l'avertissement. |

### Modèles

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `template.applied` | event | non | `var_count` | L'utilisateur a inséré un modèle dans la rédaction. |

### Rappels de relance

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `followup.created` | event | non | `duration_days_bucket` | Une relance a été attachée à un message sortant. |

### Recherche

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | non | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | Durée d'une recherche parmi les messages enregistrés sur cet appareil, sans compter les résultats récupérés ensuite depuis le serveur de messagerie. |
| `search.error` | event | non | `scope`, `kind` | Le gestionnaire de recherche a levé une erreur -- soit annulation utilisateur, soit échec réel. |

### Indexeur de corps

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | non | `indexed`, `folders_scanned` | Un cycle complet de l'indexeur sur tous les dossiers. |
| `body_indexer.coverage_pct` | gauge | non | `total_messages`, `indexed_messages` | Fraction des messages en cache dont `body_text` est indexé. |
| `body_indexer.backlog` | gauge | non | -- | Nombre absolu de messages en cache encore sans `body_text`. |
| `body_indexer.folder_error` | event | non | `folder_role`, `error_streak`, `backoff_ms` | L'indexeur a rencontré une série d'erreurs sur un dossier et est passé en backoff. |

### Maintenance de l'index plein-texte

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `fts.merge.work_ms` | histogram | non | `outcome`, `steps`, `max_step_ms`, `segments_before`, `segments_after` | Cycle de fusion incrémentale FTS5 : durée totale des fusions synchrones, étape la plus longue, nombre de segments avant/après. |
| `fts.merge.failed` | event | non | `reason` | La fusion incrémentale FTS5 a levé une erreur. |

### Synchronisation des en-têtes

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | non | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Exécution complète de `syncFolderHeaders` -- séparation upsert / autre pour le profilage. |
| `sync.headers.coalesced` | event | non | `folder_role` | Une tentative `syncFolderHeaders` doublée s'est rattachée à une exécution en cours. |

### Instrumentation de l'ouverture des messages

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | non | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Latence de bout en bout de l'ouverture d'un message, observée côté renderer (du clic jusqu'au rendu du corps). Le tag `cache_hit_level` indique le niveau de cache qui a servi le corps : `memory`, `db`, `eml`, `imap` ou `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | non | `cache_hit_level` | Temps wall du gestionnaire IPC `net:messageDetails` côté processus principal. Isole la latence serveur du bruit du trajet aller-retour renderer vers main. Un échantillon par branche terminale (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | non | `requester`, `wait_ms_bucket` | Temps d'attente pour acquérir une connexion dans le pool IMAP par compte. Émis uniquement lorsque l'attente dépasse 500 ms, afin que les tableaux de bord capturent la longue queue sans bruit des acquisitions rapides. |

### Analyse des fichiers EML

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `eml.parse_dispatch` | event | non | `path`, `size_bucket` | Une analyse EML, avec le chemin réellement suivi : `worker` (analysé hors du thread principal), `worker_failed` (le worker était disponible mais cette analyse précise a échoué), `worker_aborted` (vous avez fermé le message avant que le worker ait terminé), `inline_below_threshold` (assez petit pour être analysé sur le thread principal par conception), ou `inline_unavailable` (analysé sur le thread principal parce que le worker lui-même est inutilisable pour cette session). |
| `eml.parse_worker_unavailable` | event | non | `reason` | Se déclenche au plus une fois par session, au moment où l'analyse EML hors thread principal s'avère impossible pour le reste de cette session — toute analyse ultérieure basculera vers `inline_unavailable` ci-dessus. `reason` vaut `script_missing`, `spawn_failed`, `startup_failed` ou `not_main_thread`. |
| `eml.parse_cap_hard` | event | non | `size_bucket` | Un message dont la taille brute dépassait la limite stricte d'analyse : son corps et ses pièces jointes n'ont jamais été lus. La plupart du temps, cela signifie que le message s'est ouvert sous forme d'espace réservé ne contenant que les en-têtes, mais l'événement se déclenche aussi quand une synchronisation hors ligne en arrière-plan refuse un téléchargement trop volumineux en cours de route -- rien n'a alors été ouvert et aucun espace réservé n'a été affiché, faute d'ouverture à laquelle répondre. N'emporte que la bande de taille grossière décrite plus haut — rien du message lui-même. Indique si quelqu'un reçoit réellement du courrier de cette taille, autrement dit si la limite est au bon endroit. |
| `eml.parse_cap_soft` | event | non | `size_bucket`, `tier` | Un corps de message décodé coupé à la limite souple. La plupart du temps, cela signifie qu'un bandeau est apparu dans le volet de lecture pour signaler que seul le début est affiché, mais l'événement se déclenche aussi quand l'outil de l'assistant IA qui liste les pièces jointes analyse en arrière-plan un message stocké localement -- aucun bandeau n'est alors affiché, faute de volet de lecture où l'afficher. `tier` vaut `default` pour la limite avec laquelle tout message s'ouvre, ou `full` lorsque même la limite relevée que vous avez demandée en cliquant sur « Afficher le message entier » n'a pas suffi. Aucun texte, aucune longueur en octets, aucun objet — seulement la bande et laquelle des deux limites s'appliquait. |

Aucun de ces quatre événements n'est agrégé : chacun est enregistré individuellement plutôt que fusionné avec d'autres de la même rafale, car l'information dont un mainteneur a besoin — quel chemin une analyse a suivi, pourquoi le worker est mort, ou si une limite a effectivement été atteinte — serait sinon noyée dans le décompte. `eml.parse_dispatch` et `eml.parse_worker_unavailable` décrivent comment une analyse s'est déroulée ; `eml.parse_cap_hard` et `eml.parse_cap_soft` enregistrent qu'une limite de taille a été franchie — pour la limite souple, pendant une analyse effective ; pour la limite stricte, éventuellement avant même qu'une analyse commence — et ils ne se déclenchent pas au même rythme que l'événement d'analyse : un message dépassant la limite stricte n'est jamais transmis à un analyseur, il produit donc `eml.parse_cap_hard` sans aucun `eml.parse_dispatch` ; un message qui ne dépasse que la limite souple est bel et bien analysé, il produit donc son `eml.parse_dispatch` habituel plus `eml.parse_cap_soft` en plus.

Ce qui est garanti, c'est un événement `eml.parse_dispatch` par fichier EML que MailCopilot transmet réellement à un analyseur — pas un événement par message que vous ouvrez, et, comme ci-dessus, aucun pour un message arrêté par la limite stricte avant que l'analyse ne commence. Ouvrir un message déjà présent dans le cache de détails en mémoire ou sur disque (les niveaux `memory` et `db` du tag `cache_hit_level`, décrits plus haut dans [Instrumentation de l'ouverture des messages](#instrumentation-de-louverture-des-messages)) n'analyse jamais de fichier `.eml`, donc aucun de ces quatre événements n'est produit pour cette ouverture. Au-delà de cette exception liée au cache, `eml.parse_dispatch`, `eml.parse_worker_unavailable` et `eml.parse_cap_soft` ne se déclenchent que lorsqu'un message est lu depuis un fichier `.eml` stocké localement ou vient d'être téléchargé et doit être analysé -- cela inclut les recherches de pièces jointes en arrière-plan de l'assistant IA, qui lisent un fichier `.eml` stocké localement de la même façon qu'une ouverture ordinaire. `eml.parse_cap_hard` se déclenche dans ces mêmes cas, plus un de plus qui ne touche à aucun fichier `.eml` : une synchronisation hors ligne en arrière-plan qui refuse un téléchargement trop volumineux en cours de route, avant que quoi que ce soit ne soit enregistré sur le disque. Chaque événement `eml.parse_dispatch` porte le `path` de cette analyse précise et le `size_bucket` de ce message précis ; chaque événement `eml.parse_cap_hard` ou `eml.parse_cap_soft` porte le `size_bucket` du message qui a déclenché la limite — ainsi que, comme tout autre événement envoyé par l'application, l'identifiant d'installation décrit dans [Identifiant d'installation](#identifiant-dinstallation), qui le relie au reste des événements de votre session. Le tag `size_bucket` utilise le même traitement en tranches grossières déjà appliqué à la taille des messages ailleurs sur cette page (voir `body_size_bucket` dans [File d'envoi](#file-denvoi) et [Instrumentation de l'ouverture des messages](#instrumentation-de-louverture-des-messages)) : l'une de cinq tranches — `<1KB`, `1-10KB`, `10-100KB`, `100KB-1MB`, `1MB+` — pas une taille exacte en octets, pas une taille à une résolution plus fine, et jamais un objet, un expéditeur, un nom de fichier ou un identifiant de message.

### Invitations de calendrier

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `mail.invite_rsvp` | event | non | `method`, `hadLocation` | Se déclenche une fois qu'une réponse à une invitation de calendrier (Accepter / Provisoire / Refuser) a été envoyée avec succès. `hadLocation` retient seulement si l'invitation d'origine comportait un champ de lieu, pas ce qu'il indiquait. Les envois de réponse échoués ne sont pas comptés ici. |

### Rafraîchissement des jetons OAuth IMAP

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | non | `provider` | Rafraîchissement du jeton OAuth déclenché par un échec d'authentification IMAP (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | non | `provider` | Le rafraîchissement a réussi -- la nouvelle tentative IMAP utilisera le jeton frais. |
| `imap.auth_refresh_failure` | event | non | `provider`, `reason` | Le rafraîchissement a échoué -- l'erreur d'authentification d'origine remonte à l'appelant. |
| `imap.auth_refresh_suppressed` | event | non | `reason` | Le cooldown par compte a empêché une tentative de rafraîchissement, pour éviter des rafales de requêtes `/token` quand un refresh token a été révoqué. |
| `imap.idle_auth_refreshed` | event | non | `provider` | La boucle IDLE s'est remise d'un échec d'authentification en cours de cycle via un rafraîchissement in-loop -- la livraison push reprend sans le backoff de 60 min. |
| `imap.auth_refresh_exhausted` | event | non | `provider`, `consecutive` | La boucle IDLE a déclenché le storm-brake : N rafraîchissements consécutifs ont réussi côté fournisseur mais IMAP a continué à rejeter les jetons frais, donc on retombe sur le backoff d'authentification ordinaire. |

### Récupération de la confiance des certificats

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `imap.cert_error` | event | oui (fenêtre 10 s) | `provider` | Une opération IMAP a échoué avec une erreur TLS classée comme relevant du certificat (auto-signé, chaîne non fiable, conflit de pin, conflit de nom d'hôte). |
| `cert.recovery_dialog_shown` | event | non | `provider` | La boîte de dialogue de récupération de certificat a été affichée pour un hôte, au plus une fois par fenêtre de storm-guard. |
| `cert.trust_clicked` | event | non | `provider`, `pem` | Vous avez accepté un certificat présenté, ce qui a enregistré un pin TLS et déclenché une resynchronisation du compte. `pem` retient seulement si le corps du certificat a été capturé avec le pin, ce qui détermine si un serveur auto-signé peut être approuvé par la suite. |
| `cert.trust_rejected` | event | non | `provider`, `reason` | Une tentative de confiance ne s'est pas terminée par un pin enregistré -- par exemple vous avez refusé la confirmation, ou le certificat présenté par le serveur ne correspondait pas à celui montré par la boîte de dialogue de récupération. |
| `cert.interception_notice_shown` | event | non | `provider` | Un avis unique a été affiché indiquant que la chaîne de certificats de votre serveur de messagerie ne se vérifie que par rapport au magasin de certificats de votre système d'exploitation, pas par rapport à la liste des racines publiques intégrée -- la signature d'un antivirus ou d'un proxy d'entreprise inspectant la connexion. |

Aucun de ces tags ne porte jamais le nom d'hôte, l'empreinte du certificat, le nom de l'émetteur ou le texte d'erreur brut -- seulement la classification énumérée `provider` et des codes de motif fermés.

### Badge de reconnexion de compte

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `account.reauth_flagged` | event | non | `flagged_accounts_bucket` | Une boîte aux lettres a dépassé le seuil d'échecs d'authentification consécutifs et affiche désormais le badge « Se reconnecter ». Émis une seule fois quand le badge apparaît, jamais à chaque tentative de synchronisation échouée -- cela compte des identifiants cassés, pas de simples ratés réseau. |
| `account.reauth_badge_clicked` | event | non | — | Vous avez cliqué sur « Se reconnecter » sur le badge. Enregistré au moment du clic lui-même, pas selon le résultat : l'enregistrement est conservé même si l'éditeur de compte ne parvient ensuite pas à s'ouvrir. |
| `account.reauth_cleared` | event | non | `reason`, `flag_duration` | Le badge d'une boîte aux lettres a cessé d'être affiché -- avec la raison (`signed_in`, la boîte a recommencé à s'authentifier, ou `account_removed`, vous avez supprimé le compte à la place) et la durée d'affichage du badge (`flag_duration` : `<1min`, `1-10min`, `10-60min`, `1-6h`, `6-24h`, `24h+`, ou `unknown` pour le cas rare où aucune heure de départ n'a été enregistrée). |

Aucun de ces trois événements ne porte d'identifiant de compte, d'adresse e-mail, de fournisseur de messagerie ou de texte serveur. `flagged_accounts_bucket` est une case grossière du nombre de boîtes aux lettres signalées en même temps sur toute l'installation, pas lesquelles.

### Rétention du cache

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | non | `count_bucket`, `freed_bytes_bucket` | La purge de rétention a supprimé des fichiers `.eml` plus anciens que la limite configurée. Les quantités et les tailles sont regroupées en intervalles — aucun chemin ni nombre exact n'est transmis. |
| `cache.folder_index_disabled` | event | non | `count`, `role` | Un dossier a été exclu de la recherche plein-texte — automatiquement pour Junk/Spam/Corbeille à la première enregistrement, ou manuellement via le menu contextuel du dossier. `role` : `spam`, `trash` ou `manual`. |

### Signaux de sécurité du cache et de perte de données

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | non | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | Un `DELETE FROM messages` à la portée du dossier a été émis. Chaque site d'appel fournit une raison pour distinguer une régression qui efface un cache sain d'un bump UIDVALIDITY légitime. |
| `imap.stale_wipe_guard_tripped` | event | non | `folder_role`, `provider` | La protection mass-delete a refusé de purger le cache local du dossier parce que `mailbox.exists` est revenu non numérique. Un pic indique un problème de fournisseur ou de connexion, pas une perte de données utilisateur. |
| `imap.header_response_unaddressable` | event | non | `folder_role`, `provider` | Une réponse FETCH d'en-tête n'avait pas d'UID exploitable : le message n'a pas pu être stocké et la passe de synchronisation s'est déclarée incomplète. Compte les passes, pas les messages ; désigne le fournisseur dont le flux FETCH perd des UID. |
| `db.shutdown_wal_checkpoint_ms` | histogram | non | `busy`, `reclaimed_kb_bucket`, `ok` | Durée du `PRAGMA wal_checkpoint(TRUNCATE)` exécuté avant la fermeture pour garantir que les écritures committées mais non checkpointées survivent au redémarrage. |

### Limites de dépenses IA

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `db.ai_reserve_denied` | event | oui (fenêtre 10 s) | `reason` | Une réservation de budget IA a été refusée avant que la moindre dépense ne puisse se produire -- le plus souvent parce que votre plafond de dépenses configuré était atteint. |
| `ai.request_budget.stopped` | event | non | `provider`, `steps` | Une requête de chat a été arrêtée prématurément parce que le coût accumulé a atteint votre plafond configuré par requête. `steps` est le nombre d'étapes agentiques terminées avant l'arrêt, jamais leur contenu. |

### Garde stdio MCP (protection renderer-vers-RCE)

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `mcp.stdio.connect_attempted` | event | non | `approved_source` | Le transport stdio MCP est sur le point d'être lancé -- émis une fois par connect réussi après les portes d'approbation et d'allowlist. |
| `mcp.stdio.connect_blocked` | event | non | `reason` | La connexion ou la sauvegarde stdio a été refusée par la garde (`not_approved`, `unapproved_command`, `forbidden_field`, `forbidden_env_key`, `env_disabled`). |
| `mcp.stdio.approval_granted` | event | non | `source`, `scope` | L'utilisateur a accordé l'approbation stdio MCP (activation globale ou par connexion) ; `source` distingue env vs native-confirm, `scope` distingue global vs par connexion. |
| `mcp.stdio.env_sanitized_on_load` | event | non | `count_bucket` | La migration de configuration a retiré les clés d'env loader-hook interdites des connexions MCP persistantes au chargement. Au plus une fois par lancement. |

### Audit des actions IA (barrière preview -> apply)

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ai.action.preview_created` | event | non | `kind` | Un outil MCP `*_preview` a enregistré une action mutante en attente du clic Apply de l'utilisateur. |
| `ai.action.applied` | event | non | `kind` | Un outil MCP `*_apply` a exécuté avec succès une action mutante précédemment confirmée. |
| `ai.action.rejected` | event | non | `kind`, `reason` | Un appel `*_apply` a été rejeté à la porte de validation -- le preview manquait ou avait expiré, le jeton de confirmation manquait, ne correspondait pas ou avait expiré, le type d'action ne correspondait pas au preview, le callback manquait, ou la limite de fréquence était atteinte. |
| `ai.action.expired` | event | non | `kind` | Une action mutante en attente a expiré sans que l'utilisateur ait cliqué Apply (TTL). |
| `ai.action.apply_duration_ms` | histogram | non | `kind` | Durée d'un apply réussi -- combien de temps a pris la mutation sous-jacente (DB / IMAP / SMTP). |
| `ai.action.preview_skipped` | event | non | `kind`, `reason` | Un outil MCP `*_preview` a refusé d'enregistrer une action en attente parce que l'ensemble de cibles résolu était vide (aucune correspondance après résolution de la requête). |
| `ai.action.batch_size` | event | non | `kind`, `accounts_count_bucket`, `emails_count_bucket`, `folders_count_bucket` | Enregistré lorsqu'un enregistrement de preview couvre un lot de messages. Les trois décomptes sont des plages approximatives, jamais des nombres exacts. |
| `ai.turn.action_not_prepared` | event | non | `role`, `search_calls_bucket` | Un tour de discussion avec l'IA a utilisé le mécanisme des actions destructrices (un appel preview ou apply) mais s'est terminé sans enregistrer une nouvelle action ni faire valider avec succès une action déjà confirmée (seul compte un jeton de confirmation accepté par MailCopilot — une confirmation périmée ou invalide ne compte pas, tandis qu'une validation réussie exclut cet événement même si l'action échoue ensuite) : aucun bouton de confirmation n'est apparu et rien n'a été modifié. Le panneau vous le dit également en toutes lettres. `role` indique quelle moitié de la paire a été appelée — `preview` ou `apply`. `search_calls_bucket` est une plage approximative du nombre de recherches effectuées pendant ce tour. Ni votre demande, ni la réponse de l'assistant, ni les requêtes de recherche ne sont transmises : la détection repose uniquement sur les outils appelés. |

### Garde de sortie réseau de l'IA

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | non | `tool_name`, `account_id` | Un appel d'outil sortant (par ex. `WebSearch`, `WebFetch`, un outil MCP externe générique) a été refusé pendant que les données email de l'utilisateur étaient dans le périmètre -- soit filtré du toolset SDK, soit arrêté par la garde runtime. |
| `ai.egress.allowed_once` | event | non | `tool_name`, `account_id` | L'utilisateur a accordé un consentement ponctuel pour la sortie réseau et l'IA en a usé. Permet de distinguer "les utilisateurs court-circuitent régulièrement" de "la garde tient, les tentatives sont surtout des injections". |
| `ai.egress.intercepted` | event | non | `tool_name`, `outcome`, `was_consented_for_turn` | Un appel d'outil internet (recherche web, récupération web, outil MCP externe) a été intercepté par la fenêtre de confirmation décrite dans [Politique d'egress IA](./ai-data#politique-degress-ia), en notant s'il a été approuvé ou refusé et si un consentement déjà donné pour le même tour de réponse le couvrait déjà. Jamais la requête, l'URL ou les arguments de l'outil -- ceux-ci ne sont hachés que dans le journal d'audit IA local. |

### Actions dans le panneau d'audit de confidentialité IA

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ai.audit.export_requested` | event | non | `format` | Vous avez cliqué sur Exporter JSON ou Exporter CSV dans le panneau du journal d'audit IA. |
| `ai.audit.entry_deleted` | event | non | `scope` | Vous avez supprimé en douceur une entrée du journal d'audit, ou effacé toutes les entrées d'un coup. Les lignes sous-jacentes ne sont pas supprimées, seulement masquées -- voir [Le journal d'audit](./ai-data#le-journal-daudit). |

### Règles IA en arrière-plan

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ai.rule.applied` | event | non | `action` | Le pipeline de règles IA en arrière-plan a automatiquement appliqué une action réversible (archiver, déplacer, marquer comme lu ou marquer d'une étoile) à un message. |
| `ai.rule.destructive_preview` | event | non | `action` | Le pipeline de règles IA en arrière-plan a proposé une action destructrice (mettre à la corbeille ou marquer comme spam) mais l'a enregistrée comme preview en attente au lieu de l'appliquer automatiquement. |

### Actions rapides de rédaction

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ai.quick_action.input_too_long` | event | non | `preset`, `length_bucket` | Une action rapide (Améliorer / Raccourcir / Formel) a refusé votre brouillon parce qu'il dépasse la limite acceptée par cette fonctionnalité : rien n'a été envoyé au fournisseur d'IA. `preset` indique lequel des trois boutons vous avez pressé. `length_bucket` est une tranche de taille grossière — `<=8k`, `8k-12k`, `12k-20k`, `20k-50k`, `50k-100k` ou `100k+` caractères — jamais la longueur exacte, et jamais un seul caractère du brouillon lui-même. Il existe pour nous permettre de savoir si la limite est trop stricte pour des e-mails longs ordinaires. La valeur `<=8k` est déclarée par souci d'exhaustivité mais n'est pas atteignable aujourd'hui : cet événement ne se déclenche qu'au-delà de la limite de 8 000 caractères des actions rapides, elle n'existe que pour qu'un futur abaissement de cette limite ne produise pas une valeur hors de l'ensemble déclaré. |
| `ai.proofread.input_too_long` | event | non | `length_bucket` | La vérification de relecture a refusé votre brouillon parce qu'il dépassait la limite acceptée par la fonction ; rien n'a été envoyé au fournisseur d'IA. `length_bucket` est la même bande de taille grossière que ci-dessus — jamais la longueur exacte, et jamais un seul caractère du brouillon. Elle existe pour nous permettre de savoir si la limite est trop stricte pour des e-mails longs ordinaires. |
| `ai.quick_action.preview_outcome` | event | non | `preset`, `outcome` | Ce que vous avez fait d'une réécriture d'action rapide affichée dans le panneau de relecture. `preset` indique lequel des trois boutons vous avez pressé. `outcome` vaut exactement l'une de ces trois valeurs : `replaced`, `inserted` ou `cancelled`. Rien du texte n'est transmis : ni le brouillon, ni la réécriture, ni leur longueur, ni le nombre de modifications trouvées. Il existe pour nous permettre de savoir si ces réécritures sont retenues ou rejetées. Un panneau qui disparaît sans choix (fenêtre fermée, autre action rapide lancée par-dessus) n'enregistre rien du tout. |

### Mises à jour automatiques

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `update.check_triggered` | event | non | `source` | Une vérification de mise à jour a été déclenchée, soit par le minuteur d'arrière-plan horaire, soit par votre clic dans Paramètres -> À propos. |
| `update.check_result` | event | non | `result`, `error_class` | Une vérification de mise à jour s'est terminée : à jour, une mise à jour est disponible, ou elle a échoué. |
| `update.download_started` | event | non | `source` | Un téléchargement de mise à jour a commencé, automatiquement ou sur votre clic. |
| `update.download_completed` | event | non | — | Un téléchargement de mise à jour s'est terminé avec succès et est prêt à être installé au prochain redémarrage. |
| `update.download_failed` | event | non | `error_class` | Un téléchargement de mise à jour ne s'est pas terminé (coupure réseau, disque plein, signature incorrecte, ou similaire). |
| `update.install_outcome` | event | non | `result`, `error_class` | Ce qui s'est passé après que vous ayez cliqué sur Redémarrer pour installer. |

Aucun de ces événements ne porte le numéro de version de la version concernée -- seulement le résultat regroupé -- donc ce tableau ne permet pas de savoir à quel point une installation individuelle est en retard.

### Garde des liens externes

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `links.external_open_suppressed` | event | oui (fenêtre 10 s) | `source` | Une demande d'ouverture d'un lien dans votre navigateur par défaut a été limitée en fréquence par la garde d'ouverture de liens externes. `source` identifie quelle partie de l'application a fait la demande (par exemple une boîte de dialogue de mise à jour ou un lien de désabonnement), jamais l'URL elle-même. |

### Repli du magasin de secrets

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `secret_store.fallback_active` | event | non | `surface`, `platform` | Une lecture du magasin de secrets de votre système d'exploitation (keytar / libsecret / Secret Service) a échoué -- cette installation fonctionne sans trousseau accessible. `surface` identifie quel type de lecture d'identifiants a échoué, jamais l'identifiant, le compte ou son adresse e-mail. |

### Stockage des clés API de l'IA

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ai.api_key_store_op` | event | oui (fenêtre 10 s) | `op`, `provider`, `outcome` | Une clé API IA enregistrée a été lue, écrite ou supprimée dans le magasin de secrets de votre système d'exploitation. `op` vaut `read`, `write` ou `delete`. `provider` vaut `anthropic-api`, `openai-api` ou `gemini-api`. `outcome` vaut `found` ou `absent` pour une lecture (une clé existe ou non en ce moment), `ok` pour une écriture ou une suppression réussie, ou `store_error` lorsque le magasin de secrets lui-même n'a pas pu être atteint. La valeur de la clé n'apparaît jamais -- ni comme texte, ni comme longueur, ni comme hash. |

### Confirmation de destination IA

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ai.destination_confirm` | event | non | `field`, `outcome` | Le résultat du verrou de confirmation de destination qui protège tout changement de l'adresse du point de terminaison IA ou du proxy (voir [Confirmer une nouvelle destination IA](../ai-assistant#confirmer-une-nouvelle-destination-ia)). `field` vaut `endpoint` ou `proxy`. `outcome` vaut `accepted`, `declined` (le changement n'a pas été approuvé — vous avez cliqué sur Annuler ou appuyé sur Échap, la fenêtre de confirmation s'est fermée avant votre réponse, ou la boîte de dialogue elle-même n'a pas pu s'afficher), `blocked_invalid` (la nouvelle adresse n'était pas une URL http(s) utilisable, refusée sans qu'aucune boîte de dialogue ne soit affichée), ou `blocked_busy` (le changement est arrivé alors qu'une autre confirmation était déjà ouverte — une seule boîte de dialogue peut être ouverte à la fois pour toute l'application, ce qui peut donc arriver même pour le même champ). Un décompte `declined` n'est pas seulement un décompte de refus délibérés — il couvre aussi une boîte de dialogue qui n'a pas pu s'afficher du tout. Ni l'adresse ni l'hôte ne sont jamais inclus. |

### Enregistrement des réglages

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `settings.field_refused` | event | oui (fenêtre 10 s) | `field`, `code` | Les réglages ont été enregistrés en laissant un champ de côté, parce que la valeur envoyée pour celui-ci sortait de ce que cette version accepte. Tous les autres champs acceptés du même enregistrement ont été appliqués, et le champ ignoré a conservé sa valeur précédente. `field` est le nom du champ ignoré (`mcpExportWhitelist`). `code` est la raison lisible par machine (`unknown_export_tool` — la liste contenait un nom d'outil MCP que cette version n'exporte pas, généralement hérité d'une version plus ancienne). La valeur ignorée n'est jamais incluse. |

### Performance IPC

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | oui (fenêtre 10 s) | `channel`, `duration_bucket` | Le gestionnaire IPC a dépassé le seuil « lent ». |

### Réactivité de l'UI

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | oui (fenêtre 10 s) | `duration_bucket`, `inflight_count`, `oldest_inflight` | La boucle d'événements du renderer a été bloquée plus longtemps que le seuil de gel. |
| `ui.freeze.main_ms` | histogram | oui (fenêtre 10 s) | `duration_bucket`, `inflight_count`, `oldest_inflight`, `top_sql`, `sql_ms` | La boucle d'événements du processus main a été bloquée (via le delay de `perf_hooks`). Le tag `top_sql` est un condensé `<verbe> <table>` de la requête SQL la plus lente mesurée dans cette fenêtre : forme de la requête uniquement, jamais les valeurs des paramètres. |

### Menu contextuel

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ui.context_menu_shown` | event | oui (fenêtre 10 s) | `context` | Le menu contextuel natif (clic droit) a ete affiche. `context` indique quelle section a ete proposee : `link` (lien), `editable` (champ de texte) ou `selection` (texte selectionne non editable). |
| `ui.context_menu_link_action` | event | oui (fenêtre 10 s) | `action` | Un des deux elements de lien du menu contextuel a ete active. `action` vaut `open` (Ouvrir le lien dans le navigateur) ou `copy_address` (Copier l’adresse du lien). Ni l'URL du lien ni son texte visible ne sont jamais inclus. |
| `ui.context_menu_spell_action` | event | oui (fenêtre 10 s) | `action` | Vous avez utilise un element d’orthographe du menu contextuel. `action` vaut `replace` (une suggestion a ete appliquee) ou `add_to_dictionary` (un mot a ete ajoute a votre dictionnaire personnel). Ni le mot ni le remplacement ne sont jamais inclus. |

### Verification orthographique

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `spellcheck.configured` | event | oui (fenêtre 10 s) | `enabled`, `language_count`, `platform_owned` | L’etat de la verification orthographique applique a l’application, au demarrage et apres chaque enregistrement des reglages : si elle est active, COMBIEN de dictionnaires sont actives et si le systeme d’exploitation possede la liste des langues (macOS). Les langues choisies ne sont jamais incluses — seulement leur nombre. |
| `spellcheck.dictionary_consent` | event | non | `outcome`, `language_count` | Comment s’est terminee la demande d’autorisation de telecharger un dictionnaire : `accepted`, `declined`, `blocked_busy` (une autre demande etait deja ouverte), `failed` (la boite de dialogue n’a pas pu s’afficher) ou `unconsented_download` (un telechargement a commence sans reponse enregistree — un defaut dont nous voulons etre informes). Les noms de langues ne sont jamais transmis. |

## Spans de performance

Au-delà des événements discrets et des histogrammes ci-dessus, MailCopilot chronomètre un ensemble fixe d'opérations sous forme de spans de performance Sentry -- le mécanisme que Sentry utilise pour le traçage de latence plutôt que pour les compteurs. Chaque valeur d'attribut ci-dessous est un agrégat : une énumération, un décompte, une durée ou un booléen. Aucun d'eux ne porte de contenu de message, une adresse, une requête, une URL ou un prompt.

### Synchronisation et livraison du courrier

| Span | Type | Agrégé | Attributs | Objectif |
| --- | --- | --- | --- | --- |
| `imap.idle` | span | non | `folder_role`, `provider`, `exit_reason`, `duration_bucket` | Un cycle IDLE : connexion, attente d'une notification push, puis rafraîchissement ou sortie. |
| `imap.sync` | span | non | `folder_role`, `provider`, `changed_since_present`, `fetched_headers_bucket`, `skipped`, `errored` | Une passe de synchronisation des en-têtes pour un dossier, via CONDSTORE ou une récupération complète. |
| `smtp.send` | span | non | `provider`, `size_bucket`, `has_attachments` | Une tentative d'envoi SMTP. |

### Traitement en arrière-plan

| Span | Type | Agrégé | Attributs | Objectif |
| --- | --- | --- | --- | --- |
| `body_indexer.batch` | span | non | `folder_role`, `batch_size_bucket`, `fetched_ok_bucket`, `failed_bucket` | Un lot de messages traité au sein d'un cycle de l'indexeur de corps. |
| `offline.replay` | span | non | `ops_count_bucket`, `failed_bucket`, `uidvalidity_mismatch` | Une relecture des actions hors ligne en attente pour un compte une fois reconnecté. |
| `search.fts` | span | non | `query_len_bucket`, `result_count_bucket` | Un envoi de recherche plein-texte au worker de recherche. |
| `net.message_details` | span | non | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Le gestionnaire du processus principal qui résout le contenu complet d'un message, couvrant tout chemin depuis un hit en mémoire jusqu'à une récupération IMAP fraîche. |

### Latence des fonctionnalités IA

| Span | Type | Agrégé | Attributs | Objectif |
| --- | --- | --- | --- | --- |
| `ai.chat` | span | non | `ai.provider`, `ai.model`, `ai.context_type`, `ai.has_history`, `ai.session_resumed`, `ai.tool_call_count`, `ai.tools_used`, `ai.aborted`, `ai.cost_usd` | Une requête de chat à l'assistant IA, de l'ouverture du flux du fournisseur jusqu'à l'achèvement ou l'annulation. `ai.context_type` et les indicateurs d'historique/de reprise décrivent d'où la conversation a démarré et si elle en poursuivait une précédente -- jamais son contenu. |
| `ai.thread_summary.generate` | span | non | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | Une génération de résumé IA du fil. Ne se déclenche que sur un appel réel au fournisseur, jamais sur un hit de cache. |
| `ai.quick_action.rewrite` | span | non | `preset`, `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | Une réécriture via les actions rapides de rédaction. `preset` retient lequel des préréglages (Améliorer / Raccourcir / Formel) vous avez choisi, jamais le texte de votre brouillon. |
| `ai.instant_reply.generate` | span | non | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `draft_count` | Un appel de génération de réponse instantanée. `draft_count` est le nombre d'options de réponse générées, jamais leur texte. |
| `ai.proofread.check` | span | non | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `edit_count`, `dropped_count` | Une vérification de relecture d'un brouillon. `edit_count` est le nombre de suggestions qui vous ont été proposées ; `dropped_count` est le nombre de suggestions renvoyées par le modèle qui n'ont pas pu être associées à votre texte et ont été écartées. Ce sont uniquement des compteurs — jamais une suggestion, jamais un fragment du brouillon, jamais l'explication affichée à côté d'une suggestion. |
| `ai.translate.message` | span | non | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `source_labeled`, `target_lang`, `cache_hit` | Une traduction de message. Enregistrée aussi pour les résultats en cache — `cache_hit` les distingue, et un résultat en cache ne porte ni tokens ni coût ; un refus pour traduction désactivée, texte vide, message trop long, absence de fournisseur ou budget épuisé n'enregistre aucun span. `target_lang` est un code de langue tiré de la liste fermée de seize valeurs proposée dans le sélecteur de langue cible. `source_labeled` est un booléen qui indique seulement si la détection locale (ou votre propre choix) a pu nommer une langue source pour la légende -- jamais laquelle, car ce serait un fait dérivé du contenu de votre courrier. |
| `ai.translate.draft` | span | non | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `target_lang` | Une traduction de brouillon depuis la fenêtre de composition : votre propre texte du brouillon, traduit sur demande. Enregistrée uniquement lorsqu'un fournisseur a été sélectionné ; un refus pour traduction désactivée, texte vide, absence de texte propre, message trop long, absence de fournisseur ou budget épuisé n'enregistre aucun span. `target_lang` est un code de langue tiré de la même liste fermée de seize valeurs, celle que vous avez choisie dans la fenêtre de composition -- jamais la langue que MailCopilot a pu suggérer pour la réponse, et jamais un indicateur signalant que ce choix provient de cette suggestion : un tel indicateur n'existe pas ici, délibérément, car associé à `target_lang` il révélerait faiblement la langue du message auquel vous répondez -- la même identité que le span ci-dessus, côté lecture, ne divulgue pas. |

L'attribut `provider` des spans de latence IA ci-dessus qui le portent (tous sauf `ai.chat`, qui utilise l'attribut distinct `ai.provider`) prend l'une des valeurs d'un ensemble fixe : `anthropic-api`, `openai-api`, `gemini-api`, `local` (le futur chemin du modèle sur l'appareil), ou `unknown`. Toute valeur non reconnue par MailCopilot est mappée sur `unknown` avant l'enregistrement, si bien que cet attribut ne peut jamais s'élargir à une chaîne libre ou inattendue.

### Base de données locale

| Span | Type | Agrégé | Attributs | Objectif |
| --- | --- | --- | --- | --- |
| `db.upsert_messages` | span | non | `row_count_bucket`, `folder_role` | Une transaction d'upsert de messages par lot. |
| `db.reconcile_uids` | span | non | `row_count_bucket`, `folder_role`, `uidvalidity_changed` | Une passe de réconciliation qui retire du cache local les messages qui ne sont plus sur le serveur. |
| `db.search_messages` | span | non | `query_len_bucket`, `folder_role`, `result_count_bucket` | Un appel de recherche dans le cache local, quel que soit le chemin interne de recherche qui l'a servi. |

## Contact

Des questions ou des réserves sur ce qui est collecté ? Ouvrez une issue sur [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) ou contactez l'équipe directement via le formulaire de retour dans Paramètres -> À propos.
