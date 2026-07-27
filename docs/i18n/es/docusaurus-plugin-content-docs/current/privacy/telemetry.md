---
title: Telemetry
sidebar_position: 2
---

# Telemetria

MailCopilot recopila una pequena cantidad de datos anonimos de diagnostico y de uso cuando activas **Enviar diagnosticos y datos de uso anonimos** en Ajustes -> Acerca de. Esta pagina documenta exactamente que se recopila y -- igual de importante -- que no se recopila nunca.

## Lo que nunca recopilamos

En ningun caso MailCopilot transmite:

- El texto de tus mensajes (asunto, cuerpo, adjuntos, borradores)
- Tus direcciones de correo ni las de tus contactos
- Nombres o rutas de carpetas en tu servidor IMAP
- Nombres de archivos de adjuntos
- El texto de tus consultas de busqueda
- El contenido de las conversaciones del asistente IA o de su memoria
- Hosts, puertos o credenciales de servidores

## Como se enrutan los datos

Toda la telemetria se envia a [Sentry](https://sentry.io), nuestra plataforma de monitorizacion de errores y rendimiento. Cuando desactivas el interruptor en Ajustes, la canalizacion se omite por completo: no se envia nada. Si activas el registro de depuracion, los mismos eventos aparecen ademas en tu archivo local `main.log` para que puedas inspeccionar exactamente que se transmitiria.

### Identificador de instalacion anonimo

En el primer arranque, MailCopilot genera un UUID aleatorio y lo guarda en el archivo de configuracion local. Ese UUID nunca sale de tu dispositivo. Lo que se transmite en su lugar es un hash SHA-256 del mismo, truncado a 16 caracteres hexadecimales, al que llamamos `install_id_hash`. Se adjunta a cada evento de telemetria como Sentry user id para que podamos responder a preguntas como «cuantas instalaciones distintas usan la version X» o «el crash Y afecta a 1 usuario o a 100». El hash es:

- **Anonimo**: no se deriva ni se correlaciona con un email de cuenta, una huella del dispositivo, una direccion IP ni un identificador de hardware.
- **Estable entre versiones**: la misma instalacion conserva el mismo hash tras una autoactualizacion, de modo que las metricas de retencion sobreviven a los cambios de version.
- **No reversible**: en nuestro lado no existe correspondencia entre el hash y el UUID original ni con tu dispositivo.
- **Se descarta al desactivar la telemetria**: poner el interruptor de Ajustes en off limpia inmediatamente el identificador en el cliente Sentry y detiene cualquier transmision posterior.

Usamos este identificador como una herramienta de analitica web usaria un visitor id anonimo: nos permite contar instalaciones *distintas* en lugar de *eventos totales*. Esa diferencia es justamente lo que hace que la telemetria sea util: sin ella, una instalacion ruidosa pareceria igual a cien tranquilas.

## Eventos

### Ciclo de vida de la app

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | no | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Una vez por arranque. Lleva `install_id_hash` para DAU/MAU. |
| `app.session_ended` | histogram | no | `reason`, `install_id_hash` | Una vez al cierre normal. value_ms = duracion de la sesion. |
| `app.updated` | event | no | `from_version`, `to_version` | Una vez tras instalar una nueva version por autoactualizacion. |
| `app.startup_ms` | histogram | no | `accounts_count` | Tiempo desde `app.whenReady` hasta el primer `BrowserWindow` visible. |

### Resumen de uso

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | no | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | Mapa de bits al cierre: que funciones se usaron al menos una vez. |

### Onboarding

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | no | `first_run` | El usuario abrio el flujo de anadir cuenta. |
| `onboarding.method_selected` | event | no | `method` | El usuario eligio entre OAuth o IMAP/SMTP manual. |
| `onboarding.autoconfig_result` | event | no | `success`, `provider` | Sondeo de autoconfiguracion finalizado: ¿se encontraron los ajustes IMAP/SMTP? |
| `onboarding.connection_test_result` | event | no | `kind`, `success`, `failure_kind` | Test de conectividad IMAP o SMTP finalizado. |
| `onboarding.google_oauth_result` | event | no | `success`, `failure_kind` | Flujo de Google OAuth2 finalizado. |
| `onboarding.account_saved` | event | no | `provider`, `auth_type` | Credenciales de la cuenta escritas en keytar/electron-store. |
| `onboarding.first_headers_sync_completed` | histogram | no | `provider`, `folder_count_bucket` | Tiempo desde `account_saved` hasta la primera sincronizacion completa de cabeceras (value_ms). |
| `onboarding.first_message_opened` | event | no | `time_since_sync_bucket` | El usuario abrio su primer mensaje tras iniciar sesion. |

### Redaccion

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `compose.opened` | event | no | `source`, `has_draft` | Ventana de redaccion abierta; rastrea el punto de entrada. |

### Cola de envio

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `send_queue.enqueued` | event | no | `scheduled`, `send_and_archive`, `has_attachments`, `body_size_bucket` | Mensaje saliente anadido a `send_queue` (inmediato o programado). |
| `send_queue.sent` | histogram | no | `scheduled` | Tiempo desde el encolado hasta la entrega exitosa: SMTP para la mayoria de cuentas, Microsoft Graph para Outlook (value_ms). |
| `send_queue.failed` | event | no | `failure_kind` | Intento de envio fallido de forma permanente (la cola se rinde). Cubre tanto SMTP como Microsoft Graph. |
| `send_queue.retried` | event | no | `attempt_number` | Error de envio transitorio: mensaje reprogramado. Cubre tanto SMTP como Microsoft Graph. |

### Avisos de destinatario erroneo

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `misdirection.prompted` | event | no | `kind` | Redaccion mostro el dialogo de advertencia. |
| `misdirection.outcome` | event | no | `outcome`, `kind` | El usuario respondio al aviso. |

### Plantillas

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `template.applied` | event | no | `var_count` | El usuario inserto una plantilla en la redaccion. |

### Recordatorios de seguimiento

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `followup.created` | event | no | `duration_days_bucket` | Se asocio un recordatorio de seguimiento a un mensaje saliente. |

### Busqueda

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | no | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | Latencia extremo a extremo de la busqueda FTS (lado main, antes del merge remoto). Se sustituira por `search.completed` en PR 2. |
| `search.error` | event | no | `scope`, `kind` | El manejador de busqueda lanzo: cancelacion del usuario o fallo real. |

### Indexador de cuerpos

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | no | `indexed`, `folders_scanned` | Un tick completo del indexador a traves de todas las carpetas. |
| `body_indexer.coverage_pct` | gauge | no | `total_messages`, `indexed_messages` | Fraccion de mensajes en cache cuyo `body_text` esta indexado. |
| `body_indexer.backlog` | gauge | no | -- | Numero absoluto de mensajes en cache aun sin `body_text`. |
| `body_indexer.folder_error` | event | no | `folder_role`, `error_streak`, `backoff_ms` | El indexador acumulo errores en una carpeta y entro en backoff. |

### Mantenimiento del indice de texto completo

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `fts.optimize.duration_ms` | histogram | no | `segments_before`, `segments_after`, `reduction` | Pasada FTS5 optimize: tiempo y numero de segmentos antes/despues. |
| `fts.optimize.failed` | event | no | `reason` | FTS5 optimize lanzo un error. |

### Sincronizacion de cabeceras

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | no | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Ejecucion completa de `syncFolderHeaders`: separa upsert del resto para perfilar. |
| `sync.headers.coalesced` | event | no | `folder_role` | Un intento duplicado de `syncFolderHeaders` se enganchó a una ejecución en curso. |

### Instrumentacion de apertura de mensajes

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | no | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Latencia de extremo a extremo de la apertura de un mensaje, observada desde el renderer (desde el clic hasta el renderizado del cuerpo). La etiqueta `cache_hit_level` indica que nivel de cache sirvio el cuerpo: `memory`, `db`, `eml`, `imap` o `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | no | `cache_hit_level` | Tiempo de pared del manejador IPC `net:messageDetails` en el proceso principal. Aisla la latencia del servidor del ruido del viaje de ida y vuelta renderer a main. Una muestra por rama terminal (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | no | `requester`, `wait_ms_bucket` | Tiempo de espera para adquirir una conexion del pool IMAP por cuenta. Se emite solo cuando la espera supera 500 ms, para que los paneles capturen la cola larga sin ruido de adquisiciones rapidas. |

### Renovacion de tokens OAuth de IMAP

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | no | `provider` | Renovacion del token OAuth disparada por un fallo de autenticacion IMAP (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | no | `provider` | La renovacion tuvo exito: el reintento IMAP usara el token recien obtenido. |
| `imap.auth_refresh_failure` | event | no | `provider`, `reason` | La renovacion fallo: el error de autenticacion original se propaga al llamador. |
| `imap.auth_refresh_suppressed` | event | no | `reason` | El cooldown por cuenta suprimio un intento de renovacion para evitar tormentas de peticiones a `/token` cuando un refresh token ha sido revocado. |
| `imap.idle_auth_refreshed` | event | no | `provider` | El bucle IDLE se recupero de un fallo de autenticacion en mitad del ciclo via una renovacion in-loop: la entrega push siguio sin el backoff de 60 min. |
| `imap.auth_refresh_exhausted` | event | no | `provider`, `consecutive` | El bucle IDLE activo el storm-brake: N renovaciones consecutivas tuvieron exito en el proveedor pero IMAP siguio rechazando los tokens nuevos, asi que volvemos al backoff de autenticacion habitual. |

### Retencion del cache

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | no | `count_bucket`, `freed_bytes_bucket` | La purga de retencion elimino archivos `.eml` mas antiguos que el limite configurado. Los recuentos y los tamanos se transmiten solo como rangos — no se envian rutas ni numeros exactos. |
| `cache.folder_index_disabled` | event | no | `count`, `role` | Una carpeta fue excluida de la busqueda de texto completo — automaticamente para Junk/Spam/Papelera en el primer registro, o manualmente mediante el menu contextual de carpeta. `role`: `spam`, `trash` o `manual`. |

### Senales de seguridad del cache y de perdida de datos

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | no | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | Se emitio un `DELETE FROM messages` a nivel de carpeta. Cada llamador suministra un motivo para distinguir una regresion que borra una cache sana de un bump UIDVALIDITY legitimo. |
| `imap.stale_wipe_guard_tripped` | event | no | `folder_role`, `provider` | La proteccion mass-delete se nego a vaciar la cache local de la carpeta porque `mailbox.exists` no era numerico. Un pico aqui apunta a un problema del proveedor o de conexion, no a perdida real de datos. |
| `db.shutdown_wal_checkpoint_ms` | histogram | no | `busy`, `reclaimed_kb_bucket`, `ok` | Duracion del `PRAGMA wal_checkpoint(TRUNCATE)` que ejecutamos antes de salir, para que las escrituras committed-pero-no-checkpointed sobrevivan al reinicio. |

### Puerta stdio MCP (proteccion renderer-a-RCE)

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `mcp.stdio.connect_attempted` | event | no | `approved_source` | El transporte stdio MCP esta a punto de arrancar: se emite una vez por connect exitoso tras pasar las puertas de aprobacion y allowlist. |
| `mcp.stdio.connect_blocked` | event | no | `reason` | Conexion o guardado stdio rechazado por la puerta (`not_approved`, `unapproved_command`, `forbidden_field`, `forbidden_env_key`, `env_disabled`). |
| `mcp.stdio.approval_granted` | event | no | `source`, `scope` | El usuario concedio la aprobacion stdio MCP (activacion global o por conexion); `source` distingue env vs native-confirm, `scope` distingue global vs por conexion. |
| `mcp.stdio.env_sanitized_on_load` | event | no | `count_bucket` | La migracion de ajustes elimino claves de entorno loader-hook prohibidas de las conexiones MCP persistidas al cargar. A lo sumo una vez por arranque. |

### Auditoria de acciones de IA (barrera preview -> apply)

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `ai.action.preview_created` | event | no | `kind` | Una herramienta MCP `*_preview` registro una accion mutadora pendiente, esperando el clic Apply del usuario. |
| `ai.action.applied` | event | no | `kind` | Una herramienta MCP `*_apply` ejecuto con exito una accion mutadora confirmada previamente. |
| `ai.action.rejected` | event | no | `kind`, `reason` | Una llamada `*_apply` fue rechazada en la puerta de validacion (preview ausente/expirado, token ausente o no coincidente, kind mismatch, callback ausente o rate limit). |
| `ai.action.expired` | event | no | `kind` | Una accion mutadora pendiente expiro sin que el usuario hiciera clic en Apply (TTL). |
| `ai.action.apply_duration_ms` | histogram | no | `kind` | Duracion de un apply exitoso: cuanto duro la mutacion subyacente (DB / IMAP / SMTP). |

### Puerta de salida (egress) de IA

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | no | `tool_name`, `account_id` | Una llamada a una herramienta de salida (por ejemplo, `WebSearch`, `WebFetch`, una herramienta MCP externa generica) fue rechazada mientras los datos de correo del usuario estaban en el alcance: filtrada del toolset del SDK o detenida por la puerta en runtime. |
| `ai.egress.allowed_once` | event | no | `tool_name`, `account_id` | El usuario otorgo un consentimiento puntual para la salida y la IA lo uso. Permite distinguir «los usuarios anulan rutinariamente» de «la puerta aguanta, los intentos son sobre todo por inyeccion». |

### Rendimiento de IPC

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | si (ventana 10 s) | `channel`, `duration_bucket` | El manejador IPC supero el umbral «lento». |

### Capacidad de respuesta de la UI

| Evento | Tipo | Agregado | Etiquetas | Proposito |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | si (ventana 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | El bucle de eventos del renderer estuvo bloqueado mas que el umbral de congelacion. |
| `ui.freeze.main_ms` | histogram | si (ventana 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | El bucle de eventos del proceso main estuvo bloqueado (medido con `perf_hooks` delay). |

## Contacto

¿Preguntas o dudas sobre lo que recopilamos? Abre una incidencia en [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) o contacta con el equipo directamente a traves del formulario de comentarios en Ajustes -> Acerca de.
