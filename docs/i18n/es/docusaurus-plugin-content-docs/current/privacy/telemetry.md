---
title: Telemetry
sidebar_position: 2
---

# Telemetría

MailCopilot puede enviar una pequeña cantidad de datos de diagnóstico y de uso -- pero solo después de que des tu consentimiento activo. Nunca contienen el contenido de tu correo, pero sí un identificador aleatorio de esta instalación, por lo que los datos **no son totalmente anónimos**: consulta [Identificador de instalación](#identificador-de-instalación) más abajo para saber exactamente qué permite y qué no permite averiguar ese identificador. Esta página documenta exactamente qué se recopila y -- igual de importante -- qué no se recopila nunca.

## Consentimiento en el primer arranque

La primera vez que inicias MailCopilot, antes de que se abra el asistente de configuración de cuenta, verás una pantalla de consentimiento titulada **¿Enviar datos de diagnóstico?**. Enumera qué se enviaría si lo permites y qué no se envía nunca, y ofrece dos botones del mismo tamaño: **Permitir** y **No permitir**. Ninguno de los dos está preseleccionado ni destacado, y no hay ninguna casilla premarcada -- tienes que hacer una elección activa.

De ahí se derivan varias cosas:

- **No se recopila nada antes de que respondas, no solo que no se envía.** Los contadores y búferes de diagnóstico y de uso no se abren mientras el consentimiento está pendiente -- MailCopilot no acumula en silencio un rezago para enviarlo de golpe en cuanto lo permitas. Lo que ocurrió antes de tu respuesta simplemente desaparece; en el momento en que lo permites, el conteo empieza de cero desde ese instante (una medición de duración de sesión, por ejemplo, empieza a contar desde el momento del consentimiento, no desde el inicio de la aplicación).
- **Cerrar la pantalla o pulsar Escape cuenta como "No permitir".** No hay forma de cerrar la pantalla y terminar habiendo consentido.
- **Tu decisión se guarda junto con la versión de esta divulgación.** MailCopilot solo vuelve a mostrar la pantalla si la lista de lo recopilado realmente se amplía -- una nueva categoría de datos, un nuevo destino, o un alcance más amplio que antes. Las actualizaciones normales de la aplicación, los ajustes de redacción y las correcciones de errores nunca provocan una nueva pregunta.
- **Si ya habías desactivado el diagnóstico** en Ajustes -> Acerca de antes de que existiera esta pantalla, esa negativa se respeta y no se te vuelve a preguntar. A todos los demás se les desactiva el diagnóstico automáticamente, y se les pregunta una vez en el siguiente inicio.
- **Puedes cambiar de opinión en cualquier momento** en **Ajustes -> Acerca de**. Hasta que respondas a la pregunta inicial, el interruptor allí se muestra apagado y deshabilitado, con una nota que explica que solo tendrá efecto una vez que respondas en la pantalla de consentimiento.

## Qué enviamos

Si lo permites, MailCopilot envía:

- **Errores y fallos** -- el tipo de error y la traza de la pila que indica en qué punto del código ocurrió. Algunas rutas de fallo ya pasan por un conjunto cerrado de campos estructurales que descarta por completo el texto de un servidor de terceros -- por ejemplo, cuando falla el guardado de una copia de un mensaje enviado en tu carpeta Enviados, el diagnóstico lleva el rol de la carpeta (`sent`, nunca su nombre), un hash SHA-256 con sal del identificador del mensaje, truncado a 12 caracteres hexadecimales (nunca el identificador en sí -- esto es una etiqueta seudónima, no una anonimización: quien tenga un identificador de mensaje candidato puede confirmar una coincidencia recalculando el hash), la longitud de la respuesta del servidor y un conjunto cerrado de códigos de protocolo (como `AUTHENTICATIONFAILED` u `OVERQUOTA`). Otros informes de error que aún no se han convertido a esta forma estructurada todavía pueden reenviar texto de un servidor de terceros, atrapado solo por la limpieza de direcciones y rutas descrita más abajo -- no por una garantía estructural -- consulta [Cómo se limpian direcciones y rutas](#cómo-se-limpian-direcciones-y-rutas).
- **Versiones** -- la versión de MailCopilot, tu sistema operativo y la versión de este.
- **Rendimiento** -- la duración de operaciones como la sincronización de correo, la búsqueda, el envío y las peticiones a la IA.
- **Uso de funciones** -- qué funciones has usado en una sesión y con qué frecuencia (búsqueda, redacción de mensajes, IA, reglas, plantillas, posponer y más), además, cuando usas el asistente de IA, qué proveedor y modelo atendieron la petición y el coste estimado de esa petición. Consulta [Registro de uso de IA](#registro-de-uso-de-ia) más abajo para los campos específicos de la IA.
- **Contexto de configuración** -- cuántas cuentas tienes conectadas, el tipo de servicio de correo de cada una (por ejemplo, Gmail u Outlook), cómo iniciaste sesión (OAuth o contraseña), el idioma de tu interfaz y tu tema.
- **Identificador de instalación** -- un identificador aleatorio creado en el primer arranque, descrito en detalle más abajo. Conecta los datos de tus distintas sesiones entre sí -- por eso mismo los datos no son totalmente anónimos.

## Lo que nunca recopilamos

MailCopilot no diseña ninguna ruta de código para enviar lo siguiente. En el caso de las métricas tipadas y del diagnóstico de fallo al guardar la copia enviada, es una garantía absoluta, reforzada por un conjunto cerrado de campos estructurales que el código tiene permitido rellenar. El resto de informes de diagnóstico dependen sobre todo de que el punto de envío no ponga ahí el contenido en primer lugar, respaldado por un filtro basado en formas que atrapa, como segunda capa, formas reconocibles de direcciones y rutas -- no un filtro universal de contenido. Consulta [Cómo se limpian direcciones y rutas](#cómo-se-limpian-direcciones-y-rutas) más abajo para ver exactamente qué atrapa y qué no atrapa esa segunda capa.

- El texto de tus mensajes (asunto, cuerpo, adjuntos, borradores)
- Tus direcciones de correo ni las de tus contactos -- el formulario de comentarios en Ajustes -> Acerca de es el único lugar donde se envía una dirección a propósito, cuando escribes allí tú mismo una para poder recibir una respuesta.
- Los nombres o rutas de tus carpetas en tu servidor IMAP -- en los datos solo aparece el tipo general de carpeta (como Bandeja de entrada, Enviados o Papelera), nunca el nombre que le hayas puesto
- Nombres de archivos de adjuntos
- Lo que escribes en la búsqueda -- solo se cuentan la longitud de la consulta y el número de resultados, nunca el texto en sí
- El contenido de las conversaciones del asistente IA o de su memoria
- Hosts, puertos o credenciales de servidores
- Tu dirección IP como dato adjunto -- cada evento le indica explícitamente a Sentry que no registre ninguna. La propia conexión de red expone inevitablemente tu IP a todo aquello por lo que pasa en tránsito; lo que un servidor receptor, un proxy o sus propios registros hagan con ella es una cuestión de configuración de esa infraestructura, no algo que controle la carga útil de MailCopilot.
- El nombre de tu cuenta del sistema operativo en los informes de diagnóstico que construimos -- los vacíos documentados están en [Cómo se limpian direcciones y rutas](#cómo-se-limpian-direcciones-y-rutas)

## Cómo se enrutan los datos

Toda la telemetría se envía a [Sentry](https://sentry.io), nuestra plataforma de monitorización de errores y rendimiento, y solo después de que la hayas permitido en la pantalla de consentimiento (o más tarde, activando el interruptor en Ajustes -> Acerca de). Cuando el diagnóstico está desactivado -- ya sea porque lo rechazaste, aún no has respondido, o desactivaste el interruptor más tarde -- la canalización se omite por completo y no se envía nada. Si activas el registro de depuración, los mismos eventos aparecen además en tu archivo local `main.log` para que puedas inspeccionar exactamente qué se transmitiría.

### Identificador de instalación

En el primer arranque, MailCopilot genera un UUID aleatorio y lo guarda en el archivo de configuración local. Ese UUID nunca sale de tu dispositivo. Lo que se transmite en su lugar es un hash SHA-256 del mismo, truncado a 16 caracteres hexadecimales, al que llamamos `install_id_hash`. Se adjunta a cada evento de telemetría como Sentry user id, en cada evento y transacción, no solo en los de nivel de sesión, para que podamos responder a preguntas como «cuántas instalaciones distintas usan la versión X» o «el crash Y afecta a 1 usuario o a 100». El hash es:

- **Seudónimo, no identificativo, pero tampoco inconectable** -- no se deriva de un email de cuenta, una huella del dispositivo, una dirección IP ni un identificador de hardware, y en nuestro lado no existe correspondencia que lo devuelva al UUID ni a tu dispositivo. Pero está deliberadamente pensado como un identificador estable de esta instalación concreta: enlaza en un mismo hilo cada evento y transacción que esta instalación envíe jamás -- y, como cualquier identificador seudónimo entregado a un tercero, en principio podría cruzarse con otros datos disponibles para Sentry o para nosotros. Esta es la razón por la que la pantalla de consentimiento llama a los datos «no totalmente anónimos» en lugar de anónimos.
- **Estable entre versiones**: la misma instalación conserva el mismo hash tras una autoactualización, de modo que las métricas de retención sobreviven a los cambios de versión.
- **Se descarta al desactivar la telemetría**: poner el interruptor de Ajustes en off limpia inmediatamente el identificador en el cliente Sentry y detiene cualquier transmisión posterior.

Usamos este identificador como una herramienta de analítica web usaría un visitor id: nos permite contar instalaciones *distintas* en lugar de *eventos totales*. Esa diferencia es justamente lo que hace que la telemetría sea útil: sin ella, una instalación ruidosa parecería igual a cien tranquilas.

### Cómo se limpian direcciones y rutas

Dos filtros basados en la forma del texto se ejecutan sobre cada evento saliente y cada entrada de registro estructurada, en ambos procesos -- el principal y el renderer --, como última parada antes de la transmisión -- con una excepción: el sobre del formulario de comentarios, cuya dirección escribiste tú a propósito para que podamos responderte, queda deliberadamente excluido del filtro de direcciones. Son una red de seguridad para contenido que nunca debería haber llegado hasta ahí, no el mecanismo principal -- el mecanismo principal es que las etiquetas de las métricas tipadas ya son, de partida, enumeraciones cerradas y campos estructurales, así que ahí no hay nada de texto libre que limpiar.

- **El texto con forma de correo** se sustituye por `<email>`. El patrón reconoce la forma práctica y habitual de una dirección (letras, dígitos y un pequeño conjunto de signos de puntuación antes de la `@`, un dominio con punto después) -- no la gramática formal completa del correo. Una exclusión deliberada: `root@localhost` y direcciones similares sin dominio con punto se dejan intactas, para que un texto normal que mencione un paquete como `@types/node` no quede desfigurado. Una parte local construida con puntuación poco habitual puede dejar un fragmento inicial tras eliminarse su `@dominio.tld`.
- **Las rutas al directorio personal** (`/home/<nombre>/...`, `/Users/<nombre>/...`, `C:\Users\<nombre>\...`) tienen el segmento del nombre de cuenta sustituido por `<user>`. El único caso residual documentado: un nombre de cuenta con un espacio, al final mismo de una ruta, sin comilla de cierre ni separador después, puede dejar su segunda palabra (`C:\Users\Juan Pérez` al final de una línea conserva «Pérez»). El proceso principal además sustituye tu ruta literal de directorio personal allí donde aparezca textualmente, algo que el renderer, en su sandbox, no puede hacer.
- Ambos filtros recorren un conjunto conocido y acotado de campos del evento (texto de la pila de llamadas, mensajes, datos de la petición, breadcrumbs y similares) más un recorrido acotado en profundidad y tamaño de los contenedores de forma libre (como máximo 4 niveles de profundidad y 500 nodos visitados, donde cada elemento de contenedor y cada clave de objeto cuenta contra ese presupuesto, no solo las cadenas realmente reescritas) -- no un barrido ilimitado de todo el evento, así que el contenido más allá de ese límite no se visita. Hay un campo que deliberadamente no se toca: el nombre de host de la máquina que el propio SDK de Sentry adjunta a cada evento (`server_name`), porque en macOS y Windows suele derivarse del nombre de la cuenta y ninguna regla de limpieza puede distinguir eso de forma fiable de un nombre de host no relacionado.
- Una fuga con una forma que ninguno de los dos filtros reconoce -- un nombre de carpeta, una línea de asunto, texto libre del servidor -- no se atrapa aquí. Por eso las tablas de métricas de más abajo, y el diagnóstico de fallo al guardar la copia enviada, están construidas con campos estructurales cerrados en lugar de depender de la limpieza de texto libre.

### Registro de uso de IA

Cada vez que envías un mensaje al asistente de IA, MailCopilot registra una entrada de registro estructurada al terminar la petición, además del booleano de la sinopsis de uso descrita arriba. Esa entrada incluye: el **proveedor de IA** (por ejemplo el proveedor de tu clave de API, o «subscription»), el **modelo** que atendió la petición, el **número total de llamadas a herramientas** y los **nombres de las herramientas que llamó** (por ejemplo `send_email` o `mail_action`, nunca los argumentos que se les pasaron), si la petición se canceló o falló, y el **coste estimado** de la petición en USD cuando el proveedor expone precios. Nada de esto incluye el texto de tu petición, la respuesta de la IA ni contenido de correo -- para el desglose completo de lo que el propio asistente de IA envía a los proveedores (un tema aparte y mucho más amplio, que no debe confundirse con esta entrada de registro estructurada), consulta [Datos de IA y registro de auditoría](./ai-data). Las mediciones de latencia de funciones concretas de IA llevan sus propios campos agregados (tipo de contexto de la conversación, si ya había un historial, recuentos de tokens, el preset de reescritura usado, el número de borradores generados y similares) -- consulta [Spans de rendimiento](#spans-de-rendimiento) más abajo.

## Eventos

### Ciclo de vida de la app

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | no | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Una vez por arranque. Lleva `install_id_hash` para DAU/MAU. |
| `app.session_ended` | histogram | no | `reason`, `install_id_hash` | Una vez al cierre normal. value_ms = duración de la sesión. |
| `app.updated` | event | no | `from_version`, `to_version` | Una vez tras instalar una nueva versión por autoactualización. |
| `app.startup_ms` | histogram | no | `accounts_count` | Tiempo desde `app.whenReady` hasta el primer `BrowserWindow` visible. |
| `window.rescued` | event | no | `windows_moved`, `pass` | Un ciclo de rescate devolvió a la vista al menos una ventana que había quedado fuera de la pantalla tras un cambio en la configuración de pantallas (conexión de monitor, cambio de resolución, reactivación). |

### Consentimiento de telemetría

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `telemetry.consent_granted` | event | no | `version` | Solo se dispara cuando pulsas Permitir en la pantalla de consentimiento, con la versión del listado de datos que viste. Un rechazo no dispara ningún evento -- medir un «no» sería en sí mismo la transmisión que el rechazo pretende evitar. Volver a activar el interruptor en Ajustes -> Acerca de después de desactivarlo tampoco dispara este evento -- solo lo hace una respuesta a la pantalla de consentimiento. |

### Resumen de uso

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | no | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | Mapa de bits al cierre: qué funciones se usaron al menos una vez. |

### Onboarding

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | no | `first_run` | El usuario abrió el flujo de añadir cuenta. |
| `onboarding.method_selected` | event | no | `method` | El usuario eligió entre OAuth o IMAP/SMTP manual. |
| `onboarding.autoconfig_result` | event | no | `success`, `provider` | Sondeo de autoconfiguración finalizado: ¿se encontraron los ajustes IMAP/SMTP? |
| `onboarding.connection_test_result` | event | no | `kind`, `success`, `failure_kind` | Test de conectividad IMAP o SMTP finalizado. |
| `onboarding.google_oauth_result` | event | no | `success`, `failure_kind` | Flujo de Google OAuth2 finalizado. |
| `onboarding.account_saved` | event | no | `provider`, `auth_type` | Credenciales de la cuenta escritas en keytar/electron-store. |
| `onboarding.first_headers_sync_completed` | histogram | no | `provider`, `folder_count_bucket` | Tiempo desde `account_saved` hasta la primera sincronización completa de cabeceras (value_ms). |
| `onboarding.first_message_opened` | event | no | `time_since_sync_bucket` | El usuario abrió su primer mensaje tras iniciar sesión. |

### Redacción

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `compose.opened` | event | no | `source`, `has_draft` | Ventana de redacción abierta; rastrea el punto de entrada. |

### Cola de envío

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `send_queue.enqueued` | event | no | `scheduled`, `send_and_archive`, `has_attachments`, `body_size_bucket` | Mensaje saliente añadido a `send_queue` (inmediato o programado). |
| `send_queue.sent` | histogram | no | `scheduled` | Tiempo desde el encolado hasta la entrega SMTP exitosa (value_ms). |
| `send_queue.failed` | event | no | `failure_kind` | Intento de envío SMTP fallido de forma permanente (la cola se rinde). |
| `send_queue.retried` | event | no | `attempt_number` | Error de envío SMTP transitorio: mensaje reprogramado. |
| `send_queue.append_failed` | event | no | `reason`, `provider_id` | La entrega SMTP tuvo éxito, pero guardar una copia del mensaje en la carpeta Enviados por IMAP falló. Consulta el diagnóstico de la copia enviada descrito arriba en «Qué enviamos». |

### Avisos de destinatario erróneo

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `misdirection.prompted` | event | no | `kind` | Redacción mostró el diálogo de advertencia. |
| `misdirection.outcome` | event | no | `outcome`, `kind` | El usuario respondió al aviso. |

### Plantillas

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `template.applied` | event | no | `var_count` | El usuario insertó una plantilla en la redacción. |

### Recordatorios de seguimiento

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `followup.created` | event | no | `duration_days_bucket` | Se asoció un recordatorio de seguimiento a un mensaje saliente. |

### Búsqueda

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | no | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | Latencia extremo a extremo de la búsqueda FTS (lado main, antes del merge remoto). Se sustituirá por `search.completed` en PR 2. |
| `search.error` | event | no | `scope`, `kind` | El manejador de búsqueda lanzó: cancelación del usuario o fallo real. |

### Indexador de cuerpos

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | no | `indexed`, `folders_scanned` | Un tick completo del indexador a través de todas las carpetas. |
| `body_indexer.coverage_pct` | gauge | no | `total_messages`, `indexed_messages` | Fracción de mensajes en caché cuyo `body_text` está indexado. |
| `body_indexer.backlog` | gauge | no | -- | Número absoluto de mensajes en caché aún sin `body_text`. |
| `body_indexer.folder_error` | event | no | `folder_role`, `error_streak`, `backoff_ms` | El indexador acumuló errores en una carpeta y entró en backoff. |

### Mantenimiento del índice de texto completo

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `fts.optimize.duration_ms` | histogram | no | `segments_before`, `segments_after`, `reduction` | Pasada FTS5 optimize: tiempo y número de segmentos antes/después. |
| `fts.optimize.failed` | event | no | `reason` | FTS5 optimize lanzó un error. |

### Sincronización de cabeceras

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | no | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Ejecución completa de `syncFolderHeaders`: separa upsert del resto para perfilar. |
| `sync.headers.coalesced` | event | no | `folder_role` | Un intento duplicado de `syncFolderHeaders` se enganchó a una ejecución en curso. |

### Instrumentación de apertura de mensajes

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | no | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Latencia de extremo a extremo de la apertura de un mensaje, observada desde el renderer (desde el clic hasta el renderizado del cuerpo). La etiqueta `cache_hit_level` indica qué nivel de caché sirvió el cuerpo: `memory`, `db`, `eml`, `imap` o `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | no | `cache_hit_level` | Tiempo de pared del manejador IPC `net:messageDetails` en el proceso principal. Aisla la latencia del servidor del ruido del viaje de ida y vuelta renderer a main. Una muestra por rama terminal (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | no | `requester`, `wait_ms_bucket` | Tiempo de espera para adquirir una conexión del pool IMAP por cuenta. Se emite solo cuando la espera supera 500 ms, para que los paneles capturen la cola larga sin ruido de adquisiciones rápidas. |

### Invitaciones de calendario

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `mail.invite_rsvp` | event | no | `method`, `hadLocation` | Se dispara al enviarse con éxito una respuesta a una invitación de calendario (Aceptar / Provisional / Rechazar). `hadLocation` solo registra si la invitación original tenía un campo de ubicación, no qué decía. Los envíos de respuesta fallidos no se cuentan aquí. |

### Renovación de tokens OAuth de IMAP

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | no | `provider` | Renovación del token OAuth disparada por un fallo de autenticación IMAP (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | no | `provider` | La renovación tuvo éxito: el reintento IMAP usará el token recién obtenido. |
| `imap.auth_refresh_failure` | event | no | `provider`, `reason` | La renovación falló: el error de autenticación original se propaga al llamador. |
| `imap.auth_refresh_suppressed` | event | no | `reason` | El cooldown por cuenta suprimió un intento de renovación para evitar tormentas de peticiones a `/token` cuando un refresh token ha sido revocado. |
| `imap.idle_auth_refreshed` | event | no | `provider` | El bucle IDLE se recuperó de un fallo de autenticación en mitad del ciclo vía una renovación in-loop: la entrega push siguió sin el backoff de 60 min. |
| `imap.auth_refresh_exhausted` | event | no | `provider`, `consecutive` | El bucle IDLE activó el storm-brake: N renovaciones consecutivas tuvieron éxito en el proveedor pero IMAP siguió rechazando los tokens nuevos, así que volvemos al backoff de autenticación habitual. |

### Recuperación de confianza de certificados

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `imap.cert_error` | event | sí (ventana 10 s) | `provider` | Una operación IMAP falló con un error TLS clasificado como de certificado (autofirmado, cadena no confiable, discrepancia de pin, discrepancia de nombre de host). |
| `cert.recovery_dialog_shown` | event | no | `provider` | Se mostró el diálogo de recuperación de certificado para un host, como máximo una vez por ventana de storm-guard. |
| `cert.trust_clicked` | event | no | `provider`, `pem` | Aceptaste un certificado presentado, guardando un pin TLS y disparando una resincronización de la cuenta. `pem` solo registra si el cuerpo del certificado se capturó junto con el pin, lo que determina si un servidor autofirmado puede seguir siendo de confianza en adelante. |
| `cert.trust_rejected` | event | no | `provider`, `reason` | Un intento de confianza no terminó con un pin guardado -- por ejemplo, rechazaste la confirmación, o el certificado que presentó el servidor no coincidía con el que mostraba el diálogo de recuperación. |
| `cert.interception_notice_shown` | event | no | `provider` | Se mostró un aviso único de que la cadena de certificados de tu servidor de correo solo se verifica contra el almacén de certificados de tu sistema operativo, no contra la lista de raíces públicas incluida -- la firma de un antivirus o un proxy corporativo inspeccionando la conexión. |

Ninguna de estas etiquetas lleva jamás el nombre de host, la huella del certificado, el nombre del emisor o el texto de error en bruto -- solo la clasificación enumerada `provider` y códigos de motivo cerrados.

### Retención del caché

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | no | `count_bucket`, `freed_bytes_bucket` | La purga de retención eliminó archivos `.eml` más antiguos que el límite configurado. Los recuentos y los tamaños se transmiten solo como rangos — no se envían rutas ni números exactos. |
| `cache.folder_index_disabled` | event | no | `count`, `role` | Una carpeta fue excluida de la búsqueda de texto completo — automáticamente para Junk/Spam/Papelera en el primer registro, o manualmente mediante el menú contextual de carpeta. `role`: `spam`, `trash` o `manual`. |

### Señales de seguridad del caché y de pérdida de datos

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | no | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | Se emitió un `DELETE FROM messages` a nivel de carpeta. Cada llamador suministra un motivo para distinguir una regresión que borra una caché sana de un bump UIDVALIDITY legítimo. |
| `imap.stale_wipe_guard_tripped` | event | no | `folder_role`, `provider` | La protección mass-delete se negó a vaciar la caché local de la carpeta porque `mailbox.exists` no era numérico. Un pico aquí apunta a un problema del proveedor o de conexión, no a pérdida real de datos. |
| `db.shutdown_wal_checkpoint_ms` | histogram | no | `busy`, `reclaimed_kb_bucket`, `ok` | Duración del `PRAGMA wal_checkpoint(TRUNCATE)` que ejecutamos antes de salir, para que las escrituras committed-pero-no-checkpointed sobrevivan al reinicio. |

### Límites de gasto en IA

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `db.ai_reserve_denied` | event | sí (ventana 10 s) | `reason` | Se rechazó una reserva de presupuesto de IA antes de que pudiera producirse ningún gasto -- casi siempre porque se alcanzó el límite de gasto que configuraste. |
| `ai.request_budget.stopped` | event | no | `provider`, `steps` | Una petición de chat se detuvo antes de tiempo porque el coste acumulado alcanzó el techo por petición que configuraste. `steps` es el número de pasos agénticos completados antes de la parada, nunca su contenido. |

### Puerta stdio MCP (protección renderer-a-RCE)

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `mcp.stdio.connect_attempted` | event | no | `approved_source` | El transporte stdio MCP está a punto de arrancar: se emite una vez por connect exitoso tras pasar las puertas de aprobación y allowlist. |
| `mcp.stdio.connect_blocked` | event | no | `reason` | Conexión o guardado stdio rechazado por la puerta (`not_approved`, `unapproved_command`, `forbidden_field`, `forbidden_env_key`, `env_disabled`). |
| `mcp.stdio.approval_granted` | event | no | `source`, `scope` | El usuario concedió la aprobación stdio MCP (activación global o por conexión); `source` distingue env vs native-confirm, `scope` distingue global vs por conexión. |
| `mcp.stdio.env_sanitized_on_load` | event | no | `count_bucket` | La migración de ajustes eliminó claves de entorno loader-hook prohibidas de las conexiones MCP persistidas al cargar. A lo sumo una vez por arranque. |

### Auditoría de acciones de IA (barrera preview -> apply)

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `ai.action.preview_created` | event | no | `kind` | Una herramienta MCP `*_preview` registró una acción mutadora pendiente, esperando el clic Apply del usuario. |
| `ai.action.applied` | event | no | `kind` | Una herramienta MCP `*_apply` ejecutó con éxito una acción mutadora confirmada previamente. |
| `ai.action.rejected` | event | no | `kind`, `reason` | Una llamada `*_apply` fue rechazada en la puerta de validación -- faltaba o expiró el preview, faltó, no coincidió o expiró el token de confirmación, el tipo de acción no coincidía con el preview, faltaba el callback, o se alcanzó el límite de frecuencia. |
| `ai.action.expired` | event | no | `kind` | Una acción mutadora pendiente expiró sin que el usuario hiciera clic en Apply (TTL). |
| `ai.action.apply_duration_ms` | histogram | no | `kind` | Duración de un apply exitoso: cuánto duró la mutación subyacente (DB / IMAP / SMTP). |
| `ai.action.preview_skipped` | event | no | `kind`, `reason` | Una herramienta MCP `*_preview` se negó a registrar una acción pendiente porque el conjunto de objetivos resuelto quedó vacío (sin coincidencias tras resolver la consulta). |
| `ai.action.batch_size` | event | no | `kind`, `accounts_count_bucket`, `emails_count_bucket`, `folders_count_bucket` | Se registra cuando el registro de un preview abarca un lote de mensajes. Los tres recuentos son rangos aproximados, nunca números exactos. |

### Puerta de salida (egress) de IA

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | no | `tool_name`, `account_id` | Una llamada a una herramienta de salida (por ejemplo, `WebSearch`, `WebFetch`, una herramienta MCP externa genérica) fue rechazada mientras los datos de correo del usuario estaban en el alcance: filtrada del toolset del SDK o detenida por la puerta en runtime. |
| `ai.egress.allowed_once` | event | no | `tool_name`, `account_id` | El usuario otorgó un consentimiento puntual para la salida y la IA lo usó. Permite distinguir «los usuarios anulan rutinariamente» de «la puerta aguanta, los intentos son sobre todo por inyección». |
| `ai.egress.intercepted` | event | no | `tool_name`, `outcome`, `was_consented_for_turn` | Se interceptó una llamada a una herramienta de internet (búsqueda web, obtención web, herramienta MCP externa) mediante el modal de confirmación descrito en [Política de egress de IA](./ai-data#política-de-egress-de-ia), registrando si se aprobó o se denegó y si ya existía un consentimiento previo para el mismo turno de respuesta. Nunca la consulta, la URL o los argumentos de la herramienta -- eso solo se registra con hash en el registro de auditoría de IA local. |

### Acciones en el panel de auditoría de privacidad de IA

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `ai.audit.export_requested` | event | no | `format` | Hiciste clic en Exportar JSON o Exportar CSV en el panel del registro de auditoría de IA. |
| `ai.audit.entry_deleted` | event | no | `scope` | Eliminaste de forma suave una entrada del registro de auditoría, o borraste todas a la vez. Las filas subyacentes no se eliminan, solo se ocultan -- consulta [El registro de auditoría](./ai-data#el-registro-de-auditoría). |

### Reglas de IA en segundo plano

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `ai.rule.applied` | event | no | `action` | El proceso de reglas de IA en segundo plano aplicó automáticamente una acción reversible (archivar, mover, marcar como leído o marcar con estrella) a un mensaje. |
| `ai.rule.destructive_preview` | event | no | `action` | El proceso de reglas de IA en segundo plano propuso una acción destructiva (eliminar o marcar como spam), pero la registró como preview pendiente en lugar de aplicarla automáticamente. |

### Actualizaciones automáticas

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `update.check_triggered` | event | no | `source` | Se emitió una comprobación de actualizaciones, ya fuera por el temporizador horario en segundo plano o por tu clic en Ajustes -> Acerca de. |
| `update.check_result` | event | no | `result`, `error_class` | Terminó una comprobación de actualizaciones: al día, hay una actualización disponible, o falló. |
| `update.download_started` | event | no | `source` | Comenzó una descarga de actualización, ya fuera automática o por tu clic. |
| `update.download_completed` | event | no | — | La descarga de una actualización terminó con éxito y queda lista para instalarse en el próximo reinicio. |
| `update.download_failed` | event | no | `error_class` | Una descarga de actualización no terminó (corte de red, disco lleno, discrepancia de firma o similar). |
| `update.install_outcome` | event | no | `result`, `error_class` | Qué ocurrió después de que pulsaras Reiniciar para instalar. |

Ninguno de estos lleva la cadena de versión de la versión implicada -- solo el resultado agrupado -- así que esta tabla no permite saber cuánto se ha quedado atrás una instalación concreta.

### Puerta de enlaces externos

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `links.external_open_suppressed` | event | sí (ventana 10 s) | `source` | Una solicitud de abrir un enlace en tu navegador predeterminado fue limitada por la puerta de apertura de enlaces externos. `source` identifica qué parte de la aplicación hizo la solicitud (por ejemplo un diálogo de actualización o un enlace de baja), nunca la URL en sí. |

### Reserva del almacén de secretos

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `secret_store.fallback_active` | event | no | `surface`, `platform` | Una lectura del almacén de secretos de tu sistema operativo (keytar / libsecret / Secret Service) falló, lo que significa que esta instalación funciona sin un llavero accesible. `surface` identifica qué tipo de lectura de credenciales falló, nunca la credencial, la cuenta ni su dirección de correo. |

### Rendimiento de IPC

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | sí (ventana 10 s) | `channel`, `duration_bucket` | El manejador IPC superó el umbral «lento». |

### Capacidad de respuesta de la UI

| Evento | Tipo | Agregado | Etiquetas | Propósito |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | sí (ventana 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | El bucle de eventos del renderer estuvo bloqueado más que el umbral de congelación. |
| `ui.freeze.main_ms` | histogram | sí (ventana 10 s) | `duration_bucket`, `inflight_count`, `top_inflight` | El bucle de eventos del proceso main estuvo bloqueado (medido con `perf_hooks` delay). |

## Spans de rendimiento

Además de los eventos discretos e histogramas anteriores, MailCopilot cronometra un conjunto fijo de operaciones como spans de rendimiento de Sentry -- el mecanismo que Sentry usa para el trazado de latencia en lugar de contadores. Cada valor de atributo de abajo es un agregado: una enumeración, un recuento, una duración o un booleano. Ninguno lleva contenido de mensajes, una dirección, una consulta, una URL o un prompt.

### Sincronización y entrega de correo

| Span | Tipo | Agregado | Atributos | Propósito |
| --- | --- | --- | --- | --- |
| `imap.idle` | span | no | `folder_role`, `provider`, `exit_reason`, `duration_bucket` | Un ciclo IDLE: conectar, esperar una notificación push, y actualizar o salir. |
| `imap.sync` | span | no | `folder_role`, `provider`, `changed_since_present`, `fetched_headers_bucket`, `skipped`, `errored` | Un pase de sincronización de cabeceras para una carpeta, vía CONDSTORE o una obtención completa. |
| `smtp.send` | span | no | `provider`, `size_bucket`, `has_attachments` | Un intento de envío por SMTP. |

### Procesamiento en segundo plano

| Span | Tipo | Agregado | Atributos | Propósito |
| --- | --- | --- | --- | --- |
| `body_indexer.batch` | span | no | `folder_role`, `batch_size_bucket`, `fetched_ok_bucket`, `failed_bucket` | Un lote de mensajes procesado dentro de un ciclo del indexador de cuerpos. |
| `offline.replay` | span | no | `ops_count_bucket`, `failed_bucket`, `uidvalidity_mismatch` | Una repetición de acciones offline en cola para una cuenta al reconectarse. |
| `search.fts` | span | no | `query_len_bucket`, `result_count_bucket` | Un envío de búsqueda de texto completo al worker de búsqueda. |
| `net.message_details` | span | no | `cache_hit_level`, `body_size_bucket`, `attachments_count` | El manejador del proceso principal que resuelve el contenido completo de un mensaje, cubriendo desde un acierto en memoria hasta una obtención fresca por IMAP. |

### Latencia de funciones de IA

| Span | Tipo | Agregado | Atributos | Propósito |
| --- | --- | --- | --- | --- |
| `ai.chat` | span | no | `ai.provider`, `ai.model`, `ai.context_type`, `ai.has_history`, `ai.session_resumed`, `ai.tool_call_count`, `ai.tools_used`, `ai.aborted`, `ai.cost_usd` | Una petición de chat al asistente de IA, desde la apertura del flujo del proveedor hasta su finalización o cancelación. `ai.context_type` y los indicadores de historial/reanudación describen desde dónde empezó la conversación y si continuaba una anterior -- nunca su contenido. |
| `ai.thread_summary.generate` | span | no | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | Una generación de resumen IA del hilo. Solo se dispara ante una llamada real al proveedor, nunca ante un acierto de caché. |
| `ai.quick_action.rewrite` | span | no | `preset`, `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | Una reescritura mediante las acciones rápidas al redactar. `preset` registra cuál de los presets (Mejorar / Acortar / Formal / Corregir gramática) elegiste, nunca el texto de tu borrador. |
| `ai.instant_reply.generate` | span | no | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `draft_count` | Una llamada de generación de respuesta instantánea. `draft_count` es cuántas opciones de respuesta se generaron, nunca su texto. |

### Base de datos local

| Span | Tipo | Agregado | Atributos | Propósito |
| --- | --- | --- | --- | --- |
| `db.upsert_messages` | span | no | `row_count_bucket`, `folder_role` | Una transacción de upsert de mensajes por lotes. |
| `db.reconcile_uids` | span | no | `row_count_bucket`, `folder_role`, `uidvalidity_changed` | Un pase de reconciliación que elimina de la caché local los mensajes que ya no están en el servidor. |
| `db.search_messages` | span | no | `query_len_bucket`, `folder_role`, `result_count_bucket` | Una invocación de búsqueda en la caché local, sea cual sea la ruta interna de búsqueda que la haya atendido. |

## Contacto

¿Preguntas o dudas sobre lo que recopilamos? Abre una incidencia en [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) o contacta con el equipo directamente a través del formulario de comentarios en Ajustes -> Acerca de.
