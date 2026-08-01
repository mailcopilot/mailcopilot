---
title: Telemetry
sidebar_position: 2
---

# Télémétrie

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

Chaque fois que vous envoyez un message à l'assistant IA, MailCopilot enregistre une entrée de journal structurée une fois la requête terminée, en plus du booléen de synthèse d'usage évoqué plus haut. Cette entrée porte : le **fournisseur IA** (par exemple le fournisseur de votre clé API, ou « subscription »), le **modèle** qui a traité la requête, le **nombre total d'appels d'outils** et les **noms des outils qu'il a appelés** (par exemple `send_email` ou `mail_action`, jamais les arguments qui leur ont été passés), si la requête a été annulée ou a échoué, et le **coût estimé** de la requête en USD lorsque le fournisseur expose ses tarifs. Rien de tout cela n'inclut le texte de votre requête, la réponse de l'IA ou du contenu d'e-mail -- pour le détail complet de ce que l'assistant IA lui-même envoie aux fournisseurs (un sujet distinct et beaucoup plus vaste, à ne pas confondre avec cette entrée de journal structurée), voir [Données IA et journal d'audit](./ai-data). Les mesures de latence propres à chaque fonctionnalité IA portent leurs propres champs agrégés (type de contexte de la conversation, présence ou non d'un historique, nombres de tokens, préréglage de réécriture utilisé, nombre de brouillons de réponse générés et similaires) -- voir [Spans de performance](#spans-de-performance) ci-dessous.

## Événements

### Cycle de vie de l'application

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | non | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Une fois au démarrage. Porte `install_id_hash` pour DAU/MAU. |
| `app.session_ended` | histogram | non | `reason`, `install_id_hash` | Une fois à l'arrêt normal. value_ms = durée de la session. |
| `app.updated` | event | non | `from_version`, `to_version` | Une fois après l'installation d'une nouvelle version par auto-update. |
| `app.startup_ms` | histogram | non | `accounts_count` | Temps entre `app.whenReady` et la première `BrowserWindow` visible. |
| `window.rescued` | event | non | `windows_moved`, `pass` | Une passe de sauvetage a ramené dans l'écran au moins une fenêtre qui en était sortie, après un changement de configuration d'affichage (branchement d'un moniteur, changement de résolution, sortie de veille). |

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
| `search.duration_ms` | histogram | non | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | Latence de bout en bout d'une recherche FTS (côté main, avant fusion distante). Sera remplacé par `search.completed` en PR 2. |
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
| `fts.optimize.duration_ms` | histogram | non | `segments_before`, `segments_after`, `reduction` | Passe FTS5 optimize : durée et nombre de segments avant/après. |
| `fts.optimize.failed` | event | non | `reason` | FTS5 optimize a levé une erreur. |

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

### Performance IPC

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | oui (fenêtre 10 s) | `channel`, `duration_bucket` | Le gestionnaire IPC a dépassé le seuil « lent ». |

### Réactivité de l'UI

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | oui (fenêtre 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | La boucle d'événements du renderer a été bloquée plus longtemps que le seuil de gel. |
| `ui.freeze.main_ms` | histogram | oui (fenêtre 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | La boucle d'événements du processus main a été bloquée (via le delay de `perf_hooks`). |

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
| `ai.quick_action.rewrite` | span | non | `preset`, `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | Une réécriture via les actions rapides de rédaction. `preset` retient lequel des préréglages (Améliorer / Raccourcir / Formel / Corriger la grammaire) vous avez choisi, jamais le texte de votre brouillon. |
| `ai.instant_reply.generate` | span | non | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `draft_count` | Un appel de génération de réponse instantanée. `draft_count` est le nombre d'options de réponse générées, jamais leur texte. |

### Base de données locale

| Span | Type | Agrégé | Attributs | Objectif |
| --- | --- | --- | --- | --- |
| `db.upsert_messages` | span | non | `row_count_bucket`, `folder_role` | Une transaction d'upsert de messages par lot. |
| `db.reconcile_uids` | span | non | `row_count_bucket`, `folder_role`, `uidvalidity_changed` | Une passe de réconciliation qui retire du cache local les messages qui ne sont plus sur le serveur. |
| `db.search_messages` | span | non | `query_len_bucket`, `folder_role`, `result_count_bucket` | Un appel de recherche dans le cache local, quel que soit le chemin interne de recherche qui l'a servi. |

## Contact

Des questions ou des réserves sur ce qui est collecté ? Ouvrez une issue sur [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) ou contactez l'équipe directement via le formulaire de retour dans Paramètres -> À propos.
