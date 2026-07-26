---
title: Telemetry
sidebar_position: 2
---

# Telemetrie

MailCopilot collecte une petite quantite de donnees diagnostiques et d'usage anonymes lorsque vous activez **Envoyer un diagnostic et des donnees d'usage anonymes** dans Parametres -> A propos. Cette page documente exactement ce qui est collecte et -- aussi important -- ce qui ne l'est jamais.

## Ce que nous ne collectons jamais

En aucune circonstance, MailCopilot ne transmet :

- Le contenu de vos messages (objet, corps, pieces jointes, brouillons)
- Vos adresses e-mail ni celles de vos contacts
- Les noms ou chemins de dossiers sur votre serveur IMAP
- Les noms de fichiers de pieces jointes
- Le texte de vos requetes de recherche
- Le contenu des conversations ou de la memoire de l'assistant IA
- Les hotes, ports ou identifiants de vos serveurs

## Comment les donnees sont acheminees

Toute la telemetrie est envoyee a [Sentry](https://sentry.io), notre plateforme de monitoring d'erreurs et de performance. Lorsque vous desactivez l'interrupteur dans Parametres, le pipeline est entierement contourne -- rien n'est envoye. Si vous activez la journalisation de debogage, les memes evenements apparaissent aussi dans votre `main.log` local pour que vous puissiez verifier exactement ce qui serait transmis.

### Identifiant d'installation anonyme

Au premier demarrage, MailCopilot genere un UUID aleatoire et le stocke dans le fichier de configuration local. Ce UUID ne quitte jamais votre appareil. A la place, ce qui est transmis est un hash SHA-256 -- tronque a 16 caracteres hexadecimaux -- que nous appelons `install_id_hash`. Il est attache a chaque evenement de telemetrie en tant que Sentry user id pour que nous puissions repondre a des questions du type « combien d'installations distinctes utilisent la version X » ou « le crash Y affecte-t-il 1 ou 100 utilisateurs ». Ce hash est :

- **Anonyme** -- il n'est pas derive de, ni correle avec, une adresse e-mail de compte, une empreinte d'appareil, une adresse IP ou un identifiant materiel.
- **Stable entre versions** -- la meme installation conserve le meme hash apres une mise a jour automatique, de sorte que les metriques de retention survivent aux changements de version.
- **Non reversible** -- il n'existe aucune correspondance de notre cote entre le hash et l'UUID ou votre appareil.
- **Supprime quand vous desactivez la telemetrie** -- basculer l'interrupteur sur off efface immediatement l'identifiant cote client Sentry et arrete toute transmission ulterieure.

Nous utilisons cet identifiant comme un outil d'analyse web utiliserait un identifiant de visiteur anonyme : il nous permet de compter des installations *distinctes* plutot que des *evenements totaux*. Cette difference est la raison meme pour laquelle la telemetrie est utile -- sans elle, une installation bruyante ressemblerait a cent installations calmes.

## Evenements

### Cycle de vie de l'application

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | non | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Une fois au demarrage. Porte `install_id_hash` pour DAU/MAU. |
| `app.session_ended` | histogram | non | `reason`, `install_id_hash` | Une fois a l'arret normal. value_ms = duree de la session. |
| `app.updated` | event | non | `from_version`, `to_version` | Une fois apres l'installation d'une nouvelle version par auto-update. |
| `app.startup_ms` | histogram | non | `accounts_count` | Temps entre `app.whenReady` et la premiere `BrowserWindow` visible. |

### Synthese d'usage

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | non | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | Bitmap de fin de session : quelles fonctionnalites ont ete utilisees au moins une fois ? |

### Mise en route

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | non | `first_run` | L'utilisateur a ouvert l'assistant d'ajout de compte. |
| `onboarding.method_selected` | event | non | `method` | Choix entre OAuth et IMAP/SMTP manuel. |
| `onboarding.autoconfig_result` | event | non | `success`, `provider` | Sondage de l'autoconfiguration termine -- les parametres IMAP/SMTP ont-ils ete trouves ? |
| `onboarding.connection_test_result` | event | non | `kind`, `success`, `failure_kind` | Test de connectivite IMAP ou SMTP termine. |
| `onboarding.google_oauth_result` | event | non | `success`, `failure_kind` | Le flux Google OAuth2 s'est termine. |
| `onboarding.account_saved` | event | non | `provider`, `auth_type` | Identifiants du compte ecrits dans keytar/electron-store. |
| `onboarding.first_headers_sync_completed` | histogram | non | `provider`, `folder_count_bucket` | Temps entre `account_saved` et la fin de la premiere synchro d'en-tetes (value_ms). |
| `onboarding.first_message_opened` | event | non | `time_since_sync_bucket` | L'utilisateur a ouvert son premier message apres la connexion. |

### Redaction

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `compose.opened` | event | non | `source`, `has_draft` | Fenetre de redaction ouverte ; suit le point d'entree. |

### File d'envoi

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `send_queue.enqueued` | event | non | `scheduled`, `send_and_archive`, `has_attachments`, `body_size_bucket` | Message sortant ajoute a `send_queue` (immediat ou planifie). |
| `send_queue.sent` | histogram | non | `scheduled` | Temps entre l'ajout en file et la livraison reussie -- SMTP pour la plupart des comptes, Microsoft Graph pour Outlook (value_ms). |
| `send_queue.failed` | event | non | `failure_kind` | Tentative d'envoi definitivement echouee (la file a abandonne). Couvre les chemins SMTP et Microsoft Graph. |
| `send_queue.retried` | event | non | `attempt_number` | Erreur d'envoi transitoire -- message reprogramme. Couvre les chemins SMTP et Microsoft Graph. |

### Avertissements de mauvais destinataire

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `misdirection.prompted` | event | non | `kind` | La fenetre de redaction a affiche le dialogue d'avertissement. |
| `misdirection.outcome` | event | non | `outcome`, `kind` | L'utilisateur a repondu a l'avertissement. |

### Modeles

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `template.applied` | event | non | `var_count` | L'utilisateur a insere un modele dans la redaction. |

### Rappels de relance

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `followup.created` | event | non | `duration_days_bucket` | Une relance a ete attachee a un message sortant. |

### Recherche

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | non | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | Latence de bout en bout d'une recherche FTS (cote main, avant fusion distante). Sera remplace par `search.completed` en PR 2. |
| `search.error` | event | non | `scope`, `kind` | Le gestionnaire de recherche a leve une erreur -- soit annulation utilisateur, soit echec reel. |

### Indexeur de corps

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | non | `indexed`, `folders_scanned` | Un cycle complet de l'indexeur sur tous les dossiers. |
| `body_indexer.coverage_pct` | gauge | non | `total_messages`, `indexed_messages` | Fraction des messages en cache dont `body_text` est indexe. |
| `body_indexer.backlog` | gauge | non | -- | Nombre absolu de messages en cache encore sans `body_text`. |
| `body_indexer.folder_error` | event | non | `folder_role`, `error_streak`, `backoff_ms` | L'indexeur a rencontre une serie d'erreurs sur un dossier et est passe en backoff. |

### Maintenance de l'index plein-texte

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `fts.optimize.duration_ms` | histogram | non | `segments_before`, `segments_after`, `reduction` | Passe FTS5 optimize : duree et nombre de segments avant/apres. |
| `fts.optimize.failed` | event | non | `reason` | FTS5 optimize a leve une erreur. |

### Synchronisation des en-tetes

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | non | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Execution complete de `syncFolderHeaders` -- separation upsert / autre pour le profilage. |
| `sync.headers.coalesced` | event | non | `folder_role` | Une tentative `syncFolderHeaders` doublee s'est rattachee a une execution en cours. |

### Instrumentation de l'ouverture des messages

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | non | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Latence de bout en bout de l'ouverture d'un message, observee cote renderer (du clic jusqu'au rendu du corps). Le tag `cache_hit_level` indique le niveau de cache qui a servi le corps : `memory`, `db`, `eml`, `imap` ou `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | non | `cache_hit_level` | Temps wall du gestionnaire IPC `net:messageDetails` cote processus principal. Isole la latence serveur du bruit du trajet aller-retour renderer vers main. Un echantillon par branche terminale (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | non | `requester`, `wait_ms_bucket` | Temps d'attente pour acquerir une connexion dans le pool IMAP par compte. Emis uniquement lorsque l'attente depasse 500 ms, afin que les tableaux de bord capturent la longue queue sans bruit des acquisitions rapides. |

### Rafraichissement des jetons OAuth IMAP

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | non | `provider` | Rafraichissement du jeton OAuth declenche par un echec d'authentification IMAP (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | non | `provider` | Le rafraichissement a reussi -- la nouvelle tentative IMAP utilisera le jeton frais. |
| `imap.auth_refresh_failure` | event | non | `provider`, `reason` | Le rafraichissement a echoue -- l'erreur d'authentification d'origine remonte a l'appelant. |
| `imap.auth_refresh_suppressed` | event | non | `reason` | Le cooldown par compte a empeche une tentative de rafraichissement, pour eviter des rafales de requetes `/token` quand un refresh token a ete revoque. |
| `imap.idle_auth_refreshed` | event | non | `provider` | La boucle IDLE s'est remise d'un echec d'authentification en cours de cycle via un rafraichissement in-loop -- la livraison push reprend sans le backoff de 60 min. |
| `imap.auth_refresh_exhausted` | event | non | `provider`, `consecutive` | La boucle IDLE a declenche le storm-brake : N rafraichissements consecutifs ont reussi cote fournisseur mais IMAP a continue a rejeter les jetons frais, donc on retombe sur le backoff d'authentification ordinaire. |

### Retention du cache

| Événement | Type | Agrégé | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | non | `count_bucket`, `freed_bytes_bucket` | La purge de retention a supprime des fichiers `.eml` plus anciens que la limite configuree. Les quantites et les tailles sont regroupees en intervalles — aucun chemin ni nombre exact n'est transmis. |
| `cache.folder_index_disabled` | event | non | `count`, `role` | Un dossier a ete exclu de la recherche plein-texte — automatiquement pour Junk/Spam/Corbeille a la premiere enregistrement, ou manuellement via le menu contextuel du dossier. `role` : `spam`, `trash` ou `manual`. |

### Signaux de securite du cache et de perte de donnees

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | non | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | Un `DELETE FROM messages` a la portee du dossier a ete emis. Chaque site d'appel fournit une raison pour distinguer une regression qui efface un cache sain d'un bump UIDVALIDITY legitime. |
| `imap.stale_wipe_guard_tripped` | event | non | `folder_role`, `provider` | La protection mass-delete a refuse de purger le cache local du dossier parce que `mailbox.exists` est revenu non numerique. Un pic indique un probleme de fournisseur ou de connexion, pas une perte de donnees utilisateur. |
| `db.shutdown_wal_checkpoint_ms` | histogram | non | `busy`, `reclaimed_kb_bucket`, `ok` | Duree du `PRAGMA wal_checkpoint(TRUNCATE)` execute avant la fermeture pour garantir que les ecritures committees mais non checkpointees survivent au redemarrage. |

### Garde stdio MCP (protection renderer-vers-RCE)

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `mcp.stdio.connect_attempted` | event | non | `approved_source` | Le transport stdio MCP est sur le point d'etre lance -- emis une fois par connect reussi apres les portes d'approbation et d'allowlist. |
| `mcp.stdio.connect_blocked` | event | non | `reason` | La connexion ou la sauvegarde stdio a ete refusee par la garde (`not_approved`, `unapproved_command`, `forbidden_field`, `forbidden_env_key`, `env_disabled`). |
| `mcp.stdio.approval_granted` | event | non | `source`, `scope` | L'utilisateur a accorde l'approbation stdio MCP (activation globale ou par connexion) ; `source` distingue env vs native-confirm, `scope` distingue global vs par connexion. |
| `mcp.stdio.env_sanitized_on_load` | event | non | `count_bucket` | La migration de configuration a retire les cles d'env loader-hook interdites des connexions MCP persistantes au chargement. Au plus une fois par lancement. |

### Audit des actions IA (barriere preview -> apply)

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ai.action.preview_created` | event | non | `kind` | Un outil MCP `*_preview` a enregistre une action mutante en attente du clic Apply de l'utilisateur. |
| `ai.action.applied` | event | non | `kind` | Un outil MCP `*_apply` a execute avec succes une action mutante precedemment confirmee. |
| `ai.action.rejected` | event | non | `kind`, `reason` | Un appel `*_apply` a ete rejete a la porte de validation (preview manquant/expire, jeton manquant ou non concordant, kind mismatch, callback manquant ou rate limit). |
| `ai.action.expired` | event | non | `kind` | Une action mutante en attente a expire sans que l'utilisateur ait clique Apply (TTL). |
| `ai.action.apply_duration_ms` | histogram | non | `kind` | Duree d'un apply reussi -- combien de temps a pris la mutation sous-jacente (DB / IMAP / SMTP). |

### Garde de sortie reseau de l'IA

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | non | `tool_name`, `account_id` | Un appel d'outil sortant (par ex. `WebSearch`, `WebFetch`, un outil MCP externe generique) a ete refuse pendant que les donnees email de l'utilisateur etaient dans le perimetre -- soit filtre du toolset SDK, soit arrete par la garde runtime. |
| `ai.egress.allowed_once` | event | non | `tool_name`, `account_id` | L'utilisateur a accorde un consentement ponctuel pour la sortie reseau et l'IA en a use. Permet de distinguer "les utilisateurs court-circuitent regulierement" de "la garde tient, les tentatives sont surtout des injections". |

### Performance IPC

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | oui (fenetre 10 s) | `channel`, `duration_bucket` | Le gestionnaire IPC a depasse le seuil « lent ». |

### Reactivite de l'UI

| Evenement | Type | Agrege | Tags | Objectif |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | oui (fenetre 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | La boucle d'evenements du renderer a ete bloquee plus longtemps que le seuil de gel. |
| `ui.freeze.main_ms` | histogram | oui (fenetre 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | La boucle d'evenements du processus main a ete bloquee (via le delay de `perf_hooks`). |

## Contact

Des questions ou des reserves sur ce qui est collecte ? Ouvrez une issue sur [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) ou contactez l'equipe directement via le formulaire de retour dans Parametres -> A propos.
