---
sidebar_position: 1
title: AI Data & Audit Log
---

# Datos de IA y registro de auditoría

Esta página explica qué datos procesa el asistente de IA, cómo MailCopilot registra ese procesamiento en un registro de auditoría local y qué controles tiene usted sobre esos datos.

## Qué envía el asistente de IA a los proveedores

Cuando utiliza el asistente de IA, MailCopilot transmite lo siguiente a su proveedor de IA elegido:

- El contenido del correo o hilo de conversación que está viendo en ese momento (asunto, cuerpo, remitente, destinatarios).
- Los archivos adjuntos que le pide explícitamente al asistente que lea.
- Sus notas de memoria de IA (si la función de Memoria está configurada).
- El texto de su mensaje al asistente en el chat.

**Lo que nunca se envía:**

- Correos o carpetas que no haya abierto ni mencionado en la sesión actual.
- Sus credenciales IMAP/SMTP o la configuración del servidor.
- Las contraseñas de sus cuentas de correo.
- Datos de cuentas que no haya utilizado explícitamente en la solicitud de IA actual.

El asistente de IA es completamente opcional. Si no configura un proveedor, ningún dato de correo se transmite a ningún servicio externo.

## Resumen IA del hilo

El [Resumen IA del hilo](../ai-assistant#resumen-ia-del-hilo) es una función independiente y opcional que genera un breve resumen de un hilo abierto. Sigue las mismas protecciones que el resto del asistente de IA:

- **Deshabilitado de forma predeterminada, por cuenta.** No se envía nada para resumir a menos que habilite **Configuración > IA > Resumen IA del hilo** para esa cuenta específica.
- **Contenido envuelto.** Cada mensaje incluido en la solicitud de resumen se envuelve con marcadores de límite `wrapUntrusted()` antes de llegar al proveedor de IA, la misma protección descrita más abajo en [Protección contra inyección de prompts](#protección-contra-inyección-de-prompts).
- **Generaciones auditadas.** Cada vez que se genera realmente un resumen (y no se sirve desde la caché), se escribe una entrada en el [registro de auditoría de IA](#el-registro-de-auditoría) con el objetivo de la acción de resumen. Volver a abrir un hilo que ya fue resumido lee el resultado en caché y no crea una nueva entrada de auditoría ni vuelve a contactar al proveedor de IA.
- **Caché limitada a la cuenta.** Un resumen generado se almacena en caché y se busca por cuenta: la clave de caché combina su cuenta con la identidad del hilo, de modo que un resumen en caché de una cuenta nunca se reutiliza ni se expone para otra cuenta.
- **Consciente del presupuesto.** Si se ha alcanzado el presupuesto diario de IA, el resumen se rechaza de forma controlada en lugar de generarse — consulte [Resumen IA del hilo](../ai-assistant#resumen-ia-del-hilo) para ver qué se muestra en ese caso.
- **Selección de proveedor.** El Resumen IA del hilo utiliza su **proveedor configurado por clave de API** (Anthropic, compatible con OpenAI o Google Gemini) — **una suscripción de Claude no es compatible con el Resumen IA del hilo** y produce el mismo rechazo "sin proveedor de IA" que la ausencia total de un proveedor configurado. Está diseñado para preferir un modelo local, en el dispositivo, en cuanto esa opción esté disponible, de modo que el contenido del hilo no necesitaría salir de su equipo — ese soporte aún no está disponible, por lo que hoy siempre usa su proveedor remoto configurado por clave de API.
- **La telemetría no contiene contenido de mensajes.** El evento de uso anónimo registrado en cada generación solo incluye el identificador del proveedor, si el modelo se ejecutó localmente, los recuentos de tokens de entrada/salida, la latencia y una clase de error agregada — nunca el asunto, el cuerpo o las direcciones de los participantes del hilo.

## Acciones rápidas al redactar

Las [Acciones rápidas al redactar](../ai-assistant#acciones-rapidas-al-redactar) reescriben el texto actual de su borrador en la ventana de redacción (Mejorar / Acortar / Formal / Corregir gramática). Siguen las mismas protecciones que el resto del asistente de IA:

- **Sin sustitución silenciosa.** Una reescritura solo se muestra como una comparación antes/después. El cuerpo de su borrador solo cambia después de que haga clic explícitamente en **Reemplazar** o **Insertar en el cursor** — hacer clic en **Cancelar**, o descartar la comparación, deja su borrador sin cambios y no se envía nada más.
- **Contenido envuelto.** El texto de su borrador se envuelve con marcadores de límite `wrapUntrusted()` antes de llegar al proveedor de IA, la misma protección descrita en [Protección contra inyección de prompts](#protección-contra-inyección-de-prompts) más abajo — esto también protege contra texto que haya pegado desde una fuente no confiable.
- **Generaciones auditadas.** Cada reescritura escribe una entrada en el [registro de auditoría de IA](#el-registro-de-auditoría) con `goal` establecido en `quick_action`; el preset concreto usado (Mejorar / Acortar / Formal / Corregir gramática) se registra en el span de telemetría, no en la entrada de auditoría.
- **Selección de proveedor.** Las Acciones rápidas utilizan su **proveedor configurado por clave de API** (Anthropic, compatible con OpenAI o Google Gemini) — **una suscripción de Claude no es compatible** y produce el mismo rechazo "sin proveedor de IA" que la ausencia total de un proveedor configurado. No hay un ajuste de activación/desactivación independiente: las Acciones rápidas están disponibles siempre que haya un proveedor adecuado configurado y el borrador tenga texto para reescribir.
- **Consciente del presupuesto.** Si se ha alcanzado el presupuesto diario de IA, la reescritura se rechaza de forma controlada — consulte [Acciones rápidas al redactar](../ai-assistant#acciones-rapidas-al-redactar) para ver qué se muestra en ese caso.
- **La telemetría no contiene contenido de mensajes.** El evento de uso anónimo registrado en cada reescritura solo incluye el preset usado, el identificador del proveedor, si el modelo se ejecutó localmente, los recuentos de tokens, la latencia y una clase de error agregada — nunca el texto del borrador en sí.

## Respuesta instantánea

La [Respuesta instantánea](../ai-assistant#respuesta-instantanea) es una función independiente y opcional que redacta dos o tres opciones de respuesta breves para el mensaje que tiene abierto. Sigue las mismas protecciones que el resto del asistente de IA, más una salvaguarda adicional específica de cómo obtiene el cuerpo del correo:

- **Deshabilitada de forma predeterminada, por cuenta.** No se envía nada para redactar a menos que habilite **Configuración > IA > Respuesta instantánea** para esa cuenta específica. Cuando está deshabilitada, el botón de Respuesta instantánea no se muestra y no se realiza ninguna solicitud.
- **Solo cuerpo desde la caché.** La Respuesta instantánea resuelve el cuerpo del correo original desde la caché local de MailCopilot por cuenta, carpeta y UID del mensaje — nunca confía en el texto del cuerpo que pudiera venir de lo que se esté mostrando en la ventana, lo que descarta una clase de ataques de envenenamiento de caché en los que una vista manipulada podría influir en lo que se envía al proveedor de IA.
- **Contenido envuelto.** El cuerpo del correo original se envuelve con marcadores de límite `wrapUntrusted()` antes de llegar al proveedor de IA, la misma protección descrita en [Protección contra inyección de prompts](#protección-contra-inyección-de-prompts) más abajo.
- **Nunca se envía automáticamente.** Elegir una opción redactada solo prellena una **nueva** ventana de redacción. No se envía nada hasta que usted revise explícitamente el borrador y pulse Enviar usted mismo.
- **Generaciones auditadas.** Cada vez que se generan realmente borradores, se escribe una entrada en el [registro de auditoría de IA](#el-registro-de-auditoría) con el objetivo de la acción de respuesta instantánea.
- **Selección de proveedor.** La Respuesta instantánea utiliza su **proveedor configurado por clave de API** (Anthropic, compatible con OpenAI o Google Gemini) — **una suscripción de Claude no es compatible** y produce el mismo rechazo "sin proveedor de IA" que la ausencia total de un proveedor configurado.
- **Consciente del presupuesto.** Si se ha alcanzado el presupuesto diario de IA, la redacción se rechaza de forma controlada — consulte [Respuesta instantánea](../ai-assistant#respuesta-instantanea) para ver qué se muestra en ese caso.
- **La telemetría no contiene contenido de mensajes.** El evento de uso anónimo registrado en cada generación solo incluye el identificador del proveedor, si el modelo se ejecutó localmente, los recuentos de tokens, la latencia y una clase de error agregada — nunca el asunto, el cuerpo del correo, las direcciones del remitente o del destinatario, o el texto de la respuesta redactada.

## Política de egress de IA

MailCopilot intercepta cada llamada a herramientas de internet que la IA desea realizar — búsqueda web, obtención de páginas web y llamadas a herramientas MCP externas — y detiene la IA para solicitar su aprobación antes de ejecutar la llamada. Esto evita que un correo malicioso filtre silenciosamente sus datos mediante un ataque de inyección de prompt.

### Funcionamiento

Cuando la IA quiere usar una herramienta de internet (por ejemplo, realizar una búsqueda web), MailCopilot detiene la respuesta y muestra un modal de confirmación integrado en el panel de IA con el mensaje **«La IA quiere acceder a Internet»**. El modal muestra:

- El tipo de acción — «Búsqueda web:», «Obtener URL:» o «Llamada a herramienta externa»
- La consulta, URL o nombre de herramienta externa solicitado por la IA (cuando esté disponible)
- Los botones **Permitir** y **Denegar**

Haga clic en **Permitir** para permitir que la IA continúe, o en **Denegar** para rechazar. Su decisión se aplica a todo el turno de respuesta actual — si la IA realiza varias llamadas a herramientas de internet en una misma respuesta, solo se le preguntará una vez. Al hacer clic en **Permitir** se concede acceso para todas las llamadas restantes de ese turno.

Si no responde en 30 segundos, MailCopilot deniega la llamada a la herramienta automáticamente.

### Icono de escudo

Se muestra un icono de escudo en el encabezado del panel de IA cuando la interception de egress está activa. Al pasar el cursor sobre él, aparece: «El acceso web de la IA está interceptado: cada llamada saliente requiere su aprobación». Este icono confirma que el interceptor está en funcionamiento y que ninguna llamada a internet puede omitir su aprobación.

### Configuración de política

Puede ajustar la política de egress en **Configuración → AI** (bajo el control **Acceso web de la IA**). Controla cuándo la IA puede usar herramientas de internet. Con **Denegar por defecto** o **Preguntar en cada turno**, MailCopilot solicita confirmación en la primera llamada a herramienta de internet de cada turno de respuesta. Con **Permitir siempre**, la solicitud se omite — las herramientas de internet se ejecutan sin confirmación:

- **Denegar por defecto (recomendado)** — interceptar todas las llamadas a herramientas de internet; usted aprueba o deniega cada turno mediante el modal de confirmación.
- **Preguntar en cada turno** — mismo comportamiento que la denegación predeterminada: consentimiento explícito por turno a través del modal de confirmación.
- **Permitir siempre** — la IA puede llamar libremente a herramientas web. Advertencia: la IA puede enviar contenido de correo a servicios externos.

### Registro de auditoría

Cada llamada a herramientas de internet interceptada crea una fila en el registro de auditoría; las llamadas denegadas incrementan la columna **Bloqueado**, mientras que las llamadas aprobadas se registran con **Bloqueado** = 0. Cada entrada también se contabiliza en el evento de telemetría `ai.egress.intercepted` con etiquetas que indican el nombre de la herramienta, el resultado (aprobado o denegado) y si el consentimiento para ese turno ya estaba registrado. Para los detalles de consulta o URL, el registro almacena únicamente un hash SHA-256 truncado a los primeros 16 caracteres hexadecimales; las consultas y URL sin procesar nunca se escriben en el disco.

## El registro de auditoría

MailCopilot mantiene un registro de auditoría local de cada acción de IA. El registro se almacena en su base de datos local en su dispositivo y nunca se transmite a MailCopilot ni a terceros.

### Qué registra cada entrada

| Campo | Descripción |
|-------|-------------|
| **Marca de tiempo** | Fecha y hora exactas en que ocurrió la acción. |
| **Proveedor** | El proveedor de IA utilizado (p. ej., Anthropic, OpenAI, Google). |
| **Modelo** | La versión específica del modelo que procesó la solicitud. |
| **Objetivo** | Una breve descripción de lo que se pidió al asistente. |
| **Herramienta** | La herramienta MCP llamada, si corresponde (p. ej., `send_email`, `mail_action`, `move_email`). |
| **Tokens entrada / salida** | Recuento de tokens de entrada y salida para esta acción. Los valores se registran si el proveedor los expone a través del SDK; de lo contrario, las columnas muestran **n/d**. |
| **Costo (USD)** | Costo estimado según los precios publicados del proveedor, o **n/d** para proveedores por suscripción. El costo es la señal principal para el seguimiento del gasto. |
| **Envuelto** | Número de invocaciones del marcador `wrapUntrusted()`. Cada invocación significa que un bloque de contenido de correo fue aislado antes de pasarse a la IA para prevenir la inyección de prompts. |
| **Bloqueado** | Número de intentos de egress saliente bloqueados por la política de seguridad durante esta acción. |
| **Resultado** | Resultado de la acción: **OK** (completado con éxito), **Error** (fallido) o **Cancelado** (interrumpido por usted o el sistema). |

### Inmutabilidad y retención

Las nuevas entradas siempre se añaden al final. Todas las columnas excepto `deleted_at` son inmutables después de la inserción — los registros existentes no se modifican una vez escritos. Esto significa que la aplicación no puede alterar entradas pasadas (solo puede eliminarlas de forma suave o dejar que el límite de rotación elimine las más antiguas). La eliminación suave de una entrada (ver más abajo) establece la marca de tiempo `deleted_at` y oculta la entrada de la vista, pero todas las demás columnas permanecen sin cambios.

El registro está limitado a **10.000 entradas**. Cuando se añade una nueva entrada y el total supera este límite, las filas más antiguas se eliminan automáticamente para mantener el registro dentro del límite. Las entradas anteriores a las 10.000 más recientes se eliminan permanentemente de la base de datos local. Si necesita un registro permanente, exporte el registro regularmente mediante los botones **Exportar JSON** o **Exportar CSV** antes de que las entradas queden fuera de la ventana de retención.

### Acceder al registro de auditoría

Abra **Configuración → IA** y expanda la sección **Privacidad y auditoría**. El registro está paginado y ordenado del más reciente al más antiguo.

### Exportar

Haga clic en **Exportar JSON** o **Exportar CSV** para descargar el registro de auditoría actualmente visible (filas activas dentro del límite de rotación de 10.000 entradas; las entradas eliminadas de forma suave y las eliminadas por rotación quedan excluidas). La exportación incluye todos los campos listados arriba para cada entrada incluida. El archivo CSV utiliza el formato RFC 4180 con separadores de línea CRLF y escape correcto (los campos que contienen comas, comillas o saltos de línea están correctamente escapados). El archivo CSV es compatible con Excel, Numbers y LibreOffice. Puede usarla para:

- Revisar la actividad de IA en cualquier momento.
- Responder a solicitudes de acceso a datos personales bajo el RGPD u otras normativas similares.
- Conservar una copia sin conexión para sus propios registros.

### Eliminar entradas

**Eliminación suave por fila** — haga clic en el icono de eliminación de una entrada del registro para ocultarla de la vista. La marca de tiempo `deleted_at` de la entrada se establece y desaparece de la lista y los agregados, pero los datos subyacentes se conservan para preservar la integridad del audit.

**Borrar todo** — marca todas las entradas de auditoría como eliminadas de forma suave (establece `deleted_at` en cada registro). Antes de ejecutar esta acción, MailCopilot muestra un diálogo de confirmación nativo del sistema operativo con el título "Clear AI audit log" y los botones **Cancel** y **Delete All**. Las entradas quedan ocultas de la lista, los agregados y las exportaciones. Tenga en cuenta que el límite automático de 10.000 filas (ver más arriba) elimina físicamente las filas más antiguas con el tiempo; las entradas eliminadas de forma suave cuentan para el límite y eventualmente serán purgadas definitivamente por la rotación.

## Agregados de tokens y costos

La parte superior del panel de Privacidad y auditoría muestra los totales de tokens y costos por proveedor. Seleccione un período — **Hoy**, **Últimos 7 días** o **Últimos 30 días** — para filtrar los agregados. Estas son ventanas móviles, no semana o mes calendario. Estos totales se calculan a partir del registro de auditoría local y nunca se envían a ningún servidor.

Para los proveedores por suscripción, los costos se muestran como **n/d** porque no aplica la tarificación por solicitud.

## Protección contra inyección de prompts

Cada bloque de contenido de correo que se pasa a la IA se envuelve con marcadores de límite `wrapUntrusted()`. Estos marcadores instruyen a la IA a tratar el contenido incluido como datos de usuario no confiables — no como instrucciones — para que un correo malicioso no pueda secuestrar el comportamiento del asistente. La columna **Envuelto** en el registro de auditoría le permite ver exactamente cuántas veces se aplicó esta protección en cada solicitud. El contador es preciso: si el mismo correo se recupera más de una vez dentro de una misma solicitud (por ejemplo, cuando la IA vuelve a consultarlo durante una tarea de varios pasos), cada recuperación se contabiliza por separado, de modo que el total refleja con exactitud el número real de lecturas de correos.

## Véase también

- [Asistente de IA](../ai-assistant) — guía completa para usar el asistente de IA.
- [Telemetría](./telemetry) — datos de diagnóstico anónimos recopilados por MailCopilot (independientes del registro de auditoría de IA).
